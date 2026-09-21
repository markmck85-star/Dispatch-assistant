/**
 * netlify/functions/delete-mileage-report.js
 * DELETE ?id=<uuid>  — removes one technician_mileage_reports row.
 * Used by mileage.html (Mike page) so test uploads can be cleared
 * without opening Supabase.
 */
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let id = (event.queryStringParameters || {}).id || '';
  if (!id && event.body) {
    try { id = JSON.parse(event.body).id || ''; } catch { /* ignore */ }
  }
  id = String(id).trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { error: 'Valid report id required' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from('technician_mileage_reports')
      .delete()
      .eq('id', id)
      .select('id, technician_name_raw, source_filename')
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(404, { error: 'Report not found' });
    return json(200, { ok: true, deleted: data });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
