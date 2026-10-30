// lib/closing-notes.js
//
// Self-contained closing-note extraction pass, meant to be called from
// salesforce-report-sync-background.mjs AFTER performImport() has run
// (so newly-imported rows are already in site_visits) but BEFORE the
// browser closes (so it can reuse the same login session -- no extra
// Salesforce login added on top of the existing cycle).
//
// Wrapped in try/catch by the CALLER (per the agreed plan) so a failure
// here can never affect the already-succeeded report import. This module
// itself also never throws past its own boundary -- runClosingNotesPass
// catches everything internally and returns a summary object either way.
//
// Reuses the exact same list-view search -> click -> extract logic
// proven in closing-notes-sync.mjs (2026-09-11), just adapted to take an
// already-authenticated `page` instead of doing its own login.

const LIST_VIEW_URL = 'https://iti4dmv.my.site.com/dispatchconsole/s/recordlist/ServiceAppointment/00BVN000003AbUV2A0?ServiceAppointment-filterId=Completed';

// 2026-09-11: attempt tracking added. Previously every cycle just queried
// `closing_note IS NULL`, which can't distinguish "never tried" from
// "tried and failed 5 times already" -- a persistently not-found or
// erroring record would come back to the FRONT of every single query
// (newest-first) and could eat a large share of each cycle's time budget
// indefinitely, starving records that would actually succeed. Mark caught
// this live (28 "not found" out of 40 attempted in one real run) before
// starting several NC-scoped test runs, which would have made that
// backlog-clearing test misleading. Fix: query now also reads each
// candidate's current closing_note_attempts and sorts by that ASCENDING
// first (never-tried records go first), THEN by recency -- so repeatedly-
// failing records get deprioritized rather than permanently excluded
// (their sort-window/search-index situation may change later, so still
// worth retrying eventually, just not every single cycle).
//
// 2026-09-11 (later): now also excludes closing_note_is_blank=true rows
// entirely. Those are a different case from "failed/not found" -- the
// scraper DID reach the record and DID confirm the Appointment Note field
// renders empty, so there's nothing left to retry for. Recorded found some
// of these are >18 attempts deep with zero chance of ever changing, wasting
// real time budget re-checking a page we already know is blank. If a
// technician's note is ever amended after the fact, this can be manually
// cleared for that one record -- not expected to happen often enough to
// need automatic re-checking.
async function getSaNumbersNeedingNotes(supabase, daysBack, limit, priorityState, maxAttempts) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const baseQuery = () => {
    let q = supabase
      .from('site_visits')
      .select('appointment_number, closing_note_attempts, state, site_id')
      .is('closing_note', null)
      .eq('closing_note_is_blank', false)
      .not('appointment_number', 'is', null)
      .gte('started_at', cutoff)
      .order('closing_note_attempts', { ascending: true })
      .order('started_at', { ascending: false });
    if (maxAttempts != null) {
      q = q.or(`closing_note_attempts.is.null,closing_note_attempts.lt.${maxAttempts}`);
    }
    return q;
  };

  const toTargets = (rows) => (rows || []).map((r) => ({
    appointmentNumber: r.appointment_number,
    attempts: r.closing_note_attempts || 0,
    state: r.state || null,
    siteId: r.site_id || null,
  }));

  if (!priorityState) {
    const { data, error } = await baseQuery().limit(limit);
    if (error) throw new Error('Query for SA numbers needing notes failed: ' + error.message);
    return toTargets(data);
  }

  // A manual Refresh Now triggered from a specific state's panel: that
  // state's own backlog goes first, then remaining capacity (if any) fills
  // in with everything else -- so the normal multi-state catch-up still
  // happens too, just after the state someone specifically asked about.
  const { data: priorityData, error: priorityErr } = await baseQuery().eq('state', priorityState).limit(limit);
  if (priorityErr) throw new Error('Priority-state query for SA numbers needing notes failed: ' + priorityErr.message);
  const priorityTargets = toTargets(priorityData);

  const remaining = limit - priorityTargets.length;
  if (remaining <= 0) return priorityTargets;

  const { data: restData, error: restErr } = await baseQuery().neq('state', priorityState).limit(remaining);
  if (restErr) throw new Error('Fallback query for SA numbers needing notes failed: ' + restErr.message);

  return priorityTargets.concat(toTargets(restData));
}

// Records that a record was attempted this cycle, regardless of outcome --
// increments closing_note_attempts and stamps closing_note_last_attempted_at
// always; additionally writes the note itself (and closing_note_captured_at)
// when one was actually found. currentAttempts comes from the SAME query
// that built the target list (no extra read needed) -- fine given this
// pipeline never runs more than one instance at a time (the existing
// in-progress-flag concurrency guard in salesforce-report-sync-background.mjs
// already prevents overlapping cloud runs; a manual local script run
// alongside a cloud run is a real but low/accepted risk of a stale
// increment, not data corruption -- worst case a record's attempts count
// undercounts by one).
// dryRun (added 2026-09-11): when true, logs what WOULD have been written
// but skips the actual Supabase update entirely -- lets closing-notes-
// sync.mjs's --dry-run flag keep working now that it shares this function
// instead of having its own separate write logic.
async function recordAttempt(supabase, appointmentNumber, currentAttempts, note, dryRun, isBlank = false) {
  const update = {
    closing_note_attempts: currentAttempts + 1,
    closing_note_last_attempted_at: new Date().toISOString(),
  };
  if (note) {
    update.closing_note = note;
    update.closing_note_captured_at = new Date().toISOString();
  }
  if (isBlank) {
    update.closing_note_is_blank = true;
  }
  if (dryRun) {
    console.log(`[closing-notes] (dry run -- not written) ${appointmentNumber}:`, JSON.stringify(update));
    return;
  }
  const { error } = await supabase
    .from('site_visits')
    .update(update)
    .eq('appointment_number', appointmentNumber);
  if (error) throw new Error(`Recording attempt for ${appointmentNumber} failed: ` + error.message);
}

async function getListViewContext(page) {
  const hasSearchBox = await page.getByPlaceholder(/search this list/i).first().isVisible().catch(() => false);
  if (hasSearchBox) return page;
  for (const frame of page.frames()) {
    const found = await frame.getByPlaceholder(/search this list/i).first().isVisible().catch(() => false);
    if (found) return frame;
  }
  return page; // fall back -- caller's try/catch handles a failure to find anything
}

async function findAndOpenBySaNumber(ctx, page, saNumber) {
  const searchBox = ctx.getByPlaceholder(/search this list/i).first();
  await searchBox.fill(saNumber);
  await searchBox.press('Enter');
  await page.waitForTimeout(2500);

  const bodyText = await ctx.locator('body').innerText().catch(() => '');
  if (!bodyText.includes(saNumber)) return false;

  const resultLink = ctx.locator(`a:has-text("${saNumber}")`).first();
  const clickable = await resultLink.isVisible().catch(() => false);
  if (!clickable) return false;

  await resultLink.click();
  await page.waitForTimeout(2000);
  return true;
}

async function extractAppointmentNote(page) {
  await page.waitForSelector('text=Appointment Note', { timeout: 15000 });
  const label = page.locator('span.test-id__field-label', { hasText: /^Appointment Note$/ }).first();
  await label.waitFor({ timeout: 10000 });
  const fieldContainer = label.locator('xpath=ancestor::*[.//lightning-formatted-text][1]');
  const note = await fieldContainer.locator('lightning-formatted-text').first().innerText({ timeout: 5000 });
  return note.trim();
}

// ---------------------------------------------------------------------------
// Card Reader Asset Tag (2026-10-29)
//
// The tag the technician reads off the sticker on the reader at each visit lives in the
// "Card Reader Asset Tag" field of the Appointment Notes section (right-hand column; the
// "Card Reader Serial Number" field next to it is usually empty). Stored on the visit and used
// to link unlinked reader_lookup entries to their site. Georgia only for now; add a state to
// TAG_STATES to turn it on elsewhere.
//
// Reference data only: nothing here alerts anyone or shows on a technician/dispatcher page.
// Every function below catches its own errors, so a problem reading the tag can never stop the
// closing-note capture it rides along with.
// ---------------------------------------------------------------------------
const TAG_STATES = ['GA'];

function normalizeTag(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 6) return null;
  return digits.padStart(6, '0');
}

// Returns the raw text of the field (may be ''), or THROWS if the label is not on the page
// (layout differs / page not ready) so callers can tell "blank" from "could not find the field".
async function extractReaderTag(page) {
  const label = page.locator('span.test-id__field-label', { hasText: /^Card Reader Asset Tag$/ }).first();
  await label.waitFor({ timeout: 8000 });
  const item = label.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " slds-form-element ")][1]');
  let text = '';
  const val = item.locator('.test-id__field-value').first();
  if (await val.count().catch(() => 0)) text = await val.innerText({ timeout: 3000 }).catch(() => '');
  if (!text) {
    text = await item.innerText({ timeout: 3000 }).catch(() => '');
    text = text.replace(/Card Reader Asset Tag/i, '');
  }
  return text.replace(/\s+/g, ' ').trim();
}

async function saveReaderTag(supabase, appointmentNumber, tag, dryRun) {
  const update = { card_reader_tag: tag || null, card_reader_tag_checked_at: new Date().toISOString() };
  if (dryRun) { console.log(`[reader-tag] (dry run -- not written) ${appointmentNumber}:`, JSON.stringify(update)); return; }
  const { error } = await supabase.from('site_visits').update(update).eq('appointment_number', appointmentNumber);
  if (error) throw new Error(`Saving reader tag for ${appointmentNumber} failed: ` + error.message);
}

// Links a reader_lookup entry that has no site yet to this visit's site. Only ever fills an empty
// site_code: never overwrites an existing link, never touches a number that more than one entry
// shares (those are decided by hand), and only logs when the entry is linked to a different site.
async function linkReaderToSite(supabase, siteId, tag, dryRun) {
  try {
    if (!tag || !siteId) return 'skipped';
    const { data: rows, error } = await supabase.from('reader_lookup').select('id, name, num, site_code').eq('num', tag);
    if (error) { console.log('[reader-tag] reader_lookup read failed:', error.message); return 'error'; }
    if (!rows || !rows.length) { console.log(`[reader-tag] tag ${tag}: no reader entry with that number yet.`); return 'no-entry'; }
    const { data: site } = await supabase.from('sites').select('site_code').eq('id', siteId).maybeSingle();
    if (!site || !site.site_code) return 'skipped';
    const elsewhere = rows.filter((r) => r.site_code && r.site_code !== site.site_code);
    if (elsewhere.length) console.log(`[reader-tag] tag ${tag} was read at ${site.site_code} but reader entry "${elsewhere[0].name}" is linked to ${elsewhere[0].site_code}. Left as is.`);
    if (rows.length > 1) { if (rows.some((r) => !r.site_code)) console.log(`[reader-tag] tag ${tag} is shared by ${rows.length} reader entries -- not auto-linked.`); return 'shared'; }
    if (rows[0].site_code) return rows[0].site_code === site.site_code ? 'already-linked' : 'mismatch';
    if (dryRun) { console.log(`[reader-tag] (dry run) would link "${rows[0].name}" (${tag}) to ${site.site_code}.`); return 'would-link'; }
    const { error: upErr } = await supabase.from('reader_lookup').update({ site_code: site.site_code }).eq('id', rows[0].id).is('site_code', null);
    if (upErr) { console.log('[reader-tag] link update failed:', upErr.message); return 'error'; }
    console.log(`[reader-tag] linked "${rows[0].name}" (${tag}) to ${site.site_code}.`);
    return 'linked';
  } catch (e) { console.log('[reader-tag] link step failed:', e.message); return 'error'; }
}

// Rides along with a closing-note read: the record page is already open, so reading the tag costs
// nothing extra. Never throws.
async function captureReaderTagOnPage(page, supabase, target, dryRun) {
  try {
    if (!TAG_STATES.includes(target.state)) return;
    const raw = await extractReaderTag(page);
    const tag = normalizeTag(raw);
    await saveReaderTag(supabase, target.appointmentNumber, tag, dryRun);
    if (tag) {
      console.log(`[reader-tag] ${target.appointmentNumber}: tag ${tag}${dryRun ? ' [dry run]' : ''}.`);
      await linkReaderToSite(supabase, target.siteId, tag, dryRun);
    } else {
      console.log(`[reader-tag] ${target.appointmentNumber}: Card Reader Asset Tag is blank.`);
    }
  } catch (e) {
    console.log(`[reader-tag] ${target.appointmentNumber}: could not read the tag field (${e.message.split('\n')[0]}).`);
  }
}

/**
 * Backfill: for each Georgia site with no tag on file, opens that site's most recent visit and
 * reads the tag. A site is skipped for good once it has one; a visit whose tag is blank counts
 * toward a limit of 3 tries per site. Meant for the night window only; small per-run cap.
 * Stops early if the field cannot be found on the page 3 times in a row (layout differs), without
 * marking those visits as checked, so nothing is burned on a bad selector.
 * @returns {Promise<{attempted:number, found:number, blank:number, notFound:number, linked:number, layoutMisses:number, failed:number, stoppedByDeadline:boolean}>}
 */
async function runReaderTagPass(page, supabase, options = {}) {
  const limit = options.limit ?? 12;
  const deadlineAt = options.deadlineAt ?? (Date.now() + 5 * 60 * 1000);
  const dryRun = options.dryRun || false;
  const summary = { attempted: 0, found: 0, blank: 0, notFound: 0, linked: 0, layoutMisses: 0, failed: 0, stoppedByDeadline: false };
  try {
    const { data: targets, error } = await supabase.rpc('reader_tag_backfill_targets', { p_states: TAG_STATES, p_limit: limit, p_days: options.daysBack ?? 120 });
    if (error) throw new Error('Reader tag target query failed: ' + error.message);
    if (!targets || !targets.length) { console.log('[reader-tag] Nothing left to backfill.'); return summary; }
    console.log(`[reader-tag] ${targets.length} site(s) to check.`);

    await page.goto(LIST_VIEW_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    let ctx = await getListViewContext(page);
    let consecutiveMisses = 0;

    for (const t of targets) {
      if (Date.now() >= deadlineAt) { summary.stoppedByDeadline = true; break; }
      summary.attempted++;
      try {
        const saNumber = t.appointment_number;
        const found = await findAndOpenBySaNumber(ctx, page, saNumber);
        if (!found) {
          summary.notFound++;
          await saveReaderTag(supabase, saNumber, null, dryRun);   // counts as a blank try so the site moves on
        } else {
          await page.waitForSelector('text=Appointment Note', { timeout: 15000 });
          let raw;
          try { raw = await extractReaderTag(page); }
          catch (e) {
            summary.layoutMisses++; consecutiveMisses++;
            console.log(`[reader-tag] ${saNumber}: tag field not found on the page (${consecutiveMisses} in a row).`);
            if (consecutiveMisses >= 3) { console.log('[reader-tag] Stopping: field not found 3 times in a row.'); break; }
            raw = null;
          }
          if (raw !== null) {
            consecutiveMisses = 0;
            const tag = normalizeTag(raw);
            await saveReaderTag(supabase, saNumber, tag, dryRun);
            if (tag) {
              summary.found++;
              console.log(`[reader-tag] ${saNumber}: tag ${tag}${dryRun ? ' [dry run]' : ''}.`);
              const r = await linkReaderToSite(supabase, t.site_id, tag, dryRun);
              if (r === 'linked') summary.linked++;
            } else { summary.blank++; }
          }
        }
      } catch (err) {
        summary.failed++;
        console.log(`[reader-tag] ${t.appointment_number}: FAILED -- ${err.message}`);
      }
      await page.goto(LIST_VIEW_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2000);
      ctx = await getListViewContext(page);
    }
  } catch (err) {
    console.log('[reader-tag] Pass failed:', err.message);
    summary.failed++;
  }
  return summary;
}

/**
 * @param {import('playwright-core').Page} page - already authenticated,
 *   currently on/near the report page.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} options
 * @param {number} [options.daysBack=7] - only look at recent visits, since
 *   the 20-min cycle's job is staying current, not backfilling.
 * @param {number} [options.limit=100] - how many candidate rows to query
 *   for -- deliberately generous now that TIME (deadlineAt), not record
 *   count, is the real safety mechanism (see deadlineAt below). This just
 *   needs to be large enough that there's always a full backlog available
 *   to fill whatever time budget remains, whether that's 2 minutes or 12.
 * @param {number} [options.deadlineAt] - absolute Date.now()-style
 *   timestamp (ms) after which the loop stops starting new records, no
 *   matter how many are left. REQUIRED in practice -- the caller computes
 *   this from its own real elapsed time so far, since Netlify Background
 *   Functions have a hard 15-minute execution ceiling and a fixed record
 *   count can't safely account for how much of that the report-download
 *   step already used (which varies run to run, sometimes needing several
 *   reload attempts). Defaults to 10 minutes from now if not passed, as a
 *   fallback -- but the caller should always pass a real deadline based on
 *   its own actual start time.
 * @param {string} [options.priorityState] - 2-letter state code (e.g. "GA").
 *   When set, that state's own backlog is queried and processed first,
 *   ahead of everything else, before falling back to normal multi-state
 *   catch-up for any remaining capacity. Used when a manual Refresh Now is
 *   triggered from a specific state's panel.
 * @param {boolean} [options.dryRun=false] - when true, extracts and logs
 *   but never writes to Supabase (neither the note nor the attempt count).
 * @returns {Promise<{attempted:number, succeeded:number, blank:number, notFound:number, failed:number, stoppedByDeadline:boolean, errors:Array}>}
 */
async function runClosingNotesPass(page, supabase, options = {}) {
  const daysBack = options.daysBack ?? 7;
  const limit = options.limit ?? 100;
  const deadlineAt = options.deadlineAt ?? (Date.now() + 10 * 60 * 1000);
  const priorityState = options.priorityState || null;
  const dryRun = options.dryRun || false;
  const summary = { attempted: 0, succeeded: 0, blank: 0, notFound: 0, failed: 0, stoppedByDeadline: false, errors: [] };

  try {
    const maxAttempts = options.maxAttempts ?? null;
    const targets = await getSaNumbersNeedingNotes(supabase, daysBack, limit, priorityState, maxAttempts);
    if (!targets.length) return summary;

    console.log(`[closing-notes] ${targets.length} candidate record(s) found, ${Math.round((deadlineAt - Date.now()) / 1000)}s time budget.`);

    await page.goto(LIST_VIEW_URL, { waitUntil: 'domcontentloaded' }).catch((err) => {
      console.log('[closing-notes] Navigation to list view threw (often benign):', err.message);
    });
    await page.waitForTimeout(3000);

    let ctx = await getListViewContext(page);

    for (const target of targets) {
      const { appointmentNumber: saNumber, attempts } = target;
      // Check the deadline BEFORE starting each record, not just once at
      // the top -- a record that's already in flight is allowed to finish
      // (it's already this far, and stopping mid-extraction wouldn't save
      // meaningful time), but no NEW record starts once the deadline has
      // passed. This is the real safety mechanism, not the query limit.
      if (Date.now() >= deadlineAt) {
        console.log(`[closing-notes] Stopping early -- time budget exhausted (${summary.attempted}/${targets.length} attempted).`);
        summary.stoppedByDeadline = true;
        break;
      }

      summary.attempted++;
      try {
        const found = await findAndOpenBySaNumber(ctx, page, saNumber);
        if (!found) {
          console.log(`[closing-notes] ${saNumber}: not found in list view (attempt ${attempts + 1}).`);
          summary.notFound++;
          await recordAttempt(supabase, saNumber, attempts, null, dryRun);
        } else {
          const note = await extractAppointmentNote(page);
          await captureReaderTagOnPage(page, supabase, target, dryRun);   // 2026-10-29: Georgia only; never throws
          if (!note || !note.trim()) {
            // 2026-09-11: distinguished from "not found" -- this means we
            // DID reach the record and the Appointment Note section DID
            // render, but the tech simply never typed anything in it.
            // Mark asked specifically whether some of the "not found"
            // count might actually be this case; previously there was no
            // way to tell the two apart at all. Recorded as an attempt
            // (so it gets deprioritized like anything else unsuccessful)
            // but closing_note stays null -- there's genuinely nothing to
            // store. Now also marked closing_note_is_blank=true, so
            // getSaNumbersNeedingNotes excludes it going forward entirely
            // rather than just deprioritizing it -- no reason to keep
            // re-checking a page we've confirmed is empty. (If a
            // technician's record is ever amended after the fact, this
            // flag can be cleared manually for that one record.)
            console.log(`[closing-notes] ${saNumber}: record found, but Appointment Note is blank (attempt ${attempts + 1}) -- marking as confirmed blank, won't retry.`);
            summary.blank++;
            await recordAttempt(supabase, saNumber, attempts, null, dryRun, true);
          } else {
            await recordAttempt(supabase, saNumber, attempts, note, dryRun);
            console.log(`[closing-notes] ${saNumber}: captured (${note.length} chars)${dryRun ? ' [dry run]' : ''}.`);
            summary.succeeded++;
          }
        }
      } catch (err) {
        console.log(`[closing-notes] ${saNumber}: FAILED -- ${err.message}`);
        summary.failed++;
        summary.errors.push({ saNumber, error: err.message });
        // Still record the attempt even on failure -- otherwise a
        // persistently-erroring record would also stay stuck at the front
        // of every future query (same problem attempt-tracking is meant to
        // solve, just triggered by an error instead of a clean not-found).
        await recordAttempt(supabase, saNumber, attempts, null, dryRun).catch((attemptErr) => {
          console.log(`[closing-notes] ${saNumber}: also failed to record the attempt itself -- ${attemptErr.message}`);
        });
      }

      // Back to the list view for the next SA number.
      await page.goto(LIST_VIEW_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2000);
      ctx = await getListViewContext(page);
    }
  } catch (err) {
    console.log('[closing-notes] Pass failed before processing any records:', err.message);
    summary.errors.push({ saNumber: null, error: err.message });
  }

  return summary;
}

module.exports = { runClosingNotesPass, runReaderTagPass };
