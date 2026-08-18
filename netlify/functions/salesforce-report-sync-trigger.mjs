// salesforce-report-sync-trigger.mjs
//
// A true Netlify Scheduled Function (30s hard cap) that does almost nothing
// itself -- it just pings salesforce-report-sync-background's URL and
// returns immediately, without awaiting the response.
//
// Why this file has to exist at all: Netlify treats a function as EITHER a
// Background Function (any filename ending in "-background", 15-minute
// allowance, fire-and-forget) OR a Scheduled Function (has a `schedule` in
// netlify.toml, 30-second hard cap) -- never both at once. Attaching
// `schedule` directly to salesforce-report-sync-background.mjs (as
// netlify.toml was found doing on 2026-08-18) silently drops it back to the
// 30-second cap despite the "-background" filename, which isn't nearly
// enough time for a real headless-browser Salesforce login + export +
// download + import cycle. This file exists so the SCHEDULE lives here
// (cheap, fast, well under 30s) while the actual work stays on the
// background function with its full 15-minute allowance.
//
// netlify.toml must point its schedule at THIS function, not at
// salesforce-report-sync-background directly -- see the fix applied
// alongside this file.

exports.handler = async () => {
  const siteUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!siteUrl) {
    console.error('[salesforce-report-sync-trigger] No site URL available (URL/DEPLOY_URL env var missing) -- cannot ping background function.');
    return { statusCode: 500, body: 'Missing site URL' };
  }

  const target = siteUrl + '/.netlify/functions/salesforce-report-sync-background';
  try {
    // Deliberately NOT awaited on the response body/completion -- the whole
    // point is this trigger returns fast. fetch() itself still needs to be
    // awaited just long enough to confirm the request was actually sent
    // before this function's own invocation ends.
    await fetch(target, { method: 'POST' });
    console.log('[salesforce-report-sync-trigger] Pinged background sync function.');
  } catch (err) {
    console.error('[salesforce-report-sync-trigger] Failed to ping background function:', err.message);
    return { statusCode: 502, body: 'Ping failed: ' + err.message };
  }

  return { statusCode: 200, body: 'Triggered' };
};
