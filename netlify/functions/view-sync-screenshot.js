// view-sync-screenshot.js
//
// Serves the failure screenshot salesforce-report-sync-background.js saves
// to Blobs (report-sync/last-failure-screenshot) directly as a viewable
// PNG, so it can just be opened as a URL in a phone browser instead of
// digging through Netlify's Blobs dashboard, which isn't built for
// previewing images on mobile. Built 2026-07-27 for exactly this
// debugging session.
//
// GET /.netlify/functions/view-sync-screenshot

const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore('report-sync');

  let shot;
  try {
    shot = await store.get('last-failure-screenshot', { type: 'arrayBuffer' });
  } catch (e) {
    return { statusCode: 404, body: 'No failure screenshot on file.' };
  }

  if (!shot) {
    return { statusCode: 404, body: 'No failure screenshot on file yet.' };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    body: Buffer.from(shot).toString('base64'),
    isBase64Encoded: true,
  };
};
