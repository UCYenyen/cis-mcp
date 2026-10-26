import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE_URL = (process.env.CIS_SITE_URL ?? "https://student.ciputra.ac.id").replace(/\/+$/, "");
export const SITE_HOST = new URL(SITE_URL).host;

/** The user's everyday browser; requests reuse its open, logged-in CEdX tab. Any Chromium browser with AppleScript works. */
export const BROWSER_APP = process.env.CIS_BROWSER_APP ?? "Google Chrome";

export const CONFIG_DIR = process.env.CIS_CONFIG_DIR ?? join(homedir(), ".config", "cis-mcp");
export const SESSION_FILE = join(CONFIG_DIR, "session.json");
export const DOWNLOAD_DIR = process.env.CIS_DOWNLOAD_DIR ?? join(homedir(), "Downloads", "cis");

/** Universitas Ciputra is in WIB (UTC+7, no DST). */
export const TIMEZONE = "Asia/Jakarta";

/** Project root (one level above src/). */
export const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * When true, cis_book_room submits without the macOS confirmation dialog (for unattended,
 * scheduled bookings). Set "autoApproveBookings": true in cis.config.json at the project root,
 * or CIS_AUTO_APPROVE_BOOKINGS=1. Read on every call, so toggling the file needs no restart.
 */
export function autoApproveBookings(): boolean {
  if (process.env.CIS_AUTO_APPROVE_BOOKINGS === "1") return true;
  try {
    const cfg = JSON.parse(readFileSync(join(PROJECT_DIR, "cis.config.json"), "utf8")) as { autoApproveBookings?: unknown };
    return cfg.autoApproveBookings === true;
  } catch {
    return false;
  }
}
