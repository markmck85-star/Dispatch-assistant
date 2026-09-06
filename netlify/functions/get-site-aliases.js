// netlify/functions/get-site-aliases.js
//
// Read-only lookup: returns every alias currently on file for a site code,
// used by admin.html to pre-fill the "Colloquial Names" field when a
// dispatcher opens an existing location to edit it.
//
// GET /.netlify/functions/get-site-aliases?site_code=GA1067
// -> { site_code, aliases: [{ alias, source }, ...] }
//
// Returns aliases from EVERY source (admin_panel, manual, salesforce_report,
// dispatch_email, rma_email) so the form shows the full picture -- but see
// save-site-aliases.js for why only admin_panel-sourced ones are editable
// from this form.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const siteCode = String((event.queryStringParameters || {}).site_code || '').trim().toUpperCase();
  if (!siteCode) return json(400, { error: 'site_code is required' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id')
    .eq('site_code', siteCode)
    .maybeSingle();

  if (siteErr) return json(500, { error: 'Site lookup failed: ' + siteErr.message });
  if (!site) return json(200, { site_code: siteCode, aliases: [] }); // new/unsaved site -- nothing to show yet

  const { data: aliases, error: aliasErr } = await supabase
    .from('site_aliases')
    .select('alias, source')
    .eq('site_id', site.id)
    .order('alias');

  if (aliasErr) return json(500, { error: 'Alias lookup failed: ' + aliasErr.message });

  return json(200, { site_code: siteCode, aliases: aliases || [] });
};
