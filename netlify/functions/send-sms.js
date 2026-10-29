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
        const { to, email, body, htmlBody, subject, deliverAt, smsFallback, emailFallback, holdUntil, techName } = JSON.parse(event.body);

        if (!process.env.MAILGUN_API_KEY) {
            return { statusCode: 500, body: JSON.stringify({ error: 'MAILGUN_API_KEY not set' }) };
        }

        // 2026-10-29: hold until a later time (the "not before 8:00 AM the technician's time" rule).
        // The message waits in held_texts and release-held-texts sends it, the same way, when due.
        // Past or invalid times are ignored (sends now); capped at 24 hours ahead.
        // Scheduled sends (deliverAt, used by the Saturday on-call page) use the same queue now that
        // texts no longer go through Mailgun's scheduler; those may be up to 3 days ahead.
        const holdAt = holdUntil || deliverAt;
        if (holdAt) {
            const when = new Date(holdAt);
            const msAhead = when.getTime() - Date.now();
            const maxAhead = holdUntil ? 24 * 60 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
            if (!isNaN(when.getTime()) && msAhead > 60 * 1000 && msAhead < maxAhead) {
                const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
                const { data: row, error } = await supabase.from('held_texts').insert({
                    deliver_at: when.toISOString(),
                    tech_name: techName || null,
                    payload: { to, email, body, htmlBody, subject, smsFallback, emailFallback },
                    created_by: (event.headers && (event.headers['x-mcr-user'] || event.headers['X-Mcr-User'])) || null,
                }).select('id').single();
                if (error) {
                    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Could not hold the message: ' + error.message }) };
                }
                return { statusCode: 200, body: JSON.stringify({ ok: true, held: true, heldId: row.id, deliverAt: when.toISOString(), results: [{ type: 'held', ok: true }] }) };
            }
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

        const out = await require('./lib/send-message.js').sendMessage({ to, email, body, htmlBody, subject, smsFallback, emailFallback, deliveryTime, techName });
        return {
            statusCode: out.allOk ? 200 : 502,
            body: JSON.stringify({ ok: out.allOk, results: out.results, scheduledFor: out.scheduledFor, smsBlocked: out.smsBlocked,
                error: out.allOk ? undefined : (out.smsBlocked ? 'This person replied STOP, so texts are blocked. Email was still sent.' : undefined) })
        };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
