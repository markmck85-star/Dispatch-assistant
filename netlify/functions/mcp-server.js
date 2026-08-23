// mcp-server.js
//
// Remote MCP server for the MCR dispatch platform -- built for Mark's and
// Gina's Claude custom connectors. GA/NC/SC scope for v1.
//
// This wraps existing, already-public read-only Netlify functions
// (get-restock-schedule.js, get-state-console.js, get-watchdog-log.js) by
// calling their handlers directly in-process rather than round-tripping
// over HTTP to ourselves. Those underlying endpoints stay exactly as they
// are -- public GET, no auth -- this function is the only thing that
// checks the shared secret.
//
// Auth: shared secret, checked two ways so it works both from curl/testing
// (an 'x-mcr-secret' header) and from Claude's custom-connector UI, which
// does not let a personal claude.ai account attach custom headers to a
// remote MCP connector -- only a URL. So in practice the secret gets
// embedded as a query param on the connector URL itself, e.g.
//   https://mcrdispatch.net/.netlify/functions/mcp-server?key=<secret>
// Both paths are checked; either satisfies auth.
//
// Transport: hand-rolled JSON-RPC 2.0 over a single POST endpoint,
// responding with a plain JSON body (not SSE) -- this is spec-compliant
// for a stateless server with no need to push multiple/async messages per
// request, which fits a Netlify function fine. No Mcp-Session-Id is
// issued; each request is handled independently.

const getRestockSchedule = require('./get-restock-schedule.js');
const getStateConsole = require('./get-state-console.js');
const getWatchdogLog = require('./get-watchdog-log.js');

const SERVER_NAME = 'mcr-dispatch';
const SERVER_VERSION = '0.1.0';
const ALLOWED_STATES = ['GA', 'NC', 'SC'];

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-mcr-secret',
    },
    body: JSON.stringify(obj),
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Wraps a tool's return value as MCP tool-call content. `data` is
// JSON-stringified into a single text block -- simplest thing that works
// for Claude to read structured data back out of.
function toolText(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Invokes another Netlify function's handler in-process (same trick as
// calling it over HTTP, without the network hop) and parses its JSON body.
async function callHandler(fn, queryStringParameters) {
  const res = await fn.handler({ httpMethod: 'GET', queryStringParameters });
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = { error: 'non-JSON response from wrapped function' };
  }
  return { statusCode: res.statusCode, body };
}

function validateState(args) {
  const state = (args && args.state || '').toUpperCase();
  if (!state) return { error: 'state is required' };
  if (!ALLOWED_STATES.includes(state)) {
    return { error: `state must be one of ${ALLOWED_STATES.join(', ')} (v1 scope)` };
  }
  return { state };
}

// ── Tool definitions (JSON Schema) ──────────────────────────────────────
const TOOLS = [
  {
    name: 'get_restock_status',
    description:
      'Restock/consumables status per site for GA, NC, or SC -- cycle-based overdue/due-soon/on-track, wrapping get-restock-schedule.js. Omit state for all three.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'GA, NC, or SC. Omit for all three.' },
        since: { type: 'string', description: 'YYYY-MM-DD, optional history-window start' },
        until: { type: 'string', description: 'YYYY-MM-DD, optional history-window end' },
      },
    },
  },
  {
    name: 'get_recent_tickets',
    description:
      'Recent trouble tickets for one state (GA, NC, or SC), with open/closed status inferred from the closed-ticket import. Wraps the ticket portion of get-state-console.js.',
    inputSchema: {
      type: 'object',
      properties: { state: { type: 'string', description: 'GA, NC, or SC' } },
      required: ['state'],
    },
  },
  {
    name: 'get_technician_availability',
    description:
      "Today's technician availability for one state (GA, NC, or SC). Wraps the technician portion of get-state-console.js.",
    inputSchema: {
      type: 'object',
      properties: { state: { type: 'string', description: 'GA, NC, or SC' } },
      required: ['state'],
    },
  },
  {
    name: 'get_watchdog_log',
    description:
      'Open trouble/install/site_survey tickets the SMS watchdog would alert on, for one state (GA, NC, or SC) -- mirrors the watchdog text content. Wraps get-watchdog-log.js.',
    inputSchema: {
      type: 'object',
      properties: { state: { type: 'string', description: 'GA, NC, or SC' } },
      required: ['state'],
    },
  },
  {
    name: 'search_emails',
    description:
      'NOT YET IMPLEMENTED. Will full-text search inbound_emails (~3,020 emails since May 16) with quoted-reply/signature/disclaimer stripping.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'opportunistic_restock_near',
    description:
      'NOT YET IMPLEMENTED. Will combine the distance matrix with the restock-threshold model to answer what is restock-overdue within N miles of a given site.',
    inputSchema: {
      type: 'object',
      properties: {
        site_code: { type: 'string' },
        radius_miles: { type: 'number' },
      },
      required: ['site_code', 'radius_miles'],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'get_restock_status': {
      const state = (args && args.state || '').toUpperCase();
      if (state && !ALLOWED_STATES.includes(state)) {
        return toolError(`state must be one of ${ALLOWED_STATES.join(', ')} (v1 scope)`);
      }
      const qs = {};
      if (state) qs.state = state;
      if (args && args.since) qs.since = args.since;
      if (args && args.until) qs.until = args.until;
      const { statusCode, body } = await callHandler(getRestockSchedule, qs);
      if (statusCode !== 200) return toolError(body.error || 'get_restock_status failed');
      return toolText(body);
    }
    case 'get_recent_tickets': {
      const v = validateState(args);
      if (v.error) return toolError(v.error);
      const { statusCode, body } = await callHandler(getStateConsole, { state: v.state });
      if (statusCode !== 200) return toolError(body.error || 'get_recent_tickets failed');
      return toolText({
        state: v.state,
        recentTickets: body.recentTickets,
        lastImportedAt: body.lastImportedAt,
        generatedAt: body.generatedAt,
      });
    }
    case 'get_technician_availability': {
      const v = validateState(args);
      if (v.error) return toolError(v.error);
      const { statusCode, body } = await callHandler(getStateConsole, { state: v.state });
      if (statusCode !== 200) return toolError(body.error || 'get_technician_availability failed');
      return toolText({ state: v.state, date: body.date, technicians: body.technicians });
    }
    case 'get_watchdog_log': {
      const v = validateState(args);
      if (v.error) return toolError(v.error);
      const { statusCode, body } = await callHandler(getWatchdogLog, { state: v.state });
      if (statusCode !== 200) return toolError(body.error || 'get_watchdog_log failed');
      return toolText({ state: v.state, entries: body.entries });
    }
    case 'search_emails':
      return toolError('search_emails is not implemented yet -- coming in the next build pass.');
    case 'opportunistic_restock_near':
      return toolError('opportunistic_restock_near is not implemented yet -- design still open (see restock-threshold-analysis).');
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function checkAuth(event) {
  const expected = process.env.MCR_MCP_SHARED_SECRET;
  if (!expected) return false; // fail closed if not configured
  const headerVal = event.headers && (event.headers['x-mcr-secret'] || event.headers['X-Mcr-Secret']);
  const queryVal = event.queryStringParameters && event.queryStringParameters.key;
  return headerVal === expected || queryVal === expected;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonResponse(200, {});
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method Not Allowed' });

  if (!checkAuth(event)) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  let req;
  try {
    req = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, rpcError(null, -32700, 'Parse error'));
  }

  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
        return jsonResponse(200, rpcResult(id, result));
      }
      case 'notifications/initialized':
        return jsonResponse(202, {});
      case 'ping':
        return jsonResponse(200, rpcResult(id, {}));
      case 'tools/list':
        return jsonResponse(200, rpcResult(id, { tools: TOOLS }));
      case 'tools/call': {
        const toolResult = await callTool(params && params.name, params && params.arguments);
        return jsonResponse(200, rpcResult(id, toolResult));
      }
      default:
        if (isNotification) return jsonResponse(202, {});
        return jsonResponse(200, rpcError(id, -32601, `Method not found: ${method}`));
    }
  } catch (e) {
    if (isNotification) return jsonResponse(202, {});
    return jsonResponse(200, rpcError(id, -32603, `Internal error: ${e.message}`));
  }
};
