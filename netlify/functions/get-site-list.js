// get-site-list.js
//
// Powers the standalone Location Lookup page's search/typeahead: returns
// every site's code, name, and state in one small payload so the page can
// filter client-side as the user types, without a round trip per keystroke.
// Read-only.
//
// 2026-09-18 fix: the plain unbounded .select() below used to just work,
// but Supabase/PostgREST silently caps an unbounded select at 1000 rows
// (the project's db.max_rows setting) -- it doesn't error, it just
// truncates. Since the query orders by state ascending, once the sites
// table grew past 1000 rows the cutoff landed alphabetically mid-list,
// silently dropping every state from roughly NV/OH onward (confirmed via
// OH1074 missing from Location Lookup's Unmatched Sites cross-check).
// Now pages through with .range() until every row is fetched.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let allRows = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('sites')
      .select('id, site_code, name, state')
      .order('state', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) return json(500, { ok: false, error: error.message });

    allRows = allRows.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return json(200, { ok: true, sites: allRows });
};
