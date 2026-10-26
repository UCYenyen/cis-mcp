import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { SESSION_FILE, SITE_URL } from "./config.ts";

export const CisSessionSchema = z.object({
  siteUrl: z.string().default(SITE_URL),
  ciSession: z.string().min(1),
  /** Every cookie the portal has set (ci_session, tokencis, reddata, ...). Login state lives in tokencis. */
  cookies: z.record(z.string(), z.string()).default({}),
  username: z.string(),
  fullName: z.string(),
  createdAt: z.string(),
});

export type CisSession = z.infer<typeof CisSessionSchema>;

/** Builds the Cookie header from all stored cookies, falling back to ci_session alone for old session files. */
export function cookieHeader(session: CisSession): string {
  const jar = { ci_session: session.ciSession, ...session.cookies };
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Merges Set-Cookie headers into the session. Returns true when anything changed. */
export function mergeSetCookies(session: CisSession, setCookies: string[]): boolean {
  let changed = false;
  for (const c of setCookies) {
    const pair = c.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (session.cookies[name] === value) continue;
    session.cookies[name] = value;
    if (name === "ci_session") session.ciSession = value;
    changed = true;
  }
  return changed;
}

export async function saveSession(session: CisSession): Promise<void> {
  await mkdir(dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function loadSession(): Promise<CisSession | null> {
  try {
    const raw = await readFile(SESSION_FILE, "utf8");
    const parsed = CisSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await rm(SESSION_FILE, { force: true });
  } catch {
    // Ignore errors when deleting session
  }
}
