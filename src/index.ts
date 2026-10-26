#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCoreTools } from "./tools.ts";
import { registerBookingTools } from "./booking.ts";

const server = new McpServer(
  { name: "cis", version: "0.1.0" },
  {
    instructions:
      "Access to the user's Ciputra CEdX student portal (student.ciputra.ac.id): academic transcript and class " +
      "schedule, via the user's open, logged-in browser tab. Read tools are safe to use. If a tool reports no tab " +
      "or a logged-out session, tell the user to open and sign in to CEdX in their browser. Times are in WIB (UTC+7). " +
      "Events/surveys/competitions and the student-assistant logbook are planned and not yet wired.",
  },
);

registerCoreTools(server);
registerBookingTools(server);

await server.connect(new StdioServerTransport());
