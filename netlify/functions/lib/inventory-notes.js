/**
 * lib/inventory-notes.js  (v1, 2026-10-12)
 * SAVE AS: netlify/functions/lib/inventory-notes.js
 *
 * Turns the raw body of an inventory email into just the message the tech typed.
 * Email signatures (name, title, company line, phone) were showing up as
 * "Notes from the mailbox" on the inventory board and in the Send reviewed set
 * preview. Used by get-inventory-detail.js and send-inventory-set.js.
 *
 * Conservative on purpose: a signature is only cut when what follows the cut is
 * small (a few short lines), so a real message is never chopped in the middle.
 * If nothing but a signature is left, the result is an empty string and the
 * caller skips the note.
 */
const { cleanEmailBody } = require("./clean-email.js");

const MAX_SIG_LINES = 10;   // most non-empty lines a signature may span
const MAX_SIG_CHARS = 450;  // most characters a signature may span
const MAX_TITLE_LINE = 50;  // a name or job-title line is short

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const CLOSING = /^(thanks|thank you|thx|regards|best regards|kind regards|best|sincerely|respectfully|cheers)[\s,!.]*$/i;
const SENT_FROM = /^sent from my\b/i;
const COMPANY = /mcr\s+technical\s+service/i;
const PHONE_START = /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL_ONLY = /^(mailto:)?[^\s@]+@[^\s@]+\.[a-z]{2,}(\s*<mailto:[^>]*>)?[\s.,;]*$/i;

// Names to recognise as the start of a signature: display names from the
// sender field plus any names the caller passes (sheet tech names).
function namesFrom(sender, extra) {
  const out = new Set();
  const m = String(sender || "").match(/^\s*"?([^"<@]+?)"?\s*</);
  if (m && /\s/.test(m[1].trim())) out.add(norm(m[1]));
  for (const n of extra || []) {
    const v = norm(n);
    if (v && /\s/.test(v)) out.add(v);
  }
  return [...out];
}

function looksLikeTitleLine(line) {
  const t = line.trim();
  return t.length > 0 && t.length <= MAX_TITLE_LINE && !/[.!?:]$/.test(t) && !/\d/.test(t);
}

// Is everything from line index i to the end small enough to be a signature?
function tailIsSignatureSized(lines, i) {
  const rest = lines.slice(i).filter((l) => l.trim());
  if (rest.length > MAX_SIG_LINES) return false;
  return rest.join("\n").length <= MAX_SIG_CHARS;
}

// Back up over up to `max` short name/title lines directly above a company or
// phone line, skipping blank lines, so "Randy Thomas / Field Technician" above
// "MCR Technical Service, LLC" go with it.
function walkBack(lines, i, max) {
  let start = i;
  let taken = 0;
  let j = i - 1;
  while (j >= 0 && taken < max) {
    if (!lines[j].trim()) { j--; continue; }
    if (!looksLikeTitleLine(lines[j])) break;
    start = j;
    taken++;
    j--;
  }
  return start;
}

function findSignatureStart(lines, names) {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    const low = norm(t);
    let cut = -1;

    if (/^(--+|—+|–+|_{3,})\s*$/.test(t)) {
      cut = i; // explicit delimiter always counts
      return cut;
    }
    if (CLOSING.test(t) || SENT_FROM.test(t)) cut = i;
    else if (names.some((n) => low.startsWith(n) && t.length <= n.length + 80)) cut = i;
    else if (COMPANY.test(t)) cut = walkBack(lines, i, 2);
    else if (PHONE_START.test(t) || EMAIL_ONLY.test(t)) cut = walkBack(lines, i, 3);

    if (cut >= 0 && tailIsSignatureSized(lines, cut)) return cut;
  }
  return -1;
}

function stripSignature(text, names) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const cut = findSignatureStart(lines, names || []);
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n");
}

/**
 * noteText(rawBody, { sender, names })
 * Returns the message with quoted replies, disclaimers and the signature removed,
 * or "" if nothing but a signature was there.
 */
function noteText(rawBody, opts) {
  const o = opts || {};
  let text = cleanEmailBody(rawBody);
  text = text.replace(/\s*<mailto:[^>]*>/gi, "");
  text = stripSignature(text, namesFrom(o.sender, o.names));
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { noteText, stripSignature };
