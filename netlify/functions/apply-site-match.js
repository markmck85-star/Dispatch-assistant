// apply-site-match.js
//
// Bulk-applies one confirmed site match to every needs_review site_visits
// row sharing the same (state, account_name_raw) -- the write side of the
// Unmatched Sites review tool. Scoped to needs_review=true rows only, so
// running this never touches a row that already has a different, possibly
// correct, site_id from some other match path.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST required' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const { state, account_name_raw, site_id } = body;
  if (!state || !account_name_raw || !site_id) {
    return json(400, { ok: false, error: 'state, account_name_raw, and site_id are all required' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('site_visits')
    .update({ site_id, needs_review: false })
    .eq('state', state)
    .eq('account_name_raw', account_name_raw)
    .eq('needs_review', true)
    .select('id');

  if (error) return json(500, { ok: false, error: error.message });

  return json(200, { ok: true, updated: (data || []).length });
};
