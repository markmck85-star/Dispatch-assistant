/**
 * preview-inventory-date-text.js  (v1 shadow, 2026-10-05)
 * SAVE AS: netlify/functions/preview-inventory-date-text.js
 *
 * Drafts one text per inventory sheet that needs a date fix. A person reviews
 * the wording, then confirms. Shadow: confirm does not send. The live text
 * path stays off until that is turned on in a later file.
 *
 * POST { since, confirm, id, text }
 *   confirm omitted or false: returns drafts, nothing is stored or sent
 *   confirm true: echoes the one draft back, sent stays false
 *
 * Does not read comment-column notes into the message.
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");

const STALE_DAYS = 7;
const NAME_FORMAT = /^[A-Z]{2}(?:\s*,\s*[A-Z]{2})*\s*SST\s*-\s*MCR\s+[A-Za-z.'_ ]+?\s*-\s*\d{8}\.(xlsx|xls)$/i;

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
  return { raw: m[0], iso: valid ? `${m[1]}-${m[2]}-${m[3]}` : null, valid, year: y };
}
function dateProblems(label, iso, arrived) {
  const out = [];
  if (!iso) return out;
  if (Number(iso.slice(0, 4)) !== Number(arrived.slice(0, 4)) && Math.abs(dayDiff(iso, arrived)) > 40) {
    out.push(`${label} date ${iso} is the wrong year`);
  } else if (dayDiff(iso, arrived) > 1) {
    out.push(`${label} date ${iso} is in the future`);
  } else if (dayDiff(arrived, iso) > STALE_DAYS) {
    out.push(`${label} date ${iso} is more than ${STALE_DAYS} days before it was sent`);
  }
  return out;
}
function fixLines(filename, sheetIso, arrived) {
  const lines = [];
  const fd = fileDateOf(filename);
  if (!sheetIso) lines.push("No readable date inside the sheet");
  if (!fd.raw) lines.push("File name has no YYYYMMDD date");
  else if (!fd.valid) lines.push(`File name date ${fd.raw} is not a real date`);
  if (sheetIso && fd.iso && sheetIso !== fd.iso) lines.push(`File name says ${fd.iso}, the sheet says ${sheetIso}`);
  else {
    lines.push(...dateProblems("File name", fd.iso, arrived));
    lines.push(...dateProblems("Sheet", sheetIso, arrived));
  }
  if (fd.iso && !sheetIso && Number(fd.year) !== Number(arrived.slice(0, 4)) && !lines.some((t) => /wrong year/.test(t))) {
    lines.push(`File name date ${fd.iso} is the wrong year`);
  }
  if (!NAME_FORMAT.test(String(filename || "").trim()) && !lines.length) lines.push("File name is not in the standard format");
  return lines;
}
function firstName(name) {
  const w = String(name || "").trim().split(/\s+/).filter(Boolean);
  return w[0] || "there";
}
function draftText(name, filename, lines) {
  const why = lines.slice(0, 2).join(". ");
  return `Hi ${firstName(name)}, the inventory sheet ${filename} needs a date fix (${why}). Please resend it to inventory@mcrtechservice.com with the count date in the Inv Date cell and as YYYYMMDD in the file name. Thanks.`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad JSON" }); }

  const today = etDate(new Date());
  const since = /^\d{4}-\d{2}-\d{2}$/.test(body.since || "") ? body.since : addDays(today, -14);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: techs } = await supabase.from("technicians").select("id, name, home_state, email, phone, sms_address, is_contractor").eq("active", true);
  const roster = techs || [];

  const { data: rows, error } = await supabase
    .from("inventory_sheets")
    .select("id, filename, received_at, tech:parsed->>techName, inv:parsed->>invDate")
    .gte("received_at", since + "T00:00:00-04:00")
    .not("parsed", "is", null)
    .order("received_at", { ascending: false })
    .limit(800);
  if (error) return json(500, { error: error.message });

  const latest = new Map();
  for (const r of rows || []) {
    const tech = resolveSheetTech(roster, r.tech);
    const key = tech ? tech.id : "name:" + String(r.tech || r.filename).toLowerCase();
    if (latest.has(key)) continue;
    const arrived = etDate(r.received_at);
    const lines = fixLines(r.filename, r.inv || null, arrived);
    if (!lines.length) continue;
    const display = tech ? tech.name : (r.tech || "Unmatched");
    latest.set(key, {
      id: r.id,
      name: display,
      state: tech ? tech.home_state : null,
      filename: r.filename,
      sheetDate: r.inv || null,
      smsAddress: tech && tech.sms_address ? tech.sms_address : null,
      phone: tech && tech.phone ? tech.phone : null,
      issues: lines,
      text: draftText(display, r.filename, lines),
    });
  }
  let drafts = [...latest.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (body.id) drafts = drafts.filter((d) => d.id === body.id);
  if (body.confirm && body.id && body.text && drafts[0]) drafts[0].text = String(body.text).slice(0, 600);

  return json(200, {
    ok: true,
    shadow: true,
    sent: false,
    since,
    count: drafts.length,
    drafts,
    note: "Shadow only. Confirm does not text.",
  });
};
