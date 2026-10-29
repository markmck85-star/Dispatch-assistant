// lib/send-message.js -- 2026-10-29
// The actual delivery of one dispatch message (text via Twilio, email via Mailgun).
// Moved out of send-sms.js unchanged so the held-text releaser sends exactly the same way.
//   input:  { to, email, body, htmlBody, subject, smsFallback, emailFallback, deliveryTime }
//   output: { allOk, results, smsBlocked, scheduledFor }   (throws only on a missing Mailgun key)

// A dispatch longer than one comfortable text is sent as several texts, split between stops
// (a stop starts with "1.", "2." ...). The opening line stays with the first part and the closing
// lines ("Min loadout", "Please acknowledge") with the last. Parts are marked "(1/3)".
const ONE_TEXT_MAX = 1200;   // at or under this the text goes out as a single message, unchanged
const PART_MAX = 1000;       // target size of each part when it has to be split
function splitForSms(body) {
    const text = String(body || '').trim();
    if (text.length <= ONE_TEXT_MAX) return [text];
    const lines = text.split('\n');
    const blocks = [];
    for (const ln of lines) {
        if (/^\s*\d+\.\s/.test(ln) || !blocks.length) blocks.push(ln);
        else blocks[blocks.length - 1] += '\n' + ln;
    }
    const parts = [];
    let cur = '';
    for (const b of blocks) {
        if (cur && (cur + '\n' + b).length > PART_MAX) { parts.push(cur); cur = b; }
        else cur = cur ? cur + '\n' + b : b;
    }
    if (cur) parts.push(cur);
    if (parts.length < 2) return [text];
    return parts.map((t, i) => '(' + (i + 1) + '/' + parts.length + ') ' + t.trim());
}

// Saves the full text under a long random token and returns the link, or null if that fails.
// The page is served by dispatch-link.js; rows expire after 14 days.
async function makeDispatchLink(fullText, subject, techName) {
    try {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const token = require('crypto').randomBytes(12).toString('base64url');
        const { error } = await sb.from('dispatch_links').insert({
            token, tech_name: techName || null, subject: subject || null, body: String(fullText).trim(),
            expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
        });
        if (error) { console.log('[send-message] dispatch link not saved:', error.message); return null; }
        return 'https://mcrdispatch.net/d/' + token;
    } catch (e) { console.log('[send-message] dispatch link failed:', e.message); return null; }
}

async function sendMessage(p) {
    const { to, email, body, htmlBody, subject, smsFallback, emailFallback, deliveryTime } = p;
    const apiKey = process.env.MAILGUN_API_KEY;
    const domain = process.env.MAILGUN_DOMAIN || 'mcrdispatch.net';
    if (!apiKey) { const e = new Error('MAILGUN_API_KEY not set'); e.status = 500; throw e; }

    const results = [];

    // Text goes out through Twilio only (the email-to-text carrier gateway is retired).
    // "to" is a 10-digit number, +1 number, or an old saved gateway address (the digits before the @ are used).
    // If the text cannot be sent, the result says so and the email fallback below still goes out.
    if (to) {
        // A long dispatch goes out as one short text with a private link to the full list (the email
        // still carries it too). If the link cannot be made, it falls back to several numbered texts.
        let textBody = body || 'MCR Dispatch notification';
        if (String(textBody).trim().length > ONE_TEXT_MAX) {
            const url = await makeDispatchLink(textBody, subject, p.techName);
            if (url) {
                const n = (String(textBody).match(/^\s*\d+\.\s/gm) || []).length;
                const when = (String(textBody).match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\w+\s+\d+/i) || [])[0];
                textBody = 'MCR Dispatch: ' + (n ? 'you have ' + n + ' stop' + (n !== 1 ? 's' : '') : 'your dispatch') + (when ? ' for ' + when : '') + '. Full list: ' + url;
            }
        }
        const parts = splitForSms(textBody);
        let tw = null;
        for (const part of parts) {   // one after another, so they arrive in order
            tw = await require('./sms-send.js').tryTwilio(to, part);
            if (!(tw.handled && tw.ok)) break;
        }
        if (tw.handled) results.push({ type: 'sms', ok: tw.ok, via: 'twilio', error: tw.error, parts: parts.length });
        else results.push({ type: 'sms', ok: false, via: 'twilio', error: 'text not sent (' + (tw.error || tw.reason || 'Twilio unavailable') + ')' });
    }

    // Send full HTML email if email address provided. The email is skipped when the text carries
    // everything, but it is still sent if the text could not go out through Twilio.
    const twilioOk = results.some(r => r.type === 'sms' && r.via === 'twilio' && r.ok);
    const emailTo = email || (!twilioOk ? emailFallback : null);
    if (emailTo) {
        const emailParams = new URLSearchParams({
            from: `MCR Dispatch <dispatch@${domain}>`,
            to: emailTo,
            subject: subject || 'MCR Dispatch',
            text: body || '',
            html: htmlBody || body || ''
        });
        if (deliveryTime) emailParams.set('o:deliverytime', deliveryTime);

        const emailResp = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: emailParams.toString()
        });
        results.push({ type: 'email', ok: emailResp.ok, status: emailResp.status });
    }

    const allOk = results.length > 0 && results.every(r => r.ok);
    const smsBlocked = results.some(r => r.type === 'sms' && r.error === 'recipient opted out');
    return { allOk, results, smsBlocked, scheduledFor: deliveryTime || null };
}

module.exports = { sendMessage };
