const NOISE = new Set(["mcr","field","services","service","sst","inventory","master","sheet","inc","llc","tech","technician","the","and","area","copy"]);
const PLACES = new Set(["alabama","arkansas","california","colorado","florida","georgia","idaho","illinois","indiana","michigan","minnesota","mississippi","nevada","ohio","oregon","carolina","west","virginia","north","south","detroit","al","ar","ca","co","fl","ga","id","il","in","mi","mn","ms","nc","nv","oh","or","sc","wv"]);
// Sheet spelling (words only, lower case) -> technician names it may belong to (words only).
// 2026-10-12: roster names now follow the company roster (Sidney, David, Caden, Steven,
// Paul "Rich" Gerhart) but techs still name their sheets the short way. Each entry lists
// the new and the old saved spelling so it works on either side of a rename.
const ALIASES = {
  "paul gerhart": ["paul rich gerhart", "rich gerhart"],
  "rich gerhart": ["paul rich gerhart", "rich gerhart"],
  "sid bowman": ["sidney bowman", "sid bowman"],
  "dave steingass": ["david steingass", "dave steingass"],
  "cayden torry": ["caden torry", "cayden torry"],
  "steve wiseley": ["steven wiseley", "steve wiseley"],
};
function rawWords(s) { return String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean); }
function sheetTokens(raw) { const noParens = String(raw || "").replace(/\([^)]*\)/g, " "); return rawWords(noParens).filter((w) => !NOISE.has(w) && !PLACES.has(w)); }
function resolveSheetTech(roster, rawName) {
  const toks = sheetTokens(rawName); if (!toks.length) return null;
  const set = new Set(toks); const real = (roster || []).filter((t) => !t.extra);
  const aliasTargets = ALIASES[toks.join(" ")];
  if (aliasTargets) { const hit = real.filter((t) => aliasTargets.includes(rawWords(t.name).join(" "))); if (hit.length === 1) return hit[0]; }
  const full = real.filter((t) => { const tw = rawWords(t.name); return tw.length >= 2 && tw.every((w) => set.has(w)); });
  if (full.length === 1) return full[0]; if (full.length > 1) return null;
  const byInitial = real.filter((t) => { const tw = rawWords(t.name); if (tw.length < 2) return false; const first = tw[0]; const last = tw[tw.length - 1]; if (!set.has(last)) return false; return toks.some((x) => x !== last && (x === first || (x.length === 1 && x === first[0]))); });
  return byInitial.length === 1 ? byInitial[0] : null;
}
module.exports = { resolveSheetTech, sheetTokens };
