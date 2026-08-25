// get-source-email.js — added 2026-08-25
//
// Powers "click an SA number, see the actual email it came from" on the
// site-history modal (index.html) -- Mark's been wanting this a while;
// tickets.inbound_email_id already has 100% coverage (confirmed
// 2026-08-24), so this is a straightforward lookup + cleanup, no new
// linking work needed. Reuses the same cleanup approach planned for the
// MCR Dispatch connector's still-stubbed search_emails tool.
//
// GET /.netlify/functions/get-source-email?id=<inbound_email_id>
// -> { ok, subject, sender, receivedAt, bodyText }
//
// Read-only.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Trims the noise a dispatcher never needs to see: quoted reply chains
// ("On Mon, Aug 25, 2026 ... wrote:" and everything after), Outlook/Gmail-
// style ">"-quoted lines, and common signature/disclaimer boilerplate.
// Deliberately conservative -- would rather leave a little cruft in than
// risk cutting real ticket content, since this is shown as the actual
// record of what was requested.
function cleanBody(text) {
  if (!text) return '';
  let cleaned = text;

  // Cut everything from the first quoted-reply header onward.
  const quoteHeaderPatterns = [
    /\n\s*On .{0,80}wrote:\s*\n/i,
    /\n\s*-{2,}\s*Original Message\s*-{2,}\s*\n/i,
    /\n\s*From:\s*.{0,120}\nSent:\s*.{0,120}\nTo:\s*/i,
  ];
  for (const pat of quoteHeaderPatterns) {
    const m = cleaned.match(pat);
    if (m && m.index != null) { cleaned = cleaned.slice(0, m.index); break; }
  }

  // Drop leading ">"-quoted lines anywhere they slipped through.
  cleaned = cleaned.split('\n').filter(line => !/^\s*>/.test(line)).join('\n');

  // Common disclaimer/signature boilerplate -- cut from the first match
  // onward, same conservative one-shot approach as the quote headers.
  const boilerplatePatterns = [
    /\n\s*This (?:e-?mail|message) (?:and any attachments )?(?:is|are) confidential/i,
    /\n\s*CONFIDENTIALITY NOTICE/i,
    /\n\s*Please consider the environment before printing/i,
  ];
  for (const pat of boilerplatePatterns) {
    const m = cleaned.match(pat);
    if (m && m.index != null) { cleaned = cleaned.slice(0, m.index); break; }
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// Neumo's own field labels -- same list the ticket parser (mailgun-inbound.js
// getField()) already recognizes as real field boundaries, reused here so
// this doesn't invent a second, possibly-inconsistent notion of what counts
// as a label. Longest-first avoids a short label (e.g. "Case Number")
// matching inside a longer one that starts the same way ("Parent Case
// Number") before the longer alternative gets a chance to.
const NEUMO_FIELD_LABELS = [
  'Work Order Number', 'Priority', 'Earliest Start', 'Due Date', 'Location', 'Address', 'Phone',
  'Line Item Number', 'Account Name', 'ATM ID', 'SST Name', 'PC Name', 'SST Type', 'Out of Service',
  'Line Item Issue Category', 'Line Item Issue Detail', 'Line Item Description', 'Device Errors',
  'Consumable Counts', 'Restock SST', 'SST ID',
  'Printer 1 Forms', 'Printer 2 Forms', 'Printer 3 Forms', 'Printer 4 Forms',
  'Printer 1 Ribbon', 'Printer 2 Ribbon', 'Printer 3 Ribbon', 'Printer 4 Ribbon',
  'Journal Printer',
  'Outbound Tracking Number', 'Inbound Tracking Number', 'Warehouse Name',
  'Parent Case Number', 'Case Number', 'Transfer ID', 'Request Details',
].sort((a, b) => b.length - a.length);

const NEUMO_LABEL_RE = new RegExp(
  '(' + NEUMO_FIELD_LABELS.map(l => l.replace(/\s+/g, '\\s+')).join('|') + ')\\s*[:?]',
  'g'
);

// Neumo's plain-text emails have each field on its own line in the
// original -- but whatever converts them to the plain body_text stored in
// inbound_emails collapses those line breaks, leaving one dense run-on
// paragraph ("Priority: LowLocation: GA..."). Rather than touch that
// upstream conversion (shared by every ticket type parsed from this same
// text), insert a blank line before each real field label here, in the
// viewer only.
function addFieldBreaks(text) {
  if (!text) return text;
  let sawFirstLabel = false;
  return text.replace(NEUMO_LABEL_RE, (m, label, offset, str) => {
    // Never insert a break before the very first label in the body --
    // that one already sits at the top with nothing above it to separate
    // from.
    if (!sawFirstLabel) { sawFirstLabel = true; return m; }
    return '\n\n' + m;
  });
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const id = params.id;
  if (!id) return json(400, { ok: false, error: 'Missing ?id=' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: email, error } = await supabase
    .from('inbound_emails')
    .select('subject, sender, body_text, received_at')
    .eq('id', id)
    .maybeSingle();
  if (error) return json(500, { ok: false, error: error.message });
  if (!email) return json(404, { ok: false, error: 'No email found for id ' + id });

  return json(200, {
    ok: true,
    subject: email.subject || '(no subject)',
    sender: email.sender || null,
    receivedAt: email.received_at,
    bodyText: addFieldBreaks(cleanBody(email.body_text)),
  });
};
