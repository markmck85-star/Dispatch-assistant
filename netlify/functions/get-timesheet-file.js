/**
 * get-timesheet-file.js -- v1 -- 2026-10-24
 * SAVE AS: netlify/functions/get-timesheet-file.js
 *
 * Admin-only access to the original timesheet workbooks mailgun-inbound.js now keeps in the
 * private 'timesheet-files' bucket (indexed in timesheet_files).
 *
 * GET ?list=1[&q=text][&limit=50]  -> { ok, files: [ { id, filename, technician, receivedAt, sizeBytes } ] }
 * GET ?id=<timesheet_files.id>     -> { ok, filename, url }   (signed link, valid 2 minutes)
 *
 * Requires a signed-in dispatcher whose role is admin (same sign-in cookie as the rest of the app).
 * Payroll data, so every other role, and anyone not signed in, is refused.
 */
const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env vars not configured' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const who = await auth.requireUser(sb, event);
  if (!who.user) return json(who.status || 401, { error: who.error || 'Sign in required' });
  if (who.user.role !== 'admin') return json(403, { error: 'Admin access required' });

  const params = event.queryStringParameters || {};
  try {
    if (params.id) {
      const { data: row, error } = await sb.from('timesheet_files').select('filename, storage_path').eq('id', params.id).maybeSingle();
      if (error) return json(500, { error: error.message });
      if (!row) return json(404, { error: 'File not found' });
      const { data: signed, error: sErr } = await sb.storage.from('timesheet-files').createSignedUrl(row.storage_path, 120, { download: row.filename });
      if (sErr) return json(500, { error: sErr.message });
      return json(200, { ok: true, filename: row.filename, url: signed.signedUrl });
    }

    const limit = Math.min(parseInt(params.limit, 10) || 50, 200);
    let q = sb.from('timesheet_files').select('id, filename, technician_name_raw, received_at, size_bytes').order('received_at', { ascending: false }).limit(limit);
    const text = String(params.q || '').trim().replace(/[%,()]/g, ' ');
    if (text) q = q.or(`filename.ilike.%${text}%,technician_name_raw.ilike.%${text}%`);
    const { data, error } = await q;
    if (error) return json(500, { error: error.message });
    return json(200, {
      ok: true,
      files: (data || []).map((r) => ({ id: r.id, filename: r.filename, technician: r.technician_name_raw, receivedAt: r.received_at, sizeBytes: r.size_bytes })),
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
