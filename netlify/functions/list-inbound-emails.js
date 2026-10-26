/**
 * list-inbound-emails.js — 2026-10-26 (AR and MS added: state codes, full-name inference from "Component: Arkansas OTC")
 *
 * Read-only inbox feed over inbound_emails for inbound-mail.html.
 * No send. Filters: mailbox (classified_as group), inferred state, text query.
 *
 * GET /.netlify/functions/list-inbound-emails?mailbox=trouble&state=GA&query=00153214&limit=50
 * -> { ok, emails: [{ id, sender, subject, receivedAt, classifiedAs, parseStatus,
 *                     mailbox, inferredState, bodySnippet, truncated }] }
 */
const { createClient } = require("@supabase/supabase-js");

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;
const MAX_SNIPPET_CHARS = 900;

const MAILBOXES = {
  trouble: ["trouble"],
  dispatch: ["dispatch_list"],
  restock: ["restock_sameday"],
  maintenance: ["maintenance"],
  rma: ["rma_shipping"],
  notes: ["closing_note_email", "reply"],
  other: ["unknown"],
};

const STATE_CODES = [
  "AL", "AR", "CA", "CO", "FL", "GA", "ID", "IL", "IN", "MI", "MN", "MS", "NC", "NV", "OH", "OR", "SC", "WV",
];

// Service-response emails name the state in words ("Component: Arkansas OTC"), with no state code.
const STATE_NAMES = {
  AL: "Alabama", AR: "Arkansas", CA: "California", CO: "Colorado", FL: "Florida", GA: "Georgia",
  ID: "Idaho", IL: "Illinois", IN: "Indiana", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  NC: "North Carolina", NV: "Nevada", OH: "Ohio", OR: "Oregon", SC: "South Carolina", WV: "West Virginia",
};
const NAME_TO_CODE = Object.fromEntries(Object.entries(STATE_NAMES).map(([c, n]) => [n.toLowerCase(), c]));

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

function stripQuotedChain(text) {
  let t = text;
  const cutMarkers = [
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*-{2,}\s*Forwarded message\s*-{2,}/i,
    /\nOn .{0,80} wrote:\s*\n/i,
    /\n\s*From:.*\n\s*Sent:.*\n\s*To:.*\n\s*Subject:/i,
    /\nBegin forwarded message:/i,
  ];
  for (const m of cutMarkers) {
    const idx = t.search(m);
    if (idx !== -1) t = t.slice(0, idx);
  }
  return t.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
}

function stripSignatureAndDisclaimer(text) {
  let t = text;
  const sigMarkers = [
    /\n--\s*\n/,
    /\nThis email and any files transmitted/i,
    /\nCONFIDENTIALITY NOTICE/i,
    /\nThis message (is|contains) confidential/i,
    /\nPlease [Rr]eply [Aa]ll to this email/i,
    /\nSent from my (i?Phone|i?Pad|Android|Galaxy)/i,
  ];
  for (const m of sigMarkers) {
    const idx = t.search(m);
    if (idx !== -1) t = t.slice(0, idx);
  }
  return t.trim();
}

function cleanBody(bodyText, bodyHtmlFallback, maxChars) {
  const cap = maxChars || MAX_SNIPPET_CHARS;
  let t = (bodyText || "").trim();
  if (!t && bodyHtmlFallback) {
    t = bodyHtmlFallback.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (!t) return { snippet: "", truncated: false };
  t = stripQuotedChain(t);
  t = stripSignatureAndDisclaimer(t);
  t = t.trim();
  const truncated = t.length > cap;
  return { snippet: truncated ? t.slice(0, cap) + "…" : t, truncated };
}

function inferState(row) {
  const hay = [row.subject, row.sender, row.body_text].filter(Boolean).join(" \n ");
  // Prefer an embedded site code (GA1016) over a bare "GA -" account prefix.
  const code = hay.match(/\b([A-Z]{2})\d{3,5}\b/);
  if (code && STATE_CODES.includes(code[1])) return code[1];
  const loc = hay.match(/\bLocation:\s*([A-Z]{2})\b/i) || hay.match(/\b([A-Z]{2})\s*[-–]\s+/);
  if (loc && STATE_CODES.includes(loc[1].toUpperCase())) return loc[1].toUpperCase();
  const comp = hay.match(/\bComponent:\s*([A-Za-z ]+?)\s+(?:OTC|PM|Testing|SST)\b/i);
  if (comp && NAME_TO_CODE[comp[1].trim().toLowerCase()]) return NAME_TO_CODE[comp[1].trim().toLowerCase()];
  return null;
}

function mailboxFor(classifiedAs, parseStatus) {
  // Failed parses used to land in Other and bury the catch-all
  // (surveys, armored-truck threads, odd Neumo types). Those stay
  // in their own "review" mailbox.
  if (parseStatus === "failed") return "review";
  const c = classifiedAs || "unknown";
  for (const [box, kinds] of Object.entries(MAILBOXES)) {
    if (kinds.includes(c)) return box;
  }
  return "other";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: "Supabase env vars not configured" });
  }

  const params = event.queryStringParameters || {};
  const mailbox = String(params.mailbox || "all").trim().toLowerCase();
  const state = String(params.state || "").trim().toUpperCase();
  const query = String(params.query || "").trim();
  const parseStatus = String(params.parseStatus || "").trim().toLowerCase();
  const onDate = String(params.date || "").trim();

  let limit = parseInt(params.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  // 2026-10-21: optional longer snippet (default unchanged at 900). The add-site prompt reads
  // street addresses out of ticket text, and install tickets put the real address in the line
  // item description, past the 900-character cut.
  let maxChars = parseInt(params.maxChars, 10);
  if (!Number.isFinite(maxChars) || maxChars < MAX_SNIPPET_CHARS) maxChars = MAX_SNIPPET_CHARS;
  maxChars = Math.min(maxChars, 4000);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // State is inferred per message after the fetch, so a state filter pages through the newest
  // messages (up to SCAN_CAP) until enough of that state are found. A fixed over-fetch missed
  // states whose mail was not among the newest few hundred (2026-10-26).
  const hasState = !!(state && /^[A-Z]{2}$/.test(state));
  const PAGE = 200;
  const SCAN_CAP = 3000;
  const fetchLimit = hasState ? PAGE : limit;

  const makeQuery = () => {
  let q = supabase
    .from("inbound_emails")
    .select("id, mailbox, sender, subject, body_text, body_html, received_at, classified_as, parse_status")
    .order("received_at", { ascending: false })
    .limit(fetchLimit);

  // Inventory / expense mailbox forwards must not appear on the shared
  // inbound-mail page or in "other". Admin can pass mailbox=payroll later.
  if (mailbox !== "payroll") {
    q = q.not("to_address", "ilike", "%inventory@mcrtechservice.com%");
    q = q.not("to_address", "ilike", "%expense@mcrtechservice.com%");
  }

  if (mailbox === "review") {
    q = q.eq("parse_status", "failed");
  } else if (mailbox === "testing") {
    q = q.or("subject.ilike.%K2D%,body_text.ilike.%K2D%,subject.ilike.%testing station%,body_text.ilike.%testing station%");
  } else if (mailbox === "otc") {
    q = q.or("subject.ilike.%- OTC -%,subject.ilike.% OTC -%,body_text.ilike.%- OTC -%,subject.ilike.%over-the-counter%,subject.ilike.%over the counter%");
  } else if (mailbox === "armored") {
    // Original ticket + the multi-day Loomis/Brinks scheduling chain
    // (almost all classified reply/ignored). Subject stays
    // "Armored Truck Meet" across RE:/FW:; carrier replies often
    // arrive from *@loomis.com or an SRS rewrite that still contains it.
    q = q.or("subject.ilike.%Armored Truck%,body_text.ilike.%Armored Truck Meet%,sender.ilike.%loomis.com%,sender.ilike.%brinks.com%,subject.ilike.%Brinks Meet%");
  } else if (mailbox && mailbox !== "all" && MAILBOXES[mailbox]) {
    q = q.in("classified_as", MAILBOXES[mailbox]);
    if (mailbox === "other") q = q.neq("parse_status", "failed");
  }
  if (parseStatus && ["parsed", "failed", "ignored", "pending"].includes(parseStatus)) {
    q = q.eq("parse_status", parseStatus);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(onDate)) {
    // Calendar day in Eastern (EDT -04 most of the dispatch season).
    const start = onDate + "T00:00:00-04:00";
    const [y, m, d] = onDate.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const nextStr = next.toISOString().slice(0, 10) + "T00:00:00-04:00";
    q = q.gte("received_at", start).lt("received_at", nextStr);
  }

  const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
  for (const term of terms) {
    const esc = term.replace(/[%_,]/g, " ");
    q = q.or(`subject.ilike.%${esc}%,sender.ilike.%${esc}%,body_text.ilike.%${esc}%`);
  }

  if (state && /^[A-Z]{2}$/.test(state)) {
    // Cheap prefilter: site code, "GA -", or "Location: GA"
    const stateName = STATE_NAMES[state] ? `,body_text.ilike.%${STATE_NAMES[state]}%` : "";
    q = q.or(`subject.ilike.%${state}%,body_text.ilike.%${state}%,sender.ilike.%${state}%${stateName}`);
  }
  return q;
  };

  let rows = [];
  if (hasState) {
    for (let from = 0; from < SCAN_CAP; from += PAGE) {
      const { data: part, error: pErr } = await makeQuery().range(from, from + PAGE - 1);
      if (pErr) return json(500, { ok: false, error: "inbound_emails query failed: " + pErr.message });
      const got = part || [];
      rows = rows.concat(got.filter((r) => inferState(r) === state));
      if (rows.length >= limit || got.length < PAGE) break;
    }
  } else {
    const { data, error } = await makeQuery();
    if (error) return json(500, { ok: false, error: "inbound_emails query failed: " + error.message });
    rows = data || [];
  }

  let emails = rows.map((row) => {
    const { snippet, truncated } = cleanBody(row.body_text, row.body_html, maxChars);
    const inferredState = inferState(row);
    return {
      id: row.id,
      mailboxName: row.mailbox,
      sender: row.sender,
      subject: row.subject,
      receivedAt: row.received_at,
      classifiedAs: row.classified_as,
      parseStatus: row.parse_status,
      mailbox: mailboxFor(row.classified_as, row.parse_status),
      inferredState,
      bodySnippet: snippet,
      truncated,
    };
  });

  if (state && /^[A-Z]{2}$/.test(state)) {
    emails = emails.filter((e) => e.inferredState === state);
  }

  emails = emails.slice(0, limit);

  return json(200, { ok: true, count: emails.length, mailbox, state: state || null, query, emails });
};
