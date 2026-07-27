// import-service-appointments.js
//
// Imports rows from the Salesforce "Completed Service Appointments" report
// (the same export restock tracker already knows how to parse) into the
// site_visits table. Built 2026-07-22 as the foundation for clickable
// location history and per-state dashboards -- site_visits already existed
// with a schema suited for exactly this, but had never been wired up (it
// was originally built for a stalled BlueFolder API effort instead).
//
// Client sends already-parsed rows (parsing happens in the browser via
// SheetJS, same as restock tracker) in batches, since a full report can be
// ~3,000 rows and Netlify functions have a payload/time budget.
//
// v3 (2026-07-27): the actual matching/insert logic moved to
// lib/perform-import.js so salesforce-report-sync.js (the new scheduled
// scraper) can call the exact same code instead of duplicating it. This
// file is now just the HTTP entry point: parse the request, call
// performImport, shape the response. See lib/perform-import.js for the
// site/tech matching strategy and dedup reasoning.

const { createClient } = require('@supabase/supabase-js');
const { performImport } = require('./lib/perform-import');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }
  const rows = payload.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return json(400, { ok: false, error: 'No rows provided' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const result = await performImport(supabase, rows);
    return json(200, { ok: true, ...result });
  } catch (err) {
    return json(500, { ok: false, error: 'insert failed: ' + err.message });
  }
};
