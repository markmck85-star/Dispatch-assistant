/**
 * get-inventory-receipts.js  (v2, 2026-09-29)
 * SAVE AS: netlify/functions/get-inventory-receipts.js
 *
 * Received vs missing inventory mail for the period.
 * Matches inbound mail to inventory@mcrtechservice.com (and MCR
 * subjects that say Inventory) against active technician cards.
 *
 * GET /.netlify/functions/get-inventory-receipts?since=2026-09-22
 *
 * v2 CHANGES -- matching is now per EMAIL, not per tech, and tiered:
 *
 *   The old rule looked for a tech's last name anywhere in subject + body +
 *   sender + to-address, walking the roster in state/name order and letting
 *   each tech grab the first unused email. Two real problems came out of
 *   that: (1) TJ forwards state dumps ("GA, inventory") from his own
 *   address, and his last name in the From line credited them to his own
 *   roster card; (2) whichever tech came first alphabetically won any
 *   email that happened to mention a shared name.
 *
 *   Now each email is resolved on its own, best signal first:
 *     1. NAME IN THE SUBJECT  -- full first+last name, else a last name that
 *        belongs to exactly one roster tech ("MCKELVEY - Inventory - ...").
 *     2. FROM ADDRESS         -- equals a tech's email on their card.
 *     3. SIGNATURE NAME       -- full first+last name near the top of the body.
 *   Tiers 2 and 3 are SKIPPED for forwarders (TJ, or any Fwd:/Fw: subject),
 *   because the From line of a forward says who forwarded it, not who
 *   counted the stock. A forward only credits a tech if their name is in the
 *   subject; otherwise it stays in "unmatched" with a reason, visible.
 *   An ambiguous match (two techs share a last name) is never guessed --
 *   it falls to the next tier, and ends up unmatched if nothing settles it.
 *   One email credits at most one tech; a tech's most recent email wins.
 *
 *   Response shape is unchanged (received / missing / unmatched / techCount),
 *   with two additions: received[].matchedBy and unmatched[].reason. The
 *   board page needs no changes.
 *
 *   NOT done here (needs the Mailgun handler to store attachment names):
 *   matching on attachment filename, and counting attachments.
 */
const { createClient } = require("@supabase/supabase-js");

// Addresses that forward other people's inventory. From-address and
// signature matching are skipped for these.
const FORWARDER_EMAILS = new Set(["tkadri@mcrtechservice.com"]);

// Owner / office staff who file inventory but have no technician card.
// `emails` is optional; with none, the owner is credited only when the
// subject says "Mike" as a standalone word and no technician matched.
const EXTRA_ROSTER = [
  { id: "extra-mike", name: "Mike", home_state: null, email: null, emails: [], active: true, extra: true },
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

function words(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

function nameParts(name) {
  const w = words(name);
  return { first: w[0] || "", last: w.length > 1 ? w[w.length - 1] : "" };
}

function addressOf(s) {
  const m = String(s || "").match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : "";
}

function techEmails(t) {
  const raw = [t.email].concat(t.emails || []).filter(Boolean).join(" ");
  return raw.split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"));
}

function hasWords(hay, needle) {
  // whole-word (or whole-phrase) match on already-tokenized word arrays
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function isForwarded(email, senderAddr) {
  if (FORWARDER_EMAILS.has(senderAddr)) return true;
  return /^\s*(fwd?|fw):/i.test(email.subject || "");
}

/**
 * Resolve one email to a technician. Returns
 *   { tech, matchedBy } or { tech: null, reason }.
 */
function resolveEmail(email, roster) {
  const senderAddr = addressOf(email.sender);
  const forwarded = isForwarded(email, senderAddr);
  const subjectWords = words(email.subject);
  const realTechs = roster.filter((t) => !t.extra);

  // Tier 1a: full name in the subject.
  const full = realTechs.filter((t) => {
    const { first, last } = nameParts(t.name);
    return first && last && hasWords(subjectWords, [first]) && hasWords(subjectWords, [last]);
  });
  if (full.length === 1) return { tech: full[0], matchedBy: "subject" };

  // Tier 1b: a last name held by exactly one roster tech.
  const lastHits = realTechs.filter((t) => {
    const { last } = nameParts(t.name);
    return last.length >= 3 && hasWords(subjectWords, [last]);
  });
  let ambiguous = full.length > 1;
  if (lastHits.length === 1) return { tech: lastHits[0], matchedBy: "subject" };
  if (lastHits.length > 1) ambiguous = true;

  // Tier 2: From address on a tech's card (never for forwards).
  if (!forwarded && senderAddr) {
    const byFrom = realTechs.filter((t) => techEmails(t).includes(senderAddr));
    if (byFrom.length === 1) return { tech: byFrom[0], matchedBy: "from" };
    if (byFrom.length > 1) ambiguous = true;
  }

  // Tier 3: full name in the signature area of the body (never for forwards).
  if (!forwarded) {
    const top = words(String(email.body_text || "").slice(0, 600));
    const bySig = realTechs.filter((t) => {
      const { first, last } = nameParts(t.name);
      return first && last && hasWords(top, [first]) && hasWords(top, [last]);
    });
    if (bySig.length === 1) return { tech: bySig[0], matchedBy: "body" };
    if (bySig.length > 1) ambiguous = true;
  }

  // Office staff without a technician card: standalone "mike" in the subject,
  // or their own address if one is configured.
  for (const x of roster.filter((t) => t.extra)) {
    if (!forwarded && senderAddr && techEmails(x).includes(senderAddr)) return { tech: x, matchedBy: "from" };
    if (hasWords(subjectWords, words(x.name))) return { tech: x, matchedBy: "subject" };
  }

  if (ambiguous) return { tech: null, reason: "More than one technician fits (shared name). Put the full name in the subject." };
  if (forwarded) return { tech: null, reason: "Forwarded, and no technician name in the subject." };
  return { tech: null, reason: "No technician name or known address found." };
}

/** Pure function so it can be tested without a database. */
function matchInventory(roster, inventoryMail) {
  const received = [];
  const unmatched = [];
  const creditedTechIds = new Set();
  const byTech = new Map();

  // inventoryMail is newest-first, so the first hit per tech is the most recent.
  for (const e of inventoryMail) {
    const r = resolveEmail(e, roster);
    if (!r.tech) {
      unmatched.push({ subject: e.subject, sender: e.sender, receivedAt: e.received_at, to: e.to_address, reason: r.reason });
      continue;
    }
    if (byTech.has(r.tech.id)) continue; // older duplicate for the same tech
    byTech.set(r.tech.id, { e, matchedBy: r.matchedBy });
  }

  const missing = [];
  for (const tech of roster) {
    const hit = byTech.get(tech.id);
    if (hit) {
      creditedTechIds.add(tech.id);
      received.push({
        name: tech.name,
        state: tech.home_state,
        email: tech.email || null,
        subject: hit.e.subject,
        receivedAt: hit.e.received_at,
        emailId: hit.e.id,
        matchedBy: hit.matchedBy,
      });
    } else {
      missing.push({ name: tech.name, state: tech.home_state, email: tech.email || null });
    }
  }
  return { received, missing, unmatched };
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

  const { received, missing, unmatched } = matchInventory(roster, inventoryMail);

  return json(200, {
    ok: true,
    since,
    techCount: roster.length,
    received,
    missing,
    unmatched,
  });
};

// Exposed for tests only.
exports._matchInventory = matchInventory;
