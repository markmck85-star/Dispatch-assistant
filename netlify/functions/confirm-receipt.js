// confirm-receipt.js
//
// GET-only (it's a link tapped from a text message, not an API call from
// the app). Looks up the assignment by its one-time receipt_token, stamps
// received_at + flips status to 'notified' (per Mark: he wants confirmed
// receipt to actually move the ticket forward, since some techs never
// reply even when they're already en route -- this closes that gap), then
// texts today's on-call dispatcher a short confirmation and shows the
// technician a plain "got it" page.
//
// Idempotent: tapping an already-confirmed link just re-shows the original
// confirmation time and does NOT re-notify the dispatcher a second time.
//
// No authentication -- this token lives in a text message on the tech's
// own phone. Mark's call: the edge case of someone else's hands on that
// phone tapping it is acceptably rare and low-stakes (worst case, a false
// "received" ping) next to the cost of a login flow for a one-tap link.
//
// GET /.netlify/functions/confirm-receipt?token=xxxx

const { createClient } = require('@supabase/supabase-js');

function html(statusCode, title, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#181818;color:#ddd;
      display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center;}
      .box{max-width:360px;} h1{color:#f0a500;font-size:22px;margin-bottom:10px;} p{font-size:15px;color:#bbb;}</style>
      </head><body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return html(405, 'Method not allowed', '');

  const token = String((event.queryStringParameters || {}).token || '').trim();
  if (!token) return html(400, 'Missing link', 'This confirmation link looks incomplete.');

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: a, error: fetchErr } = await sb
    .from('assignments')
    .select('id, dispatch_date, received_at, sites(site_code, name, state), technicians(name)')
    .eq('receipt_token', token)
    .maybeSingle();
  if (fetchErr) return html(500, 'Error', 'Something went wrong looking this up. Try again in a bit.');
  if (!a) return html(404, 'Link not found', "This confirmation link isn't valid -- it may be from an older message.");

  const siteName = a.sites ? a.sites.name : 'the site';
  const siteCode = a.sites ? a.sites.site_code : '';
  const techName = a.technicians ? a.technicians.name : 'the technician';

  if (a.received_at) {
    const when = new Date(a.received_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return html(200, '✅ Already confirmed', `You confirmed receipt for ${siteName} at ${when}.`);
  }

  const now = new Date();
  const { error: updateErr } = await sb
    .from('assignments')
    .update({ received_at: now.toISOString(), status: 'notified' })
    .eq('id', a.id);
  if (updateErr) return html(500, 'Error', "Couldn't save your confirmation. Try again in a bit.");

  // Text today's on-call dispatcher, so a no-reply tech no longer leaves
  // them wondering whether the ticket landed. Best-effort -- a failure
  // here shouldn't make the technician think their confirmation didn't work.
  try {
    const base = process.env.URL || process.env.DEPLOY_URL;
    const { data: sched } = await sb
      .from('saturday_dispatcher_schedule')
      .select('dispatcher_id, dispatchers(username, phone, sms_address, technician_id, technicians(phone, sms_address))')
      .eq('day', a.dispatch_date)
      .maybeSingle();
    const d = sched && sched.dispatchers;
    const linkedTech = d && d.technicians;
    const dispatcherSms = (linkedTech && linkedTech.sms_address) || (d && d.sms_address) || null;
    if (base && dispatcherSms) {
      const when = now.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      await fetch(`${base}/.netlify/functions/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: dispatcherSms,
          body: `✅ ${techName} confirmed receipt — ${siteCode} ${siteName}, ${when}.`,
        }),
      });
    }
  } catch (e) {
    console.error('[confirm-receipt] dispatcher notify failed (non-fatal):', e.message);
  }

  return html(200, '✅ Got it, thanks!', `Receipt confirmed for ${siteName}. Your dispatcher's been notified.`);
};
