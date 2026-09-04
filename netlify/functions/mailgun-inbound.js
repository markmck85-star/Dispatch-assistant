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
  const KNOWN = ["GA","FL","NC","SC","MI","IN","OH","NV","IL","MN","WV","OR","CO","ID","AL"];
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

// ── Correct timezone conversion helpers ──────────────────────────────────
// 2026-08-15: replaces the old `new Date(date.toLocaleString('en-US',
// {timeZone: tz}))` pattern used throughout this file. That pattern formats
// a date into a plain string with NO timezone info attached, then reparses
// it -- and re-parsing applies the *server's* default timezone (UTC on
// Netlify), not `tz`. The result silently mislabels the site's local
// wall-clock reading as if it were UTC. For same-day Y/M/D lookups
// (todayStrForSiteCode) this rarely bites, but calculateSlaDeadline stores
// the resulting instant via .toISOString() -- meaning every trouble-ticket
// SLA deadline was baked into the database shifted by that site's UTC
// offset (6hrs for CO/Denver, 4-5hrs for GA/Eastern, etc), always making
// deadlines look earlier than they actually are. Confirmed live 2026-08-14
// against CO1051/CO1061/CO1007 -- see mark's dispatch-platform notes.
//
// getZonedParts: what wall-clock date/time does `date` read as in `tz`?
function getZonedParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) { if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10); }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

// zonedTimeToUtc: given a wall-clock date/time meant to represent local time
// in `tz`, what real UTC instant is that? (inverse of getZonedParts)
function zonedTimeToUtc(year, month, day, hour, minute, second, tz) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));
  const offsetMs = getZonedParts(guess, tz);
  const asIfUtc = Date.UTC(offsetMs.year, offsetMs.month - 1, offsetMs.day, offsetMs.hour, offsetMs.minute, offsetMs.second);
  return new Date(guess.getTime() - (asIfUtc - guess.getTime()));
}

function todayStrForSiteCode(siteCode) {
  const tz = getTimezoneForSiteCode(siteCode);
  const p = getZonedParts(new Date(), tz);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}

// ── SLA calculator (Mon-Sat 8AM-5PM business hours) ─────────────────────────
// Saturday states (have on-call coverage): GA, IN, MI, NV
const SAT_STATES = new Set(['GA','IN','MI','NV']);

// Shared by calculateSlaDeadline and nextWorkDayStrForSiteCode -- a day is
// covered if it's Mon-Fri, or Saturday in a state with on-call coverage.
// Never Sunday, for any state.
// Takes a Date whose UTC-getters hold the wall-clock calendar we care about
// (either a genuine UTC-anchored scratchpad, or -- pre-fix legacy callers --
// a date built via new Date(y,mo,dy) in server-local time; on Netlify the
// server-local tz is UTC, so getUTCDay() and getDay() agree there too).
function isCoveredWorkDay(d, stateCode) {
  const hasSatCoverage = stateCode ? SAT_STATES.has(stateCode) : true;
  const day = d.getUTCDay();
  if (day === 0) return false; // never Sunday
  if (day === 6) return hasSatCoverage; // Saturday only if covered
  return true;
}

/**
 * Same idea as todayStrForSiteCode, but rolls forward to the next actually-
 * covered day if "today" isn't one (Sunday always, or Saturday in a state
 * without on-call coverage) -- so a ticket that comes in on an uncovered
 * day lands on the board for the day someone will actually be working,
 * instead of a day nobody's covering. Fixes a real bug found 2026-07-26:
 * a Sunday trouble ticket was landing on Sunday's board (todayStrForSiteCode
 * has no day-of-week awareness at all) even though Mark's stated rule is
 * "any Sunday call is a Monday ticket" -- calculateSlaDeadline already had
 * this exact rollover logic for the SLA deadline text, it just was never
 * reused for the board dispatch_date itself.
 */
function nextWorkDayStrForSiteCode(siteCode) {
  const tz = getTimezoneForSiteCode(siteCode);
  const stateCode = siteCode ? siteCode.substring(0, 2) : null;
  const p = getZonedParts(new Date(), tz);
  // Scratchpad Date used purely for Y/M/D calendar arithmetic (day-of-week,
  // date rollover) -- never converted back to an instant, so the UTC-vs-tz
  // hour mislabeling that bit calculateSlaDeadline doesn't apply here.
  const scratch = new Date(Date.UTC(p.year, p.month - 1, p.day));
  while (!isCoveredWorkDay(scratch, stateCode)) scratch.setUTCDate(scratch.getUTCDate() + 1);
  return `${scratch.getUTCFullYear()}-${String(scratch.getUTCMonth()+1).padStart(2,'0')}-${String(scratch.getUTCDate()).padStart(2,'0')}`;
}

// Shared by both the primary ticket-ingestion path and the address-sweep
// sibling-linking path below (2026-09-02) -- previously this whole block
// only ran once, inline, for the ticket that triggered the current
// webhook call. A sibling ticket whose site match gets resolved LATER via
// the address sweep never got a board push at all, even after it became
// fully matched and visible on the state console/watchdog -- real cases:
// GA1044 (WO 00151328), GA1084 (WO 00151329), both had to be added to the
// board manually. Extracting this so the sweep can call it too, once per
// swept sibling, right after that sibling's site_id is corrected.
async function autoAddTicketToBoard({
  supabase, siteId, ticketKind, dueDateRaw, rawSiteCode, woNum, newTicketId,
  receivedAtIso, issueCategory, issueDetail, description,
}) {
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
        if (['trouble', 'maintenance'].includes(ticketKind || 'trouble') && siteId) {
          try {
            const { data: siteDetail, error: siteDetailErr } = await supabase
              .from('sites').select('primary_tech_id').eq('id', siteId).maybeSingle();
            if (siteDetailErr) console.error('[mailgun-inbound] site detail lookup failed:', siteDetailErr.message);
            else if (siteDetail && siteDetail.primary_tech_id) {
              let dispatchDateStr;
              if ((ticketKind || 'trouble') === 'maintenance' && dueDateRaw) {
                const dd = new Date(dueDateRaw);
                dispatchDateStr = `${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
              } else if ((ticketKind || 'trouble') === 'maintenance' && rawSiteCode) {
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
                  dispatchDateStr = nextWorkDayStrForSiteCode(rawSiteCode);
                }
              } else {
                dispatchDateStr = nextWorkDayStrForSiteCode(rawSiteCode);
              }

              // 2026-08-25 fix: the plain upsert here used to be
              // ignoreDuplicates on (dispatch_date, site_id) -- meaning a
              // genuinely separate, later ticket arriving at a site that
              // ALREADY had a board entry today (even a completed one from
              // an earlier stop) silently got no board visibility at all,
              // logged only as "skipped, site already had an entry today".
              // Real case: GA1043 (Steve Reynolds) -- a new same-day trouble
              // ticket never showed up because that morning's restock stop
              // had already been marked completed. Now explicitly checks
              // what's there first: a genuinely different ticket on a
              // completed/removed row reopens that row as a fresh planned
              // stop (a real second visit is needed today); a still-planned
              // row is left untouched exactly as before, since that's an
              // active dispatcher decision this should never overwrite.
              const { data: existingAssignment, error: existingAssignErr } = await supabase
                .from('assignments')
                .select('id, status, ticket_id')
                .eq('dispatch_date', dispatchDateStr)
                .eq('site_id', siteId)
                .maybeSingle();

              // 2026-08-27: found via a real live discrepancy Mark spotted --
              // the board showing far more "still open" GA restocks today
              // than the actual field schedule/Dispatch Summary did. Root
              // cause: this whole existingAssignment check above is scoped
              // to dispatchDateStr (today, or a maintenance ticket's own due
              // date) ONLY -- it has no way to see a still-'planned' row for
              // the SAME SITE sitting open on an OLDER date. When a restock
              // first misses its due date and Neumo later sends a real
              // individual ticket for the same site (today), that ticket's
              // dispatchDateStr (today) never matches the old row's
              // dispatch_date, so the check below finds nothing and inserts
              // a brand new row -- leaving the original stuck forever with
              // no ticket_id and nothing that will ever complete it. Live
              // examples confirmed same day: GA1011 (stuck 8/23 alongside a
              // real 8/27 ticket), GA1026 (stuck 8/23 alongside 8/27),
              // GA1034 (stuck 8/18 alongside 8/27). Fix: before inserting a
              // new row, check for any OTHER still-'planned' row at this
              // site that's already overdue (dispatch_date strictly before
              // today's real date -- never a genuinely future-dated one,
              // which could be a distinct, legitimately-scheduled later
              // restock this should never touch) and move THAT row forward
              // to today with the new ticket attached, instead of creating a
              // second row. Scoped to 'planned' only -- a completed/removed
              // row for an older date is real history, not a stuck stop, and
              // is correctly left alone (same as always).
              const realTodayStr = todayStrForSiteCode(rawSiteCode);
              let staleOpenAssignment = null;
              if (!existingAssignment) {
                const { data: staleRows, error: staleErr } = await supabase
                  .from('assignments')
                  .select('id, dispatch_date')
                  .eq('site_id', siteId)
                  .eq('status', 'planned')
                  .lt('dispatch_date', realTodayStr)
                  .order('dispatch_date', { ascending: true })
                  .limit(1);
                if (staleErr) console.error('[mailgun-inbound] stale-open-assignment lookup failed:', staleErr.message);
                else if (staleRows && staleRows.length) staleOpenAssignment = staleRows[0];
              }

              if (existingAssignErr) {
                console.error('[mailgun-inbound] existing-assignment lookup for auto-add failed:', existingAssignErr.message);
              } else if (!existingAssignment && staleOpenAssignment) {
                const { error: absorbErr } = await supabase
                  .from('assignments')
                  .update({
                    dispatch_date: dispatchDateStr,
                    ticket_id: newTicketId,
                    assigned_by: 'auto',
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', staleOpenAssignment.id);
                if (absorbErr) console.error('[mailgun-inbound] absorb-stale-assignment failed:', absorbErr.message);
                else console.log(`[mailgun-inbound] Moved stale planned entry from ${staleOpenAssignment.dispatch_date} to ${dispatchDateStr} for new ticket ${woNum} instead of creating a duplicate`);
              } else if (!existingAssignment) {
                const { error: insertErr } = await supabase
                  .from('assignments')
                  .insert({
                    dispatch_date: dispatchDateStr,
                    site_id: siteId,
                    technician_id: siteDetail.primary_tech_id,
                    assigned_by: 'auto',
                    status: 'planned',
                    ticket_id: newTicketId,
                  });
                if (insertErr) console.error('[mailgun-inbound] auto-add to board failed:', insertErr.message);
                else console.log(`[mailgun-inbound] Auto-add to ${dispatchDateStr} board: added`);
              } else if (
                (existingAssignment.status === 'completed' || existingAssignment.status === 'removed')
                && newTicketId
                && existingAssignment.ticket_id !== newTicketId
              ) {
                const { error: reopenErr } = await supabase
                  .from('assignments')
                  .update({
                    status: 'planned',
                    ticket_id: newTicketId,
                    assigned_by: 'auto',
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', existingAssignment.id);
                if (reopenErr) console.error('[mailgun-inbound] auto-reopen for new ticket failed:', reopenErr.message);
                else console.log(`[mailgun-inbound] Reopened ${dispatchDateStr} board entry for a new ticket (${woNum}) at an already-${existingAssignment.status} site`);
              } else if (
                existingAssignment.status === 'planned'
                && newTicketId
                && existingAssignment.ticket_id
                && existingAssignment.ticket_id !== newTicketId
              ) {
                // 2026-09-02 fix: a second, distinct ticket arriving at a
                // site that already has an ACTIVE (still-planned) board
                // entry today used to fall straight into the plain skip
                // branch below -- the existing entry was left untouched
                // and the new ticket got zero board visibility, with
                // nothing telling the dispatcher a second issue exists.
                // Real case: FL1033 (WO 00151325) never appeared on the
                // board while an earlier ticket's stop there was still
                // planned. Fix: append the new ticket's summary onto the
                // EXISTING linked ticket's description (same append
                // pattern used for same-WO line-item follow-ups above)
                // and flag needs_review, rather than silently swapping
                // which ticket the board entry points to (that would just
                // lose visibility of the FIRST ticket instead).
                try {
                  const { data: existingTicketRow, error: existingTicketErr } = await supabase
                    .from('tickets')
                    .select('id, description')
                    .eq('id', existingAssignment.ticket_id)
                    .maybeSingle();
                  if (existingTicketErr) {
                    console.error('[mailgun-inbound] lookup of existing linked ticket for second-ticket append failed:', existingTicketErr.message);
                  } else if (existingTicketRow) {
                    const stamp = receivedAtIso.slice(0, 10);
                    const summary = (issueCategory || issueDetail)
                      ? `${issueCategory || ''}${issueDetail ? ' - ' + issueDetail : ''}`
                      : (description || 'See ticket for details');
                    const noteLine = `⚠️ SECOND TICKET TODAY [WO ${woNum}, ${stamp}]: ${summary}`;
                    const newDescription = (existingTicketRow.description ? existingTicketRow.description + '\n\n' : '') + noteLine;
                    const { error: appendErr } = await supabase
                      .from('tickets')
                      .update({ description: newDescription, needs_review: true })
                      .eq('id', existingTicketRow.id);
                    if (appendErr) console.error('[mailgun-inbound] second-ticket append failed:', appendErr.message);
                    else console.log(`[mailgun-inbound] Site already had a planned entry today -- appended new ticket ${woNum} as a note on the existing linked ticket + flagged needs_review instead of dropping it silently`);
                  }
                } catch (appendEx) {
                  console.error('[mailgun-inbound] Second-ticket append error (non-fatal):', appendEx.message);
                }
              } else {
                console.log(`[mailgun-inbound] Auto-add to ${dispatchDateStr} board: skipped, site already had a ${existingAssignment.status} entry today`);
              }
            } else {
              console.log(`[mailgun-inbound] Skipped auto-add for ${woNum}: no primary tech configured for site`);
            }
          } catch (boardEx) {
            console.error('[mailgun-inbound] Auto-add to board error (non-fatal):', boardEx.message);
          }
        }
}

function calculateSlaDeadline(receivedAt, timezone, stateCode) {
  let remaining = 240; // 4 hours in minutes
  const tz = timezone || 'America/New_York';

  // Scratchpad: a UTC-anchored Date whose UTC-getters hold the site's local
  // wall-clock reading of receivedAt. All arithmetic below stays inside
  // this wall-clock frame (never mixed with a genuine UTC instant) --
  // that's what keeps the business-hour math itself correct. The one thing
  // that changed vs. the old version: we convert this scratchpad back to a
  // real UTC instant with zonedTimeToUtc() at the very end, instead of
  // handing the mislabeled scratchpad straight to the caller.
  const startParts = getZonedParts(receivedAt, tz);
  let current = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day, startParts.hour, startParts.minute, startParts.second));

  const isWorkDay = (d) => isCoveredWorkDay(d, stateCode);

  const advanceToNextBizDay = (d) => {
    d.setUTCDate(d.getUTCDate() + 1);
    while (!isWorkDay(d)) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(8, 0, 0, 0);
    return d;
  };

  if (current.getUTCHours() < 8) current.setUTCHours(8, 0, 0, 0);
  if (current.getUTCHours() >= 17 || !isWorkDay(current)) advanceToNextBizDay(current);

  while (remaining > 0) {
    const endOfDay = new Date(current);
    endOfDay.setUTCHours(17, 0, 0, 0);
    const minsToday = Math.max(0, (endOfDay - current) / 60000);
    if (remaining <= minsToday) {
      current = new Date(current.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= minsToday;
      advanceToNextBizDay(current);
    }
  }

  // Convert the wall-clock scratchpad reading back to a genuine UTC instant.
  return zonedTimeToUtc(
    current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate(),
    current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(),
    tz
  );
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
  const KNOWN_STATES = new Set(['GA','FL','MI','IN','OH','WV','IL','MN','NV','OR','CO','ID','AL','NC','SC']);
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
    // 2026-08-08: anchor to noon UTC, not new Date(yr,mo,dy) (server-local
    // midnight -- UTC midnight on Netlify -- which shifts back into the
    // previous evening once displayed in Eastern time; noon UTC stays on
    // the correct calendar day across every US timezone). Confirmed live:
    // "by 8/10" was showing as "Aug 9, 8:00 PM" -- a real due date landing
    // on a Sunday, which should never happen under the service-window rules.
    const d = new Date(Date.UTC(yr, mo, dy, 12, 0, 0));
    if (!isNaN(d.getTime())) return m[3] ? d : rollForward(d);
  }

  m = description.match(/\b(?:by|before)\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  if (m) {
    const moKey = m[1].slice(0, 3).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MONTHS, moKey)) {
      const mo = MONTHS[moKey], dy = parseInt(m[2], 10);
      const yr = m[3] ? parseInt(m[3], 10) : year;
      const d = new Date(Date.UTC(yr, mo, dy, 12, 0, 0));
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
      const d = new Date(Date.UTC(yr, mo, dy, 12, 0, 0));
      if (!isNaN(d.getTime())) return m[3] ? d : rollForward(d);
    }
  }

  return null;
}

// `d` is now always a genuine UTC instant (post-2026-08-15 fix), so this
// must explicitly project it into the site's own timezone for display --
// it can no longer rely on the server's default tz matching.
function formatSlaDeadline(d, timezone) {
  const tz = timezone || 'America/New_York';
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const p = getZonedParts(d, tz);
  const dow = days[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const ampm = p.hour >= 12 ? 'PM' : 'AM';
  const h12 = p.hour % 12 || 12;
  const mm = String(p.minute).padStart(2, '0');
  return `${dow} ${h12}:${mm} ${ampm}`;
}

// ── Email classifier & parser (ported from watchdog.py) ──────────────────────

function parseEmailBody(text, receivedAt, subject) {
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
    // 2026-07-23: added the ITI/TechWeb closing-email's own field labels
    // (Service Call Date, Technician, Component, Location, Contact, Ticket
    // Number, Issue, Call Type, Status, Resolution and Notes, Arrival/End
    // Time, Travel Time, Mileage, PCI Requirements..., Rogue Devices...,
    // Credit Card Reader Serial Number) -- without these in the stop-list,
    // calling getField() on any one of them would swallow straight through
    // to whichever OTHER ticket type's label happened to appear next (or
    // to the end of the email), since none of this format's own labels
    // were previously recognized as a stopping point.
    // 2026-07-24: two stop-list words are also legitimate free-text content,
    // not just field labels -- "Journal Printer" is a real issue_category
    // value (not only the Consumable Counts label), and "Technician" shows
    // up constantly inside ordinary description text ("please dispatch a
    // technician..."), not only as TechWeb's own "Technician:" label. Both
    // were truncating real fields the instant that word appeared anywhere
    // in the captured value, since the stop-list didn't require a following
    // colon (unlike Location:/Address:/Phone: below, which already do).
    // Anchored these two specifically to a trailing colon so they still stop
    // a match at a REAL label but no longer collide with the same words
    // appearing as ordinary content. Found via "Add Line Item to Work
    // Order #NNNN" emails (GA1049, WO 00147776) -- issue_category came back
    // empty and description got cut to "Please dispatch the" because the
    // very next word was "technician".
    const m = text.match(new RegExp('(?<!Parent\\s)' + labelPattern + '\\s*:?\\s*(.*?)(?=\\s*(?:Work\\s+Order|Priority|Earliest\\s+Start|Due\\s+Date|Address:|Phone:|Line\\s+Item\\s+Number|Account\\s+Name|ATM\\s+ID|SST\\s+Name|PC\\s+Name|SST\\s+Type|Out\\s+of\\s+Service|Line\\s+Item\\s+Issue|Line\\s+Item\\s+Description|Device\\s+Errors|Consumable\\s+Counts|Restock\\s+SST|SST\\s+ID|Printer\\s+\\d|Journal\\s+Printer\\s*:|Outbound\\s+Tracking|Inbound\\s+Tracking|Warehouse\\s+Name|Parent\\s+Case\\s+Number|Case\\s+Number|Transfer\\s+ID|Request\\s+Details|Service\\s+Call\\s+Date|Technician\\s*:|Component\\s*:|Location\\s*:|Contact\\s*:|Ticket\\s+Number|Issue\\s*:|Call\\s+Type\\s*:|Status\\s*:|Resolution\\s+and\\s+Notes|Arrival\\s+Time|End\\s+Time|Travel\\s+Time|Mileage|PCI\\s+Requirements|Rogue\\s+Devices|Credit\\s+Card\\s+Reader|Thank\\s+you)|$)', 'is'));
    // Trailing colon left inside a captured value (not the label side, which
    // \s*:? already handles) -- happens with "Work Order #NNNN:" phrasing,
    // where the colon follows the VALUE rather than the label. Strip it the
    // same way a trailing label-colon is already stripped going in.
    return m ? m[1].trim().replace(/:\s*$/, '').trim() : '';
  };

  // 0. ITI/TechWeb closing email -- the legacy pre-Salesforce system, still
  // actively generating these for a handful of sites (GCI GA Prison and
  // other prison mail-room sites) that never migrated to the newer
  // Salesforce Field Service setup the rest of the closed-ticket import
  // covers. Found 2026-07-23. Checked first, ahead of the Maintenance
  // check below, because "Resolution and Notes" on these often contains
  // the word "maintenance" in free text (e.g. "Completed preventative
  // maintenance"), which the loose /Maintenance/i check would otherwise
  // catch -- misrouting these into the generic maintenance-ticket path
  // instead of being recognized as this distinct, already-closed format.
  // Detected on "Service Call Date:" + "Ticket Number:" together, since
  // neither label is used by any other email type this pipeline handles.
  if (/Service\s+Call\s*Date\s*:/i.test(text) && /Ticket\s+Number\s*:/i.test(text)) {
    // The forwarded email's own Subject/Date/From/To/Cc header block
    // (visible in the plain-text body above the actual data table) can
    // contain words that collide with this format's own field labels --
    // e.g. "Subject: ITI Technician Service Response..." contains the
    // word "Technician", which getField('Technician') would otherwise
    // match instead of the real field further down, swallowing
    // everything in between as its "value". Slicing to start at the
    // first real "Service Call Date:" (a label that doesn't appear
    // anywhere in the forwarded headers) before running any extraction
    // sidesteps this for every field, not just the one that happened to
    // collide in testing.
    const tableStart = text.search(/Service\s+Call\s*Date\s*:/i);
    const tableText = tableStart >= 0 ? text.slice(tableStart) : text;
    const getTWField = (label) => {
      const labelPattern = label.replace(/ /g, '\\s+');
      const m = tableText.match(new RegExp('(?<!Parent\\s)' + labelPattern + '\\s*:?\\s*(.*?)(?=\\s*(?:Service\\s+Call\\s+Date|Technician|Component|Location|Contact|Ticket\\s+Number|Issue|Call\\s+Type|Status|Resolution\\s+and\\s+Notes|Arrival\\s+Time|End\\s+Time|Travel\\s+Time|Mileage|PCI\\s+Requirements|Rogue\\s+Devices|Credit\\s+Card\\s+Reader|Thank\\s+you)|$)', 'is'));
      // Collapse line-wrap newlines (e.g. "Sean \nReich", "Georgia \nMR")
      // into single spaces -- a literal embedded newline would otherwise
      // show up in tech names/locations/remediation text everywhere this
      // gets displayed, and Date() parsing tolerating it was luck, not
      // something to rely on.
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    };

    const serviceCallDate = getTWField('Service Call Date');
    const technician = getTWField('Technician');
    const component = getTWField('Component');
    const location = getTWField('Location');
    const ticketNumber = getTWField('Ticket Number');
    const callType = getTWField('Call Type');
    const status = getTWField('Status');
    const resolutionNotes = getTWField('Resolution and Notes');
    const arrivalTime = getTWField('Arrival Time');
    const endTime = getTWField('End Time');

    // No true unique appointment number exists in this legacy format (no
    // Salesforce SA-#### equivalent) -- synthesize one from the ticket
    // number so it still works as site_visits' dedup key.
    const appointmentNumber = ticketNumber ? `TW-${ticketNumber}` : null;

    // "Component: Georgia MR" is the closest thing to a state signal in
    // this format -- no separate Jurisdiction/State field like the
    // Salesforce report has. Falls back to detectStates() against the
    // whole body if Component doesn't parse cleanly.
    const componentStateM = component.match(/\b(Georgia|Florida|Michigan|Indiana|Ohio|Nevada|Colorado|Illinois|Minnesota|Oregon|Idaho|California|Hawaii|North Carolina|South Carolina|West Virginia)\b/i);
    const STATE_NAME_TO_ABBR = { georgia: 'GA', florida: 'FL', michigan: 'MI', indiana: 'IN', ohio: 'OH', nevada: 'NV', colorado: 'CO', illinois: 'IL', minnesota: 'MN', oregon: 'OR', idaho: 'ID', alabama: 'AL', california: 'CA', hawaii: 'HI', 'north carolina': 'NC', 'south carolina': 'SC', 'west virginia': 'WV' };
    const state = componentStateM ? STATE_NAME_TO_ABBR[componentStateM[1].toLowerCase()] : (detectStates(text)[0] || null);

    return {
      type: 'techweb_closing',
      alertBody: null, // historical/already-closed, board-only path doesn't apply -- goes straight to site_visits, no SMS
      siteVisit: {
        appointmentNumber,
        accountNameRaw: location || null,
        state,
        woNumber: ticketNumber || null,
        startedAtRaw: arrivalTime || null,
        endedAtRaw: endTime || null,
        techNameRaw: technician || null,
        remediation: callType || null,
        remediationDetail: resolutionNotes || null,
        status,
        serviceCallDateRaw: serviceCallDate || null,
      },
    };
  }


  // 2026-08-05: Maintenance/Consumable Restock ticket detection moved
  // ABOVE the bulk dispatch-list check below. Individual restock tickets
  // very likely contain their own "Restock By:" field (a standard field
  // name for this ticket type), which was tripping the dispatch-list
  // check's bare /Restock By/i test FIRST -- silently misclassifying
  // every individual restock ticket as the bulk daily digest instead of
  // creating a real ticket. Confirmed live: zero maintenance-kind tickets
  // existed in the database despite real restock tickets being received
  // (per a live ticket Mark found with an explicit "PC Name:" field).
  // "Maintenance"/"Consumable Restock" text is a much more specific,
  // reliable signal for an individual ticket than the generic "Restock
  // By" substring, so checking it first should resolve this without
  // affecting real dispatch-list detection (which also has its own more
  // specific "Dispatch List"/"Restock Report" phrase checks).
  //
  // 2. Maintenance / Consumable Restock -- board-eligible for any requested
  // date, not just same-day. These never get an SMS (routine/Low priority,
  // would be a flood of texts for something that isn't urgent) -- they're
  // board-only, added via the same auto-add-to-board path as trouble tickets.
  // 2026-08-25 fix: an "Add Line Item to Work Order #NNNN" follow-up whose
  // FIRST line item happens to be a restock (Maintenance/Consumable
  // Restock) was matching this bare keyword test and getting routed here
  // as a brand-new maintenance ticket -- even when it's really a follow-up
  // on an EXISTING ticket of any kind. This branch has no isLineItemAddition
  // handling at all, so the follow-up (and the real fact that a site needed
  // another look) was silently dropped by the ignoreDuplicates upsert below.
  // Real case: GA1023 (N Decatur), WO 00150423 -- a restock line item added
  // to an already-existing Journal Printer trouble ticket vanished with no
  // trace, no note, no re-open. "Add Line Item" emails now always fall
  // through to the Trouble ticket branch below instead, which has the
  // correct existing-ticket append logic (keyed on WO number -- works
  // regardless of which line item happens to appear first in the body).
  const isAddLineItemFollowUp = /Add\s+Line\s+Item\s+to\s+Work\s+Order/i.test(subject || '')
    || /add\s+the\s+following\s+line\s+item\s+to\s+the\s+existing\s+Work\s+Order/i.test(text);
  if (!isAddLineItemFollowUp && (/Maintenance/i.test(text) || /Consumable Restock/i.test(text))) {
    const woNum = getField('Work Order Number');
    const account = getField('Account Name');
    const sstName = getField('SST Name');
    const pcName = getField('PC Name');
    const oos = getField('Out of Service\\?') || getField('Out of Service');
    const address = getField('Address');
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
      woNum, site: siteStr, siteCode, address,
      issueCategory, issueDetail,
      issue: [issueCategory, issueDetail].filter(Boolean).join(' – ') || 'See email for details',
      description,
      dueDateRaw: dueDate ? dueDate.toISOString() : null,
      slaEnd: null,
    };
  }

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
    // 2026-08-25 fix: these fields were never normalized -- literal "<br>"
    // tags and mid-value line-wrap newlines from Neumo's HTML-formatted
    // notification survived straight into case_number/warehouse_name/
    // account_name (e.g. "01414342<br>", "MCR (GA) Gina Ownbey \nWhse").
    // Harmless-looking but broke real things downstream: the warehouse-
    // name-to-technician-name regex match below, and text matching against
    // these fields anywhere else (shipments.html's technician filter).
    // cleanField collapses everything to one line for identifiers/names;
    // requestDetails alone keeps intentional multi-line formatting (its
    // display column uses white-space:pre-wrap on purpose), so it only
    // converts <br> to a real newline rather than collapsing all whitespace.
    const cleanField = (v) => (v || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
    const cleanMultilineField = (v) => (v || '').replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]+/g, ' ').trim();

    const caseNumber = cleanField(getField('Case Number'));
    const parentCaseNumber = cleanField(getField('Parent Case Number'));
    // "Work Order Number:" can get line-wrapped mid-phrase by some email
    // clients ("Work \nOrder Number:") -- \s+ tolerates that, unlike the
    // literal space the trouble-ticket parser's own version below uses.
    const woNumM = text.match(/Work\s+Order\s+Number:\s*\n?\s*(\S+)/i);
    const woNum = woNumM ? cleanField(woNumM[1]) : '';
    const transferId = cleanField(getField('Transfer ID'));
    const outboundTracking = cleanField(getField('Outbound Tracking Number UPS') || getField('Outbound Tracking Number'));
    const inboundTracking = cleanField(getField('Inbound Tracking Number UPS') || getField('Inbound Tracking Number'));
    const accountName = cleanField(getField('Account Name'));
    const warehouseName = cleanField(getField('Warehouse Name'));
    // Warehouse Name is usually "MCR (STATE) Tech Name Whse" -- but not
    // always; sometimes it's a third-party repair vendor (e.g. "Next GI")
    // with no tech involved at all. techName is null when it doesn't match.
    const techM = warehouseName.match(/^MCR\s*\([A-Z]{2}\)\s*(.+?)\s*Whse\s*$/i);
    const techName = techM ? techM[1].trim() : null;
    const requestDetails = cleanMultilineField(getField('Request Details'));
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
    const address = getField('Address');
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
    // 2026-09-04: previously used Neumo's own stated Due Date verbatim as
    // the SLA deadline for Install-category tickets (statedDueDate ||
    // calculateSlaDeadline(...)). Mark confirmed Neumo's Due Date field is
    // boilerplate on every ticket regardless of real urgency -- same as
    // Priority always reading "Low" -- so it carries no real signal and
    // should never be trusted, install tickets included. Always use the
    // app's own business-hours/Saturday-coverage-aware calculation instead.
    const ticketTz = getTimezoneForSiteCode(siteCode);
    const slaEnd = calculateSlaDeadline(receivedAt, ticketTz, siteCode.substring(0,2));
    const slaStr = formatSlaDeadline(slaEnd, ticketTz);
    const siteTrunc = site.length > 40 ? site.substring(0, 38) + '…' : site;

    // "Add Line Item to Work Order #NNNN" -- a follow-up adding a new line
    // item to a ticket that (usually) already exists on the board, not a
    // fresh dispatch. Found 2026-07-24 (GA1049, WO 00147776): the existing
    // upsert below uses ignoreDuplicates on wo_number specifically to avoid
    // clobbering a ticket a dispatcher's already actioned -- which also
    // meant these follow-ups were silently dropped with no record at all.
    // Agreed with Mark: append to the existing ticket's description instead
    // (see isLineItemAddition handling near the tickets upsert).
    const isLineItemAddition = /Add\s+Line\s+Item\s+to\s+Work\s+Order/i.test(subject || '')
      || /add\s+the\s+following\s+line\s+item\s+to\s+the\s+existing\s+Work\s+Order/i.test(text);

    let alertBody = `🚨 WO: ${woNum}\nSite: ${siteTrunc}`;
    if (issue && issue !== 'See email for details') alertBody += `\nIssue: ${issue}`;
    // Always our own calculated SLA now (see note above) -- no more branching
    // on whether Neumo supplied a Due Date, since that's never trusted.
    alertBody += `\nSLA ends: ${slaStr}`;

    return {
      type: 'trouble',
      alertBody,
      woNum, site, siteCode, issue, slaEnd: slaEnd.toISOString(),
      state: locationState,
      address,
      issueCategory: issueCategory || null,
      issueDetail: issueDetail || null,
      description: lineItemDescription || null,
      earliestStartRaw: earliestStartRaw || null,
      dueDateRaw: dueDateRaw || null,
      ticketKind: isSiteSurvey ? 'site_survey' : (isInstallCategory ? 'install' : 'trouble'),
      isLineItemAddition,
    };
  }

  return null;
}


// ── Address-fallback site matching ────────────────────────────────────────
// Added 2026-08-30. rawSiteCode-based matching (above) only works when
// Neumo's own ticket text embeds a real site code -- site_survey/install
// tickets never do, and some trouble/maintenance tickets that reference a
// site purely by name/address (no embedded code) don't either, even when
// that exact site already exists in `sites`. Confirmed live the same day:
// four "System - State Integration" tickets and one "Testing Station"
// ticket all sat unmatched despite genuine address matches already on
// file, one of which was missed even by simple exact-string comparison
// over a one-letter spelling difference ("Kraft Rd" vs "Krafft Rd").
//
// This normalizes both sides enough to survive the variation actually
// seen in practice (ordinal words vs numerals, spelled-out vs abbreviated
// street types and directionals, suite/unit noise) plus a small edit-
// distance tolerance for genuine typos, while still requiring an EXACT
// street-number match -- that's the cheap, low-false-positive anchor the
// rest of the comparison hangs off of.
const ORDINAL_WORDS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
  eleventh: '11th', twelfth: '12th', thirteenth: '13th', fourteenth: '14th',
  fifteenth: '15th', sixteenth: '16th', seventeenth: '17th', eighteenth: '18th',
  nineteenth: '19th', twentieth: '20th',
};
const STREET_TYPE_WORDS = {
  street: 'st', avenue: 'ave', road: 'rd', boulevard: 'blvd', drive: 'dr',
  lane: 'ln', highway: 'hwy', circle: 'cir', court: 'ct', place: 'pl',
  parkway: 'pkwy', trail: 'trl', terrace: 'ter', square: 'sq',
};
const DIRECTION_WORDS = {
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  north: 'n', south: 's', east: 'e', west: 'w',
};

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function normalizeStreetLine(line) {
  let s = (line || '').toLowerCase();
  const applyWordMap = (map) => {
    for (const [word, abbr] of Object.entries(map)) {
      s = s.replace(new RegExp('\\b' + word + '\\b', 'g'), abbr);
    }
  };
  applyWordMap(ORDINAL_WORDS);
  applyWordMap(DIRECTION_WORDS);
  applyWordMap(STREET_TYPE_WORDS);
  s = s.replace(/\b(suite|ste|unit|apt)\b\s*#?\s*\w*/g, ' ');
  s = s.replace(/[.,#]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Pulls { number, direction, street } from the first line of a possibly
// multi-line address. `direction` (a leading N/S/E/W/NE/NW/SE/SW token) is
// tracked separately from `street` and compared for an EXACT match below
// -- a one-character direction difference ("123 N Main St" vs "123 S Main
// St") must never fall under the typo-tolerance applied to the rest of
// the street name, since it's a materially different address, not a
// misspelling.
function extractStreetSignature(fullAddress) {
  if (!fullAddress) return null;
  const firstLine = String(fullAddress).split('\n')[0].split(',')[0];
  const norm = normalizeStreetLine(firstLine);
  const m = norm.match(/^(\d+)\s+(.*)$/);
  if (!m || !m[2]) return null;
  let rest = m[2].trim();
  let direction = null;
  const dirMatch = rest.match(/^(ne|nw|se|sw|n|s|e|w)\s+(.*)$/);
  if (dirMatch) { direction = dirMatch[1]; rest = dirMatch[2]; }
  return { number: m[1], direction, street: rest };
}

// Exact street number AND exact leading direction (if either address has
// one) required; the remaining street name allowed a small edit-distance
// tolerance after normalization -- catches genuine typos/spelling variants
// (e.g. "Kraft"/"Krafft", distance 1) without being loose enough to match
// two genuinely different streets, or two different sides of the same
// street name, that happen to share a number.
function addressesLooselyMatch(addrA, addrB) {
  const a = extractStreetSignature(addrA);
  const b = extractStreetSignature(addrB);
  if (!a || !b) return false;
  if (a.number !== b.number) return false;
  if ((a.direction || null) !== (b.direction || null)) return false;
  if (a.street === b.street) return true;
  const dist = levenshtein(a.street, b.street);
  const maxLen = Math.max(a.street.length, b.street.length);
  return maxLen > 0 && dist <= 2 && dist / maxLen < 0.3;
}

// Looks for an existing site in the same state whose address matches, when
// the ticket's own text had no embedded site code to look up directly.
// Scoped to one state's sites (cheap, and state is reliably known from the
// ticket's own Location field even without a code) rather than scanning
// every site in the database.
async function findSiteByAddress(supabase, address, stateHint) {
  if (!address || !stateHint) return null;
  const { data: candidates, error } = await supabase
    .from('sites')
    .select('id, site_code, address')
    .eq('state', stateHint);
  if (error || !candidates) return null;
  for (const c of candidates) {
    if (addressesLooselyMatch(address, c.address)) return c;
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
    let parsed = isReplyOnly ? null : parseEmailBody(effectiveBody, receivedAt, subject);
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
        const fallbackTz = STATE_TIMEZONES[stateCode] || 'America/New_York';
        const slaEnd = calculateSlaDeadline(receivedAt, fallbackTz, stateCode);
        const slaStr = formatSlaDeadline(slaEnd, fallbackTz);
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
    //
    // 2026-08-29 fix, corrected: appendedTicketState must be declared HERE,
    // above the try block, not merely above the isLineItemAddition if-block
    // inside it (that was the first attempt at this fix, and it didn't
    // actually work -- see below). The SMS-sending code that reads this
    // variable sits entirely OUTSIDE this try/catch (it's sibling code
    // after the catch closes), so a `let` declared anywhere inside the try
    // -- no matter how early -- still goes out of scope at the try block's
    // own closing brace, throwing the exact same "ReferenceError:
    // appendedTicketState is not defined" at the SMS block regardless.
    // Confirmed live 2026-08-29 (Ponce De Leon WO 00151065 forward test):
    // the first fix attempt genuinely deployed correctly (verified via
    // GitHub raw file + Netlify deploy log) and still crashed at the same
    // spot, which is what exposed this deeper scope boundary. Declaring it
    // out here, before the try even opens, is the only place both the
    // isLineItemAddition write (deep inside the try) and the SMS-block read
    // (after the try/catch closes) can both actually see it.
    let appendedTicketState = null;
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

      const classifiedAsMap = { trouble: 'trouble', maintenance: 'maintenance', restock: 'dispatch_list', rma_shipping: 'rma_shipping', techweb_closing: 'closing_note_email' };
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

      // ITI/TechWeb closing emails go straight into site_visits, not
      // `tickets` -- unlike trouble/maintenance emails, these arrive
      // already CLOSED (they're the legacy system's own after-the-fact
      // notification, not something needing a board entry). Reuses the
      // same table/shape as the Salesforce closed-ticket import, just a
      // different source value, so both flow into the same location
      // history views without any UI changes needed.
      if (dispatchType === 'techweb_closing' && parsed && parsed.siteVisit) {
        const sv = parsed.siteVisit;

        // Site match: token-overlap-coefficient against sites.name within
        // the same state, same logic and threshold as
        // import-service-appointments.js/rematch-site-visits.js. Known to
        // return null for GCI GA Prison specifically -- it was never in
        // the Salesforce site import this table is otherwise keyed off,
        // so it'll land here needs_review=true with a real account_name_raw
        // for reference until/unless it gets added as a real site.
        let siteId = null;
        if (sv.state) {
          const { data: candidateSites } = await supabase
            .from('sites')
            .select('id, name')
            .eq('state', sv.state);
          if (candidateSites && candidateSites.length && sv.accountNameRaw) {
            const TOKEN_ALIASES = { co: 'county', cnty: 'county', ave: 'avenue', blvd: 'boulevard', dr: 'drive', rd: 'road', st: 'street', mt: 'mount', hwy: 'highway', pkwy: 'parkway' };
            const tokenize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((t) => TOKEN_ALIASES[t] || t);
            const targetTokens = tokenize(sv.accountNameRaw);
            let best = null, bestScore = 0;
            for (const site of candidateSites) {
              const siteTokens = tokenize(site.name);
              const setA = new Set(targetTokens), setB = new Set(siteTokens);
              const intersection = [...setA].filter((t) => setB.has(t)).length;
              const smaller = Math.min(setA.size, setB.size);
              const score = smaller > 0 ? intersection / smaller : 0;
              if (score > bestScore) { bestScore = score; best = site; }
            }
            if (best && bestScore >= 0.65) siteId = best.id;
          }
        }

        // Arrival/End Time come as "4/1/2026 10:00:00 AM" -- a plain
        // Date() parse handles that format fine, same as the Salesforce
        // report's Actual Start/End columns elsewhere in this pipeline.
        const parseTs = (raw) => {
          if (!raw) return null;
          const d = new Date(raw);
          return isNaN(d.getTime()) ? null : d.toISOString();
        };
        const startedAt = parseTs(sv.startedAtRaw);
        const endedAt = parseTs(sv.endedAtRaw);
        let durationMin = null;
        if (startedAt && endedAt) {
          durationMin = Math.round((new Date(endedAt) - new Date(startedAt)) / 60000);
        }

        if (sv.appointmentNumber) {
          const { error: svError } = await supabase
            .from('site_visits')
            .upsert({
              appointment_number: sv.appointmentNumber,
              site_id: siteId,
              account_name_raw: sv.accountNameRaw,
              state: sv.state,
              wo_number: sv.woNumber,
              started_at: startedAt,
              ended_at: endedAt,
              duration_min: durationMin,
              tech_name_raw: sv.techNameRaw,
              technician_id: null, // not matched here -- TechWeb-era techs (e.g. Sean Reich) may not all be on the current roster; left for a future pass if needed
              remediation: sv.remediation,
              remediation_detail: sv.remediationDetail,
              source: 'closing_note_email',
              needs_review: !siteId,
              imported_at: new Date().toISOString(),
            }, { onConflict: 'appointment_number', ignoreDuplicates: true });
          if (svError) console.error('[mailgun-inbound] TechWeb site_visits upsert failed:', svError.message);
          else console.log(`[mailgun-inbound] TechWeb closing email recorded: ${sv.appointmentNumber} (site match: ${siteId ? 'yes' : 'no'})`);
        }
      }

      // Trouble tickets and maintenance/restock tickets both go into
      // `tickets` -- bulk dispatch lists are a separate, not-yet-built path
      // (see handoff doc). fromSubject-fallback trouble tickets are
      // included since they carry a real WO number even without a matched
      // site code. (appendedTicketState, read/written a bit further down
      // in this block, is declared above the surrounding try -- see the
      // 2026-08-29 comment there.)
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

        // Address-fallback match -- covers every ticket with no embedded
        // code at all (site_survey/install always; some trouble/maintenance
        // tickets too) plus the case where a code WAS embedded but somehow
        // didn't match (rare, but no reason not to still try by address).
        // One deliberate carve-out: a vague "System / State Integration"
        // ticket ("convert from ISP to the state's network") gives no clue
        // which physical device it's about, and kiosks essentially never
        // sit on a building ISP that would need converting (Neumo-supplied
        // wireless handles that) -- confirmed live 2026-08-30 that three of
        // these auto-matched straight to a real kiosk's address when they
        // almost certainly meant a separate testing-station/OTC device at
        // the same building. So for this one ambiguous category, only
        // accept an address match against an already-known T/TMP-coded
        // site -- matching a plain numeric (kiosk) code is left unmatched
        // instead, surfacing the toast for a human call rather than
        // guessing wrong silently. Every other ticket category still
        // matches confidently against any site type the address resolves to.
        let matchedByAddress = null;
        if (!siteId && parsed.address) {
          const candidate = await findSiteByAddress(supabase, parsed.address, parsed.state);
          if (candidate) {
            const isAmbiguousSystemIntegration = parsed.issueCategory === 'System'
              && /state integration/i.test(parsed.issueDetail || '');
            const candidateIsPlainKiosk = /^[A-Z]{2}\d+$/.test(candidate.site_code);
            if (isAmbiguousSystemIntegration && candidateIsPlainKiosk) {
              console.log(`[mailgun-inbound] Address matched ${candidate.site_code} but category is ambiguous System/State-Integration against a plain kiosk code -- leaving unmatched for manual review (WO ${parsed.woNum})`);
            } else {
              siteId = candidate.id;
              matchedByAddress = candidate;
              console.log(`[mailgun-inbound] Address-matched WO ${parsed.woNum} to existing site ${candidate.site_code} (no embedded code in ticket text)`);
            }
          }
        }

        // Add-Line-Item follow-up: check for an existing ticket on this WO
        // first. If found, append the new line item to its description
        // (visible on the board) rather than letting the normal
        // ignoreDuplicates upsert below silently swallow it. If no existing
        // ticket is found (the follow-up somehow arrived before/without the
        // original), fall through to the normal insert path so the
        // information isn't lost either way.
        //
        // 2026-08-05: considered auto-escalating the ORIGINAL ticket to
        // trouble/4hr-SLA whenever it's currently 'maintenance' -- Mark
        // confirmed a real case where this SHOULD happen (a kiosk running
        // out of forms before its scheduled restock) but also found a real
        // counterexample proving auto-escalation is unsafe: a line item
        // requesting new signage/marketing graphics while a tech is
        // already on-site for a restock, which is explicitly NOT
        // service-affecting and should NOT get a 4hr SLA. Both cases use
        // the same structured fields (Line Item Issue Category/Detail)
        // with no reliable way to distinguish them -- category values like
        // "Hardware" or free text like "fault"/"offline" can appear in
        // either a genuine emergency or a routine while-you're-there task,
        // and Neumo's own Priority field is not trustworthy either (Mark
        // has seen it left Low even for actually-offline machines). Rather
        // than risk auto-escalating a benign line item (or worse, failing
        // to escalate a real one), this now just FLAGS the ticket for a
        // dispatcher to make the actual call -- surfacing what the SLA
        // would be if this were genuinely urgent, without asserting it.
        let appendedToExisting = false;
        // 2026-08-26: tracks the EXISTING ticket's own state, for the SMS
        // state filter further down. Found live (WO 00150671, Plainfield IN
        // -- Mark got an unwanted text despite only covering GA/FL): an
        // "Add Line Item to Work Order #NNNN" email never repeats the
        // account name/site code/address anywhere in its body -- it's
        // purely a follow-up about the new line item, so detectStates()
        // and the normal siteCode-based state detection both correctly
        // find nothing in THIS email, even though the ticket being
        // appended to already has a known site. That correctly triggers
        // the documented "can't determine state, fail open" behavior --
        // except failing open here means every enabled recipient gets
        // texted for every appended-line-item ticket regardless of state,
        // which defeats the point of per-recipient state coverage for this
        // entire ticket category. Fixed by looking up the real state from
        // the ticket's own already-matched site instead of trying to
        // detect it fresh from an email that was never going to contain it.
        // (appendedTicketState itself is declared above, outside this
        // block -- see the 2026-08-29 comment there.)
        if (parsed.isLineItemAddition) {
          const { data: existingTicket, error: existingErr } = await supabase
            .from('tickets').select('id, description, ticket_kind, site_id, sites(state)').eq('wo_number', parsed.woNum).maybeSingle();
          if (existingErr) {
            console.error('[mailgun-inbound] existing-ticket lookup for line item addition failed:', existingErr.message);
          } else if (existingTicket) {
            appendedTicketState = existingTicket.sites?.state || null;
            const stamp = receivedAt.toISOString().slice(0, 10);
            const addedText = parsed.description || parsed.issue || 'See email for details';
            let noteLine = `[Line item added ${stamp}] ${addedText}`;
            if (existingTicket.ticket_kind === 'maintenance') {
              const slaStr = formatSlaDeadline(new Date(parsed.slaEnd), getTimezoneForSiteCode(rawSiteCode));
              noteLine = `⚠️ REVIEW NEEDED -- possible SLA impact (would be ${slaStr} if urgent): ${noteLine}`;
            }
            const newDescription = (existingTicket.description ? existingTicket.description + '\n\n' : '') + noteLine;

            const updateFields = { description: newDescription };
            if (existingTicket.ticket_kind === 'maintenance') {
              updateFields.needs_review = true;
              console.log(`[mailgun-inbound] Flagged ticket ${parsed.woNum} for dispatcher review (line item added to existing restock, possible SLA impact)`);
            }

            const { error: updateErr } = await supabase
              .from('tickets').update(updateFields).eq('id', existingTicket.id);
            if (updateErr) console.error('[mailgun-inbound] append line item failed:', updateErr.message);
            else {
              console.log(`[mailgun-inbound] Line item appended to existing ticket ${parsed.woNum} (site state: ${appendedTicketState || 'still unknown -- original ticket has no site match either'})`);
              appendedToExisting = true;
            }
          }
        }


        if (!appendedToExisting) {

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
          address: parsed.address || null,
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

        // Address-based sibling sweep -- mirrors link-ticket-to-site.js's
        // existing rawSiteCode-based sweep, but for the address-match case:
        // a building with a testing station AND an OTC printer (or several
        // testing PCs) sharing one address can have multiple still-open
        // tickets land close together, only one of which happens to be the
        // one that got matched just now. Sweeps them onto the same site
        // rather than leaving each to trigger its own separate toast.
        if (matchedByAddress) {
          try {
            const { data: siblings } = await supabase
              .from('tickets')
              .select('id, address, wo_number, ticket_kind, due_at, issue_category, issue_detail, description, received_at')
              .is('site_id', null)
              .neq('wo_number', parsed.woNum)
              .eq('status', 'open');
            const matchedSiblings = (siblings || [])
              .filter((s) => addressesLooselyMatch(s.address, matchedByAddress.address));
            const siblingIds = matchedSiblings.map((s) => s.id);
            if (siblingIds.length) {
              const { error: sweepErr } = await supabase
                .from('tickets').update({ site_id: matchedByAddress.id }).in('id', siblingIds);
              if (!sweepErr) {
                console.log(`[mailgun-inbound] Address-sweep linked ${siblingIds.length} sibling ticket(s) to ${matchedByAddress.site_code}`);
                // 2026-09-02: previously the sweep stopped at linking
                // site_id -- a swept sibling then showed correctly on the
                // state console/watchdog (both read live site_id) but
                // never got a board push, since the auto-add step only
                // ever ran once, at that sibling's OWN original ingestion
                // time, when it had no site match yet. Real cases: GA1044
                // (WO 00151328), GA1084 (WO 00151329). Now runs the same
                // auto-add function per swept sibling right here.
                for (const sib of matchedSiblings) {
                  if (!['trouble', 'maintenance'].includes(sib.ticket_kind || 'trouble')) continue;
                  try {
                    await autoAddTicketToBoard({
                      supabase,
                      siteId: matchedByAddress.id,
                      ticketKind: sib.ticket_kind,
                      dueDateRaw: sib.due_at,
                      rawSiteCode: null, // swept siblings never had an embedded site code -- that's why they needed the address sweep in the first place
                      woNum: sib.wo_number,
                      newTicketId: sib.id,
                      receivedAtIso: sib.received_at,
                      issueCategory: sib.issue_category,
                      issueDetail: sib.issue_detail,
                      description: sib.description,
                    });
                  } catch (sibBoardEx) {
                    console.error(`[mailgun-inbound] Auto-add-to-board for swept sibling ${sib.wo_number} failed (non-fatal):`, sibBoardEx.message);
                  }
                }
              }
            }
          } catch (e) {
            console.error('[mailgun-inbound] Address-based sibling sweep failed:', e.message);
          }
        }

        // Auto-add to the dispatch board -- trouble AND maintenance tickets
        // (not install/site-survey). Logic lives in autoAddTicketToBoard()
        // (2026-09-02 extraction) so the address-sweep sibling path further
        // up can call the exact same code once a swept sibling's site_id
        // is corrected, instead of that ticket silently never getting a
        // board push at all.
        if (['trouble', 'maintenance'].includes(parsed.ticketKind || 'trouble') && siteId) {
          const { data: ticketRowFetched } = await supabase
            .from('tickets').select('id').eq('wo_number', parsed.woNum).maybeSingle();
          await autoAddTicketToBoard({
            supabase,
            siteId,
            ticketKind: parsed.ticketKind,
            dueDateRaw: parsed.dueDateRaw,
            rawSiteCode,
            woNum: parsed.woNum,
            newTicketId: ticketRowFetched ? ticketRowFetched.id : null,
            receivedAtIso: receivedAt.toISOString(),
            issueCategory: parsed.issueCategory,
            issueDetail: parsed.issueDetail,
            description: parsed.description,
          });
        }
        } // end if (!appendedToExisting)
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

          // 2026-08-27: fall back to the same account-name text matching
          // used for the Salesforce closed-ticket import when the
          // WO-number/ticket path above didn't resolve a site -- confirmed
          // live that path alone was only ever hitting ~2% of real RMA
          // shipments (130 of 132 sat with site_id permanently null),
          // leaving no way to tell which site a part is for once it's
          // physically arrived days later, per Mark. account_name is in
          // the identical "STATE - City/County SiteName" format already
          // handled there, so this reuses the same tokenize/site_aliases
          // approach (same style/threshold as the TechWeb site-match a
          // little further up in this same file) rather than inventing a
          // new one.
          if (!siteId && state && parsed.accountName) {
            const { data: candidateSites } = await supabase
              .from('sites').select('id, name').eq('state', state);
            if (candidateSites && candidateSites.length) {
              const { data: aliasRows } = await supabase.from('site_aliases').select('alias, site_id');
              const aliasMap = {};
              for (const a of aliasRows || []) aliasMap[a.alias] = a.site_id;
              const aliasHit = aliasMap[String(parsed.accountName).trim()];
              if (aliasHit) {
                siteId = aliasHit;
              } else {
                const RMA_TOKEN_ALIASES = { co: 'county', cnty: 'county', ave: 'avenue', blvd: 'boulevard', dr: 'drive', rd: 'road', st: 'street', mt: 'mount', hwy: 'highway', pkwy: 'parkway' };
                const rmaTokenize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((t) => RMA_TOKEN_ALIASES[t] || t);
                const nameOnlyM = String(parsed.accountName).trim().match(/^([A-Za-z]{2})\s*-\s*(.+)$/);
                const nameOnly = nameOnlyM ? nameOnlyM[2] : String(parsed.accountName).trim();
                const targetTokens = rmaTokenize(nameOnly);
                let best = null, bestScore = 0;
                for (const site of candidateSites) {
                  const siteTokens = rmaTokenize(site.name);
                  const setA = new Set(targetTokens), setB = new Set(siteTokens);
                  const intersection = [...setA].filter((t) => setB.has(t)).length;
                  const smaller = Math.min(setA.size, setB.size);
                  const score = smaller > 0 ? intersection / smaller : 0;
                  if (score > bestScore) { bestScore = score; best = site; }
                }
                if (best && bestScore >= 0.65) siteId = best.id;
              }
            }
          }

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
          else console.log(`[mailgun-inbound] rma_shipments: case ${parsed.caseNumber} saved (tech: ${parsed.techName || 'n/a'}, ticket matched: ${!!ticketId}, site matched: ${!!siteId})`);
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
      // 2026-08-26: appendedTicketState (looked up from the DB for
      // isLineItemAddition tickets, see above) now takes priority over all
      // of this -- an "Add Line Item to Work Order" email never contains a
      // site code, state, or address anywhere in its own body, so every
      // path below always came up empty for this ticket category and hit
      // the same fail-open behavior every single time, not just
      // occasionally. Live-confirmed via WO 00150671 (Plainfield IN):
      // texted a GA/FL-only recipient because "States:" logged completely
      // blank despite the ticket's underlying site being correctly known.
      const ticketState = appendedTicketState || ((parsed.siteCode && parsed.siteCode.length >= 2)
        ? parsed.siteCode.substring(0, 2)
        : (parsed.state || (states.length > 0 ? states[0] : null)));

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
