import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cisRequest } from "./chrome-tab.ts";
import { cellText, parseRows } from "./html.ts";
import { requireApproval } from "./approval.ts";
import { ACCOUNT_ARG, jsonResult } from "./tools.ts";
import { autoApproveBookings } from "./config.ts";

const COS = "f8c82c9f-65aa-11e5-96cc-0cc47a018ff3"; // Universitas Ciputra Surabaya
const MEETING_ROOM = "c4b4d976-1348-11e9-ac47-000d3aa02732"; // book_type that holds the library rooms
const STC = "73f170d9b96a7dcfefc70fcabbfbd6f6"; // static form token used by the booking page

/** Role -> { title_id, os_id } (from the booking page's title_os map). */
const ROLES: Record<string, { titleId: string; osId: string }> = {
  "Student S1": { titleId: "dfa22580-4c92-11e6-9f2d-0006f6e60e1a", osId: "25638a65-65ab-11e5-96cc-0cc47a018ff3" },
  "BAA Student Assistant": { titleId: "0d2935d2-bef3-11e9-8da5-000d3aa02732", osId: "d2dacd81-7bc6-11e5-88e1-0cc47a018ff1" },
};

const PURPOSES: Record<string, string> = {
  A: "Lecture (Class, Exam, Consultation, Mentoring)",
  B: "UKM",
  C: "Student Activity (Meeting, Competition, Commitee, etc)",
  D: "Major / Dept Activity",
  E: "Accreditation, Audit, Ranking, etc",
  F: "Room Maintenance",
  XXX: "Other",
};

interface Room {
  barcode: string;
  name: string;
  hourcode: string;
  bookwfcode: string;
  capacity: string;
}

function attr(optTag: string, name: string): string {
  const m = new RegExp(`${name}='([^']*)'`, "i").exec(optTag);
  return m ? (m[1] ?? "") : "";
}

async function getRooms(account?: string): Promise<Room[]> {
  const res = await cisRequest("/index.php/booking/getItemBarcode", { data: { cos_id: COS, item_id: MEETING_ROOM }, account });
  const rooms: Room[] = [];
  const re = /<option\b([\s\S]*?)>([^<]+)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(res.body))) {
    const tag = m[1] ?? "";
    const barcode = attr(tag, "value");
    if (!barcode) continue;
    rooms.push({
      barcode,
      name: cellText(m[2] ?? ""),
      hourcode: attr(tag, "hourcode"),
      bookwfcode: attr(tag, "bookwfcode"),
      capacity: attr(tag, "capacity"),
    });
  }
  return rooms;
}

/** A library room is one of the A225x discussion/study rooms. */
function isLibrary(r: Room): boolean {
  return /A22\d|Collaboration|Study Room|Discussion/i.test(r.name);
}

async function resolveRoom(query: string, account?: string): Promise<Room> {
  const rooms = await getRooms(account);
  const exact = rooms.find((r) => r.barcode === query);
  if (exact) return exact;
  const matches = rooms.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No room matches "${query}". Use cis_list_library_rooms to see names.`);
  throw new Error(`"${query}" matches several rooms: ${matches.map((r) => r.name).join(", ")}. Be more specific.`);
}

function weekday(dateYmd: string): string {
  return String(new Date(`${dateYmd}T00:00:00`).getDay()); // 0=Sun..6=Sat, matches the booking "day" select
}

export function registerBookingTools(server: McpServer): void {
  server.registerTool(
    "cis_list_library_rooms",
    {
      title: "List bookable rooms",
      description:
        "Lists the bookable library rooms (A225 Collaboration / Study rooms) with capacity. Set all=true to include every meeting room.",
      inputSchema: {
        all: z.boolean().default(false).describe("Include all meeting rooms, not just the library rooms"),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ all, account }) => {
      const rooms = await getRooms(account);
      const list = (all ? rooms : rooms.filter(isLibrary)).map((r) => ({
        room: r.name,
        capacity: Number(r.capacity) || r.capacity,
        barcode: r.barcode,
      }));
      return jsonResult({ rooms: list });
    },
  );

  server.registerTool(
    "cis_room_schedule",
    {
      title: "Room booking schedule",
      description:
        "Shows a room's booking schedule for a date: the time slots and which are already booked. Pass a room name (e.g. 'Collaboration Room') or its barcode.",
      inputSchema: {
        room: z.string().describe("Room name or barcode from cis_list_library_rooms"),
        date: z.string().describe("Date as YYYY-MM-DD"),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ room, date, account }) => {
      const r = await resolveRoom(room, account);
      const res = await cisRequest("/index.php/booking/get_booking_filter", {
        data: { cos_id: COS, book_type: MEETING_ROOM, book_name: r.barcode, start_date_filter: date },
        account,
      });
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(res.body) as Record<string, unknown>;
      } catch {
        throw new Error("Could not read the schedule response from CEdX.");
      }
      return jsonResult({
        room: r.name,
        date,
        slots: data["data_slot"],
        dates: data["data_date"],
        bookings: data["data_booking_filter"],
      });
    },
  );

  server.registerTool(
    "cis_my_bookings",
    {
      title: "My room bookings",
      description: "Lists your own room-booking requests and their status (from Booking Histories).",
      inputSchema: { account: ACCOUNT_ARG },
      annotations: { readOnlyHint: true },
    },
    async ({ account }) => {
      const res = await cisRequest("/index.php/booking_history/data", { method: "GET", account });
      const rows = parseRows(res.body, {});
      return jsonResult({
        note: rows.length ? undefined : "No rows parsed; the history may load in a view this tool can't read yet.",
        bookings: rows,
      });
    },
  );

  server.registerTool(
    "cis_book_room",
    {
      title: "Book a room",
      description:
        "Requests a room booking. Unless autoApproveBookings is on in cis.config.json, a native macOS confirmation dialog must be " +
        "approved first; if declined, nothing is booked. The request is submitted for Library approval (status 'waiting'). Times are the slot " +
        "boundaries shown by cis_room_schedule, e.g. 07:30:00. Students can only book today and tomorrow, max 2 slots per day per account; " +
        "pass `account` to book as another signed-in Chrome profile.",
      inputSchema: {
        room: z.string().describe("Room name or barcode"),
        date: z.string().describe("Date as YYYY-MM-DD"),
        slotStart: z.string().describe("Start slot, e.g. 07:30:00"),
        slotEnd: z.string().describe("End slot, e.g. 09:10:00"),
        need: z.string().describe("What the room is for (purpose/description)"),
        participant: z.number().int().positive().describe("Number of people"),
        purpose: z.enum(["A", "B", "C", "D", "E", "F", "XXX"]).default("C").describe("Purpose code; C = Student Activity"),
        role: z.enum(["Student S1", "BAA Student Assistant"]).default("Student S1"),
        equipment: z.string().default("").describe("Equipment needed, if any"),
        account: ACCOUNT_ARG,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ room, date, slotStart, slotEnd, need, participant, purpose, role, equipment, account }) => {
      const r = await resolveRoom(room, account);
      const title = ROLES[role]!;
      const day = weekday(date);

      // Overlap check first.
      const check = await cisRequest("/index.php/booking/check_booking", {
        data: {
          cos_id: COS,
          barcode_id: r.barcode,
          start_date: date,
          end_date: date,
          slot_start: slotStart,
          slot_end: slotEnd,
          day,
          id: "",
        },
        account,
      });

      const autoApproved = autoApproveBookings();
      const approved =
        autoApproved ||
        (await requireApproval({
        title: "CEdX: confirm room booking",
        confirmLabel: "Book",
        summary: `Book ${r.name} on ${date}, ${slotStart}–${slotEnd}?`,
        detail: `Purpose: ${PURPOSES[purpose]}\nFor: ${need}\nPeople: ${participant}\nAs: ${role}${account ? `\nAccount: ${account}` : ""}\n\nAvailability check: ${check.body.slice(0, 200)}`,
      }));
      if (!approved) {
        return jsonResult({ booked: false, cancelled: true, reason: "The confirmation dialog was not approved. Nothing was booked." });
      }

      const dataBooking: Record<string, unknown> = {
        stc: STC,
        cek_klik: "",
        item_id: MEETING_ROOM,
        barcode_id: r.barcode,
        title_id: title.titleId,
        purpose_code: purpose,
        participant: String(participant),
        need,
        equipment,
        start_date: date,
        end_date: date,
        day,
        slot_start: slotStart,
        slot_end: slotEnd,
        room_id: "",
        other_location: "",
        cos_id: COS,
        os_id: title.osId,
        item: MEETING_ROOM,
        hour_code: r.hourcode,
        trx_code: r.bookwfcode,
        active_status: 1,
      };

      const res = await cisRequest("/index.php/booking/submit_booking", {
        data: { data_booking: dataBooking, stc: STC, flagSubmit: "W" },
        account,
      });
      let result: unknown;
      try {
        result = JSON.parse(res.body);
      } catch {
        result = res.body.slice(0, 300);
      }
      const ok = Array.isArray(result) && result[0] === "ok";
      return jsonResult({
        booked: ok,
        account: account ?? undefined,
        autoApproved,
        room: r.name,
        date,
        slot: `${slotStart}-${slotEnd}`,
        status: ok ? "submitted for approval (waiting)" : "not booked",
        response: result,
      });
    },
  );
}
