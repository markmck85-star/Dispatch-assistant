/**
 * twilio-sms-webhook.js -- 2026-10-28
 * Twilio calls this when someone texts the 855 number. Twilio itself already honors STOP/START;
 * this only records it on the technician so the send screen can show "texts blocked".
 * Twilio Console > the number > Messaging > "A message comes in" > Webhook, HTTP POST:
 *   https://mcrdispatch.net/.netlify/functions/twilio-sms-webhook
 * The request is checked against Twilio's signature (X-Twilio-Signature, HMAC-SHA1 with the auth token).
 * Replies with empty TwiML so no auto-reply is sent beyond Twilio's own STOP/START confirmation.
 */
const crypto = require('crypto');
const { setOptOut } = require('./lib/sms-send.js');

const xml = (s) => ({ statusCode: s, headers: { 'Content-Type': 'text/xml' }, body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' });

function validSignature(event, params) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sig = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
  if (!token || !sig) return false;
  const host = event.headers['x-forwarded-host'] || event.headers.host || 'mcrdispatch.net';
  const url = 'https://' + host + '/.netlify/functions/twilio-sms-webhook';
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expect = crypto.createHmac('sha1', token).update(data).digest('base64');
  const a = Buffer.from(expect), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return xml(405);
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (!validSignature(event, params)) return { statusCode: 403, body: 'bad signature' };
  const word = String(params.OptOutType || params.Body || '').trim().toUpperCase();
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(word)) await setOptOut(params.From, true);
  else if (['START', 'YES', 'UNSTOP'].includes(word)) await setOptOut(params.From, false);
  return xml(200);
};
