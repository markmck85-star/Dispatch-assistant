/**
 * list-service-responses.js
 * ITI service responses (times and miles from close-out emails), for the
 * Service responses page and its Excel download.
 * GET ?state=MI&testing=1[&format=xlsx]
 *
 * 2026-10-01 (v2): two additions, nothing removed.
 *   1. Every row now carries a site code (siteCode / siteName / matchedBy).
 *      Ticket rows use the ticket's own site when it has one. Everything
 *      else is matched to the testing-station (T) / OTC (C) sites by alias,
 *      then by name, inside the same state. A match is only made when it is
 *      unambiguous; otherwise the site code is left blank.
 *   2. Responses that never matched a ticket in the app (for example
 *      Nevada's PM-xx preventive-maintenance responses) are now listed too,
 *      straight from the response emails, tagged source "email". Replies,
 *      forwards and auto-replies are skipped so each job shows once.
 * Matched-ticket rows are exactly what they were before.
 */
const { createClient } = require("@supabase/supabase-js");
const XLSX = require("xlsx");

const ALL_STATES = ["MI", "OH", "NV", "CO"];
const MAILBOX_STATE = { "imap-mi": "MI", "imap-oh": "OH", "imap-nv": "NV", "imap-co": "CO" };
const EMAIL_LOOKBACK_DAYS = 180;
const EMAIL_LIMIT = 900;

function json(status, obj) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

/* ---------- parsing (same label logic as apply-service-responses.js) ---------- */

function decodeQp(s) {
  return String(s || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

// Some response emails arrive with the whole body base64-encoded HTML
// (a table of label/value cells). Decode those to plain "Label : value"
// text before parsing; ordinary text bodies are returned untouched.
function decodeBody(s) {
  const t = String(s || "");
  const compact = t.replace(/\s+/g, "");
  if (compact.length >= 80 && /^[A-Za-z0-9+/]+=*$/.test(compact) && !/[:#]/.test(t)) {
    try {
      const d = Buffer.from(compact, "base64").toString("utf8");
      if (/service call date|ticket number|location/i.test(d)) {
        return d
          .replace(/<img[^>]*>/gi, " ")
          .replace(/<\/(td|th|tr|p|div|table)>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&");
      }
    } catch (e) { /* fall through to the raw text */ }
  }
  return t;
}

function unfoldBody(s) {
  return decodeQp(decodeBody(s))
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNumber(s) {
  if (s == null || s === "") return null;
  const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : String(s).split(" PCI")[0].trim();
}

function field(text, label) {
  const re = new RegExp(label + "\\s*:\\s*(.*?)(?=\\s+(?:Service Call Date|Technician|Component|Location|Contact|Ticket Number|Issue|Call Type|Status|Resolution and Notes|Arrival Time|End Time|Travel Time|Mileage|PCI Requirements)\\s*:|$)", "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function parseResponse(subject, body) {
  // Decode the body on its own first: once the subject (which has a "#")
  // is glued on, a base64 body no longer looks like pure base64.
  const text = unfoldBody((subject || "") + " " + decodeBody(body));
  const ticketFromSubject = (subject || "").match(/Ticket\s*#\s*([A-Za-z0-9-]+)/i);
  return {
    ticketNumber: field(text, "Ticket Number") || (ticketFromSubject && ticketFromSubject[1]) || null,
    technician: field(text, "Technician"),
    location: field(text, "Location"),
    component: field(text, "Component"),
    status: field(text, "Status"),
    notes: field(text, "Resolution and Notes"),
    arrivalTime: field(text, "Arrival Time"),
    endTime: field(text, "End Time"),
    travelTime: firstNumber(field(text, "Travel Time")),
    mileage: firstNumber(field(text, "Mileage")),
    callType: field(text, "Call Type"),
  };
}

function isReplyLike(subject) {
  const s = String(subject || "").replace(/=\?[^?]*\?[qQ]\?/, "").replace(/_/g, " ").trim().toLowerCase();
  return /^(re|fw|fwd)\s*:/.test(s) || /^automatic reply/.test(s) || /^out of office/.test(s);
}

function normTicket(n) {
  const t = String(n || "").replace(/^#/, "").trim().toUpperCase();
  return /^\d+$/.test(t) ? t.replace(/^0+/, "") : t;
}

function onsiteMinutes(arrival, end) {
  if (!arrival || !end) return null;
  const a = new Date(arrival);
  const b = new Date(end);
  if (isNaN(a) || isNaN(b)) return null;
  const m = Math.round((b - a) / 60000);
  return m >= 0 && m < 24 * 60 ? m : null;
}

function isTesting(sr, siteText) {
  const s = `${sr.notes || ""} ${sr.callType || ""} ${sr.location || ""} ${siteText || ""} ${sr.component || ""}`;
  return /k2d|testing station|examiner|test office/i.test(s);
}

function stateName(code) {
  return ({ MI: "Michigan", OH: "Ohio", NV: "Nevada", CO: "Colorado", GA: "Georgia" })[code] || code;
}

// Which state an email belongs to: its mailbox label if it came by IMAP,
// else the Component line, else sender / recipient / body.
function inferState(email, parsed) {
  if (MAILBOX_STATE[email.mailbox]) return MAILBOX_STATE[email.mailbox];
  const pick = (hay) => {
    if (/michigan|itimic/i.test(hay)) return "MI";
    if (/nevada|itinev/i.test(hay)) return "NV";
    if (/ohio|itioh/i.test(hay)) return "OH";
    if (/colorado|iticolo/i.test(hay)) return "CO";
    return null;
  };
  return pick((parsed && parsed.component) || "")
    || pick([email.sender, email.to_address].join(" "))
    || pick(email.body_text || "");
}

/* ---------- site matching ---------- */

const NOISE = new Set([
  "sos", "dmv", "bmv", "otc", "mv", "dlo", "test", "testing", "station", "stations",
  "county", "plus", "office", "the", "of", "and",
]);

function nameKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/^(mi|oh|nv|co)\s*-\s*/, "")
    .replace(/\s*-\s*\d*\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenKey(s) {
  const toks = nameKey(s).split(" ").filter((w) => w && !NOISE.has(w) && !/^\d+$/.test(w));
  return [...new Set(toks)].sort().join(" ");
}

function codeType(code) {
  const m = String(code || "").match(/^[A-Z]{2}([TC])\d/);
  return m ? m[1] : null;
}

function wantedType(component, testingGuess) {
  if (/otc/i.test(component || "")) return "C";
  if (/examiner|testing|k2d/i.test(component || "")) return "T";
  return testingGuess ? "T" : null;
}

function buildIndex(sites, aliasRows) {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const exact = new Map();
  const tok = new Map();
  const add = (map, key, site) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(site.site_code, site);
  };
  for (const s of sites) {
    add(exact, nameKey(s.name), s);
    add(tok, tokenKey(s.name), s);
  }
  for (const a of aliasRows || []) {
    const s = byId.get(a.site_id);
    if (!s) continue;
    add(exact, nameKey(a.alias), s);
    add(tok, tokenKey(a.alias), s);
  }
  return { exact, tok };
}

function matchSite(index, loc, state, type) {
  if (!loc) return null;
  const pickUnique = (map, key) => {
    const hit = map.get(key);
    if (!hit) return null;
    const list = [...hit.values()].filter((s) => (!state || s.state === state) && (!type || codeType(s.site_code) === type));
    return list.length === 1 ? list[0] : null;
  };
  let s = pickUnique(index.exact, nameKey(loc));
  if (s) return { site: s, by: "alias/name" };
  const tk = tokenKey(loc);
  if (tk) {
    s = pickUnique(index.tok, tk);
    if (s) return { site: s, by: "name" };
  }
  return null;
}

/* ---------- handler ---------- */

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  const qs = event.queryStringParameters || {};
  const state = String(qs.state || "").toUpperCase();
  const testingOnly = qs.testing === "1" || qs.testing === "true";
  const limit = Math.min(500, Number(qs.limit || 300));

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 1. Tickets a response email closed (unchanged query, plus site_id).
  const { data, error } = await supabase
    .from("tickets")
    .select("wo_number, site_text, status, ticket_kind, manually_resolved_at, attributes, site_id")
    .not("attributes->service_response", "is", null)
    .order("manually_resolved_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return json(500, { error: error.message });

  // 2. Testing-station / OTC sites for the states in view, with aliases.
  const states = state && ALL_STATES.includes(state) ? [state] : ALL_STATES;
  let sites = [];
  for (const pat of ["__T%", "__C%"]) {
    const { data: part, error: sErr } = await supabase
      .from("sites").select("id, site_code, state, name")
      .in("state", states).like("site_code", pat).limit(1000);
    if (sErr) return json(500, { error: "sites: " + sErr.message });
    sites = sites.concat((part || []).filter((s) => /^[A-Z]{2}[TC]\d{3}$/.test(s.site_code)));
  }
  let aliasRows = [];
  const siteIds = sites.map((s) => s.id);
  for (let i = 0; i < siteIds.length; i += 80) {
    const { data: part, error: aErr } = await supabase
      .from("site_aliases").select("site_id, alias").in("site_id", siteIds.slice(i, i + 80));
    if (aErr) return json(500, { error: "aliases: " + aErr.message });
    aliasRows = aliasRows.concat(part || []);
  }
  const index = buildIndex(sites, aliasRows);

  // Sites that matched tickets point at (may be a kiosk code, not T/C).
  const ticketSiteIds = [...new Set((data || []).map((t) => t.site_id).filter(Boolean))];
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const missing = ticketSiteIds.filter((id) => !siteById.has(id));
  for (let i = 0; i < missing.length; i += 80) {
    const { data: part } = await supabase.from("sites").select("id, site_code, state, name").in("id", missing.slice(i, i + 80));
    for (const s of part || []) siteById.set(s.id, s);
  }

  const rows = [];
  const emailIdsSeen = new Set();
  const seenKeys = new Set();

  for (const t of data || []) {
    const sr = (t.attributes && t.attributes.service_response) || {};
    const blob = `${t.site_text || ""} ${sr.location || ""}`;
    if (state && !new RegExp("\\b" + state + "\\b|" + stateName(state), "i").test(blob)) continue;
    if (sr.inboundEmailId) emailIdsSeen.add(sr.inboundEmailId);
    seenKeys.add(normTicket(sr.ticketNumber || t.wo_number) + "|" + (sr.arrivalTime || ""));

    let site = t.site_id ? siteById.get(t.site_id) : null;
    let by = site ? "ticket" : null;
    if (!site) {
      const guess = isTesting(sr, t.site_text);
      const m = matchSite(index, sr.location, state || null, wantedType(sr.component, guess));
      if (m) { site = m.site; by = m.by; }
    }
    const testing = isTesting(sr, t.site_text) || (site && codeType(site.site_code) === "T");
    if (testingOnly && !testing) continue;
    rows.push({
      source: "ticket",
      wo: t.wo_number,
      site: t.site_text,
      siteCode: site ? site.site_code : "",
      siteName: site ? site.name : "",
      matchedBy: by || "",
      status: t.status,
      kind: t.ticket_kind,
      closedAt: t.manually_resolved_at,
      ticketNumber: sr.ticketNumber || t.wo_number,
      technician: sr.technician || "",
      location: sr.location || t.site_text || "",
      arrivalTime: sr.arrivalTime || "",
      endTime: sr.endTime || "",
      onsiteMin: onsiteMinutes(sr.arrivalTime, sr.endTime),
      travelTime: sr.travelTime || "",
      mileage: sr.mileage || "",
      notes: sr.notes || "",
      callType: sr.callType || "",
      testing: !!testing,
    });
  }

  // 3. Responses that are not tied to a ticket in the app.
  const since = new Date(Date.now() - EMAIL_LOOKBACK_DAYS * 86400000).toISOString();
  const { data: emails, error: eErr } = await supabase
    .from("inbound_emails")
    .select("id, subject, body_text, received_at, mailbox, sender, to_address")
    .ilike("subject", "%Technician Service Response%")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(EMAIL_LIMIT);
  if (eErr) return json(500, { error: "emails: " + eErr.message });

  for (const e of emails || []) {
    if (emailIdsSeen.has(e.id)) continue;
    if (isReplyLike(e.subject)) continue;
    const p = parseResponse(e.subject, e.body_text);
    if (!p.ticketNumber && !p.location) continue;
    const st = inferState(e, p);
    if (state && st !== state) continue;

    const key = normTicket(p.ticketNumber) + "|" + (p.arrivalTime || "");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const guess = isTesting(p, "");
    const m = matchSite(index, p.location, st || state || null, wantedType(p.component, false));
    const site = m ? m.site : null;
    const testing = guess || (site && codeType(site.site_code) === "T") || /examiner/i.test(p.component || "");
    if (testingOnly && !testing) continue;
    rows.push({
      source: "email",
      wo: p.ticketNumber || "",
      site: "",
      siteCode: site ? site.site_code : "",
      siteName: site ? site.name : "",
      matchedBy: m ? m.by : "",
      status: "",
      kind: "",
      closedAt: e.received_at,
      ticketNumber: p.ticketNumber || "",
      technician: p.technician || "",
      location: p.location || "",
      arrivalTime: p.arrivalTime || "",
      endTime: p.endTime || "",
      onsiteMin: onsiteMinutes(p.arrivalTime, p.endTime),
      travelTime: p.travelTime || "",
      mileage: p.mileage || "",
      notes: p.notes || "",
      callType: p.callType || "",
      component: p.component || "",
      responseStatus: p.status || "",
      state: st || "",
      testing: !!testing,
    });
  }

  if (qs.format === "xlsx") {
    const sheetRows = rows.map((r) => ({
      WO: r.wo,
      "ITI ticket": r.ticketNumber,
      "Site code": r.siteCode,
      Location: r.location,
      Site: r.siteName || r.site,
      Technician: r.technician,
      "Call type": r.callType,
      Testing: r.testing ? "Yes" : "",
      Arrival: r.arrivalTime,
      End: r.endTime,
      "On site (min)": r.onsiteMin,
      "Travel (min)": r.travelTime === "" ? "" : Number(r.travelTime) || r.travelTime,
      Miles: r.mileage === "" ? "" : Number(r.mileage) || r.mileage,
      Notes: r.notes,
      Closed: r.closedAt ? String(r.closedAt).slice(0, 10) : "",
      Source: r.source === "email" ? "Email only" : "Ticket",
    }));
    const ws = XLSX.utils.json_to_sheet(sheetRows.length ? sheetRows : [{ WO: "" }]);
    ws["!cols"] = [
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 28 }, { wch: 28 }, { wch: 18 },
      { wch: 16 }, { wch: 10 }, { wch: 22 }, { wch: 22 }, { wch: 14 },
      { wch: 13 }, { wch: 10 }, { wch: 60 }, { wch: 12 }, { wch: 12 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Service responses");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const stamp = new Date().toISOString().slice(0, 10);
    const name = "Service_Responses_" + (state || "All") + "_" + stamp + ".xlsx";
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": "attachment; filename=\"" + name + "\"",
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  }

  return json(200, { ok: true, count: rows.length, rows });
};

// Exposed only so the parsing and matching can be unit-tested offline.
exports._internals = { decodeBody, parseResponse, isReplyLike, normTicket, nameKey, tokenKey, buildIndex, matchSite, wantedType, inferState, codeType };
