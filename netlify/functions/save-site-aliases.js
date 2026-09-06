// netlify/functions/save-site-aliases.js
//
// Saves the dispatcher-editable colloquial-name list for a site from
// admin.html's location form.
//
// POST /.netlify/functions/save-site-aliases
// body: { site_code: "GA1067", aliases: ["Spout Springs Kroger", "Hall Spout Springs Kroger"] }
// -> { ok: true, site_code, saved: [...] }
//
// IMPORTANT: this only ever touches rows where source = 'admin_panel'.
// It deletes the site's existing admin_panel-sourced aliases and replaces
// them with the submitted list -- full replace, so removing a name from
// the field and saving actually removes it. Aliases from every other
// source (manual -- the 2026-09 spreadsheet-derived bulk import,
// salesforce_report, dispatch_email, rma_email) are never touched by this
// function, so a dispatcher editing one location's colloquial names can
// never wipe out the bulk-imported batch or anything auto-detected from
// tickets/emails.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const siteCode = String(payload.site_code || '').trim().toUpperCase();
  if (!siteCode) return json(400, { error: 'site_code is required' });

  // Normalize: trim, drop blanks, dedupe case-insensitively while
  // preserving the first-seen casing (matches the dispatcher's own typing).
  const seen = new Set();
  const aliases = [];
  for (const raw of Array.isArray(payload.aliases) ? payload.aliases : []) {
    const a = String(raw || '').trim();
    if (!a) continue;
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(a);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id')
    .eq('site_code', siteCode)
    .maybeSingle();

  if (siteErr) return json(500, { error: 'Site lookup failed: ' + siteErr.message });
  if (!site) return json(404, { error: 'Site ' + siteCode + ' not found -- save the location itself first.' });

  // Full replace of this site's admin_panel-sourced rows only.
  const { error: delErr } = await supabase
    .from('site_aliases')
    .delete()
    .eq('site_id', site.id)
    .eq('source', 'admin_panel');

  if (delErr) return json(500, { error: 'Failed to clear old aliases: ' + delErr.message });

  if (aliases.length === 0) {
    return json(200, { ok: true, site_code: siteCode, saved: [] });
  }

  // Guard against colliding with an alias already in use for a DIFFERENT
  // site under a different source -- same collision class the 2026-08
  // site-matching cleanup campaign dealt with repeatedly. Rather than
  // silently creating an ambiguous duplicate, reject the whole save and
  // tell the dispatcher which name conflicted so they can rephrase it.
  const { data: conflicts, error: conflictErr } = await supabase
    .from('site_aliases')
    .select('alias, site_id')
    .in('alias', aliases)
    .neq('site_id', site.id);

  if (conflictErr) return json(500, { error: 'Conflict check failed: ' + conflictErr.message });
  if (conflicts && conflicts.length > 0) {
    return json(409, {
      error: 'One or more names are already used for a different site: ' +
        conflicts.map(c => c.alias).join(', ') +
        '. Rename to something more specific (e.g. add the county) and try again.',
    });
  }

  const rows = aliases.map(alias => ({ site_id: site.id, alias, source: 'admin_panel' }));
  const { error: insErr } = await supabase.from('site_aliases').insert(rows);
  if (insErr) return json(500, { error: 'Failed to save aliases: ' + insErr.message });

  return json(200, { ok: true, site_code: siteCode, saved: aliases });
};
