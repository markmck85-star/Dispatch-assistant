/**
 * get-consumable-shipments.js  (v1, 2026-09-30)
 * SAVE AS: netlify/functions/get-consumable-shipments.js   (ONE file, no lib/ folder needed)
 *
 * Reads Neumo's consumable restock shipments out of inbound_emails and
 * returns them as structured shipments: who, when, what (SKU + quantity),
 * and the UPS tracking number once the warehouse has replied.
 *
 * Read-only. Does not write to any table, does not touch the inventory
 * board, and forwards nothing to Neumo.
 *
 * GET /.netlify/functions/get-consumable-shipments?since=2026-09-01
 *
 * TWO EMAIL SHAPES ARE HANDLED (both seen for real on 2026-09-08/09):
 *
 *  1. THE REQUEST -- Melinda Carter (Neumo inventory) to the warehouse,
 *     copying TJ, the state dispatcher and the tech:
 *       Subject: 9/8 - RESTOCK MCR MARK MCKELVEY - GA SST
 *       PLEASE SHIP UPS GROUND
 *       10 BOX 30 ROLLS – 10101030 FORM GA SST RED
 *       4 BOX 16 ROLLS – 10901041 PAPER JOURNAL
 *
 *  2. THE WAREHOUSE REPLY -- same thread, "Re:" subject, carries the UPS
 *     tracking number (the request itself never does):
 *       14 Boxes shipped via UPS GROUND
 *       Tracking Information: 1ZB68E430351684891
 *
 *  A forward that contains both (reply on top, request quoted below) is
 *  also handled. Requests and replies for the same thread are merged into
 *  one shipment: status "requested" until a tracking number shows up, then
 *  "shipped".
 *
 * Multiple copies of the same mail (Melinda copies several people, and each
 * may forward to shipments@) collapse into one shipment: same tech + same
 * request date + same items.
 *
 * NOT THE SAME AS THE RMA PAGE. rma_shipments is keyed by Neumo case number
 * and covers parts/RMA cases (printers, toppers, call tags). These
 * consumable shipments have no case number, go to a technician, and have
 * nothing to send back. Both will eventually want the same UPS tracking
 * lookup; the tracking URL here is the same simple UPS link.
 */
const { createClient } = require("@supabase/supabase-js");

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

const DASH = "[\\u2013\\u2014-]"; // en dash, em dash, hyphen -- Neumo mixes all three

// "9/8 - RESTOCK MCR MARK MCKELVEY - GA SST"  (with any Re:/Fwd: prefixes)
const SUBJECT_RE = new RegExp(
  "^\\s*(?:(?:re|fwd?|fw)\\s*:\\s*)*(\\d{1,2})\\/(\\d{1,2})\\s*" + DASH +
  "\\s*RESTOCK\\s+MCR\\s+(.+?)\\s*" + DASH + "\\s*([A-Z]{2})\\s+SST",
  "i"
);

// "10 BOX 30 ROLLS – 10101030 FORM GA SST RED"
//  boxes      units unit         sku       description
const ITEM_RE = new RegExp(
  "(\\d+)\\s*BOX(?:ES)?\\s+(\\d+)\\s+([A-Za-z]+)\\s*" + DASH + "\\s*(\\d{6,9})\\s*(?:" + DASH + "\\s*)?" +
  "([^\\r\\n]*?)(?=\\s+\\d+\\s*BOX\\b|\\s*THANK\\s+YOU|[\\r\\n]|$)",
  "gi"
);

const TRACKING_RE = /\b1Z[0-9A-Z]{16}\b/g;
const SHIPPED_RE = /(\d+)\s+Box(?:es)?\s+shipped\s+via\s+([A-Za-z ]+?)(?=\s*(?:\r|\n|Tracking|$))/i;
const FWD_DATE_RE = /Date:\s*(?:[A-Za-z]+\s+)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/;

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

function pad(n) { return String(n).padStart(2, "0"); }

/** "9/8" + when it was received -> "2026-09-08" (handles Dec/Jan boundary). */
function requestDateFrom(month, day, receivedAt) {
  const ref = receivedAt ? new Date(receivedAt) : new Date();
  let year = ref.getUTCFullYear();
  const guess = new Date(Date.UTC(year, month - 1, day));
  // A "12/30" request read in early January belongs to last year.
  if (guess.getTime() - ref.getTime() > 60 * 24 * 3600 * 1000) year -= 1;
  return year + "-" + pad(month) + "-" + pad(day);
}

function forwardedDate(body) {
  const m = String(body || "").match(FWD_DATE_RE);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return m[3] + "-" + pad(mi + 1) + "-" + pad(Number(m[2]));
}

function cleanBody(s) {
  return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/&nbsp;/gi, " ");
}

/**
 * Pure parser: one email -> a partial shipment, or null if it isn't one.
 * email = { id, subject, sender, body_text, received_at }
 */
function parseShipEmail(email) {
  const subject = String(email.subject || "");
  const sm = subject.match(SUBJECT_RE);
  if (!sm) return null;

  const body = cleanBody(email.body_text);
  const requestDate = requestDateFrom(Number(sm[1]), Number(sm[2]), email.received_at);
  const techNameRaw = sm[3].replace(/\s+/g, " ").trim();
  const state = sm[4].toUpperCase();

  // Items: only lines shaped "N BOX M UNIT - SKU description".
  const items = [];
  const seen = new Set();
  let im;
  ITEM_RE.lastIndex = 0;
  while ((im = ITEM_RE.exec(body)) !== null) {
    const item = {
      boxes: Number(im[1]),
      units: Number(im[2]),
      unit: im[3].toUpperCase(),
      sku: im[4],
      description: (im[5] || "").replace(/\s+/g, " ").trim(),
    };
    const k = item.sku + "|" + item.boxes + "|" + item.units;
    if (seen.has(k)) continue; // the same request quoted twice in a long thread
    seen.add(k);
    items.push(item);
  }

  const tracking = [...new Set((body.match(TRACKING_RE) || []))];
  const sh = body.match(SHIPPED_RE);
  const isReply = /^\s*re\s*:/i.test(subject) || !!sh || tracking.length > 0;

  return {
    emailId: email.id,
    requestDate,
    techNameRaw,
    state,
    items,
    tracking,
    boxesShipped: sh ? Number(sh[1]) : null,
    shipMethod: sh ? sh[2].trim().toUpperCase() : (/PLEASE\s+SHIP\s+UPS\s+GROUND/i.test(body) ? "UPS GROUND" : null),
    // The reply's own date: from a forwarded header if present, else when it arrived.
    shippedAt: tracking.length ? (forwardedDate(body) || String(email.received_at || "").slice(0, 10) || null) : null,
    sawRequestText: items.length > 0,
    sawReplyText: isReply && tracking.length > 0,
  };
}

function words(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
}

/** "MARK MCKELVEY" -> the roster technician, or null. Never guesses on a tie. */
function matchTech(nameRaw, roster) {
  const w = words(nameRaw);
  if (!w.length) return null;
  const exact = roster.filter((t) => words(t.name).join(" ") === w.join(" "));
  if (exact.length === 1) return exact[0];
  const first = w[0], last = w[w.length - 1];
  const hits = roster.filter((t) => {
    const tw = words(t.name);
    return tw.includes(first) && tw.includes(last);
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Merge parsed emails into shipments (one per tech + request date + state). */
function buildShipments(parsed, roster) {
  const groups = new Map();
  for (const p of parsed) {
    const key = [p.techNameRaw.toLowerCase(), p.requestDate, p.state].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        techNameRaw: p.techNameRaw, state: p.state, requestDate: p.requestDate,
        items: [], tracking: [], boxesShipped: null, shipMethod: null, shippedAt: null, emailIds: [],
      });
    }
    const g = groups.get(key);
    g.emailIds.push(p.emailId);
    const have = new Set(g.items.map((i) => i.sku + "|" + i.boxes + "|" + i.units));
    for (const it of p.items) {
      const k = it.sku + "|" + it.boxes + "|" + it.units;
      if (!have.has(k)) { g.items.push(it); have.add(k); }
    }
    for (const t of p.tracking) if (!g.tracking.includes(t)) g.tracking.push(t);
    if (p.boxesShipped != null) g.boxesShipped = p.boxesShipped;
    if (p.shipMethod && !g.shipMethod) g.shipMethod = p.shipMethod;
    if (p.shippedAt && (!g.shippedAt || p.shippedAt < g.shippedAt)) g.shippedAt = p.shippedAt;
  }

  const out = [];
  for (const g of groups.values()) {
    const tech = matchTech(g.techNameRaw, roster);
    const boxesRequested = g.items.reduce((s, i) => s + i.boxes, 0);
    const warnings = [];
    if (!tech) warnings.push("Technician name in the subject did not match exactly one active technician.");
    if (!g.items.length) warnings.push("Tracking reply seen but the original request (items) has not been seen.");
    if (g.boxesShipped != null && g.items.length && g.boxesShipped !== boxesRequested) {
      warnings.push("Boxes shipped (" + g.boxesShipped + ") differs from boxes requested (" + boxesRequested + ").");
    }
    out.push({
      technician: tech ? { id: tech.id, name: tech.name, state: tech.home_state } : null,
      techNameRaw: g.techNameRaw,
      state: g.state,
      requestDate: g.requestDate,
      shippedAt: g.shippedAt,
      status: g.tracking.length ? "shipped" : "requested",
      shipMethod: g.shipMethod,
      boxesRequested,
      boxesShipped: g.boxesShipped,
      items: g.items,
      tracking: g.tracking.map((n) => ({ number: n, url: "https://www.ups.com/track?tracknum=" + n })),
      emailIds: g.emailIds,
      warnings,
    });
  }
  out.sort((a, b) => (a.requestDate < b.requestDate ? 1 : a.requestDate > b.requestDate ? -1 : 0));
  return out;
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
    d.setDate(d.getDate() - 30);
    since = d.toISOString().slice(0, 10);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: techs, error: tErr } = await supabase
    .from("technicians").select("id, name, home_state").eq("active", true);
  if (tErr) return json(500, { error: tErr.message });
  const roster = (techs || []).filter((t) => !/unassigned|placeholder|new site|tmp[-_]?site/i.test(String(t.name || "")));

  const { data: mails, error: mErr } = await supabase
    .from("inbound_emails")
    .select("id, received_at, sender, subject, to_address, body_text")
    .gte("received_at", since + "T00:00:00-04:00")
    .ilike("subject", "%RESTOCK MCR%")
    .order("received_at", { ascending: true })
    .limit(500);
  if (mErr) return json(500, { error: mErr.message });

  const parsed = [];
  const skipped = [];
  for (const e of mails || []) {
    const p = parseShipEmail(e);
    if (p) parsed.push(p);
    else skipped.push({ emailId: e.id, subject: e.subject });
  }

  const shipments = buildShipments(parsed, roster);
  return json(200, {
    ok: true,
    since,
    shipmentCount: shipments.length,
    shipments,
    skipped,
  });
};

// Exposed for tests only.
exports._parseShipEmail = parseShipEmail;
exports._buildShipments = buildShipments;
