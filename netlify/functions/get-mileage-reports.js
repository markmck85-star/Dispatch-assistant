/**
 * netlify/functions/get-mileage-reports.js
 * ======================================================================
 * Lists recent technician_mileage_reports rows for the Admin Panel's
 * Mileage Check tab. Read-only. GET ?limit=25 (default 25, max 100).
 */
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit, 10) || 25, 100);

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('technician_mileage_reports')
      .select('id, technician_id, technician_name_raw, pay_period_end, source, source_filename, total_legs, matched_legs, total_claimed_miles, total_expected_miles, flagged_legs, unmatched_legs, needs_review, processed_at, technicians(name)')
      .order('processed_at', { ascending: false })
      .limit(limit);
    if (error) return json(500, { error: error.message });

    return json(200, {
      ok: true,
      reports: (data || []).map((r) => ({
        ...r,
        technicianName: r.technicians ? r.technicians.name : r.technician_name_raw,
        technicians: undefined,
      })),
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
