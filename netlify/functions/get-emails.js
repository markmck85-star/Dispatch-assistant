// get-emails.js
//
// Search inbound_emails (the raw Mailgun-received store fed by
// mailgun-inbound.js) by keyword. Built specifically to back the
// search_emails tool on the MCR Dispatch MCP connector (mcp-server.js) --
// lets Mark/Gina's Claude answer things like "did WO 00151065 ever come
// in?" directly against what the app actually received, instead of
// guessing from the tickets table (which only has a row for emails that
// both arrived AND parsed successfully).
//
// inbound_emails has no site_id/state column (see gina-claude-connector
// notes) -- this is plain ILIKE text search across subject/sender/body,
// not a structured join. Multi-word queries require every word to appear
// somewhere in subject/sender/body (AND across words, OR across those three
// columns per word) -- good enough for a WO number, a site name, or a
// couple of distinguishing words, without needing real full-text search
// infrastructure.
//
// Every returned body is cleaned (quoted-reply chains, forwarded-message
// blocks, and common signature/disclaimer boilerplate stripped) per Mark's
// 2026-08-23 decision -- callers should never see raw quoted chains.
//
// GET /.netlify/functions/get-emails?query=00151065&limit=10
// -> { query, count, emails: [{ id, mailbox, sender, subject, receivedAt,
//                                classifiedAs, parseStatus, bodySnippet,
//                                truncated }] }

const { createClient } = require('@supabase/supabase-js');

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const MAX_SNIPPET_CHARS = 1500;

// Cuts everything from the first quoted-reply / forwarded-message marker
// onward, then drops any remaining lines that are themselves quoted ("> ").
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
  return t.split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
}

// Cuts off common signature/disclaimer boilerplate once it starts.
function stripSignatureAndDisclaimer(text) {
  let t = text;
  const sigMarkers = [
    /\n--\s*\n/,                                   // standard "-- " sig delimiter
    /\nThis email and any files transmitted/i,
    /\nCONFIDENTIALITY NOTICE/i,
    /\nThis message (is|contains) confidential/i,
    /\nPlease [Rr]eply [Aa]ll to this email/i,      // Neumo's own boilerplate line
    /\nSent from my (i?Phone|i?Pad|Android|Galaxy)/i,
  ];
  for (const m of sigMarkers) {
    const idx = t.search(m);
    if (idx !== -1) t = t.slice(0, idx);
  }
  return t.trim();
}

function cleanBody(bodyText, bodyHtmlFallback) {
  let t = (bodyText || '').trim();
  if (!t && bodyHtmlFallback) {
    // Very light HTML fallback -- strip tags only, no entity decoding.
    t = bodyHtmlFallback.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (!t) return { snippet: '', truncated: false };
  t = stripQuotedChain(t);
  t = stripSignatureAndDisclaimer(t);
  t = t.trim();
  const truncated = t.length > MAX_SNIPPET_CHARS;
  return { snippet: truncated ? t.slice(0, MAX_SNIPPET_CHARS) + '…' : t, truncated };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const query = String(params.query || '').trim();
  if (!query) return json(400, { ok: false, error: 'query is required' });

  let limit = parseInt(params.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Every whitespace-separated term must match subject OR sender OR
  // body_text (case-insensitive) -- chaining one .or() per term ANDs the
  // terms together, same as Postgres would for "all these words somewhere".
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 6); // cap terms, no pathological queries
  let q = supabase
    .from('inbound_emails')
    .select('id, mailbox, sender, subject, body_text, body_html, received_at, classified_as, parse_status')
    .order('received_at', { ascending: false })
    .limit(limit);

  for (const term of terms) {
    const esc = term.replace(/[%_]/g, '\\$&');
    q = q.or(`subject.ilike.%${esc}%,sender.ilike.%${esc}%,body_text.ilike.%${esc}%`);
  }

  if (params.since) q = q.gte('received_at', params.since);
  if (params.until) q = q.lte('received_at', params.until);

  const { data, error } = await q;
  if (error) return json(500, { ok: false, error: 'inbound_emails query failed: ' + error.message });

  const emails = (data || []).map(row => {
    const { snippet, truncated } = cleanBody(row.body_text, row.body_html);
    return {
      id: row.id,
      mailbox: row.mailbox,
      sender: row.sender,
      subject: row.subject,
      receivedAt: row.received_at,
      classifiedAs: row.classified_as,   // trouble | maintenance | dispatch_list | rma_shipping | closing_note_email | reply | unknown
      parseStatus: row.parse_status,      // parsed | failed | ignored
      bodySnippet: snippet,
      truncated,
    };
  });

  return json(200, { ok: true, query, count: emails.length, emails });
};
