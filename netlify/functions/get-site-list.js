// get-site-list.js
//
// Powers the standalone Location Lookup page's search/typeahead: returns
// every site's code, name, and state in one small payload (~761 rows) so
// the page can filter client-side as the user types, without a round trip
// per keystroke. Read-only.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from('sites')
    .select('site_code, name, state')
    .order('state', { ascending: true })
    .order('name', { ascending: true });

  if (error) return json(500, { ok: false, error: error.message });

  return json(200, { ok: true, sites: data || [] });
};
