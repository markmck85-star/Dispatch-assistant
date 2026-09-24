/**
 * list-inbound-emails.js — 2026-09-24
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
  "AL", "CA", "CO", "FL", "GA", "ID", "IL", "IN", "MI", "MN", "NC", "NV", "OH", "OR", "SC", "WV",
];

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

function cleanBody(bodyText, bodyHtmlFallback) {
  let t = (bodyText || "").trim();
  if (!t && bodyHtmlFallback) {
    t = bodyHtmlFallback.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (!t) return { snippet: "", truncated: false };
  t = stripQuotedChain(t);
  t = stripSignatureAndDisclaimer(t);
  t = t.trim();
  const truncated = t.length > MAX_SNIPPET_CHARS;
  return { snippet: truncated ? t.slice(0, MAX_SNIPPET_CHARS) + "…" : t, truncated };
}

function inferState(row) {
  const hay = [row.subject, row.sender, row.body_text].filter(Boolean).join(" \n ");
  // Prefer an embedded site code (GA1016) over a bare "GA -" account prefix.
  const code = hay.match(/\b([A-Z]{2})\d{3,5}\b/);
  if (code && STATE_CODES.includes(code[1])) return code[1];
  const loc = hay.match(/\bLocation:\s*([A-Z]{2})\b/i) || hay.match(/\b([A-Z]{2})\s*[-–]\s+/);
  if (loc && STATE_CODES.includes(loc[1].toUpperCase())) return loc[1].toUpperCase();
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

  let limit = parseInt(params.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Over-fetch when a state filter is applied so client-side inference still
  // has enough rows after dropping other states. 3x is enough for a busy day.
  const fetchLimit = state && /^[A-Z]{2}$/.test(state) ? Math.min(limit * 3, 200) : limit;

  let q = supabase
    .from("inbound_emails")
    .select("id, mailbox, sender, subject, body_text, body_html, received_at, classified_as, parse_status")
    .order("received_at", { ascending: false })
    .limit(fetchLimit);

  if (mailbox === "review") {
    q = q.eq("parse_status", "failed");
  } else if (mailbox === "testing") {
    q = q.or("subject.ilike.%K2D%,body_text.ilike.%K2D%,subject.ilike.%testing station%,body_text.ilike.%testing station%");
  } else if (mailbox && mailbox !== "all" && MAILBOXES[mailbox]) {
    q = q.in("classified_as", MAILBOXES[mailbox]);
    if (mailbox === "other") q = q.neq("parse_status", "failed");
  }
  if (parseStatus && ["parsed", "failed", "ignored", "pending"].includes(parseStatus)) {
    q = q.eq("parse_status", parseStatus);
  }

  const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
  for (const term of terms) {
    const esc = term.replace(/[%_,]/g, " ");
    q = q.or(`subject.ilike.%${esc}%,sender.ilike.%${esc}%,body_text.ilike.%${esc}%`);
  }

  if (state && /^[A-Z]{2}$/.test(state)) {
    // Cheap prefilter: site code, "GA -", or "Location: GA"
    q = q.or(`subject.ilike.%${state}%,body_text.ilike.%${state}%,sender.ilike.%${state}%`);
  }

  const { data, error } = await q;
  if (error) return json(500, { ok: false, error: "inbound_emails query failed: " + error.message });

  let emails = (data || []).map((row) => {
    const { snippet, truncated } = cleanBody(row.body_text, row.body_html);
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
