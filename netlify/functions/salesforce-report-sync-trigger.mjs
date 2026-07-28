// salesforce-report-sync-trigger.mjs
//
// Built 2026-07-27 alongside the fix to salesforce-report-sync-background.mjs.
// This is the ONLY thing that runs on the 20-minute schedule now -- its one
// job is to fire an HTTP request at the real background function and
// return, which takes well under a second and stays nowhere near the
// 30-second Scheduled Function limit. The actual browser automation lives
// entirely in salesforce-report-sync-background.mjs, invoked here but
// executing in its own separate 15-minute background context.
//
// The "Refresh Now" button on state.html does NOT go through this file --
// it calls salesforce-report-sync-background directly by name, which is
// exactly the same thing this trigger does, just on a timer instead of a
// button press.

export default async (req) => {
  const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://mcrdispatch.net';
  try {
    // Fire-and-forget is fine here -- we don't need to wait for the
    // background function to finish, just to have kicked it off.
    fetch(`${siteUrl}/.netlify/functions/salesforce-report-sync-background`, { method: 'POST' }).catch((err) => {
      console.error('[salesforce-report-sync-trigger] Failed to reach background function:', err.message);
    });
  } catch (err) {
    console.error('[salesforce-report-sync-trigger] Unexpected error triggering sync:', err.message);
  }
};

export const config = {
  schedule: '*/20 * * * *',
};
