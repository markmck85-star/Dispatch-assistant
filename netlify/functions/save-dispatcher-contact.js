// save-dispatcher-contact.js
//
// Updates a dispatcher's phone/sms_address so the Saturday on-call page's
// alerts toggle can text them. Built so the prompt only ever fires when
// there's genuinely nothing on file yet, and so what it saves is usable
// everywhere else in the app, not just here.
//
// v2 (2026-09-26): checks dispatchers.technician_id first. Some
// dispatchers (Gina, Caleb) are also a real field technician, and main-
// dispatch messaging already reads phone/sms_address off THAT technicians
// row -- writing only to dispatchers for them would create a second,
// disconnected copy that the rest of the app never sees. When linked,
// this writes to technicians instead; only a dispatcher-only login (TJ,
// the generic admin account) writes to dispatchers itself.
//
// POST { dispatcher_id, phone, carrier }
//   carrier is one of the same four gateway suffixes admin.html's
//   notification-recipient form already uses -- kept as a fixed allowlist
//   rather than trusting an arbitrary suffix from the client.
// -> { ok: true, smsAddress }

const { createClient } = require('@supabase/supabase-js');

const CARRIER_SUFFIXES = new Set([
  '@vtext.com',
  '@tmomail.net',
  '@txt.att.net',
  '@messaging.sprintpcs.com',
]);

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const { dispatcher_id, phone, carrier } = body;
  const digits = String(phone || '').replace(/\D/g, '');
  if (!dispatcher_id || digits.length !== 10) {
    return json(400, { ok: false, error: 'dispatcher_id and a 10-digit phone number are required' });
  }
  if (!CARRIER_SUFFIXES.has(carrier)) {
    return json(400, { ok: false, error: 'Unrecognized carrier' });
  }

  const smsAddress = `${digits}${carrier}`;
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: dispatcher, error: lookupErr } = await sb
    .from('dispatchers')
    .select('id, technician_id')
    .eq('id', dispatcher_id)
    .maybeSingle();
  if (lookupErr) return json(500, { ok: false, error: lookupErr.message });
  if (!dispatcher) return json(404, { ok: false, error: 'Dispatcher not found' });

  const table = dispatcher.technician_id ? 'technicians' : 'dispatchers';
  const targetId = dispatcher.technician_id || dispatcher.id;

  const { error: updateErr } = await sb
    .from(table)
    .update({ phone: digits, sms_address: smsAddress })
    .eq('id', targetId);

  if (updateErr) return json(500, { ok: false, error: updateErr.message });

  return json(200, { ok: true, smsAddress });
};
