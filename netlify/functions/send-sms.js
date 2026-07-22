const { connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
    connectLambda(event);

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { to, email, body, htmlBody, subject } = JSON.parse(event.body);

        const apiKey = process.env.MAILGUN_API_KEY;
        const domain = process.env.MAILGUN_DOMAIN || 'mcrdispatch.net';

        if (!apiKey) {
            return { statusCode: 500, body: JSON.stringify({ error: 'MAILGUN_API_KEY not set' }) };
        }

        const results = [];

        // Send SMS ping if SMS address provided
        if (to) {
            const smsParams = new URLSearchParams({
                from: `MCR Dispatch <dispatch@${domain}>`,
                to: to,
                subject: 'MCR Dispatch',
                text: body || 'MCR Dispatch notification'
            });

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
        if (email) {
            const emailParams = new URLSearchParams({
                from: `MCR Dispatch <dispatch@${domain}>`,
                to: email,
                subject: subject || 'MCR Dispatch',
                text: body || '',
                html: htmlBody || body || ''
            });

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
        return {
            statusCode: allOk ? 200 : 502,
            body: JSON.stringify({ ok: allOk, results })
        };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
