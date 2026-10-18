// leftover-from-notes.js -- 2026-10-17
//
// Reads the "forms left before the restock" number out of a closing note.
// Georgia techs already write it, in wordings seen in the data:
//   "The left form count was 142 prior to restock."   (ClosePilot wording)
//   "Forms at 244 prior to restock."                  (side named elsewhere in the note, e.g. "left red 2027 forms")
//   "Form count 92 prior to restock"                  (no side at all)
// and, from the 2026-10-16 instruction to all techs, the shorter form:
//   "Replaced forms at 157."                          (no "prior to restock"; must end the sentence)
// 2026-10-18: also reads the wordings other states use (checked against real notes):
//   MI  "Left forms 178 ribbon 376 ..."  "Replaced printer one forms at 151 count with ..."  "old form roll at 89"
//   CO  "restocked left reg forms. old count 181"  "Replaced left forms 281 remained"  "left form(127)"
//   OH  "Replenished magenta forms, retained 162"  "Removed 84 forms"  "restocked lft forms to full old was 138 or 13%"
//   IN  "Restocked P3 forms (149, <.25 ...)"  "ribbon and forms 193 removed roll was .25"  "Forms count was 295"
//   NV  "the left reg forms which was at 196"  "Restocked left forms full roll, 295 remain"
// Not read on purpose: "partial roll of N" (that is the roll put IN), "system count ... did not need
// restocked" (no restock happened), percentages and fractions, journal paper and ribbon numbers.
// Returns { LF, RF, F } with only the keys found. F means a count was given but the
// printer side could not be told from the note. Only whole numbers 0-2000 count; a fraction
// of a roll ("about 1/8") is never turned into a number.

function parseLeftoverCounts(note) {
  const out = {};
  if (!note || typeof note !== 'string') return out;
  const text = note.replace(/\s+/g, ' ');

  // A kiosk that ran out of forms keeps counting down ("Forms at -2 prior to restock"), so a
  // small negative number means "empty" and is saved as 0. Callers can treat a count of exactly 0
  // as "ran out before the visit": real use was at least what the count implies.
  const ok = (n) => Number.isInteger(n) && n >= -2000 && n <= 2000;
  const fix = (n) => (n < 0 ? 0 : n);

  // A: the side is named right next to the count.
  // What may follow the number: "prior to restock", a bare "prior", "count", "remaining",
  // "and ..." (Ohio style: "left forms at 124 and left ribbon at 284"), a "<25%" low-level tag, or the end of the sentence. A "%" straight after the number
  // ("Old forms at 12%") is a percentage, never matches, and so is never read as a count.
  const TAIL = '(?:\\s*prior(?:\\s+to\\s+(?:the\\s+)?restock)?\\b|\\s*(?:count|remaining|remained)\\b|\\s+and\\b|(?=\\s+(?:ribbon|journal|right|left|replaced|restocked|all)\\b)|\\s*\\(|\\s*<\\s*\\d+\\s*%|(?=\\s*(?:[.,;!]|$)))';
  const CONN = '(?:\\s+(?:which|that))?(?:\\s*(?:was|is|were))?(?:\\s*(?:at|:))?';
  const A = new RegExp('\\b(left|right)\\b[^.\\n]{0,25}?\\bforms?(?:,?\\s+count)?' + CONN + '\\s*(-?\\d{1,4})' + TAIL, 'gi');
  let m;
  while ((m = A.exec(text)) !== null) {
    const key = m[1].toLowerCase() === 'left' ? 'LF' : 'RF';
    const n = parseInt(m[2], 10);
    if (out[key] === undefined && ok(n)) out[key] = fix(n);
  }
  if (Object.keys(out).length) return out;

  // C: wordings used outside Georgia. Each pattern names the number's role, so a roll that was
  // put IN, a percentage, or a journal/ribbon number is not read as the old forms count.
  if (!/\bdco\b|did not need (?:to be )?restock|not (?:yet )?restocked/i.test(text)) {
    const NUM = '(\\d{1,4})(?!\\d|\\s*%)';
    const C = [
      // "restocked left reg forms. old count 181"
      [new RegExp('\\b(left|right)\\s+(?:reg\\s+|registration\\s+)?(?:printer\\s+)?forms?[.:,]?\\s+old\\s+count\\s+' + NUM, 'i'), 1, 2],
      // "old form roll at 89", "old left forms roll was at 216", "old forms at 30", "forms, the old roll is at 10% 147 count"
      [new RegExp('\\bold\\s+(?:(left|right)\\s+)?(?:reg\\s+)?forms?(?:\\s+roll)?\\s*(?:was|is)?\\s*(?:at\\s*)?' + NUM, 'i'), 1, 2],
      [new RegExp('\\bforms?(?:\\s+roll)?,?\\s+(?:the\\s+)?old\\s+roll\\s+(?:is\\s+|was\\s+)?at\\s+(?:\\d{1,3}\\s*%\\s*)?' + NUM + '\\s*count', 'i'), 0, 1],
      // "lft forms to full old was 138 or 13%", "restocked lft forms to full old 152"
      [new RegExp('\\b(left|lft|right)\\s+forms?\\s+to\\s+full,?\\s+old\\s+(?:was\\s+)?' + NUM, 'i'), 1, 2],
      // "forms, retained 162"   "Removed 84 forms"   "removed 101 forms"
      [new RegExp('\\bforms?,?\\s+retained\\s+' + NUM, 'i'), 0, 1],
      [new RegExp('\\bremoved\\s+' + NUM + '\\s+(?:[a-z]+\\s+)?forms?\\b', 'i'), 0, 1],
      // "Restocked P3 forms (149, <.25 ...)", "p3 green forms (108/800 14%)", "left form(127)"
      [new RegExp('\\bforms?\\s*\\(\\s*' + NUM + '\\s*[,/)]', 'i'), 0, 1],
      // "ribbon and forms 193 removed roll was .25"
      [new RegExp('\\bforms?\\s+' + NUM + '\\s+removed\\s+roll', 'i'), 0, 1],
      // "Approximately 125 forms remaining on recovered roll"
      [new RegExp(NUM + '\\s+forms?\\s+remaining\\s+on\\s+(?:the\\s+)?recovered', 'i'), 0, 1],
      // "Restocked left forms full roll, 295 remain"
      [new RegExp('\\b(left|right)\\s+forms?\\s+full\\s+roll,?\\s*' + NUM + '\\s+remain', 'i'), 1, 2],
      // "Form count was 227", "Forms count was 295" (also covered by B for the short forms)
      [new RegExp('\\bforms?\\s+count\\s+(?:was|is)\\s+' + NUM, 'i'), 0, 1],
    ];
    for (const [re, sideIdx, numIdx] of C) {
      const mm = re.exec(text);
      if (!mm) continue;
      const n = parseInt(mm[numIdx], 10);
      if (!ok(n)) continue;
      let key = 'F';
      const side = sideIdx ? String(mm[sideIdx] || '').toLowerCase() : '';
      if (side) key = side === 'right' ? 'RF' : 'LF';
      else {
        const hasLeft = /\bleft\b|\blft\b/i.test(text), hasRight = /\bright\b/i.test(text);
        key = hasLeft && !hasRight ? 'LF' : (hasRight && !hasLeft ? 'RF' : 'F');
      }
      out[key] = fix(n);
      return out;
    }
  }

  // B: a count with no side beside it. Use the rest of the note to place it.
  const B = new RegExp('\\bforms?(?:,?\\s+count)?' + CONN + '\\s*(-?\\d{1,4})' + TAIL, 'i');
  m = B.exec(text);
  if (m) {
    const n = parseInt(m[1], 10);
    if (ok(n)) {
      const hasLeft = /\bleft\b/i.test(text);
      const hasRight = /\bright\b/i.test(text);
      const key = hasLeft && !hasRight ? 'LF' : (hasRight && !hasLeft ? 'RF' : 'F');
      out[key] = fix(n);
    }
  }
  return out;
}

module.exports = { parseLeftoverCounts };
