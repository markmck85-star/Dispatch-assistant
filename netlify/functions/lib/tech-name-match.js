// lib/tech-name-match.js -- 2026-10-29
// Matches a name that comes from Salesforce (Gantt resource, closed-visit report) to a technician.
// Order: exact name, then the technician's explicit Salesforce spelling (sf_name_alias), then a
// fuzzy match (same last name + compatible first name) that only counts when it is unambiguous.

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Same person under a different spelling of the first name (Steve/Steven, Ed/Edward, Caden/Cayden,
// Dave/David, Sid/Sidney, Tim/Timothy). Same last name AND a compatible first name. Used only as a
// fallback after an exact name match fails; ambiguous results (two candidates) are left unmatched.
function sameFirstName(a, b) {
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  if (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3)) return true;
  // one-letter slips like Caden/Cayden
  if (Math.abs(a.length - b.length) <= 1) {
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const ra = a.slice(i), rb = b.slice(i);
    if (ra.slice(1) === rb || rb.slice(1) === ra || ra.slice(1) === rb.slice(1)) return true;
  }
  return false;
}
function fuzzyTechMatch(resourceName, techs) {
  const parts = norm(resourceName).split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0], last = parts[parts.length - 1];
  const hits = [];
  for (const t of techs || []) {
    const tp = norm(t.name).split(' ').filter(Boolean);
    if (tp.length < 2) continue;
    if (tp[tp.length - 1] === last && sameFirstName(tp[0], first)) hits.push(t.id);
  }
  return hits.length === 1 ? hits[0] : null;
}


// techs: [{ id, name, sf_name_alias }]. Returns a function name -> technician id (or null).
function makeTechMatcher(techs) {
  const byName = new Map();
  for (const t of techs || []) byName.set(norm(t.name), t.id);
  for (const t of techs || []) if (t.sf_name_alias) byName.set(norm(t.sf_name_alias), t.id);
  return (name) => (name ? (byName.get(norm(name)) || fuzzyTechMatch(name, techs) || null) : null);
}

module.exports = { norm, sameFirstName, fuzzyTechMatch, makeTechMatcher };
