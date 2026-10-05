/**
 * get-inventory-receipts.js  (v2.1, 2026-09-30)
 * SAVE AS: netlify/functions/get-inventory-receipts.js
 *
 * Received vs missing inventory mail for the period.
 * Matches inbound mail to inventory@mcrtechservice.com (and MCR
 * subjects that say Inventory) against active technician cards.
 *
 * GET /.netlify/functions/get-inventory-receipts?since=2026-09-22
 *      optional: &state=GA  &excludeContractors=1  &includeNotLive=1
 *
 * v2.2 (2026-10-05): who is EXPECTED to submit. The roster used to be every
 * active technician card plus the owner (85 people), which overstated it:
 *   - contractors DO send their inventory to the office, so they stay on the
 *     roster; &excludeContractors=1 hides them (technicians.is_contractor);
 *   - the owner has no inventory, so the extra-roster entry is gone;
 *   - states MCR has not taken over yet (NOT_LIVE below) are left out until their
 *     start date, then included automatically.
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
 *   v2.1: when a tech has both an original email and a forwarded copy
 *   ("Fwd: ..." or sent by TJ), the ORIGINAL is the one shown, even if the
 *   forward is newer. Found when a test forward hid a real Monday submission.
 *
 *   Response shape is unchanged (received / missing / unmatched / techCount),
 *   with two additions: received[].matchedBy and unmatched[].reason. The
 *   board page needs no changes.
 *
 *   NOT done here (needs the Mailgun handler to store attachment names):
 *   matching on attachment filename, and counting attachments.
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");

// Addresses that forward other people's inventory. From-address and
// signature matching are skipped for these.
const FORWARDER_EMAILS = new Set(["tkadri@mcrtechservice.com"]);

// Owner / office staff who file inventory but have no technician card.
// `emails` is optional; with none, the owner is credited only when the
// subject says "Mike" as a standalone word and no technician matched.
// 2026-10-05: the owner does not keep an inventory, so he is no longer on the
// roster (it showed him as permanently missing). Add office staff here only if
// they really do file one.
const EXTRA_ROSTER = [];

// People who never file an inventory themselves. Listed by roster name.
const NOT_EXPECTED = ["TJ Kadri"];

// Contractor COMPANIES that file ONE sheet for their whole crew. The company is
// the expected submitter (listed and counted as its own entry); the individual
// crew members are not expected separately. Add more companies here as TJ
// confirms them. `members` are roster names.
const CONTRACTOR_COMPANIES = [
  { name: "KMG Computers", home_state: "WV", members: ["Craig Gosnell", "Zach Roach", "Cody Vanorsdale"] },
];

// States whose technicians are not MCR's yet. They are skipped until liveFrom
// (YYYY-MM-DD, Eastern), so the expected-submitter count stays honest and CA
// switches on by itself on its takeover date.
const NOT_LIVE = [
  { state: "CA", liveFrom: "2026-11-01" },
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
  if (full.length === 1) return { tech: full[0], matchedBy: "subject", forwarded };

  // Tier 1b: a last name held by exactly one roster tech.
  const lastHits = realTechs.filter((t) => {
    const { last } = nameParts(t.name);
    return last.length >= 3 && hasWords(subjectWords, [last]);
  });
  let ambiguous = full.length > 1;
  if (lastHits.length === 1) return { tech: lastHits[0], matchedBy: "subject", forwarded };
  if (lastHits.length > 1) ambiguous = true;

  // Tier 2: From address on a tech's card (never for forwards).
  if (!forwarded && senderAddr) {
    const byFrom = realTechs.filter((t) => techEmails(t).includes(senderAddr));
    if (byFrom.length === 1) return { tech: byFrom[0], matchedBy: "from", forwarded };
    if (byFrom.length > 1) ambiguous = true;
  }

  // Tier 3: full name in the signature area of the body (never for forwards).
  if (!forwarded) {
    const top = words(String(email.body_text || "").slice(0, 600));
    const bySig = realTechs.filter((t) => {
      const { first, last } = nameParts(t.name);
      return first && last && hasWords(top, [first]) && hasWords(top, [last]);
    });
    if (bySig.length === 1) return { tech: bySig[0], matchedBy: "body", forwarded };
    if (bySig.length > 1) ambiguous = true;
  }

  // Office staff without a technician card: standalone "mike" in the subject,
  // or their own address if one is configured.
  for (const x of roster.filter((t) => t.extra)) {
    if (!forwarded && senderAddr && techEmails(x).includes(senderAddr)) return { tech: x, matchedBy: "from", forwarded };
    if (hasWords(subjectWords, words(x.name))) return { tech: x, matchedBy: "subject", forwarded };
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
      unmatched.push({ id: e.id, subject: e.subject, sender: e.sender, receivedAt: e.received_at, to: e.to_address, reason: r.reason });
      continue;
    }
    const cur = byTech.get(r.tech.id);
    // Newest wins, except an original always beats a forwarded copy.
    if (cur && (!cur.forwarded || r.forwarded)) continue;
    byTech.set(r.tech.id, { e, matchedBy: r.matchedBy, forwarded: !!r.forwarded });
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
    .select("id, name, home_state, email, active, is_contractor")
    .eq("active", true)
    .order("home_state", { ascending: true })
    .order("name", { ascending: true });
  if (tErr) return json(500, { error: tErr.message });
  let roster = [...(techs || []), ...EXTRA_ROSTER];
  // Crew members covered by a company sheet are not expected on their own; the
  // company takes their place as one contractor entry.
  const covered = new Set(CONTRACTOR_COMPANIES.flatMap((c) => c.members.map((m) => m.toLowerCase())));
  roster = roster.filter((t) => !covered.has(String(t.name || "").toLowerCase()));
  roster = roster.filter((t) => !NOT_EXPECTED.some((n) => n.toLowerCase() === String(t.name || "").toLowerCase()));
  for (const c of CONTRACTOR_COMPANIES) {
    roster.push({ id: "company-" + c.name.toLowerCase().replace(/\W+/g, "-"), name: c.name, home_state: c.home_state, email: null, active: true, is_contractor: true, company: true });
  }
  roster = roster.filter((t) => !/unassigned|placeholder|new site|tmp[-_]?site/i.test(String(t.name || "")));
  // Everyone a sheet could belong to, before the display filters below: a sheet
  // from a hidden contractor (or a not-yet-live state) is not an unknown sheet.
  const rosterAll = roster.slice();
  const excludeContractors = params.excludeContractors === "1";
  const includeNotLive = params.includeNotLive === "1";
  if (excludeContractors) roster = roster.filter((t) => !t.is_contractor);
  if (!includeNotLive) {
    const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const hidden = new Set(NOT_LIVE.filter((x) => todayEt < x.liveFrom).map((x) => x.state));
    roster = roster.filter((t) => !hidden.has(String(t.home_state || "").toUpperCase()));
  }
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

  const matched = matchInventory(roster, inventoryMail);
  let { received, missing, unmatched } = matched;

  // 2026-10-05: also credit technicians from the NAME WRITTEN INSIDE a saved
  // count sheet. Covers a combined email carrying several sheets (one email, no
  // technician name in the subject) and mail with inventory@ only on BCC. A
  // credit from the email's own subject/sender still wins when it exists.
  const { data: sheetRows } = await supabase
    .from("inventory_sheets")
    .select("id, inbound_email_id, filename, received_at, tech:parsed->>techName")
    .gte("received_at", sinceIso)
    .not("parsed", "is", null)
    .order("received_at", { ascending: false })
    .limit(500);
  const mailById = new Map((mails || []).map((m) => [m.id, m]));
  const creditedEmailIds = new Set();
  for (const sr of sheetRows || []) {
    const tech = resolveSheetTech(roster, sr.tech);
    if (!tech) continue;
    const already = received.find((r) => r.name === tech.name);
    if (already) { if (sr.inbound_email_id === already.emailId) creditedEmailIds.add(sr.inbound_email_id); continue; }
    const mail = mailById.get(sr.inbound_email_id);
    received.push({
      name: tech.name,
      state: tech.home_state,
      email: tech.email || null,
      subject: mail ? mail.subject : sr.filename,
      receivedAt: sr.received_at,
      emailId: sr.inbound_email_id,
      matchedBy: "sheet",
    });
    missing = missing.filter((x) => x.name !== tech.name);
    creditedEmailIds.add(sr.inbound_email_id);
  }
  unmatched = unmatched.filter((u) => !creditedEmailIds.has(u.id));

  // A saved sheet whose name matches nobody on the roster would otherwise vanish
  // (it credits no one and is not in the mail-level unmatched list). Show it.
  const seenSheetNames = new Set();
  for (const sr of sheetRows || []) {
    if (resolveSheetTech(rosterAll, sr.tech)) continue;
    const key = String(sr.tech || "").toLowerCase() + "|" + String(sr.filename || "").toLowerCase();
    if (seenSheetNames.has(key)) continue;
    seenSheetNames.add(key);
    const mail = mailById.get(sr.inbound_email_id);
    unmatched.push({
      id: sr.inbound_email_id,
      subject: sr.filename,
      sender: 'sheet name: "' + (sr.tech || "none") + '"',
      receivedAt: sr.received_at,
      to: mail ? mail.to_address : null,
      reason: "This sheet's name does not match anyone on the roster, so it is not counted.",
    });
  }

  return json(200, {
    ok: true,
    since,
    techCount: roster.length,
    excludeContractors,
    received,
    missing,
    unmatched,
  });
};

// Exposed for tests only.
exports._matchInventory = matchInventory;
