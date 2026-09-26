// generate-receipt-token.js
//
// Attaches a receipt_token to an existing assignment row, for the "tap to
// confirm you got this" link appended to a dispatch text. Requires the
// assignment to already exist (created via save-assignment.js) -- this
// only adds the token, it never creates the underlying row, since a
// receipt link only makes sense for something that's actually been
// assigned.
//
// Idempotent: if a token already exists for this assignment, returns the
// same one rather than rotating it (so re-sending a text to the same tech
// for the same ticket doesn't invalidate a link they already have).
//
// POST { dispatchDate, siteCode }
// -> { ok: true, token }

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }

  const dispatchDate = String(body.dispatchDate || '').trim();
  const siteCode = String(body.siteCode || '').trim().toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dispatchDate) || !siteCode) {
    return json(400, { ok: false, error: 'dispatchDate and siteCode are required' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: site, error: siteErr } = await sb
    .from('sites').select('id').eq('site_code', siteCode).maybeSingle();
  if (siteErr) return json(500, { ok: false, error: siteErr.message });
  if (!site) return json(404, { ok: false, error: 'No site found for ' + siteCode });

  const { data: existing, error: fetchErr } = await sb
    .from('assignments')
    .select('id, receipt_token')
    .eq('dispatch_date', dispatchDate)
    .eq('site_id', site.id)
    .maybeSingle();
  if (fetchErr) return json(500, { ok: false, error: fetchErr.message });
  if (!existing) return json(404, { ok: false, error: 'No assignment exists yet for this ticket -- assign it first' });

  if (existing.receipt_token) {
    return json(200, { ok: true, token: existing.receipt_token });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const { error: updateErr } = await sb
    .from('assignments')
    .update({ receipt_token: token })
    .eq('id', existing.id);
  if (updateErr) return json(500, { ok: false, error: updateErr.message });

  return json(200, { ok: true, token });
};
