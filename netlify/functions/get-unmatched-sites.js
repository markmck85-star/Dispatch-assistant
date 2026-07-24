// get-unmatched-sites.js
//
// Powers the "Unmatched Sites" review tool. 3,452 needs_review site_visits
// rows collapse down to only ~179 distinct (state, account_name_raw)
// groups -- reviewing and fixing per GROUP rather than per row is what
// makes this tractable at all. Reuses the same tokenize/overlap scoring as
// rematch-site-visits.js to suggest a likely site for each group (even
// below that function's 0.65 auto-match threshold), so most groups can be
// confirmed with one tap instead of a manual search. Read-only.

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

function bestGuess(accountName, sitesForState) {
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
  return best ? { site_id: best.id, site_code: best.site_code, name: best.name, score: bestScore } : null;
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: sites, error: sitesErr }, { data: rows, error: rowsErr }] = await Promise.all([
    supabase.from('sites').select('id, site_code, name, state'),
    supabase.from('site_visits').select('state, account_name_raw').eq('needs_review', true),
  ]);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  if (rowsErr) return json(500, { ok: false, error: 'site_visits fetch failed: ' + rowsErr.message });

  const sitesByState = {};
  for (const s of sites) {
    if (!sitesByState[s.state]) sitesByState[s.state] = [];
    sitesByState[s.state].push(s);
  }

  const groups = {};
  for (const r of rows) {
    const key = r.state + '|' + r.account_name_raw;
    if (!groups[key]) groups[key] = { state: r.state, account_name_raw: r.account_name_raw, row_count: 0 };
    groups[key].row_count++;
  }

  const results = Object.values(groups)
    .map(g => ({ ...g, suggested: bestGuess(g.account_name_raw, sitesByState[g.state] || []) }))
    .sort((a, b) => b.row_count - a.row_count);

  return json(200, { ok: true, totalRows: rows.length, totalGroups: results.length, groups: results });
};
