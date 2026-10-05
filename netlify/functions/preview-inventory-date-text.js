/**
 * preview-inventory-date-text.js  (v2, 2026-10-05)
 * SAVE AS: netlify/functions/preview-inventory-date-text.js
 *
 * One text per sheet with a real date problem (no date, bad file date,
 * file and sheet disagree, future or wrong year). Tidy file-name notes
 * are not texted.
 *
 * Auto is off until the board switch is turned on. The switch is stored in
 * app_settings (inventoryDateTextAuto). A schedule runs this file about
 * every 10 minutes and sends at most 3, so a big batch does not blast.
 * Send text on the board sends that one sheet now, after confirm.
 *
 * Does not put comment-column notes in the message.
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");

const STALE_DAYS = 7;
const AUTO_CAP = 3;
const SETTING_KEY = "inventoryDateTextAuto";

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
  if (!all.length) return { raw: null, iso: null, valid: false, year: null };
  const m = all[all.length - 1];
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const valid = validYmd(y, mo, d);
  return { raw: m[0], iso: valid ? `${m[1]}-${m[2]}-${m[3]}` : null, valid, year: y };
}
function dateProblems(label, iso, arrived) {
  const out = [];
  if (!iso) return out;
  if (Number(iso.slice(0, 4)) !== Number(arrived.slice(0, 4)) && Math.abs(dayDiff(iso, arrived)) > 40) out.push(`${label} date ${iso} is the wrong year`);
  else if (dayDiff(iso, arrived) > 1) out.push(`${label} date ${iso} is in the future`);
  else if (dayDiff(arrived, iso) > STALE_DAYS) out.push(`${label} date ${iso} is more than ${STALE_DAYS} days before it was sent`);
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
function truthy(v) {
  if (v === true || v === "true") return true;
  if (v && typeof v === "object" && (v.enabled === true || v === true)) return true;
  return false;
}

async function autoEnabled(supabase) {
  const { data } = await supabase.from("app_settings").select("value").eq("key", SETTING_KEY).limit(1);
  return truthy(data && data[0] && data[0].value);
}
async function setAuto(supabase, enabled) {
  const value = enabled ? true : false;
  const { data: existing } = await supabase.from("app_settings").select("key").eq("key", SETTING_KEY).limit(1);
  if (existing && existing.length) {
    const { error } = await supabase.from("app_settings").update({ value }).eq("key", SETTING_KEY);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from("app_settings").insert({ key: SETTING_KEY, value });
    if (error) throw new Error(error.message);
  }
  return value;
}
async function sentIds(supabase, ids) {
  if (!ids.length) return new Set();
  const { data } = await supabase.from("inventory_date_text_log").select("sheet_id").in("sheet_id", ids);
  return new Set((data || []).map((r) => r.sheet_id));
}
async function mailText(to, text) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || "mcrdispatch.net";
  if (!apiKey) throw new Error("MAILGUN_API_KEY not set");
  const params = new URLSearchParams({
    from: "MCR Dispatch <dispatch@" + domain + ">",
    to,
    subject: "MCR Dispatch",
    text,
  });
  const resp = await fetch("https://api.mailgun.net/v3/" + domain + "/messages", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from("api:" + apiKey).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!resp.ok) {
    const raw = await resp.text();
    throw new Error("Text failed (" + resp.status + "). " + raw.slice(0, 180));
  }
}
async function loadDrafts(supabase, since) {
  const { data: techs } = await supabase.from("technicians").select("id, name, home_state, phone, sms_address").eq("active", true);
  const roster = techs || [];
  const { data: rows, error } = await supabase
    .from("inventory_sheets")
    .select("id, filename, received_at, tech:parsed->>techName, inv:parsed->>invDate")
    .gte("received_at", since + "T00:00:00-04:00")
    .not("parsed", "is", null)
    .order("received_at", { ascending: true })
    .limit(800);
  if (error) throw new Error(error.message);
  const latest = new Map();
  for (const r of rows || []) {
    const tech = resolveSheetTech(roster, r.tech);
    if (!tech) continue;
    const arrived = etDate(r.received_at);
    const lines = fixLines(r.filename, r.inv || null, arrived);
    if (!lines.length) continue;
    latest.set(tech.id, {
      id: r.id,
      name: tech.name,
      state: tech.home_state || null,
      filename: r.filename,
      sheetDate: r.inv || null,
      smsAddress: tech.sms_address || null,
      phone: tech.phone || null,
      issues: lines,
      text: draftText(tech.name, r.filename, lines),
      receivedAt: r.received_at,
    });
  }
  const drafts = [...latest.values()].sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  const sent = await sentIds(supabase, drafts.map((d) => d.id));
  for (const d of drafts) d.alreadySent = sent.has(d.id);
  return drafts;
}
async function sendOne(supabase, draft, mode) {
  if (!draft.smsAddress) throw new Error("No text address on the card");
  if (draft.alreadySent) return { sent: false, reason: "already sent" };
  await mailText(draft.smsAddress, draft.text);
  const { error } = await supabase.from("inventory_date_text_log").insert({
    sheet_id: draft.id,
    mode,
    body: draft.text,
    destination: draft.smsAddress,
  });
  if (error && !/duplicate/i.test(error.message)) throw new Error(error.message);
  return { sent: true };
}
async function runAuto(supabase) {
  const on = await autoEnabled(supabase);
  if (!on) return { ok: true, auto: false, sent: 0 };
  const since = addDays(etDate(new Date()), -14);
  const drafts = (await loadDrafts(supabase, since)).filter((d) => d.smsAddress && !d.alreadySent).slice(0, AUTO_CAP);
  const results = [];
  for (const d of drafts) {
    try {
      const r = await sendOne(supabase, d, "auto");
      results.push({ id: d.id, name: d.name, sent: r.sent });
    } catch (err) {
      results.push({ id: d.id, name: d.name, sent: false, error: err.message });
    }
  }
  return { ok: true, auto: true, sent: results.filter((r) => r.sent).length, results };
}

exports.handler = async (event) => {
  if (!event.httpMethod) return json(200, await runAuto(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)));
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad JSON" }); }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    if (body.action === "set-auto") {
      const enabled = await setAuto(supabase, !!body.enabled);
      return json(200, { ok: true, auto: enabled });
    }
    const today = etDate(new Date());
    const since = /^\d{4}-\d{2}-\d{2}$/.test(body.since || "") ? body.since : addDays(today, -14);
    const auto = await autoEnabled(supabase);
    let drafts = await loadDrafts(supabase, since);
    if (body.id) drafts = drafts.filter((d) => d.id === body.id);
    if (body.confirm) {
      if (!drafts[0]) return json(404, { error: "That sheet is not waiting on a date text." });
      if (body.text) drafts[0].text = String(body.text).slice(0, 600);
      const result = await sendOne(supabase, drafts[0], "manual");
      return json(200, { ok: true, auto, sent: result.sent, drafts });
    }
    return json(200, { ok: true, auto, sent: false, since, count: drafts.length, drafts });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
