import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { SESSION_FILE, SITE_URL } from "./config.ts";

export const CisSessionSchema = z.object({
  siteUrl: z.string().default(SITE_URL),
  ciSession: z.string().min(1),
  username: z.string(),
  fullName: z.string(),
  createdAt: z.string(),
});

export type CisSession = z.infer<typeof CisSessionSchema>;

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
