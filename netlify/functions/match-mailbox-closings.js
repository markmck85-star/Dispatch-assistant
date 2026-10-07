/**
 * match-mailbox-closings.js
 * Close an open ticket only when a state-mailbox closing email matches it.
 * A work-order number is enough. Otherwise one open ticket at that site code,
 * and the email has to land after the ticket was opened. Age alone never closes.
 *
 * GET /.netlify/functions/match-mailbox-closings?state=MI
 */
const { createClient } = require("@supabase/supabase-js");

const MAILBOX = { OH: "imap-oh", MI: "imap-mi", CO: "imap-co", NV: "imap-nv" };
const WINDOW_MS = 60 * 86400000;

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function woKeys(text) {
  const out = new Set();
  const s = String(text || "");
  const re = /\b(?:WO|work\s*order)\s*#?\s*(\d{5,})\b|\b(00\d{6,})\b/gi;
  let m;
  while ((m = re.exec(s))) out.add(String(m[1] || m[2]).replace(/^0+/, "") || String(m[1] || m[2]));
  return out;
}
function siteKeys(text) {
  const out = new Set();
  const re = /\b([A-Z]{2}\d{3,5})\b/g;
  const s = String(text || "").toUpperCase();
  let m;
  while ((m = re.exec(s))) out.add(m[1]);
  return out;
}
function sameWo(a, b) {
  const x = String(a || "").replace(/\D/g, "").replace(/^0+/, "");
  const y = String(b || "").replace(/\D/g, "").replace(/^0+/, "");
  return x.length >= 5 && x === y;
}

async function matchClosings(state) {
  const code = String(state || "").toUpperCase();
  const mailbox = MAILBOX[code];
  if (!mailbox) return { ok: false, error: "state must be OH, MI, CO, or NV" };
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: emails, error: emailErr } = await supabase
    .from("inbound_emails")
    .select("id, subject, body_text, received_at, classified_as, parse_status")
    .eq("mailbox", mailbox)
    .eq("classified_as", "closing_note_email")
    .eq("parse_status", "pending")
    .order("received_at", { ascending: false })
    .limit(200);
  if (emailErr) throw new Error(emailErr.message);

  const { data: sites, error: siteErr } = await supabase.from("sites").select("id, site_code, state").eq("state", code);
  if (siteErr) throw new Error(siteErr.message);
  const siteById = {};
  (sites || []).forEach((s) => { siteById[s.id] = s; });
  const siteIds = Object.keys(siteById);
  if (!siteIds.length) return { ok: true, state: code, closed: 0, skipped: 0, reason: "no sites" };

  const { data: tickets, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, site_id, wo_number, received_at, manually_resolved_at, status")
    .in("site_id", siteIds)
    .is("manually_resolved_at", null)
    .limit(1000);
  if (ticketErr) throw new Error(ticketErr.message);
  const open = (tickets || []).filter((t) => t.status !== "closed" && t.status !== "cancelled");

  let closed = 0, skipped = 0;
  const matched = [];
  for (const email of emails || []) {
    const hay = (email.subject || "") + "\n" + (email.body_text || "");
    const wos = woKeys(hay);
    const codes = siteKeys(hay);
    const emailAt = Date.parse(email.received_at || "") || Date.now();
    let hits = open.filter((t) => {
      if ([...wos].some((w) => sameWo(w, t.wo_number))) return true;
      const site = siteById[t.site_id];
      if (!site || !codes.has(String(site.site_code || "").toUpperCase())) return false;
      const opened = Date.parse(t.received_at || "") || 0;
      return emailAt >= opened - 86400000 && emailAt - opened <= WINDOW_MS;
    });
    const byWo = hits.filter((t) => [...wos].some((w) => sameWo(w, t.wo_number)));
    if (byWo.length) hits = byWo;
    else if (hits.length !== 1) hits = [];
    if (hits.length !== 1) { skipped += 1; continue; }
    const ticket = hits[0];
    const note = "Closed from mailbox closing email: " + String(email.subject || "closing note").slice(0, 140);
    const { error } = await supabase.from("tickets").update({
      manually_resolved_at: email.received_at || new Date().toISOString(),
      manually_resolved_note: note,
      inbound_email_id: email.id,
    }).eq("id", ticket.id).is("manually_resolved_at", null);
    if (error) { skipped += 1; continue; }
    await supabase.from("inbound_emails").update({ parse_status: "matched" }).eq("id", email.id);
    open.splice(open.findIndex((t) => t.id === ticket.id), 1);
    closed += 1;
    matched.push({ ticketId: ticket.id, site: (siteById[ticket.site_id] || {}).site_code, wo: ticket.wo_number, emailId: email.id });
  }
  return { ok: true, state: code, checked: (emails || []).length, closed, skipped, matched: matched.slice(0, 20) };
}

exports.matchClosings = matchClosings;
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  try {
    const state = (event.queryStringParameters || {}).state || "MI";
    return json(200, await matchClosings(state));
  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};
