/**
 * netlify/functions/process-mileage-timesheet.js
 * ======================================================================
 * Manual-upload entry point for the technician mileage sanity check --
 * see lib/mileage-check.js's header for the full design rationale. The
 * browser parses the uploaded .xlsx client-side with SheetJS (same
 * pattern admin.html's Closed Tickets tab already uses for its own
 * import) and posts the normalized leg rows here; this just validates
 * the shape and hands off to the shared evaluateMileageReport, which the
 * forwarded-email path (mailgun-inbound.js) also calls directly.
 *
 * POST body: {
 *   technicianNameRaw: string,
 *   legs: [{ date, fromRaw, toRaw, odometerStart, odometerEnd, claimedMiles }],
 *   payPeriodEnd?: 'YYYY-MM-DD',
 *   sourceFilename?: string
 * }
 */
const { createClient } = require('@supabase/supabase-js');
const { evaluateMileageReport } = require('./lib/mileage-check.js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const technicianNameRaw = String(payload.technicianNameRaw || '').trim();
  if (!technicianNameRaw) return json(400, { error: 'technicianNameRaw is required' });

  const legs = Array.isArray(payload.legs) ? payload.legs : [];
  if (!legs.length) return json(400, { error: 'No legs found in this file -- check it has a "Mileage" sheet with real entries' });
  for (const leg of legs) {
    if (typeof leg.fromRaw !== 'string' || typeof leg.toRaw !== 'string' || typeof leg.claimedMiles !== 'number') {
      return json(400, { error: 'Each leg needs fromRaw, toRaw (strings) and claimedMiles (number)' });
    }
  }

  const payPeriodEnd = /^\d{4}-\d{2}-\d{2}$/.test(payload.payPeriodEnd || '')
    ? payload.payPeriodEnd
    : legs.map((l) => l.date).filter(Boolean).sort().slice(-1)[0] || null;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const report = await evaluateMileageReport(supabase, {
      technicianNameRaw, legs, payPeriodEnd,
      source: 'manual_upload',
      sourceFilename: payload.sourceFilename || null,
    });
    return json(200, { ok: true, report });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
