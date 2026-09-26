// reset-saturday-alerts.js — scheduled, runs every 15 minutes (see the
// netlify.toml addition below).
//
// Complements the Saturday on-call page's alerts toggle: that toggle sets
// hoursEnd: "17:00" on each timezone-group recipient row it creates, which
// already stops texts going out after 5pm local (mailgun-inbound.js's
// existing hoursStart/hoursEnd check handles that). What it does NOT do
// is flip enabled back to false -- so a forgotten toggle stays armed and
// would fire again the next time that row's state/hours window is active
// (e.g. the following weekday). This job finds every recipient tagged
// source:'saturday-oncall' that is still enabled and past its own day's
// 5pm-local cutoff, and disables it -- so it's genuinely reset, and the
// Saturday page correctly shows alerts as off if anyone checks back.
//
// Reuses get-settings.js/save-settings.js (rather than touching the Blobs
// store directly) so this stays correct if that storage shape ever
// changes -- one place defines it.

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Offset (minutes) of `tz` at `atDate`, via Intl's shortOffset -- handles
// DST correctly without a timezone-data dependency. "GMT-4" / "GMT-04:00"
// -> -240.
function tzOffsetMinutes(tz, atDate) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(atDate);
  const raw = (parts.find(p => p.type === 'timeZoneName') || {}).value || 'GMT+0';
  const m = raw.match(/GMT([+-]\d+)(?::?(\d+))?/);
  if (!m) return 0;
  const hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// UTC epoch ms for `hour`:00 local time on `dayStr` (YYYY-MM-DD) in `tz`.
// Two-pass isn't needed at 15-minute granularity -- the offset barely
// shifts hour to hour except right at a DST transition, an edge case not
// worth the extra complexity for a once-a-week 5pm cutoff.
function localCutoffUtcMs(dayStr, hour, tz) {
  const approx = new Date(`${dayStr}T${String(hour).padStart(2, '0')}:00:00Z`);
  const offsetMin = tzOffsetMinutes(tz, approx);
  return approx.getTime() - offsetMin * 60000;
}

exports.handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) return json(500, { error: 'No site URL available to call get-settings/save-settings' });

  try {
    const res = await fetch(`${base}/.netlify/functions/get-settings?state=NOTIFICATIONS`, { cache: 'no-store' });
    const data = await res.json();
    const s = data.settings || {};
    const recipients = (s.settings && s.settings.recipients) || s.recipients || [];

    const now = Date.now();
    let changed = false;
    for (const r of recipients) {
      if (r.source !== 'saturday-oncall') continue;
      if (r.enabled === false) continue;
      if (!r.day || !r.timezone) continue;
      const cutoff = localCutoffUtcMs(r.day, 17, r.timezone);
      if (now >= cutoff) {
        r.enabled = false;
        changed = true;
      }
    }

    if (changed) {
      await fetch(`${base}/.netlify/functions/save-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'NOTIFICATIONS', settings: { recipients } }),
      });
    }

    return json(200, { ok: true, changed });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
