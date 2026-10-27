/**
 * get-timesheet-receipts.js  (v1.3, 2026-10-26)
 * SAVE AS: netlify/functions/get-timesheet-receipts.js
 *
 * v1.3 (2026-10-26): a sheet where fewer than half the hops matched a known site is no longer
 * "fine" or a bare "needs a look". It gets its own status, "unverified": little or nothing could be
 * checked, so nothing is confirmed either way. Found on a sheet with 0 of 55 hops matched that still
 * read "Nothing in this sheet looks out of line". A real flag (a bad hop, a bad day total, a period
 * far off the person's own history) still wins and stays "flagged". Derived at read time from the
 * stored report, so existing reports pick it up without being re-checked. Counted under
 * mileage.unverified. LOW_COVERAGE must match lowCoverage() in mileage.html.
 *
 * v1.2 (2026-10-25): optional &mileage=1 adds, for the Mileage Check page, each
 * received person's saved sheet(s) (timesheet_files) and newest mileage report for the
 * period, plus a status: flagged / fine / no_mileage (a sheet was kept but no mileage
 * could be read from it) / no_file (the email arrived with no spreadsheet kept).
 * Reports with no matching person on the roster come back as otherReports.
 * Each person also gets hours { weeks, total, overtime, overtimeWeeks } read from the saved sheet's
 * Time tab (a week over 40 hours is overtime). Files saved before hours were recorded are read
 * once, on demand, and the answer stored on the file row (at most 12 per request).
 * Without &mileage=1 the answer is the same as v1.1, so the Timesheet board is untouched.
 *
 * v1.1 (2026-10-12): Tom Ellison added to NOT_EXPECTED (TJ: he does not work for
 * MCR). Lance Wise and Brit Kees stay expected: TJ confirmed they file time sheets.
 * Contractors, including the company crews (Next Gig, Alliance Tech, Arcitechx,
 * Dr. Joel), are already left out because they are flagged is_contractor.
 *
 * Who has sent in the bi-weekly time and expense sheet, and who has not, for one
 * pay period. Same idea as the inventory board: inbound mail is matched to the
 * active technician roster and the people still missing are listed.
 *
 * GET /.netlify/functions/get-timesheet-receipts
 *      optional: &end=2026-10-24 (the Saturday the period ends)
 *                &state=GA  &includeContractors=1
 *
 * PAY PERIODS: two weeks, ending on a Saturday. Period ends fall on 2026-10-10,
 * 2026-10-24, 2026-11-07 and so on (ANCHOR_END below). With no &end= the period
 * is the first one ending on or after four days ago, so it switches over the
 * Wednesday after a period closes and people can still be chased for a few days.
 * Mail counts if it arrived from the Sunday that starts the period until four
 * days after it ends (early senders and late ones both land in the right period).
 *
 * WHAT COUNTS AS A TIMESHEET EMAIL (the mail has no attachment record, so this
 * goes by the address and the subject):
 *   - sent to expense@mcrtechservice.com, or
 *   - from an mcrtechservice.com address with expense / time sheet / timecard /
 *     T&E / mileage / PPE in the subject.
 *   Inventory mail and Drive "I am sharing" notices are left out.
 *
 * WHO IS MATCHED, best signal first (one email credits one person):
 *   1. a technician's full name in the subject, or a last name only one of them has
 *   2. the From address equals the address on the technician card
 *      (also for "Fwd:" mail the technician forwarded from their own address)
 *   3. the full name near the top of the body (not for mail forwarded by the office)
 * Never guesses: two possible people means it stays in "unmatched" with a reason.
 *
 * Contractors invoice rather than file a time sheet, so they are left out unless
 * &includeContractors=1.
 */
const { createClient } = require("@supabase/supabase-js");

const ANCHOR_END = "2026-10-10"; // a Saturday that closed a pay period
const WINDOW_DAYS_BEFORE_END = 13; // period start is the Sunday 13 days before
const WINDOW_DAYS_AFTER_END = 4; // late senders are still credited
const NOT_EXPECTED = ["TJ Kadri", "Tom Ellison"];
const NOT_LIVE = [{ state: "CA", liveFrom: "2026-11-01" }];
// Addresses that pass other people's sheets along; From is no clue about who filed.
const OFFICE_ADDRESSES = new Set(["tkadri@mcrtechservice.com", "mbecker@mcrtechservice.com", "expense@mcrtechservice.com", "inventory@mcrtechservice.com", "dispatch@mcrdispatch.net"]);

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}

// ---- dates (all Eastern calendar days, handled as plain y-m-d) ----
function dayNumber(ymd) { const [y, m, d] = ymd.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
function fromDayNumber(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function addDays(ymd, n) { return fromDayNumber(dayNumber(ymd) + n); }
function etOffset(ymd) {
  // US daylight time: second Sunday of March to first Sunday of November
  const y = Number(ymd.slice(0, 4));
  const nthSunday = (month, n) => { const first = new Date(Date.UTC(y, month, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1); };
  const pad = (n) => String(n).padStart(2, "0");
  const start = y + "-03-" + pad(nthSunday(2, 2));
  const end = y + "-11-" + pad(nthSunday(10, 1));
  return ymd >= start && ymd < end ? "-04:00" : "-05:00";
}
function periodEndFor(todayEt) {
  const target = dayNumber(todayEt) - WINDOW_DAYS_AFTER_END;
  const anchor = dayNumber(ANCHOR_END);
  const n = Math.ceil((target - anchor) / 14);
  return fromDayNumber(anchor + n * 14);
}
function isPeriodEnd(ymd) { return (dayNumber(ymd) - dayNumber(ANCHOR_END)) % 14 === 0; }

// ---- mileage view (v1.2) ----
const { parseTimesheetHoursBuffer } = require("./lib/timesheet-hours.js");
const REPORT_COLS = "id, technician_id, technician_name_raw, pay_period_end, source, source_email_id, source_filename, total_legs, matched_legs, total_claimed_miles, total_expected_miles, flagged_legs, unmatched_legs, day_summaries, history_comparison, needs_review, processed_at";

// v1.3: below this share of hops matched, a sheet could not really be checked. Keep in step with mileage.html.
const LOW_COVERAGE = 0.5;
function coverageOf(rep) {
  const t = Number(rep.total_legs) || 0;
  return t > 0 ? (Number(rep.matched_legs) || 0) / t : 1;
}
// A flag that stands on its own evidence: a bad hop (not one whose day adds up), a bad day total,
// or a period far off the person's own history.
function hasRealFlag(rep) {
  return (rep.flagged_legs || []).some((f) => !f.dayFits)
    || (rep.day_summaries || []).some((d) => d.flagged)
    || !!(rep.history_comparison && rep.history_comparison.flagged);
}
function mileageStatus(rep, hasFiles) {
  if (!rep) return hasFiles ? "no_mileage" : "no_file";
  if (hasRealFlag(rep)) return "flagged";
  if (coverageOf(rep) < LOW_COVERAGE) return "unverified";
  return rep.needs_review ? "flagged" : "fine";
}

/**
 * Pure: attach files + newest report to each received person. A person with no email counted
 * but a report in the period (sheet uploaded by hand, or mail that came through another
 * address) moves from missing to received, so the board does not chase someone whose sheet
 * is already on file. Mutates received / missing.
 */
function attachMileage(received, missing, unmatched, files, reports) {
  const filesByEmail = new Map();
  for (const f of files) { const a = filesByEmail.get(f.inbound_email_id) || []; a.push(f); filesByEmail.set(f.inbound_email_id, a); }
  const newestFirst = (a, b) => String(b.processed_at).localeCompare(String(a.processed_at));
  const reportsByTech = new Map();
  for (const r of reports.slice().sort(newestFirst)) { if (!r.technician_id) continue; const a = reportsByTech.get(r.technician_id) || []; a.push(r); reportsByTech.set(r.technician_id, a); }
  const used = new Set();
  const rosterIds = new Map();
  for (const p of received) rosterIds.set(p.id, p);
  for (let i = missing.length - 1; i >= 0; i--) {
    const m = missing[i];
    const mine = reportsByTech.get(m.id);
    if (!mine || !mine.length) continue;
    const rep = mine[0];
    missing.splice(i, 1);
    const p = { id: m.id, name: m.name, state: m.state, subject: rep.source_filename || "(sheet uploaded)", receivedAt: rep.processed_at, matchedBy: "upload", emails: 0, emailIds: [] };
    received.push(p);
    rosterIds.set(p.id, p);
  }
  const fileInfo = (f) => ({ id: f.id, filename: f.filename, sizeBytes: f.size_bytes, receivedAt: f.received_at });
  for (const p of received) {
    const myFiles = [];
    for (const id of p.emailIds || []) for (const f of filesByEmail.get(id) || []) myFiles.push(fileInfo(f));
    const mine = reportsByTech.get(p.id) || [];
    const rep = mine[0] || null;
    if (rep) used.add(rep.id);
    p.files = myFiles;
    // newest saved sheet whose Time tab could be read
    const withHours = (p.emailIds || []).flatMap((id) => filesByEmail.get(id) || []).filter((f) => f.hours && f.hours.ok)
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)))[0];
    p.hours = withHours ? withHours.hours : null;
    p.overtime = !!(p.hours && p.hours.overtime);
    p.report = rep;
    p.reportCount = mine.length;
    p.status = mileageStatus(rep, myFiles.length > 0);
  }
  for (const u of unmatched) {
    u.files = (filesByEmail.get(u.id) || []).map(fileInfo);
  }
  const otherReports = reports.filter((r) => !(r.technician_id && rosterIds.has(r.technician_id)));
  return { otherReports: otherReports.sort(newestFirst) };
}

// ---- mail filter ----
const TIME_SUBJECT = /(time\s*sheet|timesheet|time\s*card|timecard|expense|\bt\s*&\s*e\b|\bt\s*and\s*e\b|mileage|\bppe\b|\bexp\b)/i;
function isTimesheetMail(e) {
  const to = String(e.to_address || "").toLowerCase();
  const sub = String(e.subject || "");
  const snd = String(e.sender || "").toLowerCase();
  if (/i am sharing/i.test(sub)) return false;
  if (/service response/i.test(sub)) return false;
  const inventoryOnly = /\binv(entory)?\b/i.test(sub) && !TIME_SUBJECT.test(sub);
  if (inventoryOnly) return false;
  if (to.includes("expense@mcrtechservice.com")) return true;
  if (snd.includes("mcrtechservice.com") && TIME_SUBJECT.test(sub) && !/inventory/i.test(sub)) return true;
  return false;
}

// ---- name matching (same approach as the inventory board) ----
function words(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, "")).filter(Boolean);
}
function nameParts(name) { const w = words(name); return { first: w[0] || "", last: w.length > 1 ? w[w.length - 1] : "" }; }
function addressOf(s) { const m = String(s || "").match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); return m ? m[0].toLowerCase() : ""; }
function techEmails(t) { return [t.email].filter(Boolean).join(" ").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")); }
function hasWords(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function resolveEmail(email, roster) {
  const senderAddr = addressOf(email.sender);
  const fromOffice = OFFICE_ADDRESSES.has(senderAddr);
  const subjectWords = words(email.subject);

  const full = roster.filter((t) => { const { first, last } = nameParts(t.name); return first && last && hasWords(subjectWords, [first]) && hasWords(subjectWords, [last]); });
  if (full.length === 1) return { tech: full[0], matchedBy: "subject" };
  let ambiguous = full.length > 1;

  const lastHits = roster.filter((t) => { const { last } = nameParts(t.name); return last.length >= 3 && hasWords(subjectWords, [last]); });
  if (lastHits.length === 1) return { tech: lastHits[0], matchedBy: "subject" };
  if (lastHits.length > 1) ambiguous = true;

  if (!fromOffice && senderAddr) {
    const byFrom = roster.filter((t) => techEmails(t).includes(senderAddr));
    if (byFrom.length === 1) return { tech: byFrom[0], matchedBy: "from" };
    if (byFrom.length > 1) ambiguous = true;
    // same mailbox name on the company domain, e.g. rthomas@ for Randy Thomas
    if (!byFrom.length && /@mcrtechservice\.com$/.test(senderAddr)) {
      const local = senderAddr.split("@")[0];
      const byLocal = roster.filter((t) => { const { first, last } = nameParts(t.name); return first && last && (local === first[0] + last || local === first + last || local === first + "." + last); });
      if (byLocal.length === 1) return { tech: byLocal[0], matchedBy: "from" };
      if (byLocal.length > 1) ambiguous = true;
    }
  }

  if (!fromOffice) {
    const top = words(String(email.body_text || "").slice(0, 600));
    const bySig = roster.filter((t) => { const { first, last } = nameParts(t.name); return first && last && hasWords(top, [first]) && hasWords(top, [last]); });
    if (bySig.length === 1) return { tech: bySig[0], matchedBy: "body" };
    if (bySig.length > 1) ambiguous = true;
  }

  if (ambiguous) return { tech: null, reason: "More than one technician fits. Put the full name in the subject." };
  if (fromOffice) return { tech: null, reason: "Passed along from the office, and no technician name in the subject." };
  return { tech: null, reason: "No technician name or known address found." };
}

/** Pure, so it can be tested without a database. mail is newest-first. */
function matchTimesheets(roster, mail) {
  const byTech = new Map();
  const unmatched = [];
  for (const e of mail) {
    const r = resolveEmail(e, roster);
    if (!r.tech) { unmatched.push({ id: e.id, subject: e.subject, sender: e.sender, receivedAt: e.received_at, reason: r.reason }); continue; }
    const cur = byTech.get(r.tech.id);
    if (cur) { cur.count += 1; cur.ids.push(e.id); continue; }
    byTech.set(r.tech.id, { e, matchedBy: r.matchedBy, count: 1, ids: [e.id] });
  }
  const received = [];
  const missing = [];
  for (const t of roster) {
    const hit = byTech.get(t.id);
    if (hit) received.push({ id: t.id, name: t.name, state: t.home_state, subject: hit.e.subject, receivedAt: hit.e.received_at, matchedBy: hit.matchedBy, emails: hit.count, emailIds: hit.ids });
    else missing.push({ id: t.id, name: t.name, state: t.home_state, email: t.email || null, phone: t.phone || null });
  }
  return { received, missing, unmatched };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method Not Allowed" });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Supabase env vars not configured" });

  const params = event.queryStringParameters || {};
  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  let end = String(params.end || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !isPeriodEnd(end)) end = periodEndFor(todayEt);
  const start = addDays(end, -WINDOW_DAYS_BEFORE_END);
  const until = addDays(end, WINDOW_DAYS_AFTER_END);
  const sinceIso = start + "T00:00:00" + etOffset(start);
  const untilIso = addDays(until, 1) + "T00:00:00" + etOffset(addDays(until, 1));
  const includeContractors = params.includeContractors === "1";
  const stateFilter = String(params.state || "").trim().toUpperCase();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: techs, error: tErr } = await supabase
    .from("technicians").select("id, name, home_state, email, phone, active, is_contractor")
    .eq("active", true).order("home_state", { ascending: true }).order("name", { ascending: true });
  if (tErr) return json(500, { error: tErr.message });

  let roster = (techs || [])
    .filter((t) => !NOT_EXPECTED.some((n) => n.toLowerCase() === String(t.name || "").toLowerCase()))
    .filter((t) => !/unassigned|placeholder|new site|tmp[-_]?site/i.test(String(t.name || "")));
  if (!includeContractors) roster = roster.filter((t) => !t.is_contractor);
  const hidden = new Set(NOT_LIVE.filter((x) => todayEt < x.liveFrom).map((x) => x.state));
  roster = roster.filter((t) => !hidden.has(String(t.home_state || "").toUpperCase()));
  if (/^[A-Z]{2}$/.test(stateFilter)) roster = roster.filter((t) => String(t.home_state || "").toUpperCase() === stateFilter);

  const { data: mails, error: mErr } = await supabase
    .from("inbound_emails").select("id, received_at, sender, subject, to_address, body_text")
    .gte("received_at", sinceIso).lt("received_at", untilIso)
    .order("received_at", { ascending: false }).limit(800);
  if (mErr) return json(500, { error: mErr.message });

  const { received, missing, unmatched } = matchTimesheets(roster, (mails || []).filter(isTimesheetMail));
  const out = { ok: true, periodEnd: end, periodStart: start, countedUntil: until, techCount: roster.length, includeContractors, received, missing, unmatched };

  if (params.mileage === "1") {
    const emailIds = Array.from(new Set(received.flatMap((p) => p.emailIds || []).concat(unmatched.map((u) => u.id)).filter(Boolean)));
    let files = [];
    let reports = [];
    if (emailIds.length) {
      const { data: fRows, error: fErr } = await supabase.from("timesheet_files")
        .select("id, inbound_email_id, filename, size_bytes, received_at, storage_path, hours, hours_checked_at").in("inbound_email_id", emailIds);
      if (fErr) return json(500, { error: fErr.message });
      files = fRows || [];
      // one-time read of sheets saved before hours were recorded
      let budget = 12;
      for (const f of files) {
        if (budget <= 0) break;
        if (f.hours_checked_at || f.hours || !/\.(xlsx|xlsm|xls)$/i.test(f.filename || "")) continue;
        budget -= 1;
        try {
          const dl = await supabase.storage.from("timesheet-files").download(f.storage_path);
          if (dl.error || !dl.data) continue;
          const buf = Buffer.from(await dl.data.arrayBuffer());
          f.hours = parseTimesheetHoursBuffer(buf);
          f.hours_checked_at = new Date().toISOString();
          await supabase.from("timesheet_files").update({ hours: f.hours, hours_checked_at: f.hours_checked_at }).eq("id", f.id);
        } catch (e) { /* leave it unread; tried again next time */ }
      }
    }
    // Reports belong to the period their last mileage date falls in, or to any email counted above.
    const q1 = await supabase.from("technician_mileage_reports").select(REPORT_COLS).gte("pay_period_end", start).lte("pay_period_end", end).limit(300);
    if (q1.error) return json(500, { error: q1.error.message });
    reports = q1.data || [];
    if (emailIds.length) {
      const q2 = await supabase.from("technician_mileage_reports").select(REPORT_COLS).in("source_email_id", emailIds).limit(300);
      if (q2.error) return json(500, { error: q2.error.message });
      const have = new Set(reports.map((r) => r.id));
      for (const r of q2.data || []) if (!have.has(r.id)) reports.push(r);
    }
    const extra = attachMileage(received, missing, unmatched, files, reports);
    // names for reports that are not on the roster
    const unknownIds = Array.from(new Set(extra.otherReports.map((r) => r.technician_id).filter(Boolean)));
    const nameById = new Map();
    if (unknownIds.length) {
      const { data: tn } = await supabase.from("technicians").select("id, name, home_state").in("id", unknownIds);
      for (const t of tn || []) nameById.set(t.id, t);
    }
    // 2026-10-26: the sheet file behind each of these, so a sheet that was not tied to anyone can be re-checked
    // (after a name or roster fix) from the "Other sheets read" box like any other sheet.
    const otherFilesByEmail = new Map();
    const otherEmailIds = Array.from(new Set(extra.otherReports.map((r) => r.source_email_id).filter(Boolean)));
    if (otherEmailIds.length) {
      const { data: ofRows } = await supabase.from("timesheet_files").select("id, inbound_email_id, filename").in("inbound_email_id", otherEmailIds);
      for (const f of ofRows || []) {
        if (!otherFilesByEmail.has(f.inbound_email_id)) otherFilesByEmail.set(f.inbound_email_id, []);
        otherFilesByEmail.get(f.inbound_email_id).push({ id: f.id, filename: f.filename });
      }
    }
    out.otherReports = extra.otherReports.map((r) => ({ ...r, files: otherFilesByEmail.get(r.source_email_id) || [], technicianName: (nameById.get(r.technician_id) || {}).name || r.technician_name_raw, state: (nameById.get(r.technician_id) || {}).home_state || null }));
    out.mileage = {
      read: received.filter((p) => p.report).length,
      flagged: received.filter((p) => p.status === "flagged").length,
      unverified: received.filter((p) => p.status === "unverified").length,
      noMileage: received.filter((p) => p.status === "no_mileage" || p.status === "no_file").length,
      overtime: received.filter((p) => p.overtime).length,
    };
  }
  return json(200, out);
};

// Exposed for tests only.
exports._matchTimesheets = matchTimesheets;
exports._isTimesheetMail = isTimesheetMail;
exports._periodEndFor = periodEndFor;
exports._attachMileage = attachMileage;
exports._mileageStatus = mileageStatus;
