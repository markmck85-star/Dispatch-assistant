// leftover-from-notes.js -- 2026-10-17
//
// Reads the "forms left before the restock" number out of a closing note.
// Georgia techs already write it, in wordings seen in the data:
//   "The left form count was 142 prior to restock."   (ClosePilot wording)
//   "Forms at 244 prior to restock."                  (side named elsewhere in the note, e.g. "left red 2027 forms")
//   "Form count 92 prior to restock"                  (no side at all)
// and, from the 2026-10-16 instruction to all techs, the shorter form:
//   "Replaced forms at 157."                          (no "prior to restock"; must end the sentence)
// Returns { LF, RF, F } with only the keys found. F means a count was given but the
// printer side could not be told from the note. Only whole numbers 0-2000 count; a fraction
// of a roll ("about 1/8") is never turned into a number.

function parseLeftoverCounts(note) {
  const out = {};
  if (!note || typeof note !== 'string') return out;
  const text = note.replace(/\s+/g, ' ');

  const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 2000;

  // A: the side is named right next to the count.
  // What may follow the number: "prior to restock", a bare "prior", "count", "remaining",
  // a "<25%" low-level tag, or the end of the sentence. A "%" straight after the number
  // ("Old forms at 12%") is a percentage, never matches, and so is never read as a count.
  const TAIL = '(?:\\s*prior(?:\\s+to\\s+(?:the\\s+)?restock)?\\b|\\s*(?:count|remaining)\\b|\\s*<\\s*\\d+\\s*%|(?=\\s*(?:[.,;!]|$)))';
  const CONN = '(?:\\s*(?:was|is|were))?(?:\\s*(?:at|:))?';
  const A = new RegExp('\\b(left|right)\\b[^.\\n]{0,25}?\\bforms?(?:\\s+count)?' + CONN + '\\s*(\\d{1,4})' + TAIL, 'gi');
  let m;
  while ((m = A.exec(text)) !== null) {
    const key = m[1].toLowerCase() === 'left' ? 'LF' : 'RF';
    const n = parseInt(m[2], 10);
    if (out[key] === undefined && ok(n)) out[key] = n;
  }
  if (Object.keys(out).length) return out;

  // B: a count with no side beside it. Use the rest of the note to place it.
  const B = new RegExp('\\bforms?(?:\\s+count)?' + CONN + '\\s*(\\d{1,4})' + TAIL, 'i');
  m = B.exec(text);
  if (m) {
    const n = parseInt(m[1], 10);
    if (ok(n)) {
      const hasLeft = /\bleft\b/i.test(text);
      const hasRight = /\bright\b/i.test(text);
      const key = hasLeft && !hasRight ? 'LF' : (hasRight && !hasLeft ? 'RF' : 'F');
      out[key] = n;
    }
  }
  return out;
}

module.exports = { parseLeftoverCounts };
