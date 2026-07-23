// rematch-site-visits.js
//
// One-off correction pass: re-evaluates site_id for already-imported
// site_visits rows using the corrected matching logic from
// import-service-appointments.js (token abbreviation normalization,
// e.g. "Co" == "County"). Built 2026-07-23 after Mark caught a real
// false-positive: visits for "Fulton Co Kroger Roswell" and "Fulton Co
// Kroger Glenwood" had silently been attributed to "Fulton County Kroger
// State Bridge" instead, because the old scoring lost credit for the
// Co/County phrasing difference and a coincidentally-similar wrong site
// won instead. Since that's a silent false-positive (not something
// needs_review would have caught), a full re-check across every already-
// imported row is the only way to find how many others are affected.
//
// Batched (client calls repeatedly with increasing offset, same pattern
// as import-service-appointments.js) since ~20,700 rows won't fit in one
// invocation. Only updates a row when the recomputed site_id actually
// differs from what's stored, or when needs_review should flip -- rows
// that already match correctly are left untouched.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const TOKEN_ALIASES = {
  'co': 'county', 'cnty': 'county', 'ave': 'avenue', 'blvd': 'boulevard',
  'dr': 'drive', 'rd': 'road', 'st': 'street', 'mt': 'mount',
  'hwy': 'highway', 'pkwy': 'parkway',
};

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => TOKEN_ALIASES[t] || t);
}

function stripStatePrefix(accountName) {
  const m = String(accountName || '').trim().match(/^([A-Za-z]{2})\s*-\s*(.+)$/);
  return m ? m[2] : String(accountName || '').trim();
}

function overlapScore(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const smaller = Math.min(setA.size, setB.size);
  return smaller > 0 ? intersection / smaller : 0;
}

function matchSite(accountName, sitesForState) {
  const nameOnly = stripStatePrefix(accountName);
  const targetTokens = tokenize(nameOnly);
  let best = null;
  let bestScore = 0;
  for (const site of sitesForState) {
    const score = overlapScore(targetTokens, tokenize(site.name));
    if (score > bestScore) {
      bestScore = score;
      best = site;
    }
  }
  if (best && bestScore >= 0.65) return { siteId: best.id, matched: true };
  return { siteId: null, matched: false };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const offset = parseInt(params.offset || '0', 10);
  const limit = Math.min(parseInt(params.limit || '300', 10), 500);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: sites, error: sitesErr }, { count: totalCount, error: countErr }] = await Promise.all([
    supabase.from('sites').select('id, name, state'),
    supabase.from('site_visits').select('id', { count: 'exact', head: true }),
  ]);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  if (countErr) return json(500, { ok: false, error: 'count fetch failed: ' + countErr.message });

  const sitesByState = {};
  for (const s of sites) {
    if (!sitesByState[s.state]) sitesByState[s.state] = [];
    sitesByState[s.state].push(s);
  }

  const { data: batch, error: batchErr } = await supabase
    .from('site_visits')
    .select('id, account_name_raw, state, site_id, needs_review')
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (batchErr) return json(500, { ok: false, error: 'batch fetch failed: ' + batchErr.message });

  let changed = 0;
  let stillUnmatched = 0;
  const changedSamples = [];

  for (const row of batch) {
    const sitesForState = sitesByState[row.state] || [];
    const { siteId, matched } = matchSite(row.account_name_raw, sitesForState);
    const newNeedsReview = !matched;

    if (siteId !== row.site_id || newNeedsReview !== row.needs_review) {
      const { error: updateErr } = await supabase
        .from('site_visits')
        .update({ site_id: siteId, needs_review: newNeedsReview })
        .eq('id', row.id);
      if (!updateErr) {
        changed++;
        if (changedSamples.length < 25) {
          changedSamples.push({
            account_name_raw: row.account_name_raw,
            old_site_id: row.site_id,
            new_site_id: siteId,
          });
        }
      }
    }
    if (!matched) stillUnmatched++;
  }

  return json(200, {
    ok: true,
    processed: batch.length,
    changed,
    stillUnmatched,
    changedSamples,
    totalRows: totalCount,
    nextOffset: offset + batch.length,
    done: batch.length < limit,
  });
};
