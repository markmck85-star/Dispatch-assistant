/**
 * get-consumable-shipments.js  (v4, 2026-10-06)
 * SAVE AS: netlify/functions/get-consumable-shipments.js   (ONE file, no lib/ folder needed)
 *
 * Reads Neumo's consumable restock shipments out of inbound_emails and
 * returns them as structured shipments: who, when, what (SKU + quantity),
 * and the UPS tracking number once the warehouse has replied.
 *
 * v2: SAVES what it parses to public.consumable_shipments (created
 * 2026-09-30) and returns the saved rows. Each call re-reads the stored
 * emails, inserts shipments it has not seen, and refreshes the PARSED
 * fields (items, tracking, ship date, box counts) of ones it has. It never
 * overwrites what a person set by hand: a shipment marked delivered or
 * cancelled keeps that status. It still forwards nothing to Neumo and
 * changes nothing on the inventory or dispatch tables.
 *
 * Because the write happens on read, the table stays current whenever the
 * inventory board (or this URL) is opened. If the table is missing or the
 * write fails, the parsed shipments are still returned, with syncError set.
 *
 * v3: each shipment now carries receivedAdjustments (what a person recorded
 * when a delivery did not match what was shipped, e.g. a ribbon box that
 * held 18 instead of 24) and each item gets receivedUnits: the adjusted
 * number if there is one, otherwise the shipped units. Anything doing stock
 * math should use receivedUnits, never units.
 *
 * v4 (2026-10-06): first real traffic from the shipments mailbox showed four
 * gaps, all fixed here:
 *   - Tracking numbers are matched in any letter case and stored in capitals.
 *     (The warehouse sometimes types them lowercase, e.g. "1z2v330a4241514022";
 *     the old capitals-only match left that shipment stuck on "requested".)
 *   - The warehouse's newer reply wording is read: "Shipped via UPS GND.
 *     Master tracking for (5) boxes: 1Z..." gives the box count and method.
 *   - The mailbox poll saves the raw MIME body (quoted-printable, sometimes
 *     Windows-1252). It is decoded before parsing, so soft line breaks can no
 *     longer split a SKU or tracking number and a cp1252 dash is still a dash.
 *   - Multi-technician requests ("10/6 - DCO MCR TECHS IL SST -", with one
 *     "MCR NAME - IL SST" block per tech) become one shipment per tech.
 *     A warehouse reply to one of those has not been seen yet, so tracking for
 *     them is not matched to a tech until its format is known.
 *   - "Boxes shipped differs from requested" now says which way it differs: more
 *     shipped than parsed usually means the request has a line this page does not
 *     read (for example CLEANING CARDS).
 *
 * Query: ?since=YYYY-MM-DD (default 45 days)  &state=GA (tech's state)
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

// Multi-tech request: "10/6 - DCO MCR TECHS IL SST -", one block per tech in the body.
const DCO_SUBJECT_RE = new RegExp(
  "^\\s*(?:(?:re|fwd?|fw)\\s*:\\s*)*(\\d{1,2})\\/(\\d{1,2})\\s*" + DASH +
  "\\s*DCO\\s+MCR\\s+TECHS\\s+([A-Z]{2})\\s+SST",
  "i"
);
// "MCR RYAN BARNES - IL SST" (a tech's block header inside a multi-tech request)
const TECH_BLOCK_RE = new RegExp("MCR\\s+([A-Za-z][A-Za-z .'-]*?)\\s*" + DASH + "\\s*([A-Z]{2})\\s+SST", "g");

const TRACKING_RE = /\b1Z[0-9A-Z]{16}\b/gi;
// "Master tracking for (5) boxes" / "(5) boxes" in the warehouse's newer reply wording
const MASTER_BOXES_RE = /\(\s*(\d+)\s*\)\s*box(?:es)?\b/i;
const SHIPPED_VIA_RE = /Shipped\s+via\s+(UPS\s+[A-Za-z]+|[A-Za-z]+)/i;
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

// The mailbox poll stores the raw MIME body, so quoted-printable text arrives as
// "=\r\n" soft breaks and "=C2=A0"-style bytes. Decode it (only when the body
// says it is quoted-printable) before any matching happens.
function decodeQuotedPrintable(raw) {
  const joined = raw.replace(/=\r?\n/g, "");
  return joined.replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Buffer.from(run.replace(/=/g, ""), "hex");
    const utf8 = bytes.toString("utf8");
    if (!utf8.includes("\uFFFD")) return utf8;
    // Not valid UTF-8: treat as Windows-1252 (en/em dash and nbsp are what matter here).
    let out = "";
    for (const b of bytes) {
      out += b === 0x96 ? "\u2013" : b === 0x97 ? "\u2014" : b === 0xA0 ? " " : b === 0x92 ? "'" : String.fromCharCode(b);
    }
    return out;
  });
}

function cleanBody(s) {
  let t = String(s || "");
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(t)) t = decodeQuotedPrintable(t);
  return t.replace(/<br\s*\/?>/gi, "\n").replace(/&nbsp;/gi, " ");
}

/** Item lines shaped "N BOX M UNIT - SKU description" anywhere in `text`. */
function extractItems(text) {
  const items = [];
  const seen = new Set();
  let im;
  ITEM_RE.lastIndex = 0;
  while ((im = ITEM_RE.exec(text)) !== null) {
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
  return items;
}

/**
 * Multi-technician request ("10/6 - DCO MCR TECHS IL SST -") -> one partial
 * shipment per "MCR NAME - XX SST" block. Returns [] if it is not that shape or
 * no tech block has any item (e.g. a bare reply, whose format is not known yet).
 */
function parseMultiTechEmail(email) {
  const subject = String(email.subject || "");
  const sm = subject.match(DCO_SUBJECT_RE);
  if (!sm) return [];
  const body = cleanBody(email.body_text);
  const requestDate = requestDateFrom(Number(sm[1]), Number(sm[2]), email.received_at);

  const heads = [];
  let hm;
  TECH_BLOCK_RE.lastIndex = 0;
  while ((hm = TECH_BLOCK_RE.exec(body)) !== null) {
    heads.push({ name: hm[1].replace(/\s+/g, " ").trim(), state: hm[2].toUpperCase(), start: hm.index, end: hm.index + hm[0].length });
  }
  const out = [];
  const seenTech = new Set();
  heads.forEach((h, i) => {
    const stop = i + 1 < heads.length ? heads[i + 1].start : body.length;
    let block = body.slice(h.end, stop);
    const ty = block.search(/THANK\s+YOU/i);
    if (ty >= 0) block = block.slice(0, ty);
    const items = extractItems(block);
    const key = h.name.toLowerCase() + "|" + h.state;
    if (!items.length || seenTech.has(key)) return;
    seenTech.add(key);
    out.push({
      emailId: email.id,
      requestDate,
      techNameRaw: h.name,
      state: h.state,
      items,
      tracking: [],
      boxesShipped: null,
      shipMethod: /PLEASE\s+SHIP\s+UPS\s+GROUND/i.test(body) ? "UPS GROUND" : null,
      shippedAt: null,
      sawRequestText: true,
      sawReplyText: false,
    });
  });
  return out;
}

/** One email -> zero or more partial shipments (single-tech or multi-tech request). */
function parseShipEmails(email) {
  const single = parseShipEmail(email);
  if (single) return [single];
  return parseMultiTechEmail(email);
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

  const items = extractItems(body);

  const tracking = [...new Set((body.match(TRACKING_RE) || []).map((t) => t.toUpperCase()))];
  const sh = body.match(SHIPPED_RE);
  const mb = body.match(MASTER_BOXES_RE);
  const sv = body.match(SHIPPED_VIA_RE);
  const isReply = /^\s*re\s*:/i.test(subject) || !!sh || tracking.length > 0;

  return {
    emailId: email.id,
    requestDate,
    techNameRaw,
    state,
    items,
    tracking,
    boxesShipped: sh ? Number(sh[1]) : (tracking.length && mb ? Number(mb[1]) : null),
    shipMethod: sh ? sh[2].trim().toUpperCase()
      : (tracking.length && sv ? sv[1].trim().toUpperCase()
        : (/PLEASE\s+SHIP\s+UPS\s+GROUND/i.test(body) ? "UPS GROUND" : null)),
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
      warnings.push(g.boxesShipped > boxesRequested
        ? "Boxes shipped (" + g.boxesShipped + ") is more than the " + boxesRequested + " read from the request; the request may include a line this page does not read (for example cleaning cards)."
        : "Boxes shipped (" + g.boxesShipped + ") is fewer than boxes requested (" + boxesRequested + ").");
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

// A UPS Ground box is nearly always there within 5 business days. Past this
// many calendar days without anyone confirming it, the board shows the
// shipment as "likely arrived" rather than "in transit".
const LIKELY_ARRIVED_DAYS = 7;

function shipmentKey(s) {
  return [String(s.techNameRaw || "").toLowerCase().replace(/\s+/g, " ").trim(), s.requestDate, s.state || ""].join("|");
}

function statusFromParsed(s) {
  return s.tracking.length ? "shipped" : "requested";
}

function sameJson(a, b) {
  return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
}

function todayEt() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function daysBetween(dateStr, refStr) {
  if (!dateStr) return null;
  const a = Date.parse(dateStr + "T12:00:00Z");
  const b = Date.parse(refStr + "T12:00:00Z");
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86400000);
}

/**
 * Writes parsed shipments to the table without clobbering manual changes.
 * `db` is a supabase client. Returns { inserted, updated, error }.
 */
async function syncShipments(db, shipments) {
  if (!shipments.length) return { inserted: 0, updated: 0, error: null };
  const keys = shipments.map(shipmentKey);
  const { data: existing, error: exErr } = await db
    .from("consumable_shipments").select("*").in("shipment_key", keys);
  if (exErr) return { inserted: 0, updated: 0, error: exErr.message };
  const byKey = new Map((existing || []).map((r) => [r.shipment_key, r]));

  const toInsert = [];
  let updated = 0;
  for (const s of shipments) {
    const key = shipmentKey(s);
    const parsedCols = {
      technician_id: s.technician ? s.technician.id : null,
      state: s.state || null,
      shipped_at: s.shippedAt || null,
      ship_method: s.shipMethod || null,
      boxes_requested: s.boxesRequested || null,
      boxes_shipped: s.boxesShipped,
      items: s.items,
      tracking: s.tracking.map((t) => t.number),
      source_email_ids: s.emailIds,
      warnings: s.warnings,
    };
    const row = byKey.get(key);
    if (!row) {
      toInsert.push({
        shipment_key: key,
        tech_name_raw: s.techNameRaw,
        request_date: s.requestDate,
        status: statusFromParsed(s),
        ...parsedCols,
      });
      continue;
    }
    const patch = {};
    for (const [col, val] of Object.entries(parsedCols)) {
      if (!sameJson(row[col], val)) patch[col] = val;
    }
    // Manual states stick. Otherwise follow the parsed evidence.
    if (row.status !== "delivered" && row.status !== "cancelled") {
      const want = statusFromParsed(s);
      if (row.status !== want) patch.status = want;
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const { error: upErr } = await db.from("consumable_shipments").update(patch).eq("id", row.id);
      if (upErr) return { inserted: 0, updated, error: upErr.message };
      updated++;
    }
  }
  if (toInsert.length) {
    const { error: insErr } = await db.from("consumable_shipments").insert(toInsert);
    if (insErr) return { inserted: 0, updated, error: insErr.message };
  }
  return { inserted: toInsert.length, updated, error: null };
}

/** DB row -> the shape the board reads. */
function shape(row, techById, today) {
  const tech = row.technician_id ? techById.get(row.technician_id) : null;
  const tracking = (Array.isArray(row.tracking) ? row.tracking : []).map((n) => ({
    number: n, url: "https://www.ups.com/track?tracknum=" + n,
  }));
  const daysSinceShipped = daysBetween(row.shipped_at, today);
  let phase;
  if (row.status === "delivered") phase = "delivered";
  else if (row.status === "cancelled") phase = "cancelled";
  else if (row.status === "requested") phase = "requested";
  else phase = daysSinceShipped != null && daysSinceShipped > LIKELY_ARRIVED_DAYS ? "likely_arrived" : "in_transit";
  return {
    id: row.id,
    technician: tech ? { id: tech.id, name: tech.name, state: tech.home_state } : null,
    techNameRaw: row.tech_name_raw,
    state: row.state,
    requestDate: row.request_date,
    shippedAt: row.shipped_at,
    shipMethod: row.ship_method,
    boxesRequested: row.boxes_requested,
    boxesShipped: row.boxes_shipped,
    items: (Array.isArray(row.items) ? row.items : []).map((it) => {
      const adj = (Array.isArray(row.received_adjustments) ? row.received_adjustments : []).find((a) => a.sku === it.sku);
      return { ...it, receivedUnits: adj ? adj.receivedUnits : it.units };
    }),
    receivedAdjustments: Array.isArray(row.received_adjustments) ? row.received_adjustments : [],
    tracking,
    status: row.status,
    phase,
    daysSinceShipped,
    deliveredAt: row.delivered_at,
    deliveredNote: row.delivered_note,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
  };
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
    d.setDate(d.getDate() - 45);
    since = d.toISOString().slice(0, 10);
  }
  const stateFilter = String(params.state || "").trim().toUpperCase();
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: techs, error: tErr } = await supabase
    .from("technicians").select("id, name, home_state").eq("active", true);
  if (tErr) return json(500, { error: tErr.message });
  const roster = (techs || []).filter((t) => !/unassigned|placeholder|new site|tmp[-_]?site/i.test(String(t.name || "")));
  const techById = new Map((techs || []).map((t) => [t.id, t]));

  const { data: mails, error: mErr } = await supabase
    .from("inbound_emails")
    .select("id, received_at, sender, subject, to_address, body_text")
    .gte("received_at", since + "T00:00:00-04:00")
    .or("subject.ilike.%RESTOCK MCR%,subject.ilike.%DCO MCR%")
    .order("received_at", { ascending: true })
    .limit(500);
  if (mErr) return json(500, { error: mErr.message });

  const parsed = [];
  const skipped = [];
  for (const e of mails || []) {
    const ps = parseShipEmails(e);
    if (ps.length) parsed.push(...ps);
    else skipped.push({ emailId: e.id, subject: e.subject });
  }
  const fresh = buildShipments(parsed, roster);

  const sync = await syncShipments(supabase, fresh);
  const today = todayEt();

  let shipments;
  if (sync.error) {
    // Table missing or write failed: fall back to the in-memory parse so the
    // board still shows something. These rows have no id, so no buttons.
    shipments = fresh.map((s) => shape({
      id: null, technician_id: s.technician ? s.technician.id : null, tech_name_raw: s.techNameRaw, state: s.state,
      request_date: s.requestDate, shipped_at: s.shippedAt, ship_method: s.shipMethod,
      boxes_requested: s.boxesRequested, boxes_shipped: s.boxesShipped, items: s.items,
      tracking: s.tracking.map((t) => t.number), status: statusFromParsed(s), warnings: s.warnings,
    }, techById, today));
  } else {
    const { data: rows, error: rErr } = await supabase
      .from("consumable_shipments").select("*")
      .gte("request_date", since)
      .order("request_date", { ascending: false });
    if (rErr) return json(500, { error: rErr.message });
    shipments = (rows || []).map((r) => shape(r, techById, today));
  }

  if (/^[A-Z]{2}$/.test(stateFilter)) {
    shipments = shipments.filter((s) => String((s.technician && s.technician.state) || s.state || "").toUpperCase() === stateFilter);
  }

  return json(200, {
    ok: true,
    since,
    today,
    likelyArrivedAfterDays: LIKELY_ARRIVED_DAYS,
    shipmentCount: shipments.length,
    shipments,
    skipped,
    sync: { inserted: sync.inserted, updated: sync.updated, error: sync.error },
  });
};

// Exposed for tests only.
exports._parseShipEmail = parseShipEmail;
exports._parseShipEmails = parseShipEmails;
exports._buildShipments = buildShipments;
exports._syncShipments = syncShipments;
exports._shape = shape;
