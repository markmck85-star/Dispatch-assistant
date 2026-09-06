/**
 * ADDITION to netlify/functions/mcp-server.js
 *
 * This is a snippet to merge into the existing tool list, not a
 * standalone file. Follows the same shape as your other four tools
 * (get_restock_status, get_recent_tickets, get_technician_availability,
 * get_watchdog_log) -- shared-secret auth check stays exactly as it is
 * in the existing file; this just adds one more tool + one more
 * fetch-and-forward case.
 */

// --- Add to the tool list sent in the tools/list response ---
const searchEmailsTool = {
  name: "search_emails",
  description:
    "Search inbound service emails (restocks, trouble tickets, shipping, site surveys) by keyword, site name/code, date range, or category. Returns cleaned message text (signatures/disclaimers/quoted replies stripped). Defaults to the most recent 20 matches if no date range is given.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search text -- a site code (e.g. GA1090), a colloquial site name (e.g. 'Thompson Bridge Kroger'), a WO number, or any keyword.",
      },
      state: {
        type: "string",
        enum: ["GA", "NC", "SC"],
        description: "Optional state filter.",
      },
      category: {
        type: "string",
        enum: ["trouble", "maintenance", "restock", "shipping", "site_survey"],
        description: "Optional category filter.",
      },
      date_from: { type: "string", description: "ISO date, optional." },
      date_to: { type: "string", description: "ISO date, optional." },
      limit: {
        type: "integer",
        description: "Max results, default 20, hard cap 100.",
      },
    },
    required: ["query"],
  },
};

// --- Add to wherever the existing tools are dispatched to their
//     underlying Netlify function (mirrors the existing pattern for
//     get_restock_status etc.) ---
async function handleSearchEmails(args, baseUrl) {
  const params = new URLSearchParams({ q: args.query });
  if (args.state) params.set("state", args.state);
  if (args.category) params.set("category", args.category);
  if (args.date_from) params.set("date_from", args.date_from);
  if (args.date_to) params.set("date_to", args.date_to);
  if (args.limit) params.set("limit", String(args.limit));

  const response = await fetch(`${baseUrl}/.netlify/functions/search-emails?${params}`);
  if (!response.ok) {
    throw new Error(`search-emails endpoint returned ${response.status}`);
  }
  return response.json();
}

// In the tool-call switch statement, add:
//   case "search_emails":
//     result = await handleSearchEmails(toolArgs, process.env.URL);
//     break;

module.exports = { searchEmailsTool, handleSearchEmails };
