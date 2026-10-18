/**
 * sms-format.js -- 2026-10-18
 *
 * Shapes an outgoing dispatch text for the Twilio toll-free number (+1 855 927 0336) so it
 * matches the sample messages submitted for verification: it starts with the brand
 * ("MCR Dispatch:") and ends with the opt-out line. It also swaps emoji and curly/long dashes
 * for plain characters, because those force the text into 70-character segments.
 *
 * NOT used by the current email-to-SMS gateway path (send-sms.js, mailgun-inbound.js,
 * send-notification-digests.js): "Reply STOP" would be false there, since gateway texts can't be
 * replied to. Use it only from the Twilio send path once that exists.
 */
const BRAND = 'MCR Dispatch:';
const OPT_OUT = 'Reply STOP to opt out.';

function formatForTwilio(body) {
  let t = String(body == null ? '' : body);
  t = t
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, '') // emoji such as the siren
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!/^MCR Dispatch\b/i.test(t)) t = BRAND + ' ' + t;
  if (!/\bSTOP\b/.test(t)) t += '\n' + OPT_OUT;
  return t;
}

module.exports = { formatForTwilio, BRAND, OPT_OUT };
