/**
 * lib/sms-send.js -- 2026-10-27
 *
 * Sends a dispatch text through Twilio from the verified toll-free number
 * (+1 855 927 0336). Every text sender in the platform calls tryTwilio() first and
 * falls back to its old email-to-SMS gateway path when Twilio is not set up, the
 * recipient's phone number can't be worked out, or Twilio itself errors.
 *
 * Needs three Netlify environment variables:
 *   TWILIO_ACCOUNT_SID   starts with AC
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM (or TWILIO_FROM_NUMBER)   +18559270336
 * Optional: SMS_VIA_TWILIO=0 switches it off without removing the keys.
 *
 * The recipient list still stores gateway addresses (6787794352@vtext.com); the
 * 10-digit number in front of the @ is what Twilio is sent.
 */
const { formatForTwilio } = require('./sms-format.js');

// The sending number may be stored as TWILIO_FROM or TWILIO_FROM_NUMBER
const fromNumber = () => process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER || '';

function configured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && fromNumber())
    && process.env.SMS_VIA_TWILIO !== '0';
}

// "6787794352@vtext.com" -> "+16787794352"; "+1 678-779-4352" -> "+16787794352"; else null
function toE164(addr) {
  let s = String(addr || '').trim();
  if (!s) return null;
  if (s.includes('@')) s = s.split('@')[0];
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

/**
 * Returns { handled, ok, sid?, error?, code? }.
 * handled=false means "use the old path". handled=true means Twilio gave the final
 * answer (sent, or the person opted out so a fallback must not text them anyway).
 */
async function tryTwilio(to, body) {
  if (!configured()) return { handled: false, reason: 'not_configured' };
  const num = toE164(to);
  if (!num) return { handled: false, reason: 'no_number' };
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const resp = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: num, From: fromNumber(), Body: formatForTwilio(body) }).toString(),
    });
    const j = await resp.json().catch(() => ({}));
    if (resp.ok) return { handled: true, ok: true, sid: j.sid };
    console.log('[sms-send] Twilio error', resp.status, j.code, j.message);
    // 21610 = recipient replied STOP. Respect it: do not fall back to the gateway.
    if (j.code === 21610) { await setOptOut(num, true); return { handled: true, ok: false, code: j.code, error: 'recipient opted out' }; }
    return { handled: false, reason: 'twilio_error', code: j.code, error: j.message };
  } catch (e) {
    console.log('[sms-send] Twilio failed:', e.message);
    return { handled: false, reason: 'exception', error: e.message };
  }
}

// Remember (or clear) the opt-out on every technician whose saved text address or phone has this number.
async function setOptOut(e164, optedOut) {
  try {
    const d = String(e164).replace(/\D/g, '').slice(-10);
    if (d.length !== 10 || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return 0;
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const patch = { sms_opted_out: optedOut, sms_opted_out_at: optedOut ? new Date().toISOString() : null };
    // Match on the saved text address OR the phone number (phones are stored in mixed formats, so compare digits).
    const last10 = (v) => String(v || '').split('@')[0].replace(/\D/g, '').slice(-10);
    const { data: techs } = await sb.from('technicians').select('id, phone, sms_address');
    const ids = (techs || []).filter(t => last10(t.sms_address) === d || last10(t.phone) === d).map(t => t.id);
    if (!ids.length) return 0;
    const { data } = await sb.from('technicians').update(patch).in('id', ids).select('id');
    return (data || []).length;
  } catch (e) { console.log('[sms-send] setOptOut failed:', e.message); return 0; }
}

module.exports = { setOptOut, tryTwilio, toE164, configured, fromNumber };
