// lib/detect-restock-in-note.js
//
// Heuristic: does a captured Salesforce closing-note's free text confirm
// that forms/ribbon/journal paper were actually restocked during this
// visit, even though the visit's own ticket type (remediation) wasn't
// classified as a restock -- e.g. "Hardware Troubleshooting" tickets where
// the tech also topped off forms while on-site?
//
// This feeds `included_restock` on site_visits (same column already used
// for the existing ticket-text-inference mechanism in perform-import.js --
// see that file's comments). get-restock-schedule.js already treats any
// row with `is_restock || included_restock` as a real restock for cycle
// math and the "last restock" display.
//
// 2026-09-15: split into two confidence tiers per Mark's request -- notes
// are frequently ambiguous, so a HIGH-confidence match auto-applies
// (included_restock=true, same as before), but a LOW-confidence match
// instead sets restock_review_pending=true and leaves included_restock
// alone until a dispatcher confirms or rejects it via the review-queue
// toast on restock-tracker.html (get-restock-review-queue.js /
// resolve-restock-review.js).

// HIGH confidence: a clear completion verb directly tied to a consumable
// noun within a short window either direction -- "restocked ... forms",
// "topped off the forms", etc. Low false-positive risk.
const STRONG_PATTERNS = [
  // "restocked" (or "re-stocked") within ~40 chars of a consumable noun,
  // in either order -- covers "restocked left forms" and "forms were
  // restocked" phrasing alike.
  /\bre-?stocked\b[\s\S]{0,40}\b(forms?|ribbon|journal|paper|rolls?)\b/i,
  /\b(forms?|ribbon|journal|paper|rolls?)\b[\s\S]{0,40}\bre-?stocked\b/i,
  /\btopped off (the )?forms?\b/i,
  /\breplenished (the )?forms?\b/i,
];

// LOW confidence: same general territory, but a weaker verb (could mean
// "cleared a jam" rather than a real restock), or a strong pattern that
// showed up near a hedge word ("appears to have", "I believe", "should
// be") -- worth a human glance rather than auto-applying.
const WEAK_PATTERNS = [
  /\bloaded (new |fresh )?forms?\b/i,
  /\badded (new |fresh )?forms?\b/i,
  /\bput in (new |fresh )?forms?\b/i,
  /\breplaced (the )?forms?\b/i,
  /\bre-?stocked\b/i, // bare "restocked" with no consumable noun nearby -- ambiguous what was restocked
];

// Words within this lookback window before a match flip it to "no match at
// all" -- a clear negation, not just ambiguity ("did not restock", "unable
// to restock", "no forms available to restock").
const NEGATION_LOOKBACK_CHARS = 40;
const NEGATORS = /\b(no|not|n't|unable to|couldn't|could not|didn't|did not|declined|refused|without|never)\b/i;

// Words within this window (before OR after) downgrade an otherwise-strong
// match to low-confidence rather than discarding it -- the note is hedging
// on whether it actually happened.
const HEDGE_LOOKAROUND_CHARS = 40;
const HEDGES = /\b(might have|may have|possibly|appears? to|seems? to|looks? like|i believe|i think|should have|probably|likely|not sure|unsure|think(?:s|ing)? (?:it|they|he|she) (?:was|were))\b/i;

function isNegated(note, matchIndex) {
  const windowStart = Math.max(0, matchIndex - NEGATION_LOOKBACK_CHARS);
  return NEGATORS.test(note.slice(windowStart, matchIndex));
}

function isHedged(note, matchIndex, matchLength) {
  const start = Math.max(0, matchIndex - HEDGE_LOOKAROUND_CHARS);
  const end = Math.min(note.length, matchIndex + matchLength + HEDGE_LOOKAROUND_CHARS);
  return HEDGES.test(note.slice(start, end));
}

function snippetAround(note, matchIndex, matchLength, pad = 45) {
  const start = Math.max(0, matchIndex - pad);
  const end = Math.min(note.length, matchIndex + matchLength + pad);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < note.length ? '…' : '';
  return prefix + note.slice(start, end).trim() + suffix;
}

/**
 * @param {string|null|undefined} note - captured closing_note text
 * @returns {null|{confidence:'high'|'low', matchedPhrase:string, reason:string}}
 *   null if no restock confirmation was detected at all.
 */
function classifyRestockConfirmation(note) {
  if (!note || typeof note !== 'string') return null;

  for (const pattern of STRONG_PATTERNS) {
    const match = pattern.exec(note);
    if (!match) continue;
    if (isNegated(note, match.index)) continue;
    const snippet = snippetAround(note, match.index, match[0].length);
    if (isHedged(note, match.index, match[0].length)) {
      return { confidence: 'low', matchedPhrase: match[0], reason: `Hedged restock language: "${snippet}"` };
    }
    return { confidence: 'high', matchedPhrase: match[0], reason: `Confirmed: "${snippet}"` };
  }

  for (const pattern of WEAK_PATTERNS) {
    const match = pattern.exec(note);
    if (!match) continue;
    if (isNegated(note, match.index)) continue;
    const snippet = snippetAround(note, match.index, match[0].length);
    return { confidence: 'low', matchedPhrase: match[0], reason: `Ambiguous restock language: "${snippet}"` };
  }

  return null;
}

// Kept for anything still calling the original boolean-only API.
function noteConfirmsRestock(note) {
  const result = classifyRestockConfirmation(note);
  return !!result && result.confidence === 'high';
}

module.exports = { classifyRestockConfirmation, noteConfirmsRestock };
