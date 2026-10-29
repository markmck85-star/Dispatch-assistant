// lib/send-message.js -- 2026-10-29
// The actual delivery of one dispatch message (text via Twilio, gateway fallback, email via Mailgun).
// Moved out of send-sms.js unchanged so the held-text releaser sends exactly the same way.
//   input:  { to, email, body, htmlBody, subject, smsFallback, emailFallback, deliveryTime }
//   output: { allOk, results, smsBlocked, scheduledFor }   (throws only on a missing Mailgun key)

async function sendMessage(p) {
    const { to, email, body, htmlBody, subject, smsFallback, emailFallback, deliveryTime } = p;
    const apiKey = process.env.MAILGUN_API_KEY;
    const domain = process.env.MAILGUN_DOMAIN || 'mcrdispatch.net';
    if (!apiKey) { const e = new Error('MAILGUN_API_KEY not set'); e.status = 500; throw e; }

    const results = [];

    // Send SMS ping if SMS address provided
    let twilioDone = false;
    if (to && !deliveryTime) {
        // 2026-10-27: Twilio toll-free first (scheduled sends keep using the gateway: Mailgun holds them)
        const tw = await require('./sms-send.js').tryTwilio(to, body || 'MCR Dispatch notification');
        if (tw.handled) { results.push({ type: 'sms', ok: tw.ok, via: 'twilio', error: tw.error }); twilioDone = true; }
    }
    if (to && !twilioDone) {
        const smsParams = new URLSearchParams({
            from: `MCR Dispatch <dispatch@${domain}>`,
            to: to,
            subject: 'MCR Dispatch',
            text: smsFallback || body || 'MCR Dispatch notification'
        });
        if (deliveryTime) smsParams.set('o:deliverytime', deliveryTime);

        const smsResp = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: smsParams.toString()
        });
        results.push({ type: 'sms', ok: smsResp.ok, status: smsResp.status });
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
