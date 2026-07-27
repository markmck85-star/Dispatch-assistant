// get-report-sync-status.js
//
// Read-only status check for salesforce-report-sync-background.js, built
// 2026-07-27 to back the "Refresh Now" button on state.html. Just reads
// the same Blobs keys the sync function already writes -- no browser
// involved, so this responds in milliseconds and is safe to poll every
// few seconds while a manual sync is running.
//
// GET /.netlify/functions/get-report-sync-status
// -> { inProgress: bool, startedAt, lastSuccess: {...}|null, lastFailure: {...}|null }

const { getStore, connectLambda } = require('@netlify/blobs');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function getSyncStore() {
  return getStore('report-sync');
}

exports.handler = async (event) => {
  connectLambda(event);
  const store = getSyncStore();

  let inProgress = null;
  try { inProgress = await store.get('in-progress', { type: 'json' }); } catch (e) { /* not running */ }

  let lastSuccess = null;
  try { lastSuccess = await store.get('last-success', { type: 'json' }); } catch (e) { /* none yet */ }

  let lastFailure = null;
  try { lastFailure = await store.get('last-failure', { type: 'json' }); } catch (e) { /* none yet */ }

  return json(200, {
    inProgress: !!inProgress,
    startedAt: inProgress ? inProgress.startedAt : null,
    lastSuccess,
    lastFailure,
  });
};
