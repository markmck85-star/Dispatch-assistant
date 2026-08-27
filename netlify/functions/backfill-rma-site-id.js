// backfill-rma-site-id.js — added 2026-08-27
//
// One-off correction pass: resolves site_id for rma_shipments rows that
// have never had one. Confirmed live 2026-08-27: 130 of 132 total RMA
// shipment rows have site_id NULL -- the mailgun-inbound.js RMA parser has
// only ever set site_id via a WO-number match to an existing ticket
// (tickets.site_id), and that path rarely fires (only 3 rows). Motivation,
// per Mark: when a part physically arrives at a warehouse/tech days after
// being requested, whoever unpacks it has no fast way to tell which site
// it's for -- currently means manually digging through Salesforce/email.
//
// rma_shipments.account_name is in the exact same "STATE - City/County
// SiteName" raw format already handled by perform-import.js's matchSite()
// for the Salesforce closed-ticket report, so this reuses that same
// token-overlap + site_aliases logic verbatim (copied rather than
// required from lib/perform-import.js, matching this codebase's existing
// pattern of each one-off script carrying its own copy -- see
// rematch-site-visits.js for the precedent).
//
// Also cleans stray "<br>" HTML artifacts left in account_name/wo_number/
// warehouse_name on older rows that predate the 2026-08-25 live-parser
// fix for this (see mailgun-inbound.js) -- cosmetic, but also matters
// here since an un-stripped "<br>" would otherwise tokenize into a bogus
// "br" token and could drag down match scores.
//
// No offset/pagination needed in practice (132 total rows fits in one
// call), but written to be safely re-callable: it only ever queries rows
// still sitting at site_id IS NULL, so a matched row naturally drops out
// of scope on the next call rather than needing to track position.
//
// GET /.netlify/functions/backfill-rma-site-id?limit=500
// -> { ok, processed, matched, stillUnmatched, matchedSamples,
//      unmatchedSamples, remainingNullCount }

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const TOKEN_ALIASES = {
  'co': 'county', 'cnty': 'county', 'ave': 'avenue', 'blvd': 'boulevard',
  'dr': 'drive', 'rd': 'road', 'st': 'street', 'mt': 'mount',
  'hwy': 'highway', 'pkwy': 'parkway',
};

function cleanField(v) {
  return (v || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
}

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

function matchSite(accountName, sitesForState, aliasMap) {
  const aliasSiteId = aliasMap[String(accountName || '').trim()];
  if (aliasSiteId) return { siteId: aliasSiteId, matched: true, matchSource: 'alias' };

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
  if (best && bestScore >= 0.65) return { siteId: best.id, matched: true, matchSource: 'text' };
  return { siteId: null, matched: false, matchSource: null };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit || '500', 10), 500);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: sites, error: sitesErr }, { data: aliases, error: aliasesErr }] = await Promise.all([
    supabase.from('sites').select('id, name, state'),
    supabase.from('site_aliases').select('alias, site_id'),
  ]);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  if (aliasesErr) return json(500, { ok: false, error: 'site_aliases fetch failed: ' + aliasesErr.message });

  const sitesByState = {};
  for (const s of sites) {
    if (!sitesByState[s.state]) sitesByState[s.state] = [];
    sitesByState[s.state].push(s);
  }
  const aliasMap = {};
  for (const a of aliases || []) aliasMap[a.alias] = a.site_id;

  const { data: batch, error: batchErr } = await supabase
    .from('rma_shipments')
    .select('id, account_name, state, wo_number, warehouse_name')
    .is('site_id', null)
    .order('id', { ascending: true })
    .limit(limit);
  if (batchErr) return json(500, { ok: false, error: 'batch fetch failed: ' + batchErr.message });

  let matched = 0;
  let stillUnmatched = 0;
  const matchedSamples = [];
  const unmatchedSamples = [];

  for (const row of batch) {
    // Derive state from account_name if the stored column is somehow
    // missing -- same "STATE - " prefix format used throughout this
    // pipeline. Confirmed live that state is already populated on every
    // currently-null-site_id row, but this guards any future edge case
    // (e.g. a state value that predates that being reliably parsed).
    const cleanedAccountName = cleanField(row.account_name);
    let state = row.state;
    if (!state) {
      const stateM = cleanedAccountName.match(/^([A-Z]{2})\s*-/);
      if (stateM) state = stateM[1];
    }

    const sitesForState = state ? (sitesByState[state] || []) : [];
    const { siteId, matched: didMatch } = matchSite(cleanedAccountName, sitesForState, aliasMap);

    const updates = {};
    // Always write back the cleaned text fields, even on a match miss --
    // fixes the display-level <br> artifact regardless of whether a site
    // was resolved this pass.
    if (cleanedAccountName !== (row.account_name || '')) updates.account_name = cleanedAccountName;
    const cleanedWo = cleanField(row.wo_number);
    if (cleanedWo !== (row.wo_number || '')) updates.wo_number = cleanedWo || null;
    const cleanedWarehouse = cleanField(row.warehouse_name);
    if (cleanedWarehouse !== (row.warehouse_name || '')) updates.warehouse_name = cleanedWarehouse || null;
    if (!row.state && state) updates.state = state;
    if (didMatch) updates.site_id = siteId;

    if (Object.keys(updates).length) {
      const { error: updateErr } = await supabase
        .from('rma_shipments')
        .update(updates)
        .eq('id', row.id);
      if (updateErr) {
        console.error(`[backfill-rma-site-id] update failed for row ${row.id}:`, updateErr.message);
      } else if (didMatch) {
        matched++;
        if (matchedSamples.length < 25) {
          matchedSamples.push({ accountName: cleanedAccountName, state, siteId });
        }
      }
    }

    if (!didMatch) {
      stillUnmatched++;
      if (unmatchedSamples.length < 25) {
        unmatchedSamples.push({ accountName: cleanedAccountName, state });
      }
    }
  }

  const { count: remainingNullCount } = await supabase
    .from('rma_shipments')
    .select('id', { count: 'exact', head: true })
    .is('site_id', null);

  return json(200, {
    ok: true,
    processed: batch.length,
    matched,
    stillUnmatched,
    matchedSamples,
    unmatchedSamples,
    remainingNullCount,
  });
};
