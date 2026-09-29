/**
 * get-inventory-receipts.js
 * SAVE AS: netlify/functions/get-inventory-receipts.js
 *
 * Received vs missing inventory mail for the period.
 * Matches inbound mail to inventory@mcrtechservice.com (and MCR
 * subjects that say Inventory) against active technician cards.
 *
 * GET /.netlify/functions/get-inventory-receipts?since=2026-09-22
 */
const { createClient } = require("@supabase/supabase-js");

// Owner / office staff who file inventory but have no technician card.
const EXTRA_ROSTER = [
  { id: "extra-mike", name: "Mike", home_state: null, email: null, active: true },
];

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

function tokens(name) {
  return String(name || "")
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

function blobOf(email) {
  return [email.subject, email.sender, email.body_text, email.to_address]
    .filter(Boolean)
    .join(" \n ")
    .toLowerCase();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase env vars not configured" });
  }

  const params = event.queryStringParameters || {};
  let since = String(params.since || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    since = d.toISOString().slice(0, 10);
  }
  const sinceIso = since + "T00:00:00-04:00";
  const stateFilter = String(params.state || "").trim().toUpperCase();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: techs, error: tErr } = await supabase
    .from("technicians")
    .select("id, name, home_state, email, active")
    .eq("active", true)
    .order("home_state", { ascending: true })
    .order("name", { ascending: true });
  if (tErr) return json(500, { error: tErr.message });
  let roster = [...(techs || []), ...EXTRA_ROSTER];
  roster = roster.filter((t) => !/unassigned|placeholder|new site|tmp[-_]?site/i.test(String(t.name || "")));
  if (/^[A-Z]{2}$/.test(stateFilter)) {
    roster = roster.filter((t) => String(t.home_state || "").toUpperCase() === stateFilter);
  }

  const { data: mails, error: mErr } = await supabase
    .from("inbound_emails")
    .select("id, received_at, sender, subject, to_address, body_text")
    .gte("received_at", sinceIso)
    .order("received_at", { ascending: false })
    .limit(500);
  if (mErr) return json(500, { error: mErr.message });

  const inventoryMail = (mails || []).filter((e) => {
    const to = (e.to_address || "").toLowerCase();
    const sub = (e.subject || "").toLowerCase();
    const snd = (e.sender || "").toLowerCase();
    if (to.includes("inventory@mcrtechservice.com")) return true;
    if (sub.includes("inventory") && snd.includes("mcrtechservice.com") && !sub.includes("service response")) return true;
    return false;
  });

  const used = new Set();
  const received = [];
  const missing = [];

  for (const tech of roster) {
    const parts = tokens(tech.name);
    if (!parts.length) {
      missing.push({ tech, email: null });
      continue;
    }
    const last = parts[parts.length - 1].toLowerCase();
    const first = parts[0].toLowerCase();
    let hit = null;
    for (const e of inventoryMail) {
      if (used.has(e.id)) continue;
      const blob = blobOf(e);
      if (!blob.includes(last)) continue;
      if (parts.length > 1 && !blob.includes(first) && !blob.includes(last)) continue;
      hit = e;
      used.add(e.id);
      break;
    }
    if (hit) {
      received.push({
        name: tech.name,
        state: tech.home_state,
        email: tech.email || null,
        subject: hit.subject,
        receivedAt: hit.received_at,
        emailId: hit.id,
      });
    } else {
      missing.push({
        name: tech.name,
        state: tech.home_state,
        email: tech.email || null,
      });
    }
  }

  const unmatched = inventoryMail
    .filter((e) => !used.has(e.id))
    .map((e) => ({
      subject: e.subject,
      sender: e.sender,
      receivedAt: e.received_at,
      to: e.to_address,
    }));

  return json(200, {
    ok: true,
    since,
    techCount: roster.length,
    received,
    missing,
    unmatched,
  });
};
