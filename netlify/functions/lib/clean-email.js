/**
 * lib/clean-email.js
 *
 * Shared cleanup for raw inbound email bodies. Used by:
 *  - search_emails (MCP tool, via netlify/functions/search-emails.js)
 *  - the planned click-to-view-email feature on location-lookup.html
 *
 * Goal: strip quoted reply chains, signature blocks, and disclaimer
 * boilerplate so what gets returned/displayed is just the actual message
 * content, not the whole email thread.
 *
 * This is intentionally conservative -- it's better to leave a little
 * cruft in than to accidentally chop off real content. Patterns below
 * are based on common Outlook/Gmail/Salesforce-notification formats;
 * expect to tune these against real MCR inbound_emails samples.
 */

// Lines that mark the start of a quoted reply chain. Once one of these
// matches, everything from that line to the end is dropped.
const QUOTE_START_PATTERNS = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^On .{5,80} wrote:$/im, // "On Mon, Jan 5, 2026 at 3:00 PM, Jane Doe wrote:"
  /^From:\s?.+\nSent:\s?.+\nTo:\s?.+/im, // Outlook-style quoted header block
  /^_{5,}$/m, // Outlook's underscore divider before quoted content
  /^>{1}.*$/m, // first line beginning with a ">" quote marker
];

// Signature block openers -- once matched, drop from there to the end
// UNLESS a quote-start pattern was already found earlier (quote wins,
// since a signature often appears twice: once on the reply, once
// buried in the quoted chain).
const SIGNATURE_PATTERNS = [
  /^--\s*$/m, // standard "-- " signature delimiter
  /^Thanks,?\s*\n[A-Z][a-z]+/m,
  /^Best,?\s*\n[A-Z][a-z]+/m,
  /^Regards,?\s*\n[A-Z][a-z]+/m,
  /^Sent from my (iPhone|iPad|Android|Galaxy)/im,
];

// Disclaimer boilerplate -- typically appended at the very end by
// corporate mail systems. Matched and removed regardless of position,
// since it can appear after a signature.
const DISCLAIMER_PATTERNS = [
  /This (e-?mail|message) (and any attachments?)? ?is intended (only )?for[\s\S]{0,600}?(delete|destroy)[\s\S]{0,200}?\./i,
  /CONFIDENTIALITY NOTICE[\s\S]{0,600}/i,
  /This transmission (is|may be) confidential[\s\S]{0,500}?\./i,
  /Please consider the environment before printing/i,
];

/**
 * Find the earliest index in `text` where any pattern in `patterns`
 * matches. Returns -1 if none match.
 */
function earliestMatchIndex(text, patterns) {
  let earliest = -1;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      if (earliest === -1 || match.index < earliest) {
        earliest = match.index;
      }
    }
  }
  return earliest;
}

/**
 * Strip disclaimer boilerplate from anywhere in the text.
 */
function stripDisclaimers(text) {
  let result = text;
  for (const pattern of DISCLAIMER_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result;
}

/**
 * Clean a single email body down to its actual message content.
 *
 * @param {string} rawBodyText - the raw body_text column value
 * @returns {string} cleaned body, trimmed
 */
function cleanEmailBody(rawBodyText) {
  if (!rawBodyText || typeof rawBodyText !== "string") return "";

  let text = rawBodyText.replace(/\r\n/g, "\n");

  // Cut at the earliest quote-chain marker, if any.
  const quoteIdx = earliestMatchIndex(text, QUOTE_START_PATTERNS);
  if (quoteIdx !== -1) {
    text = text.slice(0, quoteIdx);
  }

  // Cut at the earliest signature marker, if any (only within what's
  // left after the quote-chain cut above).
  const sigIdx = earliestMatchIndex(text, SIGNATURE_PATTERNS);
  if (sigIdx !== -1) {
    text = text.slice(0, sigIdx);
  }

  // Disclaimers can appear before or after the above cuts (some
  // systems prepend them), so handle them last against what remains.
  text = stripDisclaimers(text);

  // Collapse excess blank lines left behind by the cuts above.
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

/**
 * Convenience wrapper for a full inbound_emails row.
 * Returns a shallow copy with body_text replaced by its cleaned version
 * and a new `body_cleaned` flag for callers that want to know cleanup ran.
 */
function cleanEmailRecord(emailRow) {
  if (!emailRow) return emailRow;
  return {
    ...emailRow,
    body_text: cleanEmailBody(emailRow.body_text),
    body_cleaned: true,
  };
}

module.exports = { cleanEmailBody, cleanEmailRecord };
