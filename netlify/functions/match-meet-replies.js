/**
 * match-meet-replies.js
 * Carrier replies to armored-truck meets land in the main mailbox and the
 * dispatch inbox, not the state closing mailbox. A reply with the work order
 * updates that meet. A reply whose subject dropped the work order matches
 * the site name, and only when one open meet fits.
 *
 * GET /.netlify/functions/match-meet-replies
 */
const { createClient } = require("@supabase/supabase-js");

const MAILBOXES = ["imap-main", "dispatch@mcrdispatch.net"];

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
function woOf(text) {
  const m = String(text || "").match(/\b(00\d{6,})\b/);
  return m ? m[1] : "";
}
function siteHint(subject) {
  const m = String(subject || "").match(/Armored Truck Meet\s*-\s*[A-Z]{2}\s*-\s*(.+?)(?:\s*-\s*00\d{6,})?$/i);
  return m ? m[1].replace(/\s*-\s*$/, "").trim() : "";
}
function sameWo(a, b) {
  const x = String(a || "").replace(/\D/g, "").replace(/^0+/, "");
  const y = String(b || "").replace(/\D/g, "").replace(/^0+/, "");
  return x.length >= 5 && x === y;
}
function statusOf(text) {
  const s = String(text || "");
  if (/\b(cannot support|cannot accommodate|unable to (?:support|accommodate)|won.?t make it)\b/i.test(s)) return "needs_reschedule";
  if (/\b(confirms?|added to (?:our|the) route|we (?:can|could) (?:accommodate|support))\b/i.test(s)) return "confirmed";
  return null;
}

async function matchMeetReplies() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: emails, error } = await supabase
    .from("inbound_emails")
    .select("id, mailbox, sender, subject, body_text, received_at")
    .in("mailbox", MAILBOXES)
    .ilike("subject", "%Armored Truck Meet%")
    .ilike("sender", "%loomis.com%")
    .order("received_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(error.message);

  const { data: tickets, error: ticketErr } = await supabase
    .from("tickets")
    .select("id, wo_number, site_text, loomis_meet_status, loomis_meet_last_contact_at")
    .eq("issue_category", "Armored Truck Meet")
    .eq("status", "open");
  if (ticketErr) throw new Error(ticketErr.message);
  const open = tickets || [];

  let updated = 0;
  const hits = [];
  for (const email of emails || []) {
    const wo = woOf(email.subject) || woOf(email.body_text);
    if (!wo) continue;
    const match = open.filter((t) => sameWo(wo, t.wo_number));
    if (match.length !== 1) continue;
    const ticket = match[0];
    const emailAt = Date.parse(email.received_at || "") || 0;
    const prior = Date.parse(ticket.loomis_meet_last_contact_at || "") || 0;
    if (emailAt <= prior) continue;
    const parsed = statusOf(email.body_text);
    const fields = { loomis_meet_last_contact_at: email.received_at };
    if (parsed && !(parsed === "confirmed" && ticket.loomis_meet_status === "confirmed")) fields.loomis_meet_status = parsed;
    const { error: upErr } = await supabase.from("tickets").update(fields).eq("id", ticket.id);
    if (upErr) continue;
    ticket.loomis_meet_last_contact_at = email.received_at;
    if (fields.loomis_meet_status) ticket.loomis_meet_status = fields.loomis_meet_status;
    updated += 1;
    hits.push({ wo: ticket.wo_number, site: ticket.site_text, at: email.received_at, status: fields.loomis_meet_status || "reply only" });
  }
  return { ok: true, checked: (emails || []).length, updated, hits: hits.slice(0, 20) };
}

exports.matchMeetReplies = matchMeetReplies;
exports.handler = async () => {
  try { return json(200, await matchMeetReplies()); }
  catch (err) { return json(500, { ok: false, error: err.message }); }
};
