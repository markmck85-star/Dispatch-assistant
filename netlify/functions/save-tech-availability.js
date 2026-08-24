// save-tech-availability.js
//
// Server-side write for calendar.html's "+ Add Entry" form. Mark built
// calendar.html to insert directly into Supabase from the browser using the
// anon key -- caught 2026-07-24 that this can't actually work, since
// technician_availability's write RLS policy requires an authenticated
// admin/dispatcher session (checked via auth.uid()), which a bare anon-key
// client never has. This function does the write server-side with the
// service-role key instead, matching how every other write in this app
// works (through a Netlify function, never direct client-side Supabase).
//
// Three actions, selected by body.action (same shape as save-on-call.js):
//   (default / 'add')  -- upsert a local row on (technician_id, day). Does
//                          NOT touch BlueFolder -- reasons vacation/personal/
//                          pto are separately auto-pushed by the scheduled
//                          bluefolder-sync.js job every 30 min; every other
//                          reason (comp_day, manual, other, last_day, info)
//                          is never auto-pushed, hence the explicit 'push'
//                          action below.
//   'push'              -- create a BlueFolder appointment for an existing
//                          row of ANY reason and store the returned apptId
//                          back on it. Explicit and manual so nothing writes
//                          to TJ's calendar without a tap, same reasoning as
//                          the on-call push button.
//   'delete'            -- remove the local row. If it was pushed/synced to
//                          BlueFolder (bluefolder_appt_id set), the
//                          BlueFolder appointment is NOT deleted -- there is
//                          no delete endpoint in BlueFolder's API. Instead
//                          it's edited to a clearly-cancelled subject line,
//                          same approach as save-on-call.js.
//
// Built for TJ's specific use case: BlueFolder has a hard limit on how many
// technicians can be added, so this is the standalone way to track
// vacation/PTO/etc for technicians who don't fit. Confirmed those techs
// (no bluefolder_user_id set) are silently skipped by the scheduled sync's
// push step -- entries for them stay Supabase-only; the manual 'push'
// action below also refuses with a clear message rather than erroring
// against BlueFolder.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
// BLUEFOLDER_API_TOKEN (all already configured for the existing sync).

const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false });

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const VALID_REASONS = new Set(['vacation', 'personal', 'pto', 'comp_day', 'manual', 'other', 'last_day', 'info', 'site_survey', 'install']);

// Subject-line labels for pushed BlueFolder appointments -- mirrors
// REASON_LABEL in calendar.html so what TJ sees on BlueFolder matches what
// shows on the Team Calendar.
const BF_REASON_LABEL = {
  vacation: 'VACATION', personal: 'PERSONAL', pto: 'PTO', comp_day: 'COMP DAY',
  manual: 'OUT', other: 'OUT', last_day: 'LAST DAY', info: 'NOTE',
  site_survey: 'SITE SURVEY', install: 'INSTALL',
};

// BlueFolder wants "YYYY.MM.DD HH:MM AM" -- dots in the date, 12-hour
// clock with a space before AM/PM. Same format confirmed working for the
// on-call push (save-on-call.js).
function toBFDateTime(dayStr, hour24, minute) {
  const [y, m, d] = dayStr.split('-');
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  let h12 = hour24 % 12;
  if (h12 === 0) h12 = 12;
  const hh = String(h12).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${y}.${m}.${d} ${hh}:${mm} ${ampm}`;
}

function xmlEscape(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

// Same request shape confirmed working in save-on-call.js -- Content-Type
// must be text/xml (application/xml gets rejected), fast-xml-parser
// surfaces the real BlueFolder error instead of a generic message.
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
    throw new Error(JSON.stringify(parsed.response.error));
  }
  if (!parsed?.response) {
    throw new Error(`HTTP ${res.status}, unexpected response: ${text.slice(0, 300) || '(empty body)'}`);
  }
  return parsed.response;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST required' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { technician_id, day, reason, note, action } = body;
  if (!technician_id || !day) {
    return json(400, { ok: false, error: 'technician_id and day are both required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return json(400, { ok: false, error: 'day must be YYYY-MM-DD' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ---- push: create a BlueFolder appointment for an existing local row ----
  if (action === 'push') {
    const { data: existing, error: fetchErr } = await supabase
      .from('technician_availability')
      .select('reason, note, bluefolder_appt_id, technicians(name, bluefolder_user_id)')
      .eq('technician_id', technician_id)
      .eq('day', day)
      .maybeSingle();

    if (fetchErr) return json(500, { ok: false, error: fetchErr.message });
    if (!existing) return json(404, { ok: false, error: 'Entry not found -- save it locally first' });
    if (existing.bluefolder_appt_id) {
      return json(200, { ok: true, apptId: existing.bluefolder_appt_id, note: 'Already pushed' });
    }
    const bfUserId = existing.technicians?.bluefolder_user_id;
    if (!bfUserId) {
      return json(400, { ok: false, error: `${existing.technicians?.name || 'This technician'} has no BlueFolder user ID on file -- can't push` });
    }

    const techName = existing.technicians?.name || 'Tech';
    const label = BF_REASON_LABEL[existing.reason] || 'OUT';
    const subject = `${label} - ${techName}`.slice(0, 100);
    const startDT = toBFDateTime(day, 0, 0);
    const endDT = toBFDateTime(day, 23, 59);

    const requestXml = `<request>
  <appointmentAdd>
    <subject>${xmlEscape(subject)}</subject>
    <dateTimeStart>${startDT}</dateTimeStart>
    <dateTimeEnd>${endDT}</dateTimeEnd>
    <allDayEvent>true</allDayEvent>
    <assignedTo>
      <userId>${bfUserId}</userId>
    </assignedTo>
    <description>${xmlEscape(existing.note || label)}</description>
  </appointmentAdd>
</request>`;

    let bfResponse;
    try {
      bfResponse = await bfRequest('appointments/add.aspx', requestXml);
    } catch (err) {
      return json(502, { ok: false, error: 'BlueFolder rejected the appointment: ' + err.message });
    }
    const apptId = bfResponse?.apptId;
    if (!apptId) {
      return json(502, { ok: false, error: 'BlueFolder returned no appointment id: ' + JSON.stringify(bfResponse) });
    }

    const { error: updateErr } = await supabase
      .from('technician_availability')
      .update({ bluefolder_appt_id: String(apptId) })
      .eq('technician_id', technician_id)
      .eq('day', day);
    if (updateErr) return json(500, { ok: false, error: updateErr.message });

    return json(200, { ok: true, apptId: String(apptId) });
  }

  // ---- delete: remove locally; if pushed, cancel (don't delete) in BlueFolder ----
  if (action === 'delete') {
    const { data: existing, error: fetchErr } = await supabase
      .from('technician_availability')
      .select('reason, bluefolder_appt_id, technicians(name)')
      .eq('technician_id', technician_id)
      .eq('day', day)
      .maybeSingle();
    if (fetchErr) return json(500, { ok: false, error: fetchErr.message });

    if (existing?.bluefolder_appt_id) {
      const techName = existing.technicians?.name || 'Tech';
      const label = BF_REASON_LABEL[existing.reason] || 'OUT';
      const cancelSubject = `CANCELLED - ${label} - ${techName}`.slice(0, 100);
      const editXml = `<request>
  <appointmentEdit>
    <apptId>${xmlEscape(existing.bluefolder_appt_id)}</apptId>
    <subject>${xmlEscape(cancelSubject)}</subject>
  </appointmentEdit>
</request>`;
      try {
        await bfRequest('appointments/edit.aspx', editXml);
      } catch (err) {
        console.error('BlueFolder cancel-edit failed:', err.message);
      }
    }

    const { error: deleteErr } = await supabase
      .from('technician_availability')
      .delete()
      .eq('technician_id', technician_id)
      .eq('day', day);
    if (deleteErr) return json(500, { ok: false, error: deleteErr.message });

    return json(200, { ok: true });
  }

  // ---- default: upsert the local row only (no BlueFolder call) ----
  const cleanReason = VALID_REASONS.has(reason) ? reason : 'other';

  const { data, error } = await supabase
    .from('technician_availability')
    .upsert(
      { technician_id, day, available: false, reason: cleanReason, note: note || null },
      { onConflict: 'technician_id,day' }
    )
    .select();

  if (error) return json(500, { ok: false, error: error.message });

  return json(200, { ok: true, entry: (data && data[0]) || null });
};
