/**
 * cleanup-duplicate-oncall.js — ONE-TIME CLEANUP, safe to delete after use
 *
 * The 2026-08-29 Sean Reich GA on-call push briefly hit BlueFolder twice:
 * the first attempt actually succeeded in BlueFolder but our own response
 * parsing failed before the apptId got saved back to Supabase, so a retry
 * after the fix created a second appointment. on_call_schedule only knows
 * about the second one (37611675) -- the first is an orphan with no
 * record of its apptId anywhere.
 *
 * This lists Sean Reich's BlueFolder appointments for 2026-08-29, finds
 * any "ON-CALL - GA - Sean Reich" appointment whose id is NOT the one
 * Supabase already tracks, and edits its subject to flag it as the
 * duplicate -- consistent with how save-on-call.js already handles
 * "can't delete, so cancel visibly" for BlueFolder appointments.
 *
 * Visit once in a browser:
 *   https://mcrdispatch.net/.netlify/functions/cleanup-duplicate-oncall?confirm=yes
 */
const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false });

const TARGET_DAY = '2026-08-29';
const TARGET_STATE = 'GA';
const TARGET_TECH_NAME = 'Sean Reich';

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
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
  if (event.queryStringParameters?.confirm !== 'yes') {
    return json(400, { error: 'Add ?confirm=yes to the URL to run this.' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: tracked, error: fetchErr } = await sb
    .from('on_call_schedule')
    .select('bluefolder_appt_id, technicians!inner(name)')
    .eq('state', TARGET_STATE)
    .eq('day', TARGET_DAY)
    .ilike('technicians.name', `%${TARGET_TECH_NAME}%`)
    .maybeSingle();

  if (fetchErr) return json(500, { error: fetchErr.message });
  if (!tracked?.bluefolder_appt_id) {
    return json(400, { error: 'No tracked bluefolder_appt_id found in Supabase -- nothing to compare against.' });
  }
  const knownGoodId = String(tracked.bluefolder_appt_id);

  // List that single day's appointments (unfiltered -- the userId filter
  // param is confirmed broken on this account per bluefolder-sync.js).
  const listResp = await bfRequest('appointments/list.aspx', `<request><appointmentList>` +
    `<dateRangeStart>${TARGET_DAY.replace(/-/g, '.')} 12:00 AM</dateRangeStart>` +
    `<dateRangeEnd>${TARGET_DAY.replace(/-/g, '.')} 11:59 PM</dateRangeEnd>` +
    `</appointmentList></request>`);

  const allAppts = listResp?.appointment ? [].concat(listResp.appointment) : [];
  const matches = allAppts.filter(a => String(a.subject || '').includes('ON-CALL - GA - Sean Reich'));

  const result = { knownGoodId, foundOnBlueFolder: matches.map(a => ({ id: a.id, subject: a.subject })), cancelled: [] };

  const duplicates = matches.filter(a => String(a.id) !== knownGoodId);
  for (const dup of duplicates) {
    const editXml = `<request>
  <appointmentEdit>
    <apptId>${dup.id}</apptId>
    <subject>CANCELLED - DUPLICATE - ON-CALL - GA - Sean Reich</subject>
  </appointmentEdit>
</request>`;
    try {
      await bfRequest('appointments/edit.aspx', editXml);
      result.cancelled.push(String(dup.id));
    } catch (e) {
      result.cancelled.push({ id: String(dup.id), error: e.message });
    }
  }

  return json(200, result);
};

