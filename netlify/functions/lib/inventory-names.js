/**
 * lib/inventory-names.js
 * SAVE AS: netlify/functions/lib/inventory-names.js
 *
 * Turns the name written on a technician's count sheet into a roster technician.
 * Sheet names are free text: "IN Field Services - Aaron Schrop", "MCR ERIC
 * KROEKER", "Ohio - MCR Mike LaSalvia", "R.Crabtree",
 * "MI Field Services - Caleb Caroen (Detroit Area)". Company words, state names
 * and anything in parentheses are dropped first; what remains is compared to
 * roster names.
 *
 *   1. every word of a roster name appears on the sheet     -> that technician
 *   2. same last name AND the first name or its first
 *      initial appears ("R.Crabtree" -> Ross Crabtree)       -> that technician
 *
 * Only a single match is ever returned. Two candidates, a different first name
 * with the same last name, a company name: all return null, so the sheet stays
 * visible as unmatched instead of crediting the wrong person.
 *
 * ALIASES: a sheet name that is not the roster name, but is the same person.
 * Paul Gerhart is Rich Gerhart (legal name Paul, goes by Rich). The roster card
 * stays Rich. Do not rename it.
 */
const NOISE = new Set([
  "mcr", "field", "services", "service", "sst", "inventory", "master", "sheet", "inc", "llc", "tech",
  "technician", "the", "and", "area", "copy",
]);
const PLACES = new Set([
  "alabama", "arkansas", "california", "colorado", "florida", "georgia", "idaho", "illinois", "indiana",
  "michigan", "minnesota", "mississippi", "nevada", "ohio", "oregon", "carolina", "west", "virginia",
  "north", "south", "detroit", "al", "ar", "ca", "co", "fl", "ga", "id", "il", "in", "mi", "mn", "ms",
  "nc", "nv", "oh", "or", "sc", "wv",
]);

// sheet tokens joined, matched to a roster name (case-insensitive, full name)
const ALIASES = {
  "paul gerhart": "rich gerhart",
};

function rawWords(s) {
  return String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
}
function sheetTokens(raw) {
  const noParens = String(raw || "").replace(/\([^)]*\)/g, " ");
  return rawWords(noParens).filter((w) => !NOISE.has(w) && !PLACES.has(w));
}

function resolveSheetTech(roster, rawName) {
  const toks = sheetTokens(rawName);
  if (!toks.length) return null;
  const set = new Set(toks);
  const real = (roster || []).filter((t) => !t.extra);

  const aliasTarget = ALIASES[toks.join(" ")];
  if (aliasTarget) {
    const hit = real.filter((t) => rawWords(t.name).join(" ") === aliasTarget);
    if (hit.length === 1) return hit[0];
  }

  const full = real.filter((t) => {
    const tw = rawWords(t.name);
    return tw.length >= 2 && tw.every((w) => set.has(w));
  });
  if (full.length === 1) return full[0];
  if (full.length > 1) return null;

  const byInitial = real.filter((t) => {
    const tw = rawWords(t.name);
    if (tw.length < 2) return false;
    const first = tw[0];
    const last = tw[tw.length - 1];
    if (!set.has(last)) return false;
    return toks.some((x) => x !== last && (x === first || (x.length === 1 && x === first[0])));
  });
  return byInitial.length === 1 ? byInitial[0] : null;
}

module.exports = { resolveSheetTech, sheetTokens };
