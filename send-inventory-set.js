/**
 * send-inventory-set.js  (v1, 2026-10-05)
 * SAVE AS: netlify/functions/send-inventory-set.js
 *
 * Builds the weekly inventory set from saved sheets that have a matching date
 * and a standard file name, and can mail it. The address is supplied by the
 * caller (the board field), so a test address can be used before a real one.
 *
 * POST { to, since, state, subject, note, confirm }
 *   confirm omitted or false: preview only, nothing is sent
 *   confirm true: sends, and attaches the ready spreadsheets
 *
 * Does not pick an address on its own. One to three addresses, comma separated.
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");

const NAME_FORMAT = /^[A-Z]{2}(?:\s*,\s*[A-Z]{2})*\s*SST\s*-\s*MCR\s+[A-Za-z.'_ ]+?\s*-\s*\d{8}\.(xlsx|xls)$/i;
const STALE_DAYS = 7;
const MAX_FILES = 40;
const MAX_BYTES = 18 * 1024 * 1024;

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
  if (!all.length) return { iso: null, valid: false, raw: null };
  const m = all[all.length - 1];
  const valid = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  return { raw: m[0], iso: valid ? `${m[1]}-${m[2]}-${m[3]}` : null, valid };
}
function issuesFor(filename, sheetIso, arrived) {
  const issues = [];
  const fd = fileDateOf(filename);
  if (!sheetIso) issues.push("No readable date inside the sheet");
  if (!fd.raw) issues.push("File name has no YYYYMMDD date");
  else if (!fd.valid) issues.push("File name date is not a real date");
  if (sheetIso && fd.iso && sheetIso !== fd.iso) issues.push("File name and sheet date do not match");
  else {
    for (const [label, iso] of [["File name", fd.iso], ["Sheet", sheetIso]]) {
      if (!iso) continue;
      if (Number(iso.slice(0, 4)) !== Number(arrived.slice(0, 4)) && Math.abs(dayDiff(iso, arrived)) > 40) issues.push(label + " date is the wrong year");
      else if (dayDiff(iso, arrived) > 1) issues.push(label + " date is in the future");
      else if (dayDiff(arrived, iso) > STALE_DAYS) issues.push(label + " date is more than " + STALE_DAYS + " days old");
    }
  }
  if (!NAME_FORMAT.test(String(filename || "").trim())) issues.push("File name is not in the standard format");
  return issues;
}
function addressesOf(raw) {
  return [...new Set(String(raw || "").split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)))];
}
function lineFor(it) {
  const bits = [it.code, it.name, "count " + (it.count == null ? "-" : it.count)];
  if (it.toOrder) bits.push("order " + it.toOrder);
  if (it.comment) bits.push("note: " + it.comment);
  return bits.filter(Boolean).join(" | ");
}

async function buildSet(supabase, since, stateFilter) {
  const { data: techs } = await supabase.from("technicians").select("id, name, home_state").eq("active", true);
  const roster = techs || [];
  const { data: rows, error } = await supabase
    .from("inventory_sheets")
    .select("id, inbound_email_id, filename, storage_path, received_at, parsed")
    .gte("received_at", since + "T00:00:00-04:00")
    .not("parsed", "is", null)
    .order("received_at", { ascending: false })
    .limit(400);
  if (error) throw new Error(error.message);

  const emailIds = [...new Set((rows || []).map((r) => r.inbound_email_id).filter(Boolean))];
  const mailById = new Map();
  for (let i = 0; i < emailIds.length; i += 80) {
    const { data: em } = await supabase.from("inbound_emails").select("id, sender, subject, body_text").in("id", emailIds.slice(i, i + 80));
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
    const issues = issuesFor(r.filename, parsed.invDate || null, arrived);
    const concerns = (parsed.items || []).filter((it) => it && (it.comment || it.toOrder)).map(lineFor);
    latest.set(key, {
      id: r.id,
      name: tech ? tech.name : (parsed.techName || "Unmatched"),
      state: tech ? tech.home_state : "",
      filename: r.filename,
      storagePath: r.storage_path,
      sheetDate: parsed.invDate || "",
      emailId: r.inbound_email_id,
      ready: issues.length === 0 && !!r.storage_path,
      issues,
      concerns,
    });
  }
  const sheets = [...latest.values()].sort((a, b) => String(a.state).localeCompare(String(b.state)) || String(a.name).localeCompare(String(b.name)));
  const notes = [];
  const seen = new Set();
  for (const s of sheets) {
    if (!s.emailId || seen.has(s.emailId)) continue;
    seen.add(s.emailId);
    const mail = mailById.get(s.emailId);
    if (!mail || !mail.body_text) continue;
    notes.push({ subject: mail.subject || "", text: String(mail.body_text).replace(/\r/g, "").trim().slice(0, 2500) });
  }
  return { sheets, notes };
}

function stripSignature(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((line) => /^(--|—|director of operations|mcr technical service)/i.test(line.trim()) || /^\(?\d{3}\)?\s*\d{3}-\d{4}/.test(line.trim()));
  return (cut > 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}
function previewText(since, sheets, notes, extraNote) {
  const ready = sheets.filter((s) => s.ready);
  const held = sheets.filter((s) => !s.ready);
  const lines = [];
  if (extraNote) { lines.push(extraNote); lines.push(""); }
  lines.push("Inventory count sheets since " + since + " are attached (" + ready.length + ").");
  lines.push("");
  const noteBody = notes.map((n) => stripSignature(n.text)).filter(Boolean);
  if (noteBody.length) {
    lines.push(noteBody.join("\n\n"));
    lines.push("");
  }
  if (held.length) lines.push("Held back (date or file name not ready): " + held.map((s) => s.name).join(", "));
  return lines.join("\n").trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad JSON" }); }

  const today = etDate(new Date());
  const since = /^\d{4}-\d{2}-\d{2}$/.test(body.since || "") ? body.since : addDays(today, -14);
  const stateFilter = String(body.state || "").trim().toUpperCase();
  const to = addressesOf(body.to);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let built;
  try { built = await buildSet(supabase, since, stateFilter); }
  catch (err) { return json(500, { error: err.message }); }

  const ready = built.sheets.filter((s) => s.ready);
  const builtText = previewText(since, built.sheets, built.notes, String(body.note || "").trim());
  const text = String(body.body || "").trim() || builtText;
  const subject = String(body.subject || "").trim() || ("Inventory counts since " + since);
  const preview = {
    ok: true,
    sent: false,
    since,
    to,
    subject,
    readyCount: ready.length,
    heldCount: built.sheets.length - ready.length,
    files: ready.map((s) => s.filename),
    held: built.sheets.filter((s) => !s.ready).map((s) => ({ name: s.name, state: s.state, issues: s.issues })),
    text,
  };
  if (!body.confirm) return json(200, preview);
  if (!to.length || to.length > 3) return json(400, { ...preview, error: "Enter one to three email addresses before sending." });
  if (!ready.length) return json(400, { ...preview, error: "No sheets are ready to send." });

  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || "mcrdispatch.net";
  if (!apiKey) return json(500, { ...preview, error: "MAILGUN_API_KEY not set" });

  const form = new FormData();
  form.append("from", "MCR Inventory <dispatch@" + domain + ">");
  form.append("to", to.join(", "));
  form.append("h:Reply-To", "inventory@mcrtechservice.com");
  form.append("subject", subject);
  form.append("text", text);

  let bytes = 0;
  let attached = 0;
  for (const s of ready) {
    if (attached >= MAX_FILES || bytes >= MAX_BYTES) break;
    const { data, error } = await supabase.storage.from("inventory-sheets").download(s.storagePath);
    if (error || !data) continue;
    const buf = Buffer.from(await data.arrayBuffer());
    if (bytes + buf.length > MAX_BYTES) continue;
    bytes += buf.length;
    attached++;
    form.append("attachment", new Blob([buf]), s.filename);
  }
  if (!attached) return json(500, { ...preview, error: "Could not read the saved spreadsheets." });

  const resp = await fetch("https://api.mailgun.net/v3/" + domain + "/messages", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from("api:" + apiKey).toString("base64") },
    body: form,
  });
  const raw = await resp.text();
  if (!resp.ok) return json(502, { ...preview, error: "Mail send failed (" + resp.status + "). " + raw.slice(0, 300) });
  return json(200, { ...preview, sent: true, attached, to });
};
