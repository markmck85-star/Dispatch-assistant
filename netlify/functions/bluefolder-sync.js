/**
 * netlify/functions/bluefolder-sync.js
 * ======================================================================
 * Two-way sync between TJ's BlueFolder master calendar (Appointments API)
 * and technician_availability in Supabase.
 *
 * PULL: fetches every appointment in a rolling window (today -> +60 days)
 *   with ONE unfiltered call, then matches each appointment back to a
 *   technician locally via assignedTo.userId against bluefolder_user_id.
 *   (Originally queried per-technician with a userId filter, but that
 *   parameter 404s "Data not found" for every technician on this account
 *   even though the identical unfiltered request succeeds -- confirmed via
 *   diagnose-appointments-variants.js, 2026-07-21. This also happens to be
 *   faster: one API call instead of one per technician.)
 *   Only appointments whose subject matches a known time-off keyword are
 *   acted on -- everything else (real customer appointments, work orders
 *   BlueFolder already schedules) is left alone. Matched appointments
 *   become technician_availability rows (available=false).
 *
 * PUSH: any technician_availability row marked available=false with a
 *   reason of vacation/personal/pto, that was entered locally (no
 *   bluefolder_appt_id yet), gets created as a BlueFolder appointment so
 *   TJ sees it on the master calendar too. The returned apptId is stored
 *   back on the row, which is what prevents the next PULL from re-importing
 *   the same event.
 *
 * ⚠️ OPEN QUESTIONS FOR MARK BEFORE THIS GOES LIVE (not guessed at here):
 *   1. TIME_OFF_KEYWORDS below is my best guess at how TJ labels vacation/
 *      personal/comp-day entries on the calendar. If his actual subject-line
 *      convention is different, this will silently miss real time-off or
 *      (less likely, since it's a strict keyword match) mislabel something.
 *      Confirm the real convention before running this for real.
 *   2. technicians.bluefolder_user_id needs to be populated first -- see
 *      map-bluefolder-users.js, a one-off helper to generate that mapping.
 *      Confirmed accurate for all 32 currently-mapped technicians via
 *      diagnose-bluefolder-users.js, 2026-07-21.
 *
 * ENV VARS REQUIRED
 *   BLUEFOLDER_API_TOKEN        Settings > API > Authorized API Users
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * SCHEDULE
 *   Runs every 30 minutes via netlify.toml.
 */

const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false });

// Subject-line keywords -> technician_availability.reason. Checked in order;
// first match wins. Case-insensitive substring match.
const TIME_OFF_KEYWORDS = [
  [/vacation/i, 'vacation'],
  [/\bpto\b/i, 'pto'],
  [/personal/i, 'personal'],
  [/comp\s*day/i, 'comp_day'],
];

// Matches things like TJ's "not available for on call" -- these are NOT
// full-day unavailability (declining a Saturday on-call slot doesn't mean
// you're out all week), so they're surfaced for review instead of being
// auto-written as technician_availability rows. Confirmed real wording from
// Mark's BlueFolder calendar on 2026-07-09; broadened slightly to catch
// near-variants without being so loose it catches unrelated appointments.
const ON_CALL_DECLINE_PATTERN = /not\s*available.*on.?call|unavailable.*on.?call/i;

function classify(subject) {
  if (!subject) return { reason: null, needsReview: false };
  if (ON_CALL_DECLINE_PATTERN.test(subject)) return { reason: null, needsReview: true };
  for (const [pattern, reason] of TIME_OFF_KEYWORDS) {
    if (pattern.test(subject)) return { reason, needsReview: false };
  }
  return { reason: null, needsReview: false };
}

async function bfRequest(endpoint, bodyXml) {
  const token = process.env.BLUEFOLDER_API_TOKEN;
  const auth = Buffer.from(`${token}:x`).toString('base64');
  const res = await fetch(`${BF_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml' },
    body: bodyXml,
  });
  const text = await res.text();
  const parsed = xmlParser.parse(text);
  if (parsed?.response?.['@_status'] === 'fail') {
    throw new Error(`BlueFolder API error on ${endpoint}: ${JSON.stringify(parsed.response.error)}`);
  }
  return parsed.response;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

// appointments/list.aspx specifically documents "YYYY.MM.DD HH:MM AM" rather
// than ISO 8601 (BlueFolder's own docs disagree with themselves on this).
// Every mapped tech failing identically with the same 404 on this exact
// endpoint points at the request format, not real per-tech data -- this was
// flagged as the first thing to try back when this function was written.
function bfDateTime(d, endOfDay) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return endOfDay ? `${yyyy}.${mm}.${dd} 11:59 PM` : `${yyyy}.${mm}.${dd} 12:00 AM`;
}

function eachDay(startStr, endStr) {
  const days = [];
  let cur = new Date(startStr.slice(0, 10) + 'T00:00:00Z');
  const end = new Date(endStr.slice(0, 10) + 'T00:00:00Z');
  while (cur <= end) {
    days.push(isoDate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const summary = { pulled: 0, pushed: 0, skipped_no_mapping: 0, errors: [] };

  // ---- PULL ----
  // NOTE: appointments/list.aspx's userId filter parameter fails with a 404
  // "Data not found" on this BlueFolder account for every single technician,
  // even though the exact same request without that one parameter succeeds
  // and returns real data (confirmed via diagnose-appointments-variants.js,
  // 2026-07-21). So instead of querying per-technician with a filter that
  // doesn't work here, this pulls every appointment in the date range with
  // ONE unfiltered call, then matches each one back to a technician locally
  // using assignedTo.userId against our own bluefolder_user_id mapping
  // (already confirmed accurate for all 32 mapped techs). Also faster: one
  // API call instead of 32.
  const { data: mappedTechs, error: techErr } = await supabase
    .from('technicians')
    .select('id, name, bluefolder_user_id')
    .not('bluefolder_user_id', 'is', null);
  if (techErr) throw new Error(`Fetching mapped technicians failed: ${techErr.message}`);

  if (!mappedTechs.length) {
    summary.skipped_no_mapping = 1;
    console.log('No technicians have bluefolder_user_id set yet -- nothing to pull. Run map-bluefolder-users.js first.');
  }

  const techByBfId = {};
  for (const t of mappedTechs) techByBfId[String(t.bluefolder_user_id)] = t;

  const rangeStart = new Date();
  const rangeEnd = new Date();
  rangeEnd.setDate(rangeEnd.getDate() + 60);

  let listResp;
  try {
    listResp = await bfRequest('appointments/list.aspx', `<request><appointmentList>` +
      `<dateRangeStart>${bfDateTime(rangeStart, false)}</dateRangeStart>` +
      `<dateRangeEnd>${bfDateTime(rangeEnd, true)}</dateRangeEnd>` +
      `</appointmentList></request>`);
  } catch (e) {
    summary.errors.push(`unfiltered list: ${e.message}`);
    listResp = null;
  }

  const allAppts = listResp?.appointment ? [].concat(listResp.appointment) : [];

  for (const appt of allAppts) {
    const assignees = appt?.assignedTo?.userId ? [].concat(appt.assignedTo.userId).map(String) : [];
    const matchedTechs = assignees.map(id => techByBfId[id]).filter(Boolean);
    if (!matchedTechs.length) continue; // not assigned to any of our mapped technicians

    const { reason, needsReview } = classify(appt.subject);
    if (needsReview) {
      summary.needs_review = summary.needs_review || [];
      for (const tech of matchedTechs) {
        summary.needs_review.push({ tech: tech.name, subject: String(appt.subject), date: String(appt.dateTimeStart) });
      }
      continue;
    }
    if (!reason) continue; // not a time-off event, leave it alone

    const days = eachDay(String(appt.dateTimeStart), String(appt.dateTimeEnd));
    for (const tech of matchedTechs) {
      const rows = days.map((day) => ({
        technician_id: tech.id,
        day,
        available: false,
        reason,
        note: String(appt.subject || ''),
        bluefolder_appt_id: String(appt.id),
      }));
      const { error } = await supabase
        .from('technician_availability')
        .upsert(rows, { onConflict: 'technician_id,day' });
      if (error) {
        summary.errors.push(`upsert for ${tech.name} appt ${appt.id}: ${error.message}`);
      } else {
        summary.pulled += rows.length;
      }
    }
  }

  // ---- PUSH ----
  const { data: unpushed, error: unpushedErr } = await supabase
    .from('technician_availability')
    .select('technician_id, day, reason, note, technicians(name, bluefolder_user_id)')
    .in('reason', ['vacation', 'personal', 'pto'])
    .eq('available', false)
    .is('bluefolder_appt_id', null);
  if (unpushedErr) throw new Error(`Fetching unpushed availability failed: ${unpushedErr.message}`);

  for (const row of unpushed || []) {
    const bfUserId = row.technicians?.bluefolder_user_id;
    if (!bfUserId) { summary.skipped_no_mapping++; continue; }

    const subject = row.note || `${row.reason} - ${row.technicians.name}`;
    let addResp;
    try {
      addResp = await bfRequest('appointments/add.aspx', `<request><appointmentAdd>` +
        `<subject>${escapeXml(subject)}</subject>` +
        `<dateTimeStart>${row.day}T00:00:00</dateTimeStart>` +
        `<dateTimeEnd>${row.day}T23:59:59</dateTimeEnd>` +
        `<allDayEvent>true</allDayEvent>` +
        `<assignedTo><userId>${bfUserId}</userId></assignedTo>` +
        `<notifyCustomer>false</notifyCustomer>` +
        `</appointmentAdd></request>`);
    } catch (e) {
      summary.errors.push(`push for ${row.technicians.name} on ${row.day}: ${e.message}`);
      continue;
    }

    const apptId = addResp?.apptId;
    if (apptId) {
      const { error } = await supabase
        .from('technician_availability')
        .update({ bluefolder_appt_id: String(apptId) })
        .eq('technician_id', row.technician_id)
        .eq('day', row.day);
      if (!error) summary.pushed++;
    }
  }

  console.log('BlueFolder sync summary:', JSON.stringify(summary, null, 2));
  return { statusCode: 200, body: JSON.stringify(summary) };
};

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}
