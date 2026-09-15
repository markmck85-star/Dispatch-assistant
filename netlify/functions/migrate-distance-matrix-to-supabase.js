/**
 * migrate-distance-matrix-to-supabase.js
 *
 * One-time migration for one state at a time: reads the existing
 * distance-matrix/{STATE} blob (built by compute-distance-matrix.js and
 * compute-site-distance-matrix.js, still live in Netlify Blobs) and writes
 * its entries into the Supabase tech_site_distances / site_site_distances
 * tables -- which exist in the schema already but have sat empty, since
 * nothing has ever written to them. This is what makes get-distance-matrix.js
 * and get-distance.js's switch to Supabase-backed reads (same deploy)
 * actually have real data to read.
 *
 * Splits each flat "keyA|keyB" blob entry by checking which side(s) match
 * this state's site-code pattern (^STATE\d+$, same check
 * compute-site-distance-matrix.js already uses to tell site-to-site pairs
 * apart from tech-to-site ones) -- a tech-to-site entry always has exactly
 * one matching side (the site code) and one non-matching side (the tech's
 * technicians.slug); a site-to-site entry has both sides matching.
 *
 * Nothing here calls the Google Maps API or costs anything -- pure
 * Blobs-read + Supabase-read + Supabase-write. Safe to re-run (upserts on
 * the same composite primary keys the tables already have).
 *
 * GET  /.netlify/functions/migrate-distance-matrix-to-supabase?state=GA
 *      -> dry run: counts what WOULD be written, resolves every code/slug,
 *         lists anything that failed to resolve. Nothing written.
 * GET  /.netlify/functions/migrate-distance-matrix-to-supabase?state=GA&commit=true
 *      -> the real write.
 * POST with the same query params works identically -- GET is supported
 * specifically so this can be triggered from a phone browser without
 * needing an admin.html button built first.
 *
 * mode values written: 'driving', 'haversine', 'haversine-fallback' --
 * carried straight over from the blob entry's own `type` field. A pair can
 * end up with more than one mode row over time (e.g. a haversine-fallback
 * row from a failed API element, later superseded by a real driving row) --
 * that's expected, not a bug; readers prefer 'driving', then
 * 'haversine-fallback', then 'haversine'.
 */

const { getStore, connectLambda } = require('@netlify/blobs');
const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Canonical ordering for site_site_distances, whose primary key is
// (site_a, site_b, mode) -- since driving distance is treated as symmetric
// throughout this codebase, a given unordered pair always gets written
// under exactly one ordering (lexicographically smaller UUID first),
// regardless of which direction the blob happened to store it in.
function orderPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

const UPSERT_BATCH = 500;

exports.handler = async (event) => {
  connectLambda(event);

  const params = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON body' }); }
  }

  const state = String(params.state || body.state || '').trim().toUpperCase();
  if (!state || !/^[A-Z]{2}$/.test(state)) return json(400, { ok: false, error: 'Valid 2-letter state required' });

  const commit = params.commit === 'true' || body.commit === true;

  const store = getStore('dispatch');
  const blob = await store.get('distance-matrix/' + state, { type: 'json' });
  const matrix = (blob && blob.matrix) || {};
  const entryCount = Object.keys(matrix).length;
  if (entryCount === 0) {
    return json(200, { ok: true, state, commit, message: 'No blob data found for this state -- nothing to migrate.', migrated: { siteToSite: 0, techToSite: 0 } });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const [{ data: sites, error: sitesErr }, { data: techs, error: techsErr }] = await Promise.all([
    supabase.from('sites').select('id, site_code').eq('state', state),
    supabase.from('technicians').select('id, slug').eq('home_state', state),
  ]);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  if (techsErr) return json(500, { ok: false, error: 'technicians fetch failed: ' + techsErr.message });

  const siteIdByCode = Object.fromEntries((sites || []).map((s) => [s.site_code, s.id]));
  const techIdBySlug = Object.fromEntries((techs || []).map((t) => [t.slug, t.id]));
  const siteCodePattern = new RegExp('^' + state + '\\d+$');

  // Fallback for a code the blob remembers but sites.site_code no longer
  // has -- a renumbered/merged site from one of the collision-cleanup
  // campaigns (see dispatch-platform.md). site_aliases already exists for
  // exactly this ("GA1018" -> the site now known as GA1083"), reused here
  // rather than treating a renumbered code as unresolvable. Loaded once,
  // scoped to this state's sites, and only consulted for a code-shaped
  // alias (site_aliases also holds a lot of raw ticket-text aliases for the
  // unrelated ticket-matching mechanism -- irrelevant here, this migration
  // only ever looks up short site codes, never free text, so a short
  // code-pattern alias is the only kind that could ever be a hit).
  const stateSiteIds = new Set((sites || []).map((s) => s.id));
  const { data: aliasRows, error: aliasErr } = await supabase
    .from('site_aliases')
    .select('alias, site_id')
    .eq('source', 'manual');
  if (aliasErr) return json(500, { ok: false, error: 'site_aliases fetch failed: ' + aliasErr.message });
  const siteIdByAlias = {};
  for (const row of aliasRows || []) {
    if (stateSiteIds.has(row.site_id) && /^[A-Z]{2}\d+$/.test(row.alias)) siteIdByAlias[row.alias] = row.site_id;
  }
  function resolveSiteId(code) {
    return siteIdByCode[code] || siteIdByAlias[code] || null;
  }

  const siteToSiteByKey = new Map();
  const techToSiteByKey = new Map();
  const skipped = [];

  for (const [key, entry] of Object.entries(matrix)) {
    const [a, b] = key.split('|');
    if (!a || !b || entry == null || entry.distanceMi == null) {
      skipped.push({ key, reason: 'malformed entry' });
      continue;
    }
    // site_site_distances.mode has a CHECK constraint allowing only
    // 'haversine'/'driving' -- the blob's own `type` field has a third
    // value, 'haversine-fallback' (a per-pair straight-line substitute for
    // one failed API element within an otherwise-driving build), which
    // isn't a distinction anything downstream actually reads (every reader
    // already just checks type/mode === 'driving' vs. not) -- normalized
    // to 'haversine' here rather than widening the DB constraint for a
    // difference nothing consumes. Found live: batch starting at row 3000
    // of GA's first commit run failed this exact constraint before this
    // fix.
    const mode = entry.type === 'driving' ? 'driving' : 'haversine';
    const aIsSite = siteCodePattern.test(a);
    const bIsSite = siteCodePattern.test(b);

    if (aIsSite && bIsSite) {
      const idA = resolveSiteId(a);
      const idB = resolveSiteId(b);
      if (!idA || !idB) {
        skipped.push({ key, reason: 'unresolved site code (' + (!idA ? a : b) + ' not found, inactive, or aliased)' });
        continue;
      }
      const [site_a, site_b] = orderPair(idA, idB);
      // Two different blob keys (e.g. a stale alias code and its current
      // code) can resolve to the same real pair -- de-dupe on the resolved
      // (site_a, site_b, mode) rather than the raw blob key, both because
      // writing the same row twice in one upsert batch is a Postgres error
      // ("ON CONFLICT DO UPDATE command cannot affect row a second time"),
      // and because it wouldn't be meaningful to keep both anyway. Last one
      // processed wins -- Object.entries order isn't chronological, but for
      // a genuinely stale-vs-current-code duplicate the values should be
      // close enough that which one wins doesn't matter.
      const dedupeKey = site_a + '|' + site_b + '|' + mode;
      siteToSiteByKey.set(dedupeKey, { site_a, site_b, mode, distance_mi: entry.distanceMi, duration_min: entry.durationMin ?? null, computed_at: (blob.meta && blob.meta.siteToSite && blob.meta.siteToSite.computedAt) || new Date().toISOString() });
    } else if (aIsSite || bIsSite) {
      const siteCode = aIsSite ? a : b;
      const techSlug = aIsSite ? b : a;
      const siteId = resolveSiteId(siteCode);
      const techId = techIdBySlug[techSlug];
      if (!siteId || !techId) {
        skipped.push({ key, reason: (!siteId ? 'unresolved site code ' + siteCode : 'unresolved tech slug ' + techSlug) });
        continue;
      }
      // Same dedupe reasoning as the site-to-site branch above.
      const dedupeKey = techId + '|' + siteId + '|' + mode;
      techToSiteByKey.set(dedupeKey, { technician_id: techId, site_id: siteId, mode, distance_mi: entry.distanceMi, duration_min: entry.durationMin ?? null, computed_at: (blob.meta && blob.meta.computedAt) || new Date().toISOString() });
    } else {
      skipped.push({ key, reason: 'neither side matches this state\'s site-code pattern' });
    }
  }

  const siteToSiteRows = [...siteToSiteByKey.values()];
  const techToSiteRows = [...techToSiteByKey.values()];

  if (!commit) {
    return json(200, {
      ok: true,
      state,
      commit: false,
      blobEntryCount: entryCount,
      wouldMigrate: { siteToSite: siteToSiteRows.length, techToSite: techToSiteRows.length },
      skippedCount: skipped.length,
      skippedSample: skipped.slice(0, 20),
      note: 'Dry run -- nothing written. Add &commit=true to actually migrate.',
    });
  }

  let siteToSiteWritten = 0;
  let techToSiteWritten = 0;
  const writeErrors = [];

  for (let i = 0; i < siteToSiteRows.length; i += UPSERT_BATCH) {
    const batch = siteToSiteRows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase.from('site_site_distances').upsert(batch, { onConflict: 'site_a,site_b,mode' });
    if (error) writeErrors.push({ table: 'site_site_distances', batchStart: i, error: error.message });
    else siteToSiteWritten += batch.length;
  }

  for (let i = 0; i < techToSiteRows.length; i += UPSERT_BATCH) {
    const batch = techToSiteRows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase.from('tech_site_distances').upsert(batch, { onConflict: 'technician_id,mode,site_id' });
    if (error) writeErrors.push({ table: 'tech_site_distances', batchStart: i, error: error.message });
    else techToSiteWritten += batch.length;
  }

  return json(200, {
    ok: writeErrors.length === 0,
    state,
    commit: true,
    blobEntryCount: entryCount,
    migrated: { siteToSite: siteToSiteWritten, techToSite: techToSiteWritten },
    skippedCount: skipped.length,
    skippedSample: skipped.slice(0, 20),
    writeErrors,
  });
};
