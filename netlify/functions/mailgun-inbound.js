/**
 * mailgun-inbound.js — v176-co-id-states — updated 2026-07-19
 * 
 * Netlify Function — receives inbound emails from Mailgun.
 * Classifies and parses dispatch lists and trouble tickets
 * using logic ported from watchdog.py.
 * 
 * Stores results in Blobs for the dispatch app to pick up.
 * SMS notifications via Twilio (when configured).
 * Phase 2 Stage 1: also writes inbound_emails + tickets (trouble only) to
 * Supabase, additively -- Blobs remains the source of truth for the app
 * and SMS path until Stage 2 wires dispatcher actions to `assignments`.
 */

const { getStore, connectLambda } = require("@netlify/blobs");
const { createClient } = require("@supabase/supabase-js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function getDispatchStore() {
  return getStore("dispatch");
}

function parseMailgunBody(body) {
  const fields = {};
  try {
    const params = new URLSearchParams(body);
    for (const [k, v] of params.entries()) fields[k] = v;
    // Verify we got real fields (not just a failed parse)
    if (fields['from'] || fields['sender'] || fields['subject']) return fields;
  } catch {}

  // Fallback: multipart/form-data parsing
  try {
    const boundaryMatch = body.match(/^--([^\r\n]+)/);
    if (boundaryMatch) {
      const boundary = '--' + boundaryMatch[1];
      const parts = body.split(boundary);
      for (const part of parts) {
        const nameMatch = part.match(/Content-Disposition:[^\n]*name="([^"]+)"/i);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const valueStart = part.indexOf('\r\n\r\n');
        const valueStartAlt = part.indexOf('\n\n');
        const start = valueStart !== -1 ? valueStart + 4 : (valueStartAlt !== -1 ? valueStartAlt + 2 : -1);
        if (start === -1) continue;
        const value = part.substring(start).replace(/\r?\n$/, '').trim();
        fields[name] = value;
      }
    }
  } catch {}

  return fields;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    // Table structure: convert rows and cells to tab-delimited lines
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<\/th>/gi, '\t')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#160;/g, ' ')
    .replace(/\t +/g, '\t')
    .replace(/ +\t/g, '\t')
    .replace(/\t{2,}/g, '\t')
    .replace(/ {2,}/g, ' ')
    .split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n')
    .trim();
}

// ── State detection ───────────────────────────────────────────────────────────

function detectStates(text) {
  const KNOWN = ["GA","FL","NC","SC","MI","IN","OH","NV","IL","MN","WV","OR","CO","ID"];
  const found = new Set();
  const lines = text.split(/\n/).map(l => l.trim());
  for (const line of lines) {
    // Match state from dispatch table (line starts with state code, tab or space delimited)
    for (const s of KNOWN) {
      if (line === s || line.startsWith(s+"\t") || line.startsWith(s+" ")) found.add(s);
    }
    // Extract state prefix from site codes like IN1006, GA1045 etc
    const siteCodes = line.match(/\b([A-Z]{2})(\d{3,5})(?![A-Z\d])/g) || [];
    for (const sc of siteCodes) {
      const state = sc.substring(0, 2);
      if (KNOWN.includes(state)) found.add(state);
    }
  }
  return [...found].sort();
}

// ── Timezone mapping by state code ───────────────────────────────────────────
const STATE_TIMEZONES = {
  GA: 'America/New_York',
  NC: 'America/New_York',
  SC: 'America/New_York',
  FL: 'America/New_York',
  IN: 'America/New_York',
  OH: 'America/New_York',
  WV: 'America/New_York',
  MI: 'America/Detroit',
  IL: 'America/Chicago',
  MN: 'America/Chicago',
  NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',
  CO: 'America/Denver',
  ID: 'America/Boise',
};

function getTimezoneForSiteCode(siteCode) {
  const state = siteCode ? siteCode.replace(/\d+/, '') : 'GA';
  return STATE_TIMEZONES[state] || 'America/New_York';
}

function todayStrForSiteCode(siteCode) {
  const tz = getTimezoneForSiteCode(siteCode);
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  return `${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,'0')}-${String(local.getDate()).padStart(2,'0')}`;
}

// ── SLA calculator (Mon-Sat 8AM-5PM business hours) ─────────────────────────
// Saturday states (have on-call coverage): GA, IN, MI, NV
const SAT_STATES = new Set(['GA','IN','MI','NV']);

function calculateSlaDeadline(receivedAt, timezone, stateCode) {
  let remaining = 240; // 4 hours in minutes
  const tz = timezone || 'America/New_York';
  const hasSatCoverage = stateCode ? SAT_STATES.has(stateCode) : true;

  const now = new Date(receivedAt);
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  let current = local;

  const isWorkDay = (d) => {
    const day = d.getDay();
    if (day === 0) return false; // never Sunday
    if (day === 6) return hasSatCoverage; // Saturday only if covered
    return true;
  };

  const advanceToNextBizDay = (d) => {
    d.setDate(d.getDate() + 1);
    while (!isWorkDay(d)) d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d;
  };

  if (current.getHours() < 8) current.setHours(8, 0, 0, 0);
  if (current.getHours() >= 17 || !isWorkDay(current)) advanceToNextBizDay(current);

  while (remaining > 0) {
    const endOfDay = new Date(current);
    endOfDay.setHours(17, 0, 0, 0);
    const minsToday = Math.max(0, (endOfDay - current) / 60000);
    if (remaining <= minsToday) {
      current = new Date(current.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= minsToday;
      advanceToNextBizDay(current);
    }
  }
  return current;
}

// Parses a loosely-formatted date string (e.g. "07/18/2026 2:30 PM") pulled
// from email body text. Returns null rather than throwing on anything it
// can't confidently parse -- a bad Earliest Start/Due Date string should
// never break ticket insertion.
function parseLooseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// Parses a Dispatch List email's plain-text body into a { siteCode:
// 'YYYY-MM-DD' } map of every row's "Restock By" date. Anchors on the
// site code embedded in each row's Location cell (e.g. "Weld County 1 -
// 10th King Soopers - CO1016") rather than trying to detect state tokens,
// since column headers like "LF"/"LR"/"RF"/"RR" are also 2 letters and
// would collide with state abbreviations. For each site code found, the
// row's remaining cells (quantities, consumables, date) all follow it
// before the next site code starts, so the LAST M/D/YYYY date in that
// span is the row's requested date. Works unmodified across both table
// layouts (2-printer and 4-printer) since it never depends on column count.
//
// Some NV rows have no real site code in the Location text at all --
// just Neumo's own internal reference number (e.g. "Albertsons Tropicana
// - 139" instead of "NV1048 ..."). Confirmed 2026-07-21 with Mark: that
// number is the grocery chain's own store number, which Neumo apparently
// carried into the site name -- Supabase's sites.name for NV already
// stores it as a "Name - ###" suffix, verified unique per site. For any
// state token followed by a bare 2-4 digit number with no real site code
// nearby, resolveNvFallbackCodes() below cross-references that suffix
// against sites.name to recover the real site code.
function parseDispatchListSiteDates(text) {
  const result = {};
  const codeMatches = [...text.matchAll(/\b([A-Z]{2}\d{3,5})\b/g)];
  for (let i = 0; i < codeMatches.length; i++) {
    const start = codeMatches[i].index;
    const end = i + 1 < codeMatches.length ? codeMatches[i + 1].index : text.length;
    const span = text.slice(start, end);
    const dateMatches = [...span.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)];
    if (dateMatches.length === 0) continue;
    const d = dateMatches[dateMatches.length - 1];
    const mo = parseInt(d[1], 10), dy = parseInt(d[2], 10), yr = parseInt(d[3], 10);
    result[codeMatches[i][1]] = `${yr}-${String(mo).padStart(2,'0')}-${String(dy).padStart(2,'0')}`;
  }
  return result;
}

// Finds rows with no real site code -- a known state abbreviation
// immediately followed (before the next real site code or the next state
// token) by a bare 2-4 digit reference number and a trailing date.
// Returns [{ state, refNum, dispatchDate }] for the caller to resolve
// against sites.name.
function findDispatchListFallbackRows(text) {
  const KNOWN_STATES = new Set(['GA','FL','MI','IN','OH','WV','IL','MN','NV','OR','CO','ID','NC','SC']);
  const rows = [];
  const stateMatches = [...text.matchAll(/\n\s*([A-Z]{2})\s*\n/g)].filter(m => KNOWN_STATES.has(m[1]));
  for (let i = 0; i < stateMatches.length; i++) {
    const start = stateMatches[i].index;
    const end = i + 1 < stateMatches.length ? stateMatches[i + 1].index : text.length;
    const span = text.slice(start, end);
    if (/\b[A-Z]{2}\d{3,5}\b/.test(span)) continue; // has a real site code, handled above
    const refM = span.match(/-\s*(\d{2,4})\b/);
    const dateMatches = [...span.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)];
    if (!refM || dateMatches.length === 0) continue;
    const d = dateMatches[dateMatches.length - 1];
    const mo = parseInt(d[1], 10), dy = parseInt(d[2], 10), yr = parseInt(d[3], 10);
    rows.push({
      state: stateMatches[i][1],
      refNum: refM[1],
      dispatchDate: `${yr}-${String(mo).padStart(2,'0')}-${String(dy).padStart(2,'0')}`,
    });
  }
  return rows;
}



// Extracts a requested completion date from maintenance-ticket free text
// like "Please dispatch a technician by 7/22 to restock..." -- unlike the
// trouble-ticket path's labeled "Due Date:" field, this is manually typed
// by Neumo reps and varies in format. Tries, in order: "by/before M/D[/YY]",
// "by/before Month D[, YYYY]", then a bare M/D[/YY] anywhere in the text as
// a last resort. Returns null if nothing confidently parses -- callers
// should fall back to today's date rather than treat null as an error.
function parseMaintenanceDueDate(description, receivedAt) {
  if (!description) return null;
  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const year = receivedAt.getFullYear();

  // If no year was given and the resulting date lands more than 30 days in
  // the past relative to receivedAt, assume the year rolled over (e.g. a
  // ticket mentioning "1/2" received in late December) and bump forward one year.
  const rollForward = (d) => {
    if (d.getTime() < receivedAt.getTime() - 30 * 24 * 60 * 60 * 1000) {
      d.setFullYear(d.getFullYear() + 1);
    }
    return d;
  };

  let m = description.match(/\b(?:by|before)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (m) {
    const mo = parseInt(m[1], 10) - 1, dy = parseInt(m[2], 10);
    const yr = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : year;
    const d = new Date(yr, mo, dy);
    if (!isNaN(d.getTime())) return m[3] ? d : rollForward(d);
  }

  m = description.match(/\b(?:by|before)\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  if (m) {
    const moKey = m[1].slice(0, 3).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MONTHS, moKey)) {
      const mo = MONTHS[moKey], dy = parseInt(m[2], 10);
      const yr = m[3] ? parseInt(m[3], 10) : year;
      const d = new Date(yr, mo, dy);
      if (!isNaN(d.getTime())) return m[3] ? d : rollForward(d);
    }
  }

  // Bare fallback: any M/D or M/D/YY(YY) pattern anywhere in the text, even
  // without "by"/"before" -- last resort before giving up.
  m = description.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const mo = parseInt(m[1], 10) - 1, dy = parseInt(m[2], 10);
    if (mo >= 0 && mo <= 11 && dy >= 1 && dy <= 31) {
      const yr = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : year;
      const d = new Date(yr, mo, dy);
      if (!isNaN(d.getTime())) return m[3] ? d : rollForward(d);
    }
  }

  return null;
}

function formatSlaDeadline(d) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return `${days[d.getDay()]} ${h12}:${mm} ${ampm}`;
}

// ── Email classifier & parser (ported from watchdog.py) ──────────────────────

function parseEmailBody(text, receivedAt) {
  if (!receivedAt) receivedAt = new Date();

  const getField = (label) => {
    // Stop at next Neumo field label (word(s) followed by colon at start of a segment).
    // Capture group is zero-or-more (not one-or-more) so a genuinely blank field
    // (common on install/site-survey tickets, e.g. PC Name/Account Name left empty)
    // returns '' instead of being forced to swallow the next field's own label as
    // if it were this field's value. RMA/shipping labels (Outbound/Inbound Tracking
    // Number, Warehouse Name, Parent Case Number, Case Number, Transfer ID, Request
    // Details) added 2026-07-22 -- without them in the stop-list, e.g. getField('Case
    // Number') would swallow straight through "Work Order Number:" and beyond looking
    // for the nearest label it recognized, since none of the RMA ones were in this list.
    // 's' (dotAll) flag added 2026-07-22: some forwarding clients (seen with
    // BlueMail for Mobile) hard-wrap a field's own value onto a second line
    // ("Account Name: NV - Decatur \nDMV"). Without dotAll, "." can't cross
    // that newline, so the whole match silently fails and getField() returns
    // '' even though the value is right there -- this affects every ticket
    // type that shares this helper, not just RMA/shipping.
    // 2026-07-22 (round 2): the LABEL being searched for can wrap mid-phrase
    // too, not just its value or the stop-boundary -- e.g. "Case \nNumber:"
    // or "Work \nOrder Number:". labelPattern below tolerates that on the
    // way in; the stop-list tolerates it on the way out (see below).
    const labelPattern = label.replace(/ /g, '\\s+');
    // 2026-07-22 (round 2): a wrapped LABEL used as a stop-boundary -- not
    // just a wrapped value or the label being searched for -- also defeated
    // this, e.g. a field ending right before "Case \nNumber:" would swallow
    // straight through it. Every multi-word term below now uses \s+ between
    // words instead of a literal space, so a mid-label wrap doesn't let the
    // lazy match blow straight past it into the next field's own value.
    const m = text.match(new RegExp('(?<!Parent\\s)' + labelPattern + '\\s*:?\\s*(.*?)(?=\\s*(?:Work\\s+Order|Priority|Earliest\\s+Start|Due\\s+Date|Location:|Address:|Phone:|Line\\s+Item\\s+Number|Account\\s+Name|ATM\\s+ID|SST\\s+Name|PC\\s+Name|SST\\s+Type|Out\\s+of\\s+Service|Line\\s+Item\\s+Issue|Line\\s+Item\\s+Description|Device\\s+Errors|Consumable\\s+Counts|Restock\\s+SST|SST\\s+ID|Printer\\s+\\d|Journal\\s+Printer|Outbound\\s+Tracking|Inbound\\s+Tracking|Warehouse\\s+Name|Parent\\s+Case\\s+Number|Case\\s+Number|Transfer\\s+ID|Request\\s+Details|Thank\\s+you)|$)', 'is'));
    return m ? m[1].trim() : '';
  };

  // 1. Bulk dispatch list
  if (/Dispatch List/i.test(text) || /Restock Report/i.test(text) || /Restock By/i.test(text)) {
    // Count site codes like GA1007, IN1061 etc as proxy for item count
    const siteCodes = (text.match(/\b[A-Z]{2}\d{3,5}\b/g) || []);
    const uniqueSites = new Set(siteCodes);
    const count = uniqueSites.size || (text.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || []).length;
    const states = detectStates(text);
    const stateStr = states.length > 0 ? ` (${states.join(', ')})` : '';
    return {
      type: 'restock',
      alertBody: `📋 MCR DISPATCH LIST${stateStr}: ${count} sites across ${states.length} state${states.length !== 1 ? 's' : ''}.`,
      woNum: null,
      site: null,
      issue: null,
      slaEnd: null,
    };
  }

  // 2. Maintenance / Consumable Restock -- board-eligible for any requested
  // date, not just same-day. These never get an SMS (routine/Low priority,
  // would be a flood of texts for something that isn't urgent) -- they're
  // board-only, added via the same auto-add-to-board path as trouble tickets.
  if (/Maintenance/i.test(text) || /Consumable Restock/i.test(text)) {
    const woNum = getField('Work Order Number');
    const account = getField('Account Name');
    const sstName = getField('SST Name');
    const pcName = getField('PC Name');
    const oos = getField('Out of Service\\?') || getField('Out of Service');
    const issueCategory = getField('Line Item Issue Category');
    const issueDetail = getField('Line Item Issue Detail');
    const description = getField('Line Item Description');
    const siteStr = [sstName, pcName].filter(Boolean).join(' / ') || account;
    const siteCodeM = (pcName + ' ' + account).match(/\b([A-Z]{2}\d{3,5})(?![A-Z\d])/);
    const siteCode = siteCodeM ? siteCodeM[1] : '';

    // Try to extract a requested completion date from the free-text
    // description ("Please dispatch a technician by 7/22 to restock...").
    // This field is manually typed by Neumo reps, so it's inherently
    // inconsistent -- unlike the trouble-ticket path's own labeled "Due
    // Date:" field. Returns null if nothing confidently parses; the board
    // auto-add step falls back to today's date in that case rather than
    // dropping the ticket entirely (agreed with Mark 2026-07-21 -- these
    // are Low priority routine stops, not SLA'd emergencies, so a
    // best-guess placement beats silently losing it).
    const dueDate = parseMaintenanceDueDate(description, receivedAt);

    return {
      type: 'maintenance',
      ticketKind: 'maintenance',
      alertBody: null, // board-only, no SMS
      woNum, site: siteStr, siteCode,
      issueCategory, issueDetail,
      issue: [issueCategory, issueDetail].filter(Boolean).join(' – ') || 'See email for details',
      description,
      dueDateRaw: dueDate ? dueDate.toISOString() : null,
      slaEnd: null,
    };
  }


  // 2.5. RMA / Shipping Details (Neumo parts warehouse notifications) --
  // must be checked BEFORE the generic Work Order Number trouble-ticket
  // check below, since these emails also contain a "Work Order Number:"
  // field and would otherwise get misclassified as trouble tickets --
  // triggering a false SMS alert with "Site: Unknown Site" since there's no
  // real site/issue for the trouble parser to find. Found 2026-07-22 when
  // Mark started testing RMA mailbox forwards and got a text for every one.
  // Detected by "Outbound/Inbound Tracking Number" -- consistent across
  // every real example seen so far and not something a trouble ticket ever
  // contains. No SMS alert for these -- board/data-only, same treatment as
  // maintenance tickets.
  if (/(?:Outbound|Inbound) Tracking Number/i.test(text)) {
    const caseNumber = getField('Case Number');
    const parentCaseNumber = getField('Parent Case Number');
    // "Work Order Number:" can get line-wrapped mid-phrase by some email
    // clients ("Work \nOrder Number:") -- \s+ tolerates that, unlike the
    // literal space the trouble-ticket parser's own version below uses.
    const woNumM = text.match(/Work\s+Order\s+Number:\s*\n?\s*(\S+)/i);
    const woNum = woNumM ? woNumM[1] : '';
    const transferId = getField('Transfer ID');
    const outboundTracking = getField('Outbound Tracking Number UPS') || getField('Outbound Tracking Number');
    const inboundTracking = getField('Inbound Tracking Number UPS') || getField('Inbound Tracking Number');
    const accountName = getField('Account Name');
    const warehouseName = getField('Warehouse Name');
    // Warehouse Name is usually "MCR (STATE) Tech Name Whse" -- but not
    // always; sometimes it's a third-party repair vendor (e.g. "Next GI")
    // with no tech involved at all. techName is null when it doesn't match.
    const techM = warehouseName.match(/^MCR\s*\([A-Z]{2}\)\s*(.+?)\s*Whse\s*$/i);
    const techName = techM ? techM[1].trim() : null;
    const requestDetails = getField('Request Details');
    const returnBrokenPart = /PLEASE RETURN BROKEN PART/i.test(text);

    return {
      type: 'rma_shipping',
      alertBody: null, // no SMS -- informational parts tracking, not a dispatch action
      caseNumber, parentCaseNumber, woNum, transferId,
      outboundTracking, inboundTracking, accountName, warehouseName, techName,
      requestDetails, returnBrokenPart,
    };
  }

  // 3. Trouble ticket
  if (/Work Order Number:/i.test(text) || /Work Order #/i.test(text)) {
    const woNum = getField('Work Order Number') || getField('Work Order #');
    const pcName = getField('PC Name');
    const account = getField('Account Name');
    const issueCategory = getField('Line Item Issue Category');
    const issueDetail = getField('Line Item Issue Detail');
    const issue = [issueCategory, issueDetail].filter(Boolean).join(' – ') || 'See email for details';
    // Added for Supabase tickets table (Stage 1) -- not previously extracted,
    // does not change alertBody/SMS text which still uses the combined `issue` above.
    const lineItemDescription = getField('Line Item Description');
    const earliestStartRaw = getField('Earliest Start Permitted');
    const dueDateRaw = getField('Due Date');
    const locationField = getField('Location');
    // Fallback state source for SMS recipient matching: every Location field
    // we've seen starts "XX - ..." (state abbreviation). Used when there's no
    // site code to derive state from (e.g. a site-survey ticket for a
    // brand-new location that doesn't have one yet) -- feeds the existing
    // parsed.state fallback slot already checked near the SMS-send logic.
    const locationStateM = locationField.match(/^([A-Z]{2})\s*[-–]/);
    const locationState = locationStateM ? locationStateM[1] : null;
    // Extract clean site code (ignore trailing letters from word boundaries)
    const siteCodeM = (pcName + ' ' + account).match(/\b([A-Z]{2}\d{3,5})(?![A-Z\d])/);
    const siteCode = siteCodeM ? siteCodeM[1] : '';
    // Strip leading "GA - ", "FL - " etc from account name since site code already has state
    const accountClean = account.replace(/^[A-Z]{2}\s*[-–]\s*/i, '').trim();
    const site = siteCode
      ? siteCode + (accountClean && accountClean !== siteCode ? ' – ' + accountClean : '') 
      : ([pcName, account].filter(Boolean).join(' – ') || locationField || 'Unknown Site');
    const isInstallCategory = /^install$/i.test(issueCategory || '');
    const isSiteSurvey = isInstallCategory && /site survey/i.test(issueDetail || '');
    const statedDueDate = isInstallCategory ? parseLooseDate(dueDateRaw) : null;
    const slaEnd = statedDueDate || calculateSlaDeadline(receivedAt, getTimezoneForSiteCode(siteCode), siteCode.substring(0,2));
    const slaStr = formatSlaDeadline(slaEnd);
    const siteTrunc = site.length > 40 ? site.substring(0, 38) + '…' : site;

    let alertBody = `🚨 WO: ${woNum}\nSite: ${siteTrunc}`;
    if (issue && issue !== 'See email for details') alertBody += `\nIssue: ${issue}`;
    alertBody += statedDueDate ? `\nDue: ${slaStr}` : `\nSLA ends: ${slaStr}`;

    return {
      type: 'trouble',
      alertBody,
      woNum, site, siteCode, issue, slaEnd: slaEnd.toISOString(),
      state: locationState,
      issueCategory: issueCategory || null,
      issueDetail: issueDetail || null,
      description: lineItemDescription || null,
      earliestStartRaw: earliestStartRaw || null,
      dueDateRaw: dueDateRaw || null,
      ticketKind: isSiteSurvey ? 'site_survey' : (isInstallCategory ? 'install' : 'trouble'),
    };
  }

  return null;
}

// ── Twilio SMS (optional — only fires if env vars are set) ───────────────────

/**
 * Send SMS via email-to-SMS gateway using Gmail SMTP.
 * Recipient format: "6787794352@vtext.com" (Verizon), "number@tmomail.net" (T-Mobile), etc.
 * Uses nodemailer with Gmail app password — same approach as watchdog.py.
 * Set GMAIL_USER and GMAIL_APP_PASSWORD env vars.
 */
async function sendSms(to, body, subject) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || 'mcrdispatch.net';

  if (!apiKey) {
    console.log('[mailgun-inbound] MAILGUN_API_KEY not set, skipping SMS');
    return false;
  }

  try {
    const params = new URLSearchParams({
      from: `MCR Watchdog <watchdog@${domain}>`,
      to: to,
      subject: subject || 'MCR Dispatch',
      text: body
    });

    const resp = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (resp.ok) {
      console.log(`[mailgun-inbound] SMS sent to ${to}`);
      return true;
    } else {
      const txt = await resp.text();
      console.log(`[mailgun-inbound] Mailgun SMS error ${resp.status}: ${txt}`);
      console.log(`[mailgun-inbound] Domain used: ${domain}`);
      console.log(`[mailgun-inbound] API key length: ${apiKey.length}`);
      console.log(`[mailgun-inbound] API key prefix: ${apiKey.substring(0, 8)}...`);
      return false;
    }
  } catch(e) {
    console.log(`[mailgun-inbound] SMS error: ${e.message}`);
    return false;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body || "";
    const fields = parseMailgunBody(body);

    const sender    = fields["sender"] || fields["from"] || "unknown";
    const subject   = fields["subject"] || "";
    // Prioritize full body fields over stripped — stripped versions lose forwarded content
    const textBody  = fields["body-plain"] || fields["stripped-text"] || "";
    const htmlBody  = fields["body-html"] || fields["stripped-html"] || "";
    const timestamp = fields["timestamp"] || String(Date.now());

    // A "Re:" subject means this is a reply/comment on an existing ticket
    // thread -- a scheduling question, a status update, a "can you meet
    // Monday" -- not a fresh dispatch that needs its own SMS blast. This is
    // the root-cause fix for the pattern found across three separate
    // tickets on 2026-07-09 (OH1057, and now MI1047): every prior fix
    // patched a specific way *state detection* could fail inside the
    // trouble-ticket path, but the real bug was letting replies enter that
    // path at all. "Fwd:"/"Fw:" is deliberately NOT included here --
    // forwarded emails are an intentional re-dispatch mechanism elsewhere
    // in this file (see the subject-line fallback below), unlike replies.
    const isReplyOnly = /^\s*re\s*:/i.test(subject);

    // Debug: log all field keys and sizes to diagnose forwarded email parsing
    const fieldKeys = Object.keys(fields);
    const bodySizes = fieldKeys.filter(k => k.includes('body') || k.includes('text') || k.includes('html') || k.includes('strip'))
      .map(k => `${k}:${(fields[k]||'').length}`).join(', ');
    console.log(`[mailgun-inbound] Fields: ${fieldKeys.join(', ')}`);
    console.log(`[mailgun-inbound] Body sizes: ${bodySizes}`);

    // Use HTML as fallback if plain text is too short
    let effectiveBody = textBody.length > 50 ? textBody : stripHtml(htmlBody);

    // If still too short, try to extract quoted/forwarded content
    // Manual forwards often bury the original in "---------- Forwarded message ----------" blocks
    if (effectiveBody.length < 200) {
      const forwardMarkers = [
        /[-–—]{3,}\s*(?:Forwarded|Original)\s*[Mm]essage\s*[-–—]{3,}/i,
        /On .+ wrote:/i,
        /Begin forwarded message/i,
        /From:.*\nSubject:/i
      ];
      for (const marker of forwardMarkers) {
        const idx = (textBody || '').search(marker);
        if (idx !== -1 && textBody.length - idx > 200) {
          effectiveBody = textBody.substring(idx);
          break;
        }
        const htmlIdx = stripHtml(htmlBody || '').search(marker);
        if (htmlIdx !== -1) {
          const stripped = stripHtml(htmlBody);
          effectiveBody = stripped.substring(htmlIdx);
          break;
        }
      }
    }

    console.log(`[mailgun-inbound] Function version: v176-co-id-states`);
    console.log(`[mailgun-inbound] From: ${sender} | Subject: ${subject}`);
    console.log(`[mailgun-inbound] Body length: ${effectiveBody.length} chars`);

    // Use original email Date header for accurate SLA calculation
    const emailDate = fields["Date"] || fields["date"] || null;
    const receivedAt = emailDate ? new Date(emailDate) : new Date();
    // Replies never enter dispatch parsing at all -- not "parse it and then
    // fail to match a template," genuinely skipped, so there's no path left
    // where quoted original content in the reply body could accidentally
    // satisfy the trouble-ticket template match either.
    let parsed = isReplyOnly ? null : parseEmailBody(effectiveBody, receivedAt);
    if (isReplyOnly) console.log(`[mailgun-inbound] Reply detected ("${subject}") -- skipping dispatch parsing, no SMS`);

    // Subject-line fallback: if body too short and body parse failed,
    // attempt to extract trouble ticket info from subject line.
    // Forwarded emails often arrive with tiny bodies but full info in subject.
    // Subject format: "Fwd: Tech Dispatch - SST - <type> - <state> - <site> - <WO>"
    if (!parsed && !isReplyOnly && effectiveBody.length < 200 && subject) {
      const subj = subject.replace(/^(Fwd?:|Re:)\s*/i, '').trim();
      const woMatch = subj.match(/\b(\d{8,})\b/);
      const woNum = woMatch ? woMatch[1] : '';
      const stateMatch = subj.match(/\b(GA|FL|NC|SC|MI|IN|OH|NV|IL|MN|WV|OR)\b/);
      const stateCode = stateMatch ? stateMatch[1] : '';
      let siteName = '';
      if (stateCode) {
        const afterState = subj.substring(subj.indexOf(stateCode) + stateCode.length);
        siteName = afterState.replace(/[-–\s]+\d{6,}.*$/, '').replace(/^[-–\s]+/, '').trim();
      }
      const issueMatch = subj.match(/(Registration Printer|Journal Printer|Ribbon|Forms|Restock|Maintenance|Out of Service)/i);
      const issue = issueMatch ? issueMatch[1] : 'See email';

      if (/Tech Dispatch/i.test(subj) || /Work Order/i.test(subj) || (stateCode && woNum)) {
        const siteStr = [stateCode, siteName].filter(Boolean).join(' – ') || subj.substring(0, 60);
        const slaEnd = calculateSlaDeadline(receivedAt, STATE_TIMEZONES[stateCode] || 'America/New_York', stateCode);
        const slaStr = formatSlaDeadline(slaEnd);
        parsed = {
          type: 'trouble',
          alertBody: `🚨 WO: ${woNum || 'See email'}\nSite: ${siteStr}\nIssue: ${issue}\nSLA: ${slaStr}`,
          woNum: woNum || '',
          site: siteStr,
          state: stateCode || null,
          issue,
          slaEnd: slaEnd.toISOString(),
          fromSubject: true,
        };
        console.log(`[mailgun-inbound] Subject fallback: ${siteStr} | WO: ${woNum}`);
      }
    }

    const dispatchType = parsed ? parsed.type : 'unknown';
    const states = detectStates(effectiveBody + ' ' + subject);

    console.log(`[mailgun-inbound] Type: ${dispatchType} | States: ${states.join(', ')}`);

    // ── Supabase persistence (Phase 2, Stage 1) ────────────────────────────
    // Additive only: writes to inbound_emails and, for trouble tickets, to
    // tickets. Never removes or blocks the existing Blobs write/SMS send
    // below -- if Supabase is down or a query fails, we log and move on so
    // the pipeline behaves exactly as it did before this stage landed.
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      const classifiedAsMap = { trouble: 'trouble', maintenance: 'maintenance', restock: 'dispatch_list', rma_shipping: 'rma_shipping' };
      const classifiedAs = isReplyOnly ? 'reply' : (classifiedAsMap[dispatchType] || 'unknown');
      const parseStatus = isReplyOnly ? 'ignored' : (parsed ? 'parsed' : 'failed');
      const mailgunMessageId = fields['Message-Id'] || fields['message-id'] || null;

      const inboundEmailRow = {
        mailbox: fields['recipient'] || fields['Recipient'] || null,
        sender,
        subject,
        body_text: textBody || null,
        body_html: htmlBody || null,
        received_at: receivedAt.toISOString(),
        classified_as: classifiedAs,
        parse_status: parseStatus,
        mailgun_message_id: mailgunMessageId,
      };

      // Mailgun can retry webhook delivery on timeout, so the same message
      // may arrive twice. Upsert on mailgun_message_id when we have one so
      // retries don't create duplicate rows; fall back to a plain insert
      // when there's no message id to key off of.
      let inboundEmailId = null;
      if (mailgunMessageId) {
        const { data, error } = await supabase
          .from('inbound_emails')
          .upsert(inboundEmailRow, { onConflict: 'mailgun_message_id' })
          .select('id')
          .single();
        if (error) console.error('[mailgun-inbound] inbound_emails upsert failed:', error.message);
        else inboundEmailId = data.id;
      } else {
        const { data, error } = await supabase
          .from('inbound_emails')
          .insert(inboundEmailRow)
          .select('id')
          .single();
        if (error) console.error('[mailgun-inbound] inbound_emails insert failed:', error.message);
        else inboundEmailId = data.id;
      }

      // Trouble tickets and maintenance/restock tickets both go into
      // `tickets` -- bulk dispatch lists are a separate, not-yet-built path
      // (see handoff doc). fromSubject-fallback trouble tickets are
      // included since they carry a real WO number even without a matched
      // site code.
      if ((dispatchType === 'trouble' || dispatchType === 'maintenance') && parsed && parsed.woNum) {
        const rawSiteCode = parsed.siteCode || (parsed.site && (parsed.site.match(/\b([A-Z]{2}\d{3,5})\b/) || [])[1]) || null;
        let siteId = null;
        if (rawSiteCode) {
          const { data: siteRow, error: siteErr } = await supabase
            .from('sites')
            .select('id')
            .eq('site_code', rawSiteCode)
            .maybeSingle();
          if (siteErr) console.error('[mailgun-inbound] site lookup failed:', siteErr.message);
          else if (siteRow) siteId = siteRow.id;
        }

        const earliestStartAt = parseLooseDate(parsed.earliestStartRaw);
        const dueAt = parseLooseDate(parsed.dueDateRaw);

        const ticketRow = {
          wo_number: parsed.woNum,
          site_id: siteId,
          site_text: parsed.site || null,
          needs_review: !siteId,
          ticket_kind: parsed.ticketKind || 'trouble',
          template: 'standard',
          status: 'open',
          issue_category: parsed.issueCategory || null,
          issue_detail: parsed.issueDetail || null,
          description: parsed.description || null,
          received_at: receivedAt.toISOString(),
          earliest_start_at: earliestStartAt ? earliestStartAt.toISOString() : null,
          due_at: dueAt ? dueAt.toISOString() : null,
          sla_ends_at: parsed.slaEnd || null,
          deadline_source: dispatchType === 'maintenance' ? 'restock_requested' : 'sla_4h',
          attributes: { fromSubject: !!parsed.fromSubject, rawSiteCode, rawIssue: parsed.issue || null },
          source: 'email',
          inbound_email_id: inboundEmailId,
        };

        // ON CONFLICT DO NOTHING on wo_number: if the same ticket email
        // arrives twice (Mailgun retry, duplicate forward), never overwrite
        // a row a dispatcher may have already actioned in Stage 2. A fresh
        // insert only happens the first time we see this WO number.
        const { error: ticketErr } = await supabase
          .from('tickets')
          .upsert(ticketRow, { onConflict: 'wo_number', ignoreDuplicates: true });
        if (ticketErr) console.error('[mailgun-inbound] tickets upsert failed:', ticketErr.message);
        else console.log(`[mailgun-inbound] Supabase: ticket ${parsed.woNum} written (site_id: ${siteId || 'unmatched, needs_review'})`);

        // Auto-add to the dispatch board -- trouble AND maintenance tickets
        // (not install/site-survey, which stay manual per their lower
        // volume and frequent lack of a real site code). Assigned to the
        // site's primary tech with no availability check -- a known,
        // agreed limitation; reassign manually if they're out. Deliberately
        // non-destructive: only inserts if the site has no assignment row
        // at all yet on that date (DO NOTHING on conflict) -- never
        // overwrites an existing planned/completed/reassigned entry, even a
        // cancelled one from earlier that day. A second ticket at an
        // already-touched site+date needs manual adding, same as the
        // status quo. Trouble tickets always target today (they're urgent
        // by nature); maintenance tickets target their own parsed due date
        // when one was found, falling back to today when the free-text
        // description didn't yield a confident date (agreed with Mark
        // 2026-07-21 -- best-guess placement beats losing it silently).
        if (['trouble', 'maintenance'].includes(parsed.ticketKind || 'trouble') && siteId) {
          try {
            const { data: siteDetail, error: siteDetailErr } = await supabase
              .from('sites').select('primary_tech_id').eq('id', siteId).maybeSingle();
            if (siteDetailErr) console.error('[mailgun-inbound] site detail lookup failed:', siteDetailErr.message);
            else if (siteDetail && siteDetail.primary_tech_id) {
              const { data: ticketRowFetched } = await supabase
                .from('tickets').select('id').eq('wo_number', parsed.woNum).maybeSingle();

              let dispatchDateStr;
              if ((parsed.ticketKind || 'trouble') === 'maintenance' && parsed.dueDateRaw) {
                const dd = new Date(parsed.dueDateRaw);
                dispatchDateStr = `${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
              } else if ((parsed.ticketKind || 'trouble') === 'maintenance' && rawSiteCode) {
                // This ticket's own free-text description didn't yield a
                // confident date -- check the most recently cached Dispatch
                // List for this site's own "Restock By" date before falling
                // all the way back to today.
                let cachedDate = null;
                try {
                  const dlStore = getDispatchStore();
                  const cache = await dlStore.get('dispatch-list/latest-dates', { type: 'json' });
                  if (cache && cache.dates && cache.dates[rawSiteCode]) cachedDate = cache.dates[rawSiteCode];
                } catch (dlReadEx) {
                  console.error('[mailgun-inbound] dispatch-list cache read failed:', dlReadEx.message);
                }
                if (cachedDate) {
                  dispatchDateStr = cachedDate;
                  console.log(`[mailgun-inbound] Used cached dispatch-list date for ${rawSiteCode}: ${cachedDate}`);
                } else {
                  dispatchDateStr = todayStrForSiteCode(rawSiteCode);
                }
              } else {
                dispatchDateStr = todayStrForSiteCode(rawSiteCode);
              }

              const { data: boardData, error: boardErr } = await supabase
                .from('assignments')
                .upsert({
                  dispatch_date: dispatchDateStr,
                  site_id: siteId,
                  technician_id: siteDetail.primary_tech_id,
                  assigned_by: 'auto',
                  status: 'planned',
                  ticket_id: ticketRowFetched ? ticketRowFetched.id : null,
                }, { onConflict: 'dispatch_date,site_id', ignoreDuplicates: true })
                .select();
              if (boardErr) console.error('[mailgun-inbound] auto-add to board failed:', boardErr.message);
              else console.log(`[mailgun-inbound] Auto-add to ${dispatchDateStr} board: ${(boardData && boardData.length > 0) ? 'added' : 'skipped, site already had an entry today'}`);
            } else {
              console.log(`[mailgun-inbound] Skipped auto-add for ${parsed.woNum}: no primary tech configured for site`);
            }
          } catch (boardEx) {
            console.error('[mailgun-inbound] Auto-add to board error (non-fatal):', boardEx.message);
          }
        }
      }

      // RMA / Shipping Details -- persist to rma_shipments. Tries to link to
      // an existing ticket (and through it, a site) by WO number -- the
      // shipment often arrives after the original trouble/maintenance
      // ticket, but not always, so ticket_id/site_id can be null if nothing
      // matches yet. technician_id is resolved from the decoded tech name
      // (null for third-party vendor cases like "Next GI", which is
      // expected, not an error). Upserts on case_number so a resend/update
      // for the same case (e.g. a corrected tracking number) updates the
      // existing row instead of creating a duplicate.
      if (dispatchType === 'rma_shipping' && parsed) {
        try {
          let ticketId = null, siteId = null;
          if (parsed.woNum) {
            const { data: matchedTicket } = await supabase
              .from('tickets').select('id, site_id').eq('wo_number', parsed.woNum).maybeSingle();
            if (matchedTicket) { ticketId = matchedTicket.id; siteId = matchedTicket.site_id; }
          }
          let technicianId = null;
          if (parsed.techName) {
            const { data: matchedTech } = await supabase
              .from('technicians').select('id').ilike('name', parsed.techName).maybeSingle();
            if (matchedTech) technicianId = matchedTech.id;
          }
          const stateM = (parsed.accountName || '').match(/^([A-Z]{2})\s*[-–]/);
          const state = stateM ? stateM[1] : null;

          const { error: rmaErr } = await supabase.from('rma_shipments').upsert({
            case_number: parsed.caseNumber || null,
            parent_case_number: parsed.parentCaseNumber || null,
            wo_number: parsed.woNum || null,
            ticket_id: ticketId,
            site_id: siteId,
            account_name: parsed.accountName || null,
            state,
            warehouse_name: parsed.warehouseName || null,
            technician_id: technicianId,
            outbound_tracking: parsed.outboundTracking || null,
            inbound_tracking: parsed.inboundTracking || null,
            transfer_id: parsed.transferId || null,
            request_details: parsed.requestDetails || null,
            return_broken_part: !!parsed.returnBrokenPart,
            inbound_email_id: inboundEmailId,
            received_at: receivedAt.toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'case_number' });
          if (rmaErr) console.error('[mailgun-inbound] rma_shipments upsert failed:', rmaErr.message);
          else console.log(`[mailgun-inbound] rma_shipments: case ${parsed.caseNumber} saved (tech: ${parsed.techName || 'n/a'}, ticket matched: ${!!ticketId})`);
        } catch (rmaEx) {
          console.error('[mailgun-inbound] RMA persistence error (non-fatal):', rmaEx.message);
        }
      }

      // Dispatch List -- cache a site->date lookup for the maintenance-
      // ticket fallback above (used when a ticket's own free-text date
      // can't be parsed). Resolves rows with no real site code -- just
      // Neumo's own internal store reference number, seen so far only for
      // NV -- against sites.name, which already stores that same number as
      // a "Name - ###" suffix (confirmed 2026-07-21 with Mark: it's the
      // grocery chain's own store number, carried into the site name by
      // Neumo). Overwrites the previous cache each time a new list
      // arrives -- this is a rolling "latest known requested dates," not a
      // history, so an older list can't clobber a newer one out of order
      // as long as they're processed in receipt order.
      if (dispatchType === 'restock') {
        try {
          const siteDateMap = parseDispatchListSiteDates(effectiveBody);
          const fallbackRows = findDispatchListFallbackRows(effectiveBody);
          if (fallbackRows.length > 0) {
            const byState = {};
            for (const row of fallbackRows) (byState[row.state] = byState[row.state] || []).push(row);
            for (const [state, rowsForState] of Object.entries(byState)) {
              const { data: stateSites, error: stateSitesErr } = await supabase
                .from('sites').select('site_code, name').eq('state', state);
              if (stateSitesErr) {
                console.error('[mailgun-inbound] dispatch-list ref-number lookup failed:', stateSitesErr.message);
                continue;
              }
              for (const row of rowsForState) {
                const match = (stateSites || []).find(s => {
                  const m = s.name && s.name.match(/-\s*(\d+)\s*$/);
                  return m && m[1] === row.refNum;
                });
                if (match) siteDateMap[match.site_code] = row.dispatchDate;
                else console.log(`[mailgun-inbound] Dispatch list: no ${state} site matched internal ref #${row.refNum}`);
              }
            }
          }
          const dlStore = getDispatchStore();
          await dlStore.setJSON('dispatch-list/latest-dates', { dates: siteDateMap, cachedAt: receivedAt.toISOString() });
          console.log(`[mailgun-inbound] Cached dispatch-list dates for ${Object.keys(siteDateMap).length} sites`);
        } catch (dlEx) {
          console.error('[mailgun-inbound] Dispatch-list date caching error (non-fatal):', dlEx.message);
        }
      }
    } catch (e) {
      console.error('[mailgun-inbound] Supabase persistence error (non-fatal, Blobs path continues):', e.message);
    }

    const store = getDispatchStore();
    const inboundKey = `inbound/${timestamp}-${dispatchType}`;

    const payload = {
      sender, subject, dispatchType, states,
      body: effectiveBody,
      parsed: parsed || null,
      receivedAt: receivedAt.toISOString(),
      processed: false,
    };

    await store.setJSON(inboundKey, payload);

    // Store latest per state (restock only)
    if (dispatchType === 'restock' && states.length > 0) {
      for (const state of states) {
        await store.setJSON(`inbound/latest-${state}`, { ...payload, inboundKey });
      }
    }

    // Global "latest inbound dispatch list" slot for the app's banner --
    // dispatch lists (restock) ONLY. Previously this slot also got
    // overwritten by ANY non-'unknown' inbound email (trouble/maintenance
    // tickets), which meant a dispatch list's banner could get silently
    // bumped out by literally anything else arriving within the ~60s poll
    // window before the app ever checked -- found 2026-07-21 when a
    // dispatch list and a trouble ticket forward arrived 38 seconds apart
    // and only the ticket ever showed up. Every frontend consumer of this
    // endpoint (the banner check, and loading the list into the Location
    // Codes box) only ever expected restock content anyway, so nothing
    // else legitimately needed this slot.
    if (dispatchType === 'restock') {
      await store.setJSON('inbound/latest-dispatch', { ...payload, inboundKey });
    }

    // Send SMS for trouble tickets
    if (dispatchType === 'trouble' && parsed && parsed.alertBody) {
      // Prefer the site-code-derived state already computed for the SLA calc
      // above -- it's reliable (site code is always present on a real work
      // order). Falls back to parsed.state for messages that went through
      // the subject-line fallback path (short-body replies/forwards, see
      // ~line 391) -- that path extracts state from the subject directly
      // and is just as reliable, it just doesn't have a full site code to
      // work with. detectStates() is the last-resort crude fallback: it
      // scans raw email text for state tokens at the start of a line, which
      // works for tabular restock lists but frequently finds nothing on a
      // single trouble ticket or reply, where the state shows up mid-line
      // ("Location: IN ...") or inside a hyphenated subject. When it
      // silently returns null, the filter below fails OPEN (notify
      // everyone) rather than fail closed -- that was the actual bug
      // behind "I'm getting every state's texts again," in two different
      // parsing paths found on 2026-07-09.
      const ticketState = (parsed.siteCode && parsed.siteCode.length >= 2)
        ? parsed.siteCode.substring(0, 2)
        : (parsed.state || (states.length > 0 ? states[0] : null));

      // Matches the app's own region convention: the "Georgia/NC/SC" admin
      // checkbox only ever stores 'GA', since GA's dispatch view already
      // absorbs NC/SC (see accepts_prefixes on the GA row in Supabase
      // `states`, and CURRENT_STATE==='GA' handling in index.html). Without
      // this, fixing the null-state bug above would just trade "everyone
      // gets every ticket" for "GA/NC/SC recipients silently stop getting
      // NC/SC tickets" -- same root cause, opposite direction.
      const GA_BUNDLED_STATES = ['NC', 'SC'];
      const recipientCoversState = (recipientStates, tState) => {
        if (!tState) return true; // still can't determine state -- fail open, don't drop a real ticket
        if (recipientStates.includes(tState)) return true;
        if (GA_BUNDLED_STATES.includes(tState) && recipientStates.includes('GA')) return true;
        return false;
      };

      // Load recipients from Blobs
      let smsRecipients = [];
      let hoursExcluded = []; // recipients that passed the state check but are outside
                               // their active-hours window right now -- queued below so
                               // they get a digest once their window opens, instead of
                               // the ticket silently vanishing for them
      try {
        const notifData = await store.get('settings/NOTIFICATIONS', { type: 'json' });
        if (notifData) {
          const recs = (notifData.settings && notifData.settings.recipients) || notifData.recipients || [];
          for (const r of recs) {
            if (r.enabled === false) continue;
            // Filter by state
            if (r.states && r.states.length > 0 && !r.states.includes('ALL') && !recipientCoversState(r.states, ticketState)) {
              continue;
            }
            // Filter by active hours
            if (r.hoursStart && r.hoursEnd) {
              // Bug fixed 2026-07-22: this used to compute "now" in the
              // TICKET's state timezone (STATE_TIMEZONES[ticketState]),
              // not the recipient's own. That silently shifted a
              // recipient's active-hours window for any ticket from a
              // state in a different timezone than their own -- e.g. a GA-
              // based recipient's morning could read as pre-7am Pacific
              // for an NV ticket and get filtered out. Confirmed via WO
              // 00147417 (NV) showing zero SMS recipients despite Mark
              // covering NV and being Active. Now uses the recipient's own
              // r.timezone (set in admin.html's notification settings,
              // defaulting to Eastern -- correct for GA/IN/MI/OH/most of
              // the roster today) instead of the ticket's state.
              const tz = r.timezone || 'America/New_York';
              const now = new Date();
              const localStr = now.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
              const [h, m] = localStr.split(':').map(Number);
              const nowMins = h * 60 + m;
              const [startH, startM] = r.hoursStart.split(':').map(Number);
              const [endH, endM] = r.hoursEnd.split(':').map(Number);
              const startMins = startH * 60 + startM;
              // "00:00" as an end time is meant as "through midnight" (end of day),
              // not literal minute 0 of the day -- without this, a same-day window
              // like 07:00-00:00 computes endMins=0, and nowMins > 0 is true almost
              // every minute of the day, so the recipient gets silently excluded
              // nearly 24/7. Confirmed 2026-07-21: this exact bug zeroed out Mark's
              // own 07:00-00:00 window entirely.
              let endMins = endH * 60 + endM;
              if (endMins === 0) endMins = 24 * 60;
              const inWindow = startMins <= endMins
                ? (nowMins >= startMins && nowMins <= endMins)   // normal same-day window
                : (nowMins >= startMins || nowMins <= endMins);  // wraps past midnight, e.g. 22:00-06:00
              if (!inWindow) {
                hoursExcluded.push(r.address);
                continue;
              }
            }
            smsRecipients.push(r.address);
          }
        }
      } catch(e) {}

      // NOTE: previously fell back to a raw SMS_RECIPIENTS env var (a single
      // hardcoded, state-blind address) whenever the filtered list came back
      // empty. Removed 2026-07-18 -- that fallback was firing constantly
      // once coverage narrowed to a few states, silently sending every
      // other state's tickets to one person regardless of the state filter
      // above, undoing it entirely. If nobody's configured to cover a
      // state, nobody gets texted for it -- that's the correct behavior
      // given deliberately-narrowed coverage, not a gap to patch over.
      console.log(`[mailgun-inbound] SMS recipients: ${smsRecipients.length} | MAILGUN_KEY: ${process.env.MAILGUN_API_KEY ? 'SET' : 'MISSING'}`);
      for (const addr of smsRecipients) {
        console.log(`[mailgun-inbound] Sending SMS to ${addr.trim()}...`);
        const ok = await sendSms(addr.trim(), parsed.alertBody, 'MCR Dispatch');
        console.log(`[mailgun-inbound] SMS result: ${ok ? 'sent' : 'failed'}`);
      }

      // Queue for a digest instead of individually resending -- avoids the
      // "half a dozen texts land at once and Verizon's email-to-SMS gateway
      // buffers/delays the batch" problem Mark flagged 2026-07-21. One
      // summary text goes out (send-notification-digests.js) the next time
      // that recipient's active-hours window opens.
      if (hoursExcluded.length) {
        try {
          const pending = (await store.get('pending-notifications', { type: 'json' })) || {};
          for (const addr of hoursExcluded) {
            const key = addr.trim();
            if (!pending[key]) pending[key] = [];
            pending[key].push({
              ticketId: parsed.woNum || null,
              siteCode: parsed.site || null,
              summary: parsed.alertBody ? parsed.alertBody.split('\n')[0].slice(0, 120) : (parsed.woNum || 'ticket'),
              queuedAt: new Date().toISOString(),
            });
            // Cap so a multi-day outage or a stuck config can't grow this unbounded
            if (pending[key].length > 50) pending[key] = pending[key].slice(-50);
          }
          await store.setJSON('pending-notifications', pending);
        } catch (e) {
          console.error('[mailgun-inbound] Failed to queue pending notification:', e.message);
        }
      }
    }

    return json(200, {
      ok: true, dispatchType, states,
      bodyLength: effectiveBody.length,
      parsed: parsed ? { type: parsed.type, woNum: parsed.woNum, site: parsed.site } : null,
      message: `Stored. Type: ${dispatchType}. States: ${states.join(', ') || 'none'}`,
    });

  } catch (err) {
    console.error("[mailgun-inbound] Error:", err);
    return json(200, { ok: false, error: err.message });
  }
};
