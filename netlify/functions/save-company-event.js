// save-company-event.js
//
// Server-side write for calendar.html's "+ Add Company Event" form.
// company_events holds calendar entries that apply to the whole company
// (holidays, office closures, etc) rather than any one technician -- the
// existing technician_availability table requires a technician_id on every
// row, so there was no way to represent something like "no service Labor
// Day" without either faking a per-tech entry for everyone or leaving it
// off the calendar entirely. Built 2026-09-04 at Mark's request.
//
// Same reasoning as save-tech-availability.js for going through a Netlify
// function instead of a direct client-side Supabase call: company_events'
// write RLS policy requires an authenticated admin/dispatcher session,
// which calendar.html's anon-key client never has. This function does the
// write server-side with the service-role key instead.
//
// Three actions, selected by body.action (same shape as save-tech-availability.js):
//   (default / 'add')  -- upsert a row by id (or insert new if no id given).
//                          Does NOT touch BlueFolder -- every company event
//                          is auto-pushed by the scheduled bluefolder-sync.js
//                          job every 30 min, same as vacation/personal/pto.
//                          The explicit 'push' action below exists so
//                          Mark doesn't have to wait on the schedule.
//   'push'              -- create a BlueFolder appointment for an existing
//                          row and store the returned apptId back on it.
//                          Always unassigned (no unique technician to tie
//                          it to) -- a plain company-wide entry, same
//                          pattern already used for technicians with no
//                          BlueFolder seat.
//   'delete'            -- remove the local row. If it was pushed to
//                          BlueFolder, the appointment is NOT deleted (no
//                          delete endpoint in BlueFolder's API) -- instead
//                          it's edited to a clearly-cancelled subject line,
//                          same approach as save-tech-availability.js /
//                          save-on-call.js.
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

// Same date/time formatting and XML request helpers as
// save-tech-availability.js -- kept duplicated here rather than shared,
// matching this codebase's existing per-function style (no shared lib for
// this yet).
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

  const { id, day, label, note, action } = body;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ---- push: create a BlueFolder appointment for an existing local row ----
  if (action === 'push') {
    if (!id) return json(400, { ok: false, error: 'id is required to push' });
    const { data: existing, error: fetchErr } = await supabase
      .from('company_events')
      .select('day, label, note, bluefolder_appt_id')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) return json(500, { ok: false, error: fetchErr.message });
    if (!existing) return json(404, { ok: false, error: 'Entry not found -- save it locally first' });
    if (existing.bluefolder_appt_id) {
      return json(200, { ok: true, apptId: existing.bluefolder_appt_id, note: 'Already pushed' });
    }

    const subject = String(existing.label || 'Company Event').slice(0, 100);
    const startDT = toBFDateTime(existing.day, 0, 0);
    const endDT = toBFDateTime(existing.day, 23, 59);
    // No <assignedTo> block -- this isn't any one technician's entry, same
    // as the unassigned fallback already used for techs with no BlueFolder
    // seat.
    const requestXml = `<request>
  <appointmentAdd>
    <subject>${xmlEscape(subject)}</subject>
    <dateTimeStart>${startDT}</dateTimeStart>
    <dateTimeEnd>${endDT}</dateTimeEnd>
    <allDayEvent>true</allDayEvent>
    <description>${xmlEscape(existing.note || existing.label || '')}</description>
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
      .from('company_events')
      .update({ bluefolder_appt_id: String(apptId), updated_at: new Date().toISOString() })
      .eq('id', id);
    if (updateErr) return json(500, { ok: false, error: updateErr.message });

    return json(200, { ok: true, apptId: String(apptId) });
  }

  // ---- delete: remove locally; if pushed, cancel (don't delete) in BlueFolder ----
  if (action === 'delete') {
    if (!id) return json(400, { ok: false, error: 'id is required to delete' });
    const { data: existing, error: fetchErr } = await supabase
      .from('company_events')
      .select('label, bluefolder_appt_id')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) return json(500, { ok: false, error: fetchErr.message });

    if (existing?.bluefolder_appt_id) {
      const cancelSubject = `CANCELLED - ${existing.label || 'Company Event'}`.slice(0, 100);
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

    const { error: deleteErr } = await supabase.from('company_events').delete().eq('id', id);
    if (deleteErr) return json(500, { ok: false, error: deleteErr.message });

    return json(200, { ok: true });
  }

  // ---- default: upsert (insert if no id, update in place if id given) ----
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return json(400, { ok: false, error: 'day is required and must be YYYY-MM-DD' });
  }
  if (!label || !String(label).trim()) {
    return json(400, { ok: false, error: 'label is required' });
  }

  const row = { day, label: String(label).trim(), note: note || null, updated_at: new Date().toISOString() };

  let result, error;
  if (id) {
    ({ data: result, error } = await supabase.from('company_events').update(row).eq('id', id).select());
  } else {
    ({ data: result, error } = await supabase.from('company_events').insert(row).select());
  }
  if (error) return json(500, { ok: false, error: error.message });

  return json(200, { ok: true, entry: (result && result[0]) || null });
};
