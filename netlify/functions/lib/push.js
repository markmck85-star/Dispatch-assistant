// Web push for the staff portal's Watchdog alerts.
//
// Subscriptions live in public.push_subscriptions (service role only). Each row
// holds the phone's push endpoint plus the REAL state codes the person chose to
// be alerted for (the portal expands "Saturday On-Call" / "All" into states
// before saving, so this file only ever compares a ticket's state to a list).
//
// Env vars (Netlify): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// (VAPID_SUBJECT is optional; defaults to the site URL).
//
// Nothing here may break ticket intake: every exported function swallows its
// own errors and returns a summary instead of throwing.

const GA_BUNDLED_STATES = ['NC', 'SC']; // same umbrella the SMS filter uses

function pushConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function getWebPush() {
  const webpush = require('web-push');
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'https://mcrdispatch.net',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return webpush;
}

// A ticket for NC/SC is covered by a GA subscription. A ticket with no
// detectable state goes to everyone (fail open, like the SMS path: better one
// extra buzz than a missed ticket).
function subscriptionCovers(states, ticketState) {
  const list = (states || []).map((s) => String(s).toUpperCase());
  const t = ticketState ? String(ticketState).toUpperCase() : '';
  if (!t) return true;
  if (list.includes(t)) return true;
  if (GA_BUNDLED_STATES.includes(t) && list.includes('GA')) return true;
  return false;
}

async function sendOne(webpush, supabase, row, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      payload,
      { TTL: 60 * 60 * 6, urgency: 'high' }
    );
    await supabase.from('push_subscriptions')
      .update({ last_sent_at: new Date().toISOString(), fail_count: 0 })
      .eq('id', row.id);
    return true;
  } catch (e) {
    const code = e && e.statusCode;
    if (code === 404 || code === 410) {
      // The phone revoked permission or uninstalled the app: forget it.
      await supabase.from('push_subscriptions').delete().eq('id', row.id);
    } else {
      await supabase.from('push_subscriptions')
        .update({ fail_count: (row.fail_count || 0) + 1 })
        .eq('id', row.id);
    }
    return false;
  }
}

// Set of staff_accounts.username values whose dispatcher row is active, or null
// if it could not be loaded (then nobody is filtered out; an alert is better
// than a silent miss).
async function activeStaffKeys(supabase) {
  try {
    const [acc, disp] = await Promise.all([
      supabase.from('staff_accounts').select('username, dispatcher_username').limit(500),
      supabase.from('dispatchers').select('username, active').limit(500),
    ]);
    if (acc.error || disp.error) return null;
    const active = new Set((disp.data || []).filter((d) => d.active === true).map((d) => d.username));
    return new Set((acc.data || []).filter((a) => active.has(a.dispatcher_username)).map((a) => a.username));
  } catch (e) { return null; }
}

// Notify every subscription that covers ticketState.
// message = { title, body, tag?, url? }
async function notifyState(supabase, ticketState, message) {
  const out = { sent: 0, failed: 0, skipped: 0 };
  try {
    if (!pushConfigured() || !supabase) { out.skipped = 1; return out; }
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, states, fail_count, account_key')
      .limit(1000);
    if (error) { console.log('[push] load failed:', error.message); return out; }
    let rows = (data || []).filter((r) => subscriptionCovers(r.states, ticketState));
    if (!rows.length) return out;
    // Only accounts whose dispatcher login is still active get alerts.
    const activeKeys = await activeStaffKeys(supabase);
    if (activeKeys) rows = rows.filter((r) => activeKeys.has(r.account_key));
    if (!rows.length) return out;
    const webpush = getWebPush();
    const payload = JSON.stringify({
      title: String(message.title || 'MCR Watchdog').slice(0, 80),
      body: String(message.body || '').slice(0, 240),
      tag: message.tag || undefined,
      url: message.url || '/tech-portal.html',
    });
    const results = await Promise.all(rows.map((r) => sendOne(webpush, supabase, r, payload)));
    results.forEach((ok) => { if (ok) out.sent++; else out.failed++; });
    console.log(`[push] state ${ticketState || '?'}: sent ${out.sent}, failed ${out.failed}`);
  } catch (e) {
    console.log('[push] notifyState error (non-fatal):', e.message);
  }
  return out;
}

// Send to one stored subscription (used by the "Send test" button).
async function notifyEndpoint(supabase, endpoint, message) {
  try {
    if (!pushConfigured()) return { ok: false, error: 'Push is not set up on the server yet.' };
    const { data } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, fail_count')
      .eq('endpoint', endpoint)
      .maybeSingle();
    if (!data) return { ok: false, error: 'This phone is not subscribed yet.' };
    const ok = await sendOne(getWebPush(), supabase, data, JSON.stringify({
      title: message.title, body: message.body, tag: 'test', url: '/tech-portal.html',
    }));
    return { ok };
  } catch (e) {
    return { ok: false, error: 'Could not send the test.' };
  }
}

module.exports = { pushConfigured, subscriptionCovers, notifyState, notifyEndpoint };
