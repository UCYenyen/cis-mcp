import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { BROWSER_APP, SITE_HOST, SITE_URL } from "./config.ts";
import type { CisSession } from "./session.ts";
import { cookieHeader, loadSession, mergeSetCookies, saveSession } from "./session.ts";

const run = promisify(execFile);

const OPEN_TAB_HINT =
  `Log in with cis_login (username/password), run pnpm signin, or open ${SITE_URL} in ${BROWSER_APP} and sign in.`;
const APPLE_EVENTS_HINT =
  `In ${BROWSER_APP}'s menu bar, turn on View → Developer → "Allow JavaScript from Apple Events" (one-time), then try again.`;

export class NoTabError extends Error {
  constructor() {
    super(`No open ${SITE_HOST} tab found. ${OPEN_TAB_HINT}`);
    this.name = "NoTabError";
  }
}
export class AccountNotFoundError extends Error {
  constructor(account: string, seen: string[]) {
    super(
      `No open ${SITE_HOST} tab is signed in as "${account}". Signed-in tabs: ${seen.length ? seen.join(", ") : "none"}. ` +
        `Open ${SITE_URL} in that account's ${BROWSER_APP} profile and sign in, then try again.`,
    );
    this.name = "AccountNotFoundError";
  }
}
export class NotLoggedInError extends Error {
  constructor(msg?: string) {
    super(msg ?? `Your CEdX session looks logged out or expired. ${OPEN_TAB_HINT}`);
    this.name = "NotLoggedInError";
  }
}

/**
 * JXA (osascript -l JavaScript): find an open tab on the CEdX host in the user's
 * browser and run `code` inside it. Same-origin, so the tab's session cookies ride
 * along. Nothing new is opened and no other tab is touched.
 *
 * Windows from every Chrome profile are visible here, so when `account` is set each
 * CEdX tab is probed for its signed-in name and only a tab whose name contains
 * `account` (case-insensitive) is used. That is how one Chrome with several profiles
 * can act as different CEdX accounts.
 */
const FIND_TAB_SCRIPT = `
function run(argv) {
  const [appName, host, code, account, probe] = argv;
  const app = Application(appName);
  if (!app.running()) return JSON.stringify({ status: "no-tab" });
  const want = (account || "").trim().toLowerCase();
  const seen = [];
  for (const w of app.windows()) {
    for (const t of w.tabs()) {
      const m = /^https?:\\/\\/([^/]+)/.exec(t.url());
      if (!m || m[1] !== host) continue;
      try {
        if (want) {
          const who = String(t.execute({ javascript: probe }) || "");
          if (who && seen.indexOf(who) < 0) seen.push(who);
          if (who.toLowerCase().indexOf(want) < 0) continue;
        }
        return JSON.stringify({ status: "ok", result: String(t.execute({ javascript: code })) });
      } catch (e) {
        return JSON.stringify({ status: "error", message: String(e) });
      }
    }
  }
  if (want) return JSON.stringify({ status: "no-account", seen: seen });
  return JSON.stringify({ status: "no-tab" });
}`;

/** JXA: every open CEdX tab's signed-in name (deduplicated), across all Chrome profiles. */
const LIST_ACCOUNTS_SCRIPT = `
function run(argv) {
  const [appName, host, probe] = argv;
  const app = Application(appName);
  if (!app.running()) return JSON.stringify({ status: "ok", accounts: [] });
  const accounts = [];
  for (const w of app.windows()) {
    for (const t of w.tabs()) {
      const m = /^https?:\\/\\/([^/]+)/.exec(t.url());
      if (!m || m[1] !== host) continue;
      try {
        const who = String(t.execute({ javascript: probe }) || "");
        if (accounts.indexOf(who) < 0) accounts.push(who);
      } catch (e) {
        return JSON.stringify({ status: "error", message: String(e) });
      }
    }
  }
  return JSON.stringify({ status: "ok", accounts: accounts });
}`;

/** In-tab code returning the signed-in name from the dashboard ("Hi, NAME"), or "" if logged out. */
const PROBE_ACCOUNT_CODE = `(function () {
  try {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/student_dashboard", false);
    xhr.send(null);
    var m = /Hi,\\s*([^<&"]+?)\\s*[<&"]/i.exec(xhr.responseText || "");
    return m ? m[1] : "";
  } catch (e) { return ""; }
})()`;

const ScriptResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: z.string() }),
  z.object({ status: z.literal("error"), message: z.string() }),
  z.object({ status: z.literal("no-tab") }),
  z.object({ status: z.literal("no-account"), seen: z.array(z.string()) }),
]);

const InTabResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().optional(),
  url: z.string().optional(),
  body: z.string().optional(),
  error: z.string().optional(),
});

/** Marks of the CEdX login page, used to detect a logged-out session. */
const LOGIN_MARKERS = ["Please login to proceed", "Login with Google", 'name="password"'];

/**
 * Runs a same-origin request inside the logged-in CEdX tab.
 * Uses native XMLHttpRequest (with fallback to jQuery if present). Synchronous
 * because AppleScript's `execute javascript` cannot await promises.
 */
function buildInTabCode(method: string, url: string, data: Record<string, unknown> | undefined): string {
  return `(function () {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open(${JSON.stringify(method)}, ${JSON.stringify(url)}, false);
      xhr.withCredentials = true;
      var body = null;
      if (${JSON.stringify(method)} === "POST" && ${JSON.stringify(data)} != null) {
        var params = new URLSearchParams();
        var d = ${JSON.stringify(data ?? {})};
        for (var k in d) {
          if (d[k] !== undefined && d[k] !== null) params.append(k, String(d[k]));
        }
        xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        body = params.toString();
      }
      xhr.send(body);
      return JSON.stringify({ ok: true, status: xhr.status, url: xhr.responseURL || "", body: xhr.responseText || "" });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  })()`;
}

export interface CisResponse {
  status: number;
  url: string;
  body: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchWithSession(
  session: CisSession,
  url: string,
  options: { method?: "GET" | "POST"; data?: Record<string, unknown> } = {},
): Promise<CisResponse> {
  const method = options.method ?? (options.data ? "POST" : "GET");
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Cookie: cookieHeader(session),
    Referer: `${SITE_URL}/student_dashboard`,
  };

  let body: string | undefined = undefined;
  if (method === "POST" && options.data) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.data)) {
      if (v !== undefined && v !== null) params.append(k, String(v));
    }
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    body = params.toString();
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
    redirect: "follow",
  });

  // Track session cookie updates
  if (mergeSetCookies(session, res.headers.getSetCookie())) {
    await saveSession(session);
  }

  const text = await res.text();
  const finalUrl = res.url || url;

  if (
    /\/\?red=/.test(finalUrl) ||
    res.status === 401 ||
    res.status === 403 ||
    (LOGIN_MARKERS.some((m) => text.includes(m)) && text.length < 60_000)
  ) {
    throw new NotLoggedInError("Your saved CEdX session has expired. Call cis_login or run pnpm signin.");
  }

  return { status: res.status, url: finalUrl, body: text };
}

/**
 * Executes a request in an open Chrome tab via AppleScript (macOS fallback).
 */
async function cisRequestInTab(
  url: string,
  options: { method?: "GET" | "POST"; data?: Record<string, unknown>; account?: string } = {},
): Promise<CisResponse> {
  const code = buildInTabCode(options.method ?? "POST", url, options.data);

  let stdout: string;
  try {
    ({ stdout } = await run("osascript", ["-l", "JavaScript", "-e", FIND_TAB_SCRIPT, BROWSER_APP, SITE_HOST, code, options.account ?? "", PROBE_ACCOUNT_CODE], {
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/-1743|not authori[sz]ed/i.test(message)) {
      throw new Error(
        `macOS blocked controlling ${BROWSER_APP}. Allow it in System Settings → Privacy & Security → Automation, then retry.`,
      );
    }
    throw new Error(`Could not talk to ${BROWSER_APP}: ${message}`);
  }

  const outer = ScriptResultSchema.parse(JSON.parse(stdout));
  if (outer.status === "no-tab") throw new NoTabError();
  if (outer.status === "no-account") throw new AccountNotFoundError(options.account ?? "", outer.seen);
  if (outer.status === "error") {
    if (/Apple Events/i.test(outer.message)) throw new Error(APPLE_EVENTS_HINT);
    throw new Error(`${BROWSER_APP} refused the request: ${outer.message}`);
  }

  const inner = InTabResultSchema.parse(JSON.parse(outer.result));
  if (!inner.ok) throw new Error(inner.error ?? "Request failed inside the browser tab.");
  const body = inner.body ?? "";
  const finalUrl = inner.url ?? "";
  if (/\/\?red=/.test(finalUrl) || (LOGIN_MARKERS.some((m) => body.includes(m)) && body.length < 60_000)) {
    throw new NotLoggedInError();
  }
  return { status: inner.status ?? 0, url: finalUrl, body };
}

/**
 * Make a request to CEdX using the saved session credentials or through an open browser tab.
 * `path` is relative to the site root, e.g. "/index.php/student_info/get_tab_transcript_close".
 */
export async function cisRequest(
  path: string,
  options: { method?: "GET" | "POST"; data?: Record<string, unknown>; account?: string } = {},
): Promise<CisResponse> {
  const url = path.startsWith("http") ? path : `${SITE_URL}${path.startsWith("/") ? "" : "/"}${path}`;

  // If no specific browser account was requested, try saved session credentials first
  if (!options.account) {
    const session = await loadSession();
    if (session) {
      try {
        return await fetchWithSession(session, url, options);
      } catch (err) {
        if (!(err instanceof NotLoggedInError)) throw err;
        // Session expired, attempt browser fallback if available
      }
    }
  }

  // Fall back to open browser tab if on macOS
  if (process.platform === "darwin") {
    try {
      return await cisRequestInTab(url, options);
    } catch (tabErr) {
      if (options.account) throw tabErr;
      throw new NotLoggedInError("You are not logged in to CEdX. Call cis_login with username and password, or run pnpm signin.");
    }
  }

  throw new NotLoggedInError("You are not logged in to CEdX. Call cis_login with username and password, or run pnpm signin.");
}

/**
 * Lists the signed-in name of every open CEdX tab across all browser profiles
 * ("" means that tab is logged out). macOS only.
 */
export async function listAccounts(): Promise<string[]> {
  if (process.platform !== "darwin") {
    throw new Error("cis-mcp talks to CEdX through an open browser tab, which only works on macOS.");
  }
  let stdout: string;
  try {
    ({ stdout } = await run("osascript", ["-l", "JavaScript", "-e", LIST_ACCOUNTS_SCRIPT, BROWSER_APP, SITE_HOST, PROBE_ACCOUNT_CODE], {
      timeout: 30_000,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not talk to ${BROWSER_APP}: ${message}`);
  }
  const out = JSON.parse(stdout) as { status: string; accounts?: string[]; message?: string };
  if (out.status === "error") {
    if (/Apple Events/i.test(out.message ?? "")) throw new Error(APPLE_EVENTS_HINT);
    throw new Error(`${BROWSER_APP} refused the request: ${out.message}`);
  }
  return out.accounts ?? [];
}
