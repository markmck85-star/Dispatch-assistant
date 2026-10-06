/**
 * get-inventory-detail.js  (v2, 2026-10-06)
 * SAVE AS: netlify/functions/get-inventory-detail.js
 *
 * Read-only. Returns the line items already parsed from saved count sheets,
 * plus the email text that arrived with them (the notes techs put in the
 * message). Used by the inventory board review screen. Sends nothing.
 *
 * v2 (2026-10-06): a sheet whose In Transit column is empty for an item Neumo has
 * already requested or shipped to that technician is held like a date problem
 * (see lib/inventory-transit.js for the exact rule).
 *
 * GET ?since=YYYY-MM-DD&state=GA
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");
const { transitProblems, shipmentsForTech } = require("./lib/inventory-transit.js");

const NAME_FORMAT = /^[A-Z]{2}(?:\s*,\s*[A-Z]{2})*\s*SST\s*-\s*MCR\s+[A-Za-z.'_ ]+?\s*-\s*\d{8}\.(xlsx|xls)$/i;
const STALE_DAYS = 7;

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
const etDate = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dayDiff = (a, b) => Math.round((new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / 86400000);
function addDays(ymd, n) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function fileDateOf(filename) {
  const all = [...String(filename || "").matchAll(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g)];
  if (!all.length) return { raw: null, iso: null, valid: false };
  const m = all[all.length - 1];
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const valid = validYmd(y, mo, d);
  return { raw: m[0], iso: valid ? `${m[1]}-${m[2]}-${m[3]}` : null, valid };
}
function dateProblems(label, iso, arrived) {
  const out = [];
  if (!iso) return out;
  if (Number(iso.slice(0, 4)) !== Number(arrived.slice(0, 4)) && Math.abs(dayDiff(iso, arrived)) > 40) out.push(label + " date " + iso + " is the wrong year");
  else if (dayDiff(iso, arrived) > 1) out.push(label + " date " + iso + " is in the future");
  else if (dayDiff(arrived, iso) > STALE_DAYS) out.push(label + " date " + iso + " is more than " + STALE_DAYS + " days before it was sent");
  return out;
}
function readyIssues(filename, sheetIso, arrived) {
  const issues = [];
  const fd = fileDateOf(filename);
  if (!sheetIso) issues.push("No readable date inside the sheet");
  if (!fd.raw) issues.push("File name has no YYYYMMDD date");
  else if (!fd.valid) issues.push("File name date " + fd.raw + " is not a real date");
  if (sheetIso && fd.iso && sheetIso !== fd.iso) issues.push("File name says " + fd.iso + ", the sheet says " + sheetIso);
  else {
    issues.push(...dateProblems("File name", fd.iso, arrived));
    issues.push(...dateProblems("Sheet", sheetIso, arrived));
  }
  if (!NAME_FORMAT.test(String(filename || "").trim())) issues.push("File name is not in the standard format");
  return issues;
}
function clip(s, n) {
  const t = String(s || "").replace(/\r/g, "").trim();
  return t.length > n ? t.slice(0, n) + "..." : t;
}
function keepItem(it) {
  if (!it) return false;
  if (it.kind === "forms" || it.kind === "ribbon" || it.kind === "journal" || it.kind === "cleaning_cards") return true;
  if (it.comment) return true;
  if (it.toOrder) return true;
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  const q = event.queryStringParameters || {};
  const today = etDate(new Date());
  const since = /^\d{4}-\d{2}-\d{2}$/.test(q.since || "") ? q.since : addDays(today, -14);
  const stateFilter = String(q.state || "").trim().toUpperCase();
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: techs } = await supabase.from("technicians").select("id, name, home_state, email, is_contractor").eq("active", true);
  const roster = techs || [];

  // Neumo -> technician shipments, for the In Transit check (a failure here must not break the page).
  let allShips = [];
  try {
    const { data: shipRows } = await supabase.from("consumable_shipments")
      .select("technician_id, tech_name_raw, status, shipped_at, request_date, delivered_at, items")
      .gte("request_date", addDays(since, -30)).limit(2000);
    allShips = shipRows || [];
  } catch (e) { allShips = []; }

  const { data: rows, error } = await supabase
    .from("inventory_sheets")
    .select("id, inbound_email_id, filename, storage_path, received_at, parsed")
    .gte("received_at", since + "T00:00:00-04:00")
    .not("parsed", "is", null)
    .order("received_at", { ascending: false })
    .limit(400);
  if (error) return json(500, { error: error.message });

  const emailIds = [...new Set((rows || []).map((r) => r.inbound_email_id).filter(Boolean))];
  const mailById = new Map();
  for (let i = 0; i < emailIds.length; i += 80) {
    const { data: em } = await supabase.from("inbound_emails").select("id, sender, subject, body_text, received_at").in("id", emailIds.slice(i, i + 80));
    for (const e of em || []) mailById.set(e.id, e);
  }

  const latest = new Map();
  for (const r of rows || []) {
    const parsed = r.parsed || {};
    const tech = resolveSheetTech(roster, parsed.techName);
    if (stateFilter && tech && String(tech.home_state || "").toUpperCase() !== stateFilter) continue;
    const key = tech ? tech.id : "name:" + String(parsed.techName || r.filename).toLowerCase();
    if (latest.has(key)) continue;
    const arrived = etDate(r.received_at);
    const transit = tech ? transitProblems(parsed.items || [], parsed.invDate || null, shipmentsForTech(tech, allShips)) : [];
    const issues = readyIssues(r.filename, parsed.invDate || null, arrived).concat(transit.map((t) => t.text));
    const items = (parsed.items || []).filter(keepItem).map((it) => ({
      code: it.code,
      name: it.name,
      kind: it.kind,
      par: it.par,
      count: it.count,
      inTransit: it.inTransit,
      toOrder: it.toOrder,
      comment: it.comment || null,
    }));
    const mail = mailById.get(r.inbound_email_id);
    latest.set(key, {
      id: r.id,
      name: tech ? tech.name : (parsed.techName || "Unmatched"),
      state: tech ? tech.home_state : null,
      contractor: tech ? !!tech.is_contractor : null,
      filename: r.filename,
      sheetDate: parsed.invDate || null,
      receivedAt: r.received_at,
      emailId: r.inbound_email_id,
      ready: issues.length === 0,
      issues,
      transitIssues: transit.map((t) => t.text),
      items,
      partialsCurrent: parsed.summary ? parsed.summary.partialsLikelyCurrent : null,
      warnings: parsed.warnings || [],
    });
  }

  const sheets = [...latest.values()].sort((a, b) => String(a.state || "").localeCompare(String(b.state || "")) || String(a.name).localeCompare(String(b.name)));
  const notes = [];
  const seenMail = new Set();
  for (const s of sheets) {
    if (!s.emailId || seenMail.has(s.emailId)) continue;
    seenMail.add(s.emailId);
    const mail = mailById.get(s.emailId);
    if (!mail || !mail.body_text) continue;
    notes.push({
      emailId: mail.id,
      subject: mail.subject || "",
      sender: mail.sender || "",
      receivedAt: mail.received_at,
      text: clip(mail.body_text, 2500),
      sheetCount: sheets.filter((x) => x.emailId === mail.id).length,
    });
  }

  return json(200, {
    ok: true,
    since,
    sheetCount: sheets.length,
    readyCount: sheets.filter((s) => s.ready).length,
    heldCount: sheets.filter((s) => !s.ready).length,
    sheets,
    notes,
  });
};
