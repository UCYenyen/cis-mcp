import { execFile } from "node:child_process";

export interface ApprovalRequest {
  title: string;
  summary: string;
  detail?: string;
  confirmLabel: string;
}

const TIMEOUT_SECONDS = 180;

function asLiteral(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Native macOS confirmation the user must click before any write to CEdX (e.g. a logbook
 * submission). Returns true ONLY on an explicit confirm. A cancel, the Escape key, a timeout,
 * or any failure to show the dialog all return false, so nothing is ever submitted without a
 * deliberate human click. Not bypassable from tool arguments.
 */
export function requireApproval(req: ApprovalRequest): Promise<boolean> {
  const lines = [req.summary];
  if (req.detail) lines.push("", req.detail);
  lines.push("", "This submits to CEdX (student.ciputra.ac.id) as you.");
  const message = lines.join("\n");

  const script =
    `tell application "System Events"\n` +
    `  activate\n` +
    `  set theResult to display dialog ${asLiteral(message)} ` +
    `with title ${asLiteral(req.title)} ` +
    `buttons {"Cancel", ${asLiteral(req.confirmLabel)}} ` +
    `default button "Cancel" cancel button "Cancel" ` +
    `with icon caution giving up after ${TIMEOUT_SECONDS}\n` +
    `  if gave up of theResult then return "__GAVEUP__"\n` +
    `  return button returned of theResult\n` +
    `end tell`;

  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.trim() === req.confirmLabel);
    });
  });
}
