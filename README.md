# cis-mcp

MCP server for the **Ciputra CEdX student portal** (https://student.ciputra.ac.id).

Log in once with your CEdX username and password (saved securely to `~/.config/cis-mcp/session.json`, permissions `600`), or seamlessly fall back to an open, logged-in CEdX tab in Google Chrome.

## Setup

```bash
pnpm install
pnpm signin   # prompts for your CEdX username and password
```

You can also log in directly via the MCP tool: ask your assistant to call `cis_login` with your username and password.

To log out and remove the saved session:

```bash
pnpm signout
```

### Register with MCP Clients

Point at `src/index.ts` with Node >= 22.18:

```json
{
  "mcpServers": {
    "cis": { "command": "node", "args": ["/absolute/path/to/cis-mcp/src/index.ts"] }
  }
}
```

## Tools (v0.1)

| Tool | What it does |
| --- | --- |
| `cis_login` | Log in with CEdX username and password (saves persistent session) |
| `cis_status` | Confirms login status and returns your signed-in name |
| `cis_get_transcript` | Full transcript (code, period, credits, grade, grade quality) + computed cumulative GPA |
| `cis_get_schedule` | This week's class schedule (subject, class, day, date, time, room) for the current period |
| `cis_list_library_rooms` | Bookable library rooms (A225 Collaboration/Study rooms) with capacity |
| `cis_room_schedule` | A room's booking schedule for a date: slots and which are already booked |
| `cis_my_bookings` | Your own room-booking requests and their status |
| `cis_book_room` | Request a room booking (submitted for approval). Asks for a macOS confirmation first |

## Multiple accounts (Chrome profiles)

Every tool takes an optional `account`, matched (case-insensitive, partial) against the signed-in
name of each open CEdX tab. Open CEdX in each Chrome profile you want to use; `cis_status` lists
the names it can see. Omit `account` to use the first CEdX tab found.

## Unattended bookings

`cis.config.json` at the project root with `"autoApproveBookings": true` (or
`CIS_AUTO_APPROVE_BOOKINGS=1`) makes `cis_book_room` submit without the macOS dialog. Read on every
call, so set it back to `false` to restore the dialog.

## Notes

- `cis_book_room` is a write and goes through the room approval workflow. The first real booking should be watched: approve the dialog, then check `cis_my_bookings` to confirm it registered.

## Planned (not yet wired)

- `cis_list_events` / `cis_list_surveys` / `cis_list_competitions` and a `cis_check_updates`
  tool that reports only items new since the last check (the basis for notifications).
- `cis_submit_logbook` for the student-assistant logbook, gated behind a native macOS
  confirmation dialog (same pattern as elearn's submit). The portal page/endpoint for the
  logbook still needs to be located before this can be implemented.

## How it authenticates

`src/chrome-tab.ts` finds a tab whose host is `student.ciputra.ac.id` in the configured browser
and runs a synchronous same-origin `jQuery.ajax` request inside it, returning the response body
to parse. Because it runs in the page, cookies and CodeIgniter CSRF handling are inherited.

## Environment overrides

`CIS_SITE_URL`, `CIS_CONFIG_DIR`, `CIS_DOWNLOAD_DIR`, `CIS_BROWSER_APP` (default `Google Chrome`).

## Security notes

- Requests only ever run against `student.ciputra.ac.id`, in your own browser session.
- No password or token is stored. Close the CEdX tab or sign out to cut access.
