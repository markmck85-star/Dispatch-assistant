/**
 * lib/address-match.js — extracted 2026-09-10 from mailgun-inbound.js
 *
 * Address-signature matching used to find an existing site when a ticket's
 * own text has no embedded site code (site_survey/install always; some
 * trouble/maintenance tickets too). Originally lived inline in
 * mailgun-inbound.js -- pulled out unchanged so lib/placeholder-sites.js
 * (new 2026-09-10, placeholder-site promotion flow) can reuse the exact
 * same matching logic instead of a second, potentially-drifting copy.
 * mailgun-inbound.js now requires this instead of defining these locally.
 */

const ORDINAL_WORDS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
  eleventh: '11th', twelfth: '12th', thirteenth: '13th', fourteenth: '14th',
  fifteenth: '15th', sixteenth: '16th', seventeenth: '17th', eighteenth: '18th',
  nineteenth: '19th', twentieth: '20th',
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

// Looks for an existing site in the same state whose address matches, when
// the ticket's own text had no embedded site code to look up directly.
// Scoped to one state's sites (cheap, and state is reliably known from the
// ticket's own Location field even without a code) rather than scanning
// every site in the database.
//
// 2026-09-10: now also selects is_placeholder, so a caller can tell whether
// the match it just got back is a real onboarded site or a placeholder
// created by the site-survey/install flow (lib/placeholder-sites.js) --
// that distinction is what triggers the promotion-toast flow when a
// real-coded ticket lands on a placeholder's address.
async function findSiteByAddress(supabase, address, stateHint) {
  if (!address || !stateHint) return null;
  const { data: candidates, error } = await supabase
    .from('sites')
    .select('id, site_code, address, is_placeholder')
    .eq('state', stateHint);
  if (error || !candidates) return null;
  for (const c of candidates) {
    if (addressesLooselyMatch(address, c.address)) return c;
  }
  return null;
}

module.exports = {
  addressesLooselyMatch,
  extractStreetSignature,
  findSiteByAddress,
};
