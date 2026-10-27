// get-status-sync-status.js
// Last few runs of the technician status pass (sa_status_sync_runs), for the State Console toggle's
// status line. Read-only. GET -> { ok, last: {ran_at, ok, rows_seen, matched_techs, error, statuses}|null, recent_failures }
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

exports.handler = async () => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('sa_status_sync_runs')
      .select('ran_at, ok, rows_seen, matched_techs, error, statuses, ms')
      .order('ran_at', { ascending: false })
      .limit(6);
    if (error) return json(500, { ok: false, error: error.message });
    const rows = data || [];
    return json(200, { ok: true, last: rows[0] || null, recent_failures: rows.filter((r) => !r.ok).length, runs: rows.length });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
