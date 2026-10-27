import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cisRequest, cisUpload } from "./chrome-tab.ts";
import { cellText, decodeEntities } from "./html.ts";
import { requireApproval } from "./approval.ts";
import { ACCOUNT_ARG, jsonResult } from "./tools.ts";
import { autoApproveLogbook, TIMEZONE } from "./config.ts";

const LOGBOOK_PATH = "/student_assistant/logbook";
const MAX_FILE_BYTES = 2 * 1024 * 1024; // the form says "Max 2MB of any file"
const MAX_DAYS_BACK = 2; // the form says "max 2 days after the activities"

const MEDIA = ["Zoom", "WhatsApp", "Line", "Telegram", "Facebook", "Tatap Muka (Offline)", "Other"] as const;

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
};

interface Option {
  value: string;
  label: string;
}

interface Student {
  nis: string;
  name: string;
  field: string; // form field name, e.g. student[uuid]
}

interface HistoryRow {
  transactionNo: string;
  subject: string;
  log: string;
  media: string;
  activity: string;
  attachmentUrl?: string;
  status: string;
}

interface LogbookPage {
  stc: string;
  uploadUrl: string;
  classes: Option[];
  media: Option[];
  history: HistoryRow[];
}

function selectOptions(html: string, id: string): Option[] {
  const select = new RegExp(`<select[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</select>`, "i").exec(html);
  if (!select) return [];
  const out: Option[] = [];
  const re = /<option\b[^>]*\bvalue=["']([^"']*)["'][^>]*>([^<]*)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(select[1] ?? ""))) {
    if (m[1]) out.push({ value: m[1], label: cellText(m[2] ?? "") });
  }
  return out;
}

function parseHistory(html: string): HistoryRow[] {
  const body = /<tbody id=["']table_body["'][^>]*>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] ?? "";
  const rows: HistoryRow[] = [];
  for (const tr of body.split(/<\/tr>/i)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? "");
    if (tds.length < 7) continue;
    const href = /href=["']([^"']+)["']/i.exec(tds[5] ?? "")?.[1];
    rows.push({
      transactionNo: cellText(tds[0]!),
      subject: cellText(tds[1]!),
      log: cellText(tds[2]!),
      media: cellText(tds[3]!),
      activity: cellText(tds[4]!),
      attachmentUrl: href ? decodeEntities(href) : undefined,
      status: cellText(tds[6]!),
    });
  }
  return rows;
}

async function getLogbookPage(account?: string): Promise<LogbookPage> {
  const res = await cisRequest(LOGBOOK_PATH, { method: "GET", account });
  const form = res.body.slice(res.body.indexOf('id="logbook_form"'));
  const stc = /name=["']stc["']\s+value=["']([^"']+)["']/i.exec(form)?.[1];
  const uploadUrl = /id=["']_form_point_url["'][^>]*action=["']([^"']+)["']/i.exec(res.body)?.[1];
  if (!stc || !uploadUrl) {
    throw new Error("Could not read the logbook form. Your account may not be registered as a student assistant.");
  }
  return {
    stc,
    uploadUrl: decodeEntities(uploadUrl),
    classes: selectOptions(res.body, "class_id"),
    media: selectOptions(res.body, "media"),
    history: parseHistory(res.body),
  };
}

function todayWib(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function weekdayName(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

function resolveClass(classes: Option[], query: string): Option {
  const q = query.trim().toLowerCase();
  const exact = classes.find((c) => c.value === query.trim());
  if (exact) return exact;
  const matches = classes.filter((c) => c.label.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0]!;
  const names = classes.map((c) => c.label).join("; ");
  if (matches.length === 0) throw new Error(`No logbook class matches "${query}". Available: ${names || "none"}.`);
  throw new Error(`"${query}" matches several classes: ${matches.map((c) => c.label).join("; ")}. Be more specific.`);
}

function parseStudents(html: string): Student[] {
  const out: Student[] = [];
  const re = /<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td[^>]*>\s*<input[^>]*\bname=['"](student\[[^'"]+\])['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ nis: decodeEntities(m[1] ?? "").trim(), name: decodeEntities(m[2] ?? "").trim(), field: m[3]! });
  return out;
}

/** Looks up the class's schedule slots and student list, the same call the form makes when a class is picked. */
async function getPertemuan(classId: string, account?: string): Promise<{ slotStart: string; slotEnd: string; students: Student[] }> {
  const res = await cisRequest("/index.php/student_assistant/get_pertemuan", { data: { id: classId }, account });
  let data: { schedule?: { slot_start?: string; slot_end?: string }; students?: string };
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error("Could not read the class details from CEdX.");
  }
  const slotStart = data.schedule?.slot_start;
  const slotEnd = data.schedule?.slot_end;
  if (!slotStart || !slotEnd) throw new Error("CEdX returned no schedule for this class.");
  return { slotStart, slotEnd, students: parseStudents(data.students ?? "") };
}

/** The portal's own validation; returns an error message, or "" when the entry is acceptable. */
async function checkEverything(
  p: { classId: string; date: string; slotStart: string; slotEnd: string; studentCount: number },
  account?: string,
): Promise<string> {
  const res = await cisRequest("/index.php/student_assistant/check_everything", {
    data: { id: p.classId, date: p.date, slot_start: p.slotStart, slot_end: p.slotEnd, student_length: p.studentCount },
    account,
  });
  let msg: unknown;
  try {
    msg = JSON.parse(res.body);
  } catch {
    msg = res.body;
  }
  return typeof msg === "string" ? cellText(msg.replace(/<br\s*\/?>/gi, " ")) : "";
}

function pickAbsent(students: Student[], absent: string[]): Student[] {
  const out: Student[] = [];
  for (const a of absent) {
    const q = a.trim().toLowerCase();
    const hits = students.filter((s) => s.nis === a.trim() || s.name.toLowerCase().includes(q));
    if (hits.length !== 1) {
      throw new Error(
        hits.length === 0
          ? `No student matches "${a}" in this class.`
          : `"${a}" matches several students (${hits.map((h) => h.name).join(", ")}). Use the NIS or a longer name.`,
      );
    }
    out.push(hits[0]!);
  }
  return out;
}

export function registerLogbookTools(server: McpServer): void {
  server.registerTool(
    "cis_logbook_classes",
    {
      title: "Student assistant logbook: classes",
      description:
        "Lists the classes you can write a Student Assistant logbook entry for (class id, subject, day, time) and the media options. " +
        "Entries can be made once per class per date, up to 2 days after the activity.",
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ account }) => {
      const page = await getLogbookPage(account);
      return jsonResult({
        classes: page.classes.map((c) => ({ id: c.value, class: c.label })),
        media: page.media.map((m) => m.label),
      });
    },
  );

  server.registerTool(
    "cis_logbook_history",
    {
      title: "Student assistant logbook: history",
      description: "Lists your submitted Student Assistant logbook entries with transaction no., subject, date/time, media, activity, attachment link and approval status.",
      inputSchema: {
        limit: z.number().int().positive().default(20).describe("How many of the most recent entries to return"),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, account }) => {
      const page = await getLogbookPage(account);
      const entries = [...page.history].reverse().slice(0, limit); // the portal lists oldest first
      return jsonResult({ total: page.history.length, entries });
    },
  );

  server.registerTool(
    "cis_logbook_submit",
    {
      title: "Submit a student assistant logbook entry",
      description:
        "Submits a Student Assistant logbook entry for a class: uploads the attachment, then submits the form with every student marked present " +
        "(list `absentStudents` to untick some). The class's scheduled slots are used. Rules enforced by CEdX: one entry per class per date, " +
        "weekdays only, up to 2 days after the activity, attachment max 2MB. Unless autoApproveLogbook is on in cis.config.json " +
        "(or CIS_AUTO_APPROVE_LOGBOOK=1), a native macOS confirmation dialog must be approved first. The upload needs a saved login (cis_login). " +
        "Use dryRun to validate everything without uploading or submitting. After submitting, the history is re-read to confirm the entry exists.",
      inputSchema: {
        class: z.string().describe("Class name or id from cis_logbook_classes, e.g. 'Basic Programming'"),
        activity: z.string().min(1).max(1000).describe("What was done in the class"),
        attachmentPath: z.string().describe("Path to a local jpg/png/pdf file (max 2MB), e.g. a photo of the class"),
        date: z.string().optional().describe("Date as YYYY-MM-DD; defaults to today (WIB)"),
        media: z.enum(MEDIA).default("Tatap Muka (Offline)").describe("How the class was held"),
        absentStudents: z.array(z.string()).default([]).describe("Names or NIS of students to leave unticked; everyone else is marked present"),
        dryRun: z.boolean().default(false).describe("Validate only: nothing is uploaded or submitted"),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ class: classQuery, activity, attachmentPath, date, media, absentStudents, dryRun, account }) => {
      const day = date ?? todayWib();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Date must be YYYY-MM-DD, got "${day}".`);
      const age = daysBetween(day, todayWib());
      if (age < 0) throw new Error(`${day} is in the future; a logbook entry can only be made after the activity.`);
      if (age > MAX_DAYS_BACK) throw new Error(`${day} is ${age} days ago; CEdX only accepts entries up to ${MAX_DAYS_BACK} days after the activity.`);
      const weekday = weekdayName(day);
      if (weekday === "Saturday" || weekday === "Sunday") throw new Error(`${day} is a ${weekday}; CEdX only accepts weekdays.`);

      // Attachment checks come first so nothing is touched when the file is unusable.
      const ext = extname(attachmentPath).toLowerCase();
      const mime = MIME[ext];
      if (!mime) throw new Error(`Attachment must be a jpg, png or pdf file, got "${ext || "no extension"}".`);
      const info = await stat(attachmentPath).catch(() => null);
      if (!info?.isFile()) throw new Error(`Attachment not found: ${attachmentPath}`);
      if (info.size > MAX_FILE_BYTES) throw new Error(`Attachment is ${(info.size / 1048576).toFixed(1)}MB; CEdX allows at most 2MB.`);

      const page = await getLogbookPage(account);
      const cls = resolveClass(page.classes, classQuery);
      const mediaOpt = page.media.find((m) => m.label === media);
      if (!mediaOpt) throw new Error(`CEdX has no media option "${media}".`);
      const { slotStart, slotEnd, students } = await getPertemuan(cls.value, account);
      const absent = pickAbsent(students, absentStudents);
      const present = students.filter((s) => !absent.includes(s));

      const problem = await checkEverything({ classId: cls.value, date: day, slotStart, slotEnd, studentCount: present.length }, account);
      if (problem) return jsonResult({ submitted: false, reason: problem, class: cls.label, date: day });

      const plan = {
        class: cls.label,
        date: `${day} (${weekday})`,
        media,
        activity,
        attachment: `${basename(attachmentPath)} (${Math.round(info.size / 1024)} KB)`,
        studentsPresent: present.length,
        studentsAbsent: absent.map((s) => s.name),
      };
      if (dryRun) return jsonResult({ submitted: false, dryRun: true, valid: true, plan });

      const autoApproved = autoApproveLogbook();
      const approved =
        autoApproved ||
        (await requireApproval({
          title: "CEdX: confirm logbook entry",
          confirmLabel: "Submit",
          summary: `Submit a logbook entry for ${cls.label} on ${day}?`,
          detail: `Media: ${media}\nActivity: ${activity}\nAttachment: ${plan.attachment}\nStudents present: ${present.length}${absent.length ? ` (absent: ${plan.studentsAbsent.join(", ")})` : ""}`,
        }));
      if (!approved) {
        return jsonResult({
          submitted: false,
          cancelled: true,
          reason: autoApproved
            ? "Not approved."
            : "The confirmation dialog was not approved (or could not be shown on this machine; set autoApproveLogbook in cis.config.json or CIS_AUTO_APPROVE_LOGBOOK=1 to submit without it). Nothing was submitted.",
        });
      }

      // 1. Upload the attachment; CEdX returns the stored filename.
      const upload = await cisUpload(page.uploadUrl, "_inp_point_url", {
        name: basename(attachmentPath),
        type: mime,
        bytes: await readFile(attachmentPath),
      });
      let uploaded: { status?: string; filename?: string } = {};
      try {
        uploaded = JSON.parse(upload.body);
      } catch {
        // handled below
      }
      if (uploaded.status !== "success" || !uploaded.filename) {
        throw new Error(`Attachment upload failed: ${upload.body.slice(0, 200)}`);
      }

      // 2. Submit the form, exactly as the page does.
      const fields: Record<string, unknown> = {
        stc: page.stc,
        class_id: cls.value,
        date: day,
        slot_start: slotStart,
        slot_end: slotEnd,
        media: mediaOpt.value,
        activity,
        point_url: uploaded.filename,
      };
      for (const s of present) fields[s.field] = "1";
      await cisRequest(LOGBOOK_PATH, { method: "POST", data: fields, account });

      // 3. Confirm by finding the new row in the history.
      const code = cls.label.split(/\s+/)[0]!;
      const before = new Set(page.history.map((h) => h.transactionNo));
      const after = (await getLogbookPage(account)).history;
      const created = after.find((h) => !before.has(h.transactionNo) && h.subject.includes(code));
      if (!created) {
        return jsonResult({
          submitted: false,
          unconfirmed: true,
          reason: "The form was sent but no new entry appeared in the history. Check cis_logbook_history before trying again, so you do not create a duplicate.",
          plan,
        });
      }
      return jsonResult({ submitted: true, autoApproved, transactionNo: created.transactionNo, status: created.status, log: created.log, plan });
    },
  );
}
