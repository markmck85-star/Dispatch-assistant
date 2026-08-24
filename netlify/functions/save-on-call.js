// netlify/functions/save-on-call.js
//
// Writes to on_call_schedule using the Supabase service-role key (same
// reasoning as save-tech-availability.js -- RLS on this table requires an
// authenticated admin/dispatcher session, and this page only ever holds
// the anon key client-side).
//
// Three actions, selected by body.action:
//   (default / 'add')  -- upsert a local on_call_schedule row. Does NOT
//                          touch BlueFolder. Pushing is a separate,
//                          explicit step (action: 'push') so nothing
//                          writes to TJ's BlueFolder calendar silently.
//   'push'              -- create a BlueFolder appointment for an
//                          existing local row and store the returned
//                          apptId back on that row.
//   'delete'            -- remove the local row. If it was pushed to
//                          BlueFolder (bluefolder_appt_id is set), the
//                          BlueFolder appointment is NOT deleted --
//                          BlueFolder's API has no delete endpoint for
//                          appointments. Instead it's edited to a
//                          clearly-cancelled subject line so it stays
//                          visible on TJ's calendar as an inert record
//                          rather than disappearing or erroring out.
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already
// configured), and BLUEFOLDER_API_TOKEN (already configured, used by the
// existing read-side BlueFolder sync).

const { createClient } = require('@supabase/supabase-js');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';

function bfAuthHeader() {
  const token = process.env.BLUEFOLDER_API_TOKEN;
  return 'Basic ' + Buffer.from(`${token}:X`).toString('base64');
}

// BlueFolder wants "YYYY.MM.DD HH:MM AM" -- dots in the date, 12-hour
// clock with a space before AM/PM.
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
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal extraction -- BlueFolder's responses are simple/flat, so a
// regex is enough and avoids pulling in an XML parser dependency.
function parseBFResponse(xmlText) {
  const statusMatch = xmlText.match(/<response\s+status="(\w+)"/);
  const status = statusMatch ? statusMatch[1] : 'unknown';
  if (status !== 'ok') {
    const errMatch = xmlText.match(/<error[^>]*>([\s\S]*?)<\/error>/);
    const msg = errMatch ? errMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : 'Unknown BlueFolder error';
    return { ok: false, error: msg };
  }
  const apptIdMatch = xmlText.match(/<apptId>(\d+)<\/apptId>/);
  return { ok: true, apptId: apptIdMatch ? apptIdMatch[1] : null };
}

async function bfRequest(path, bodyXml) {
  const res = await fetch(`${BF_BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': bfAuthHeader(),
      'Content-Type': 'application/xml',
    },
    body: bodyXml,
  });
  const text = await res.text();
  return parseBFResponse(text);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }) };
  }

  const { state, technician_id, day, action } = body;
  if (!state || !technician_id || !day) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'state, technician_id, and day are required' }) };
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ---- push: create a BlueFolder appointment for an existing local row ----
  if (action === 'push') {
    const { data: existing, error: fetchErr } = await sb
      .from('on_call_schedule')
      .select('bluefolder_appt_id, technicians(name, bluefolder_user_id)')
      .match({ state, day, technician_id })
      .maybeSingle();

    if (fetchErr) return { statusCode: 500, body: JSON.stringify({ ok: false, error: fetchErr.message }) };
    if (!existing) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'On-call entry not found -- save it locally first' }) };
    if (existing.bluefolder_appt_id) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, apptId: existing.bluefolder_appt_id, note: 'Already pushed' }) };
    }
    const bfUserId = existing.technicians?.bluefolder_user_id;
    if (!bfUserId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: `${existing.technicians?.name || 'This technician'} has no BlueFolder user ID on file -- can't push` }) };
    }

    const techName = existing.technicians?.name || 'Tech';
    const subject = `ON-CALL - ${state} - ${techName}`.slice(0, 100);
    const startDT = toBFDateTime(day, 8, 0);   // 8:00 AM
    const endDT = toBFDateTime(day, 20, 0);    // 8:00 PM -- matches Saturday monitoring hours

    const requestXml = `<request>
  <appointmentAdd>
    <subject>${xmlEscape(subject)}</subject>
    <dateTimeStart>${startDT}</dateTimeStart>
    <dateTimeEnd>${endDT}</dateTimeEnd>
    <allDayEvent>false</allDayEvent>
    <assignedTo>
      <userId>${bfUserId}</userId>
    </assignedTo>
    <description>${xmlEscape(`Saturday on-call rotation -- ${state}`)}</description>
  </appointmentAdd>
</request>`;

    let bfResult;
    try {
      bfResult = await bfRequest('appointments/add.aspx', requestXml);
    } catch (err) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'Could not reach BlueFolder: ' + err.message }) };
    }
    if (!bfResult.ok) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'BlueFolder rejected the appointment: ' + bfResult.error }) };
    }

    const { error: updateErr } = await sb
      .from('on_call_schedule')
      .update({ bluefolder_appt_id: bfResult.apptId })
      .match({ state, day, technician_id });
    if (updateErr) return { statusCode: 500, body: JSON.stringify({ ok: false, error: updateErr.message }) };

    return { statusCode: 200, body: JSON.stringify({ ok: true, apptId: bfResult.apptId }) };
  }

  // ---- delete: remove locally; if pushed, cancel (don't delete) in BlueFolder ----
  if (action === 'delete') {
    const { data: existing, error: fetchErr } = await sb
      .from('on_call_schedule')
      .select('bluefolder_appt_id, technicians(name)')
      .match({ state, day, technician_id })
      .maybeSingle();
    if (fetchErr) return { statusCode: 500, body: JSON.stringify({ ok: false, error: fetchErr.message }) };

    if (existing?.bluefolder_appt_id) {
      const techName = existing.technicians?.name || 'Tech';
      const cancelSubject = `CANCELLED - ON-CALL - ${state} - ${techName}`.slice(0, 100);
      const editXml = `<request>
  <appointmentEdit>
    <apptId>${xmlEscape(existing.bluefolder_appt_id)}</apptId>
    <subject>${xmlEscape(cancelSubject)}</subject>
  </appointmentEdit>
</request>`;
      try {
        const bfResult = await bfRequest('appointments/edit.aspx', editXml);
        if (!bfResult.ok) {
          // Don't block the local removal on a BlueFolder hiccup -- surface
          // it, but let the local delete proceed below.
          console.error('BlueFolder cancel-edit failed:', bfResult.error);
        }
      } catch (err) {
        console.error('BlueFolder cancel-edit request failed:', err.message);
      }
    }

    const { error: deleteErr } = await sb
      .from('on_call_schedule')
      .delete()
      .match({ state, day, technician_id });
    if (deleteErr) return { statusCode: 500, body: JSON.stringify({ ok: false, error: deleteErr.message }) };

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // ---- default: upsert the local row only (no BlueFolder call) ----
  const { error } = await sb
    .from('on_call_schedule')
    .upsert({ state, technician_id, day }, { onConflict: 'state,day,technician_id' });

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
