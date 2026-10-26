/**
 * reprocess-timesheet.js -- v1 -- 2026-10-25
 * SAVE AS: netlify/functions/reprocess-timesheet.js
 *
 * Admin-only. Re-runs the mileage check and hours read on a timesheet workbook already kept in the
 * private 'timesheet-files' bucket, so a checker fix applies to sheets already received without
 * anyone re-sending them.
 *
 * POST { id: <timesheet_files.id> }  ->  { ok, report: { id, technician, matched, total, flagged }, hours }
 *
 * The new report is written first; reports previously made from the SAME email and file are removed
 * afterwards (so a failed re-check never leaves the person with nothing). Name on the sheet, then the
 * file name, then the sender decides whose it is, exactly as at arrival.
 */
const { createClient } = require('@supabase/supabase-js');
const auth = require('./lib/auth');
const { parseMileageWorkbookBuffer, evaluateMileageReport } = require('./lib/mileage-check.js');
const { parseTimesheetHoursBuffer } = require('./lib/timesheet-hours.js');
const own = require('./lib/timesheet-owner.js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Supabase env vars not configured' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const who = await auth.requireUser(sb, event);
  if (!who.user) return json(who.status || 401, { error: who.error || 'Sign in required' });
  if (who.user.role !== 'admin') return json(403, { error: 'Admin access required' });

  let id = '';
  try { id = String(JSON.parse(event.body || '{}').id || '').trim(); } catch { /* ignore */ }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { error: 'Valid file id required' });

  try {
    const { data: row, error } = await sb.from('timesheet_files')
      .select('id, inbound_email_id, filename, storage_path').eq('id', id).maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!row) return json(404, { error: 'File not found' });

    const { data: blob, error: dErr } = await sb.storage.from('timesheet-files').download(row.storage_path);
    if (dErr || !blob) return json(500, { error: 'Could not open the stored file: ' + ((dErr && dErr.message) || 'empty') });
    const buffer = Buffer.from(await blob.arrayBuffer());

    // hours first: independent of whether the mileage log reads
    let hours = null;
    try {
      hours = parseTimesheetHoursBuffer(buffer);
      await sb.from('timesheet_files').update({ hours, hours_checked_at: new Date().toISOString() }).eq('id', row.id);
    } catch (e) { /* non-fatal */ }

    const parsed = parseMileageWorkbookBuffer(buffer);
    const legs = parsed.legs || [];
    if (!legs.length) return json(200, { ok: true, report: null, hours, note: 'No mileage log found in this file' });

    let name = parsed.technicianNameRaw;
    if (!name) name = await own.resolveTechnicianNameFromFilename(sb, row.filename);
    if (!name && row.inbound_email_id) {
      const { data: em } = await sb.from('inbound_emails').select('sender').eq('id', row.inbound_email_id).maybeSingle();
      if (em && em.sender) name = await own.resolveTechnicianNameFromSender(sb, em.sender);
    }
    if (!name) return json(200, { ok: true, report: null, hours, note: 'Could not tell whose sheet this is' });

    const payPeriodEnd = legs.map((l) => l.date).filter(Boolean).sort().slice(-1)[0] || null;
    const report = await evaluateMileageReport(sb, {
      technicianNameRaw: name, legs, payPeriodEnd,
      source: 'email', sourceEmailId: row.inbound_email_id || null, sourceFilename: row.filename,
    });

    // old copies from this same email + file
    if (row.inbound_email_id) {
      await sb.from('technician_mileage_reports').delete()
        .eq('source_email_id', row.inbound_email_id).eq('source_filename', row.filename).neq('id', report.id);
    }
    return json(200, {
      ok: true, hours,
      report: { id: report.id, technician: report.technician_name_raw, matched: report.matched_legs, total: report.total_legs, flagged: (report.flagged_legs || []).length },
    });
  } catch (err) {
    return json(500, { error: err.message || 'Unexpected error' });
  }
};
