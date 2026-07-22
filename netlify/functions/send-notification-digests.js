/**
 * send-notification-digests.js — v1 — added 2026-07-21
 *
 * Netlify Scheduled Function, runs every 15 min. Flushes
 * pending-notifications (queued by mailgun-inbound.js whenever a
 * recipient's active-hours window excluded them from a real-time trouble
 * ticket text) into ONE summary SMS per recipient, the next time that
 * recipient's window opens -- rather than resending each one
 * individually. Deliberately a single digest, not a burst of individual
 * texts: Mark flagged 2026-07-21 that several texts landing at once has
 * previously caused Verizon's email-to-SMS gateway to buffer/delay the
 * whole batch, so a burst of catch-up texts could actually make delivery
 * worse, not better.
 *
 * Uses the same hoursStart/hoursEnd window logic as mailgun-inbound.js's
 * live filter (including the "00:00 means midnight/end-of-day, not
 * minute 0" fix). Since there's no specific ticket driving this check,
 * the recipient's own timezone is approximated from the first state in
 * their coverage list (falls back to America/New_York, matching every
 * other undated fallback already in this codebase) rather than a
 * ticket's state.
 */
const { getStore, connectLambda } = require('@netlify/blobs');

const STATE_TIMEZONES = {
  GA: 'America/New_York', NC: 'America/New_York', SC: 'America/New_York',
  FL: 'America/New_York', IN: 'America/New_York', OH: 'America/New_York',
  WV: 'America/New_York', MI: 'America/Detroit', IL: 'America/Chicago',
  MN: 'America/Chicago', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  CO: 'America/Denver', ID: 'America/Boise',
};

async function sendSms(to, body, subject) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || 'mcrdispatch.net';
  if (!apiKey) {
    console.log('[send-notification-digests] MAILGUN_API_KEY not set, skipping');
    return false;
  }
  try {
    const params = new URLSearchParams({
      from: `MCR Watchdog <watchdog@${domain}>`,
      to,
      subject: subject || 'MCR Dispatch',
      text: body,
    });
    const resp = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    return resp.ok;
  } catch (e) {
    console.error('[send-notification-digests] sendSms failed:', e.message);
    return false;
  }
}

function inWindow(hoursStart, hoursEnd, tz) {
  if (!hoursStart || !hoursEnd) return true; // 24/7 recipient
  const now = new Date();
  const localStr = now.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = localStr.split(':').map(Number);
  const nowMins = h * 60 + m;
  const [startH, startM] = hoursStart.split(':').map(Number);
  const [endH, endM] = hoursEnd.split(':').map(Number);
  const startMins = startH * 60 + startM;
  let endMins = endH * 60 + endM;
  if (endMins === 0) endMins = 24 * 60; // "00:00" end means through midnight, not minute 0
  return startMins <= endMins
    ? (nowMins >= startMins && nowMins <= endMins)   // normal same-day window
    : (nowMins >= startMins || nowMins <= endMins);  // wraps past midnight, e.g. 22:00-06:00
}

exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore('dispatch');
  const summary = { checked: 0, sent: 0, stillWaiting: 0, dropped: 0, errors: [] };

  try {
    const pending = (await store.get('pending-notifications', { type: 'json' })) || {};
    const notifData = await store.get('settings/NOTIFICATIONS', { type: 'json' });
    const recipients = notifData
      ? ((notifData.settings && notifData.settings.recipients) || notifData.recipients || [])
      : [];
    const recByAddr = {};
    for (const r of recipients) recByAddr[r.address.trim()] = r;

    let changed = false;
    for (const [addr, items] of Object.entries(pending)) {
      summary.checked++;
      if (!items || !items.length) { delete pending[addr]; changed = true; continue; }

      const r = recByAddr[addr];
      // Recipient was removed or turned off since being queued -- nothing to deliver to
      if (!r || r.enabled === false) { delete pending[addr]; changed = true; summary.dropped++; continue; }

      const tz = STATE_TIMEZONES[(r.states && r.states[0]) || ''] || 'America/New_York';
      if (!inWindow(r.hoursStart, r.hoursEnd, tz)) { summary.stillWaiting++; continue; }

      const lines = items.slice(0, 15).map(it => `#${it.ticketId || '?'} ${it.siteCode || ''}: ${it.summary || ''}`.trim());
      const overflow = items.length > 15 ? `\n(+${items.length - 15} more -- check dispatch app)` : '';
      const body = `MCR Dispatch: ${items.length} ticket${items.length === 1 ? '' : 's'} came in outside your active hours:\n`
        + lines.join('\n') + overflow;

      const ok = await sendSms(addr, body, 'MCR Dispatch');
      if (ok) {
        summary.sent++;
        delete pending[addr];
        changed = true;
      } else {
        summary.errors.push(`send failed for ${addr}`);
      }
    }

    if (changed) await store.setJSON('pending-notifications', pending);
  } catch (err) {
    summary.errors.push(err.message);
  }

  console.log('[send-notification-digests] summary:', JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
