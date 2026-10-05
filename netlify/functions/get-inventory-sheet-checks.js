/**
 * get-inventory-sheet-checks.js  (v1, 2026-10-05)
 * SAVE AS: netlify/functions/get-inventory-sheet-checks.js
 *
 * Looks at every saved inventory count sheet and lists the ones with a date or
 * file-name problem, so they can be corrected right after they arrive instead
 * of at month-end. READ-ONLY: it sends nothing. (A later step can message the
 * technician with the same list; the contact details are included for that.)
 *
 * Two things must both be right on every sheet:
 *   1. the FILE NAME:  "<STATE> SST - MCR <NAME> - YYYYMMDD.xlsx"
 *   2. the DATE CELL inside the sheet ("Inv Date")
 * and the two dates should agree and be the day the count was done.
 *
 * Problems reported (kind = "fix" must be corrected, "note" is tidy-up):
 *   fix   no readable date in the sheet
 *   fix   file name has no YYYYMMDD date
 *   fix   file name and sheet disagree (both dates shown)
 *   fix   a date is in the future, or in the wrong year
 *   fix   a date is more than 7 days before the day the sheet arrived
 *   note  same sheet date as that technician's previous sheet (old sheet reused?)
 *   note  file name does not follow the standard format
 *
 * GET ?since=YYYY-MM-DD (default: 14 days ago, Eastern)
 */
const { createClient } = require("@supabase/supabase-js");
const { resolveSheetTech } = require("./lib/inventory-names.js");

const STALE_DAYS = 7;
// The name part may not contain " - " (that is how extras like "- MASTER SHEET -" sneak in).
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

// Problems with one date (file or sheet) relative to the day the sheet arrived.
function dateProblems(label, iso, arrived) {
  const out = [];
  if (!iso) return out;
  if (Number(iso.slice(0, 4)) !== Number(arrived.slice(0, 4)) && Math.abs(dayDiff(iso, arrived)) > 40) {
    out.push({ kind: "fix", code: "wrong_year", text: `${label} date ${iso} is the wrong year` });
  } else if (dayDiff(iso, arrived) > 1) {
    out.push({ kind: "fix", code: "future", text: `${label} date ${iso} is in the future` });
  } else if (dayDiff(arrived, iso) > STALE_DAYS) {
    out.push({ kind: "fix", code: "old", text: `${label} date ${iso} is more than ${STALE_DAYS} days before it was sent` });
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });
  const q = event.queryStringParameters || {};
  const today = etDate(new Date());
  const since = /^\d{4}-\d{2}-\d{2}$/.test(q.since || "") ? q.since : addDays(today, -14);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: techs } = await supabase.from("technicians").select("id, name, home_state, email, is_contractor").eq("active", true);
  const roster = techs || [];

  // Look back 60 days so "same date as the previous sheet" has something to compare to.
  const lookback = addDays(since, -46);
  const { data: rows, error } = await supabase
    .from("inventory_sheets")
    .select("id, inbound_email_id, filename, received_at, tech:parsed->>techName, inv:parsed->>invDate")
    .gte("received_at", lookback + "T00:00:00-04:00")
    .not("parsed", "is", null)
    .order("received_at", { ascending: true })
    .limit(2000);
  if (error) return json(500, { error: error.message });

  const emailIds = [...new Set((rows || []).map((r) => r.inbound_email_id).filter(Boolean))];
  const senderById = new Map();
  for (let i = 0; i < emailIds.length; i += 100) {
    const { data: em } = await supabase.from("inbound_emails").select("id, sender").in("id", emailIds.slice(i, i + 100));
    for (const e of em || []) senderById.set(e.id, e.sender || "");
  }

  // One entry per (technician, file, sheet date): a sheet sent twice (directly,
  // then again inside a combined email) is checked once, using the latest copy.
  const entries = new Map();
  for (const r of rows || []) {
    const tech = resolveSheetTech(roster, r.tech);
    const key = (tech ? tech.id : "name:" + String(r.tech || "").toLowerCase()) + "|" + String(r.filename).toLowerCase() + "|" + (r.inv || "");
    entries.set(key, { r, tech });
  }
  const byTech = new Map();
  for (const { r, tech } of entries.values()) {
    const k = tech ? tech.id : "name:" + String(r.tech || "").toLowerCase();
    if (!byTech.has(k)) byTech.set(k, []);
    byTech.get(k).push({ r, tech });
  }

  const sheets = [];
  let checked = 0;
  for (const list of byTech.values()) {
    list.sort((a, b) => String(a.r.received_at).localeCompare(String(b.r.received_at)));
    list.forEach(({ r, tech }, idx) => {
      const arrived = etDate(r.received_at);
      if (arrived < since) return;
      checked++;
      const issues = [];
      const fd = fileDateOf(r.filename);
      const sheetIso = r.inv || null;

      if (!sheetIso) issues.push({ kind: "fix", code: "no_sheet_date", text: "No readable date inside the sheet" });
      if (!fd.raw) issues.push({ kind: "fix", code: "no_file_date", text: "File name has no YYYYMMDD date" });
      else if (!fd.valid) issues.push({ kind: "fix", code: "bad_file_date", text: `File name date ${fd.raw} is not a real date` });

      if (sheetIso && fd.iso && sheetIso !== fd.iso) {
        issues.push({ kind: "fix", code: "mismatch", text: `File name says ${fd.iso}, the sheet says ${sheetIso}` });
      } else {
        issues.push(...dateProblems("File name", fd.iso, arrived));
        issues.push(...dateProblems("Sheet", sheetIso, arrived));
        // a wrong year in an unreal/odd file name still deserves a flag
        if (fd.raw && !fd.valid) { /* already reported */ }
      }
      if (fd.iso && !sheetIso && Number(fd.year) !== Number(arrived.slice(0, 4)) && !issues.some((i) => i.code === "wrong_year")) {
        issues.push({ kind: "fix", code: "wrong_year", text: `File name date ${fd.iso} is the wrong year` });
      }

      // repeated date: an earlier, different submission by the same person with the same sheet date
      if (sheetIso) {
        const earlier = list.slice(0, idx).find((o) => o.r.inv === sheetIso && String(o.r.filename).toLowerCase() !== String(r.filename).toLowerCase());
        if (earlier) issues.push({ kind: "note", code: "repeat", text: `Same sheet date (${sheetIso}) as their previous sheet` });
      }
      if (!NAME_FORMAT.test(String(r.filename || "").trim())) {
        issues.push({ kind: "note", code: "format", text: "File name is not in the standard format (STATE SST - MCR NAME - YYYYMMDD)" });
      }

      const sender = senderById.get(r.inbound_email_id) || "";
      sheets.push({
        id: r.id,
        name: tech ? tech.name : r.tech,
        state: tech ? tech.home_state : null,
        contractor: tech ? !!tech.is_contractor : null,
        contactEmail: tech ? tech.email || null : null,
        filename: r.filename,
        receivedAt: r.received_at,
        sheetDate: sheetIso,
        fileDate: fd.iso,
        viaCombinedEmail: /tkadri@/i.test(sender),
        issues,
      });
    });
  }
  const withIssues = sheets.filter((s) => s.issues.length);
  withIssues.sort((a, b) => (b.issues.some((i) => i.kind === "fix") - a.issues.some((i) => i.kind === "fix")) || String(a.name).localeCompare(String(b.name)));
  return json(200, {
    ok: true, since, checked, needFix: withIssues.filter((s) => s.issues.some((i) => i.kind === "fix")).length,
    withIssues: withIssues.length, sheets: withIssues,
  });
};
