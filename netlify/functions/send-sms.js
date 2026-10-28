const { connectLambda } = require('@netlify/blobs');
const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');

exports.handler = async (event) => {
    connectLambda(event);

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // v2 (2026-10-15): this sends mail and texts as the dispatch domain, so it is
    // for signed-in logins (or another function) only. The gate in front of all
    // functions checks this too; this is the second lock.
    if (process.env.AUTH_ENFORCE !== '0') {
        const who = await auth.requireUser(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY), event);
        if (who.error) {
            return { statusCode: who.status || 401, headers: { 'Content-Type': 'application/json', 'x-mcr-gate': 'deny' }, body: JSON.stringify({ ok: false, error: who.error, code: 'auth_required' }) };
        }
    }

    try {
        const { to, email, body, htmlBody, subject, deliverAt, smsFallback, emailFallback } = JSON.parse(event.body);

        const apiKey = process.env.MAILGUN_API_KEY;
        const domain = process.env.MAILGUN_DOMAIN || 'mcrdispatch.net';

        if (!apiKey) {
            return { statusCode: 500, body: JSON.stringify({ error: 'MAILGUN_API_KEY not set' }) };
        }

        // Optional scheduled delivery (used by the Saturday on-call page when
        // a message would land outside the technician's local waking hours).
        // Mailgun holds the message and delivers it at that time; it accepts
        // at most 3 days ahead. A missing, invalid, past, or too-far-out value
        // is ignored and the message goes out immediately.
        let deliveryTime = null;
        if (deliverAt) {
            const when = new Date(deliverAt);
            const msAhead = when.getTime() - Date.now();
            if (!isNaN(when.getTime()) && msAhead > 60 * 1000 && msAhead < 3 * 24 * 60 * 60 * 1000) {
                deliveryTime = when.toUTCString();
            }
        }

        const results = [];

        // Send SMS ping if SMS address provided
        let twilioDone = false;
        if (to && !deliveryTime) {
            // 2026-10-27: Twilio toll-free first (scheduled sends keep using the gateway: Mailgun holds them)
            const tw = await require('./lib/sms-send.js').tryTwilio(to, body || 'MCR Dispatch notification');
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

        // Send full HTML email if email address provided
        // The email is skipped when the text carries everything, but it is still sent if the text
        // could not go out through Twilio (the gateway fallback only says "details sent to your email").
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
        return {
            statusCode: allOk ? 200 : 502,
            body: JSON.stringify({ ok: allOk, results, scheduledFor: deliveryTime, smsBlocked,
                error: allOk ? undefined : (smsBlocked ? 'This person replied STOP, so texts are blocked. Email was still sent.' : undefined) })
        };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
