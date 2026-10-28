/**
 * send-test-text.js -- 2026-10-27
 * Sends one test text through Twilio so the setup can be checked end to end.
 * POST { "to": "6787794352" } (signed-in logins only, same lock as send-sms.js).
 * Never falls back to the gateway: the answer says exactly what Twilio did.
 */
const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');
const { toE164, configured } = require('./lib/sms-send.js');
const { formatForTwilio } = require('./lib/sms-format.js');

const json = (s, o) => ({ statusCode: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  if (process.env.AUTH_ENFORCE !== '0') {
    const who = await auth.requireUser(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY), event);
    if (who.error) return json(who.status || 401, { ok: false, error: who.error });
  }
  const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'].filter(k => !process.env[k]);
  if (missing.length) return json(200, { ok: false, step: 'setup', error: 'Missing Netlify environment variable(s): ' + missing.join(', ') });
  if (!configured()) return json(200, { ok: false, step: 'setup', error: 'SMS_VIA_TWILIO is set to 0' });
  let to;
  try { to = toE164(JSON.parse(event.body || '{}').to); } catch (e) {}
  if (!to) return json(400, { ok: false, error: 'Send a 10-digit phone number as "to"' });
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const resp = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: formatForTwilio('Test text from the dispatch platform. If you can read this, Twilio texting works.') }).toString(),
  });
  const j = await resp.json().catch(() => ({}));
  return json(200, { ok: resp.ok, status: resp.status, sid: j.sid, twilioCode: j.code, error: resp.ok ? undefined : j.message, to });
};
