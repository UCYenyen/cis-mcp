import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { BROWSER_APP, SITE_HOST, SITE_URL } from "./config.ts";

const run = promisify(execFile);

const OPEN_TAB_HINT =
  `Open ${SITE_URL} in ${BROWSER_APP} and sign in (an already logged-in tab is fine), then try again.`;
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
  constructor() {
    super(`Your CEdX session looks logged out. ${OPEN_TAB_HINT}`);
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
    var m = /Hi,\\s*([^<]+?)\\s*</i.exec(xhr.responseText || "");
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

/**
 * Make a request to CEdX through the user's logged-in browser tab.
 * `path` is relative to the site root, e.g. "/index.php/student_info/get_tab_transcript_close".
 * macOS only (uses AppleScript).
 */
export async function cisRequest(
  path: string,
  options: { method?: "GET" | "POST"; data?: Record<string, unknown>; account?: string } = {},
): Promise<CisResponse> {
  if (process.platform !== "darwin") {
    throw new Error("cis-mcp talks to CEdX through an open browser tab, which only works on macOS.");
  }
  const url = path.startsWith("http") ? path : `${SITE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
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
