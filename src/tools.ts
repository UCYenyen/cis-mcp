import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cisRequest, listAccounts } from "./chrome-tab.ts";
import { firstMatch, parseRows } from "./html.ts";

/** Optional account selector shared by every tool. */
export const ACCOUNT_ARG = z
  .string()
  .optional()
  .describe(
    "Which CEdX account to act as, matched against the signed-in name of each open CEdX tab (case-insensitive, partial match, e.g. 'Marsha'). " +
      "Use when several Chrome profiles are signed in. Omit to use the first CEdX tab found. cis_status lists the names.",
  );

export function jsonResult(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function num(s: string | undefined): number | null {
  if (s == null) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function registerCoreTools(server: McpServer): void {
  server.registerTool(
    "cis_status",
    {
      title: "CEdX login status",
      description:
        "Checks that an open, logged-in CEdX tab (student.ciputra.ac.id) is reachable in the user's browser and returns the signed-in name. " +
        "Also lists every signed-in account across Chrome profiles; pass one of those names (or part of it) as `account` to other tools to act as that account. " +
        "Run this first if other tools report no tab or a logged-out session.",
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ account }) => {
      const accounts = (await listAccounts()).filter((a) => a !== "");
      const res = await cisRequest("/student_dashboard", { method: "GET", account });
      const name = firstMatch(res.body, /Hi,\s*([^<]+?)\s*</i);
      return jsonResult({ loggedIn: true, name: name ?? undefined, signedInAccounts: accounts });
    },
  );

  server.registerTool(
    "cis_get_transcript",
    {
      title: "Academic transcript",
      description:
        "Returns the full academic transcript (every subject with code, period, credits, grade, grade quality) plus computed cumulative GPA and credits. Grades marked 'T' are in progress.",
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ account }) => {
      const res = await cisRequest("/index.php/student_info/get_tab_transcript_close", { account });
      const rows = parseRows(res.body, { tableId: "score_table" });
      const courses = rows
        .filter((r) => r.length >= 4 && /^[A-Z]{2,}\d/.test(r[0] ?? ""))
        .map((r) => {
          const credits = num(r[3]);
          const grade = r.length >= 6 ? r[4] : undefined;
          const quality = r.length >= 6 ? num(r[5]) : null;
          return {
            code: r[0],
            name: r[1],
            period: r[2],
            credits,
            grade: grade || undefined,
            gradeQuality: quality,
            inProgress: grade === "T" || grade === "" || grade == null,
          };
        });

      let qSum = 0;
      let cSum = 0;
      let passedCredits = 0;
      for (const c of courses) {
        if (c.inProgress || c.credits == null || c.gradeQuality == null) continue;
        qSum += c.gradeQuality;
        cSum += c.credits;
        passedCredits += c.credits;
      }
      const gpa = cSum > 0 ? Number((qSum / cSum).toFixed(2)) : null;
      return jsonResult({
        courses,
        summary: {
          totalSubjects: courses.length,
          gradedCredits: cSum,
          passedCredits,
          cumulativeGpa: gpa,
          note: "GPA is computed from graded subjects only (grade 'T' = in progress, excluded).",
        },
      });
    },
  );

  server.registerTool(
    "cis_get_schedule",
    {
      title: "Class schedule",
      description:
        "Returns this week's class schedule: subject code and name, class, day, date, start/end time, and room, for the current study period.",
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ account }) => {
      const res = await cisRequest("/index.php/student_info/get_tab_schedule", { account });
      const period = firstMatch(res.body, /<option value="[^"]*"\s+selected>([^<]+)<\/option>/i);
      const weekStart = firstMatch(res.body, /name="first_date"\s+value="([^"]+)"/i);
      const rows = parseRows(res.body, { tbodyId: "schedule_body" });
      const classes = rows
        .filter((r) => r.length >= 6)
        .map((r) => {
          const when = r[4] ?? "";
          const date = firstMatch(when, /(\d{4}-\d{2}-\d{2})/);
          const time = firstMatch(when, /(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/);
          return {
            code: r[0],
            name: r[1],
            class: r[2],
            day: r[3],
            date,
            time: time ? time.replace(/\s*-\s*/, " - ") : undefined,
            room: r[5],
          };
        });
      return jsonResult({ period: period ?? undefined, weekStartDate: weekStart ?? undefined, classes });
    },
  );
}
