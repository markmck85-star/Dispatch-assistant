// get-unmatched-sites.js — v2 — updated 2026-08-30
//
// Powers the "Unmatched Sites" review tool. 3,452 needs_review site_visits
// rows collapse down to only ~179 distinct (state, account_name_raw)
// groups -- reviewing and fixing per GROUP rather than per row is what
// makes this tractable at all. Read-only.
//
// v2 changes, all driven by the same root cause: plain token-overlap
// scoring treats every shared word as equally meaningful, but generic
// words like "bmv"/"dmv"/"sos"/"county" appear in dozens of site names
// per state and drown out the one word that actually distinguishes a
// location (the town/street name). Confirmed live 2026-08-30: 21 BMV-
// named sites in Indiana alone meant every "___ BMV" unmatched name tied
// at the same score against all 21, so the tool just showed whichever
// happened to come first -- consistently wrong (e.g. "Midtown BMV"
// suggested "Bluffton BMV", a real site 100+ miles away, while the
// actual matches -- Midtown AND Midtown 2, two separate Big Hoku units
// genuinely both at that address -- never surfaced at all).
//
//  1. IDF-style down-weighting: a token's weight is inverse to how many
//     site names in that state contain it, computed per-state from the
//     sites list itself (no hardcoded stopword list to maintain).
//  2. Multi-unit siblings ("Carmel", "Carmel 2", "Carmel 3" -- a real,
//     widespread Indiana pattern of separate Big Hoku units at one busy
//     address) are meant to score identically against an unnumbered raw
//     name, not be treated as a meaningful mismatch -- bare numeric
//     tokens are dropped before scoring so they group as intended siblings
//     instead of being penalized as an extra unmatched word.
//  3. Ties are surfaced, not silently resolved: every site scoring at (or
//     within a small margin of) the top score comes back as a candidate,
//     not just one arbitrary pick presented with false confidence. When
//     the raw name carries no unit number itself, the base (unnumbered)
//     sibling is marked primary among the tied candidates.
//  4. Ticket-address crossover: many of these same raw names also show up
//     in email tickets, which (unlike this Salesforce-report data) often
//     carry a captured street address. When one exists and it matches a
//     candidate site's address, that becomes a high-confidence
//     "address-confirmed" result that overrides the name-only guess
//     entirely, using the same address-normalization approach validated
//     against mailgun-inbound.js's own matching the same day.

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
    .map((t) => TOKEN_ALIASES[t] || t)
    // Bare numeric tokens are either an internal reference number ("205",
    // "376") or a multi-unit suffix ("2", "3", "4") -- neither is a
    // meaningful distinguishing word for scoring purposes. Dropping both
    // lets "Carmel" and "Carmel 2" tokenize identically, so they correctly
    // tie as siblings instead of scoring as a partial mismatch.
    .filter((t) => !/^\d+$/.test(t));
}

function stripStatePrefix(accountName) {
  const m = String(accountName || '').trim().match(/^([A-Za-z]{2})\s*-\s*(.+)$/);
  return m ? m[2] : String(accountName || '').trim();
}

// Category guard, carried over from the original site-matching cleanup
// campaign's hard rule: an agency-acronym raw name must never match a
// retail-chain-named site even on strong incidental word overlap (shared
// city/county/street name). Token scoring alone can't tell "DMV" and
// "Kroger" apart if the raw name and the site both happen to mention the
// same town -- this is a categorical veto, not a score penalty, same as
// the safety rule already proven out on the closed-ticket import matcher.
// Returns 'agency', 'retail', or null (uncategorized -- doesn't veto).
const AGENCY_PATTERNS = [/\bbmv\b/, /\bdmv\b/, /\bsos\b/, /\bsso\b/, /\btc\b/, /\bmv\b/, /\bstate prison\b/];
const RETAIL_CHAINS = [
  'kroger', 'meijer', 'publix', 'walmart', 'albertsons', 'safeway', 'raley',
  'cub foods', 'discount drug', 'harris teeter', 'food lion', 'giant eagle',
  'save-a-lot', 'weis', 'shoprite', 'winn-dixie', 'h-e-b', 'heb', 'fred meyer',
  "fry's", 'king soopers', 'ralphs', 'vons', 'pavilions', 'jewel-osco',
  'stop & shop', 'stop and shop', 'wegmans', "martin's super market",
];
function categorizeName(name) {
  const lower = (name || '').toLowerCase();
  for (const pat of AGENCY_PATTERNS) if (pat.test(lower)) return 'agency';
  for (const chain of RETAIL_CHAINS) if (lower.includes(chain)) return 'retail';
  return null;
}

// Per-state inverse-document-frequency weights, computed from how many
// site names in that state contain each token. A token in every site's
// name (weight -> near 0) contributes almost nothing to the score; a
// token unique to one or two sites (weight -> near 1) carries real
// distinguishing power. log-based so the falloff is gradual rather than
// all-or-nothing.
function buildTokenWeights(sitesForState) {
  const docFreq = {};
  for (const site of sitesForState) {
    const seen = new Set(tokenize(site.name));
    for (const t of seen) docFreq[t] = (docFreq[t] || 0) + 1;
  }
  const n = Math.max(sitesForState.length, 1);
  const weights = {};
  for (const [t, df] of Object.entries(docFreq)) {
    weights[t] = Math.log((n + 1) / df);
  }
  return weights;
}

// Weighted Jaccard similarity: shared weight over the weight of the
// COMBINED vocabulary (target ∪ candidate), not just the target's own
// tokens. The earlier version only measured how much of the target was
// covered by the candidate, so a candidate with extra unrelated words
// scored no worse than one without any -- confirmed live 2026-08-30:
// "Elkhart County Kroger" tied EXACTLY with plain "Elkhart" against a
// target of "Elkhart BMV", because both equally cover the target's own
// tokens and the extra "County"/"Kroger" words never counted against the
// former. Weighted Jaccard fixes this: those extra words add weight to
// the union (denominator) without adding anything to the intersection
// (numerator), correctly scoring the plain "Elkhart" match higher since
// it doesn't carry unrelated extra content the target never mentioned.
function weightedOverlapScore(targetTokens, siteTokens, weights) {
  const setA = new Set(targetTokens);
  const setB = new Set(siteTokens);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  let sharedWeight = 0;
  let unionWeight = 0;
  for (const t of union) {
    const w = weights[t] ?? 1;
    unionWeight += w;
    if (setA.has(t) && setB.has(t)) sharedWeight += w;
  }
  return unionWeight > 0 ? sharedWeight / unionWeight : 0;
}

// Returns every site within TIE_MARGIN of the top score, not just the
// single best -- genuine ties (multi-unit siblings, or two otherwise
// equally-plausible guesses) need a human to see all the options, not
// one arbitrary pick.
const TIE_MARGIN = 0.02;
// Every real multi-unit sibling pattern seen in practice (Carmel 2/3/4,
// Mishawaka Hoku 1-4, Indy North/South/East/West 2/3/4) tops out at a
// handful of units at one address. A tied group far larger than that
// isn't a genuine multi-way ambiguity -- it means the ONLY thing shared
// between the raw name and every candidate is a generic category word
// ("Kroger", "BMV"), with nothing distinctive matching at all (e.g. a
// town name -- "Lambertville" -- that doesn't exist in any site name for
// that state, because the location genuinely isn't in the database yet).
// Confirmed live 2026-08-30: "MI - Lambertville Kroger" tied with every
// single Kroger-named site in Michigan at the same score. Past this cap,
// treat it as no confident match rather than surfacing dozens of
// unrelated alternates.
const MAX_TIE_GROUP = 6;
function rankedCandidates(accountName, sitesForState, weights) {
  const nameOnly = stripStatePrefix(accountName);
  const targetTokens = tokenize(nameOnly);
  const targetCategory = categorizeName(nameOnly);
  const scored = sitesForState
    // Categorical veto first: an agency name and a retail-chain name are
    // never the same site, regardless of how well the rest of the words
    // overlap -- excluded outright, not just scored lower.
    .filter((site) => {
      const siteCategory = categorizeName(site.name);
      if (!targetCategory || !siteCategory) return true;
      return targetCategory === siteCategory;
    })
    .map((site) => ({ site, score: weightedOverlapScore(targetTokens, tokenize(site.name), weights) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const topScore = scored[0].score;
  const tied = scored.filter((s) => s.score >= topScore - TIE_MARGIN);
  if (tied.length > MAX_TIE_GROUP) return [];

  // If the raw name itself carries no digit (no explicit unit number),
  // and the tied set includes both a base (unnumbered) site and numbered
  // siblings, prefer the base one as primary -- it's the more likely
  // intended match for a generic historical reference, with the numbered
  // siblings still listed as alternates rather than hidden.
  const rawHasDigit = /\d/.test(nameOnly);
  if (!rawHasDigit && tied.length > 1) {
    const baseFirst = [...tied].sort((a, b) => {
      const aHasNum = /\d/.test(a.site.name) ? 1 : 0;
      const bHasNum = /\d/.test(b.site.name) ? 1 : 0;
      return aHasNum - bHasNum;
    });
    return baseFirst;
  }
  return tied;
}

// ── Address-based matching (mirrors mailgun-inbound.js's approach) ───────
const ORDINAL_WORDS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
};
const STREET_TYPE_WORDS = {
  street: 'st', avenue: 'ave', road: 'rd', boulevard: 'blvd', drive: 'dr',
  lane: 'ln', highway: 'hwy', circle: 'cir', court: 'ct', place: 'pl',
  parkway: 'pkwy', trail: 'trl', terrace: 'ter', square: 'sq',
};
const DIRECTION_WORDS = {
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  north: 'n', south: 's', east: 'e', west: 'w',
};

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function normalizeStreetLine(line) {
  let s = (line || '').toLowerCase();
  const applyWordMap = (map) => {
    for (const [word, abbr] of Object.entries(map)) {
      s = s.replace(new RegExp('\\b' + word + '\\b', 'g'), abbr);
    }
  };
  applyWordMap(ORDINAL_WORDS);
  applyWordMap(DIRECTION_WORDS);
  applyWordMap(STREET_TYPE_WORDS);
  s = s.replace(/\b(suite|ste|unit|apt)\b\s*#?\s*\w*/g, ' ');
  s = s.replace(/[.,#]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function extractStreetSignature(fullAddress) {
  if (!fullAddress) return null;
  const firstLine = String(fullAddress).split('\n')[0].split(',')[0];
  const norm = normalizeStreetLine(firstLine);
  const m = norm.match(/^(\d+)\s+(.*)$/);
  if (!m || !m[2]) return null;
  let rest = m[2].trim();
  let direction = null;
  const dirMatch = rest.match(/^(ne|nw|se|sw|n|s|e|w)\s+(.*)$/);
  if (dirMatch) { direction = dirMatch[1]; rest = dirMatch[2]; }
  return { number: m[1], direction, street: rest };
}

function addressesLooselyMatch(addrA, addrB) {
  const a = extractStreetSignature(addrA);
  const b = extractStreetSignature(addrB);
  if (!a || !b) return false;
  if (a.number !== b.number) return false;
  if ((a.direction || null) !== (b.direction || null)) return false;
  if (a.street === b.street) return true;
  const dist = levenshtein(a.street, b.street);
  const maxLen = Math.max(a.street.length, b.street.length);
  return maxLen > 0 && dist <= 2 && dist / maxLen < 0.3;
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: sites, error: sitesErr }, { data: rows, error: rowsErr }, { data: ticketRows, error: ticketErr }] = await Promise.all([
    supabase.from('sites').select('id, site_code, name, state, address'),
    supabase.from('site_visits').select('state, account_name_raw').eq('needs_review', true),
    supabase.from('tickets').select('site_text, address').not('address', 'is', null),
  ]);
  if (sitesErr) return json(500, { ok: false, error: 'sites fetch failed: ' + sitesErr.message });
  if (rowsErr) return json(500, { ok: false, error: 'site_visits fetch failed: ' + rowsErr.message });
  if (ticketErr) return json(500, { ok: false, error: 'tickets fetch failed: ' + ticketErr.message });

  const sitesByState = {};
  for (const s of sites) {
    if (!sitesByState[s.state]) sitesByState[s.state] = [];
    sitesByState[s.state].push(s);
  }
  const weightsByState = {};
  for (const [state, list] of Object.entries(sitesByState)) weightsByState[state] = buildTokenWeights(list);

  // Address lookup keyed by normalized raw name (state-prefix stripped,
  // lowercased) -- first captured address wins for a given name.
  const addressByName = {};
  for (const t of ticketRows) {
    if (!t.site_text || !t.address) continue;
    const key = stripStatePrefix(t.site_text).toLowerCase().trim();
    if (!addressByName[key]) addressByName[key] = t.address;
  }

  const groups = {};
  for (const r of rows) {
    const key = r.state + '|' + r.account_name_raw;
    if (!groups[key]) groups[key] = { state: r.state, account_name_raw: r.account_name_raw, row_count: 0 };
    groups[key].row_count++;
  }

  const results = Object.values(groups).map((g) => {
    const sitesForState = sitesByState[g.state] || [];
    const weights = weightsByState[g.state] || {};
    const candidates = rankedCandidates(g.account_name_raw, sitesForState, weights);

    // Address crossover: if a ticket shares this exact raw name and has an
    // address, and that address matches exactly one candidate (or any site
    // in the state, even one that didn't score well on name alone), that's
    // far more reliable than token overlap -- surface it as the confirmed
    // answer instead of a name-only guess.
    const key = stripStatePrefix(g.account_name_raw).toLowerCase().trim();
    const knownAddress = addressByName[key];
    let addressConfirmed = null;
    if (knownAddress) {
      const addressMatch = sitesForState.find((s) => addressesLooselyMatch(knownAddress, s.address));
      if (addressMatch) {
        addressConfirmed = { site_id: addressMatch.id, site_code: addressMatch.site_code, name: addressMatch.name };
      }
    }

    const candidateList = candidates.map((c) => ({
      site_id: c.site.id, site_code: c.site.site_code, name: c.site.name, score: c.score,
    }));

    return {
      ...g,
      suggested: candidateList[0] || null,
      alternates: candidateList.slice(1),
      addressConfirmed,
    };
  }).sort((a, b) => b.row_count - a.row_count);

  return json(200, { ok: true, totalRows: rows.length, totalGroups: results.length, groups: results });
};
