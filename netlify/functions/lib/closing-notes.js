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

async function getSaNumbersNeedingNotes(supabase, daysBack, limit, priorityState) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const baseQuery = () => supabase
    .from('site_visits')
    .select('appointment_number')
    .is('closing_note', null)
    .not('appointment_number', 'is', null)
    .gte('started_at', cutoff)
    .order('started_at', { ascending: false });

  if (!priorityState) {
    const { data, error } = await baseQuery().limit(limit);
    if (error) throw new Error('Query for SA numbers needing notes failed: ' + error.message);
    return (data || []).map((r) => r.appointment_number);
  }

  // A manual Refresh Now triggered from a specific state's panel: that
  // state's own backlog goes first, then remaining capacity (if any) fills
  // in with everything else -- so the normal multi-state catch-up still
  // happens too, just after the state someone specifically asked about.
  const { data: priorityData, error: priorityErr } = await baseQuery().eq('state', priorityState).limit(limit);
  if (priorityErr) throw new Error('Priority-state query for SA numbers needing notes failed: ' + priorityErr.message);
  const priorityNumbers = (priorityData || []).map((r) => r.appointment_number);

  const remaining = limit - priorityNumbers.length;
  if (remaining <= 0) return priorityNumbers;

  const { data: restData, error: restErr } = await baseQuery().neq('state', priorityState).limit(remaining);
  if (restErr) throw new Error('Fallback query for SA numbers needing notes failed: ' + restErr.message);
  const restNumbers = (restData || []).map((r) => r.appointment_number);

  return priorityNumbers.concat(restNumbers);
}

async function writeNoteBack(supabase, appointmentNumber, note) {
  const { error } = await supabase
    .from('site_visits')
    .update({ closing_note: note, closing_note_captured_at: new Date().toISOString() })
    .eq('appointment_number', appointmentNumber);
  if (error) throw new Error(`Writing note back for ${appointmentNumber} failed: ` + error.message);
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
 * @returns {Promise<{attempted:number, succeeded:number, notFound:number, failed:number, stoppedByDeadline:boolean, errors:Array}>}
 */
async function runClosingNotesPass(page, supabase, options = {}) {
  const daysBack = options.daysBack ?? 7;
  const limit = options.limit ?? 100;
  const deadlineAt = options.deadlineAt ?? (Date.now() + 10 * 60 * 1000);
  const priorityState = options.priorityState || null;
  const summary = { attempted: 0, succeeded: 0, notFound: 0, failed: 0, stoppedByDeadline: false, errors: [] };

  try {
    const targets = await getSaNumbersNeedingNotes(supabase, daysBack, limit, priorityState);
    if (!targets.length) return summary;

    console.log(`[closing-notes] ${targets.length} candidate record(s) found, ${Math.round((deadlineAt - Date.now()) / 1000)}s time budget.`);

    await page.goto(LIST_VIEW_URL, { waitUntil: 'domcontentloaded' }).catch((err) => {
      console.log('[closing-notes] Navigation to list view threw (often benign):', err.message);
    });
    await page.waitForTimeout(3000);

    let ctx = await getListViewContext(page);

    for (const saNumber of targets) {
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
          console.log(`[closing-notes] ${saNumber}: not found in list view.`);
          summary.notFound++;
        } else {
          const note = await extractAppointmentNote(page);
          await writeNoteBack(supabase, saNumber, note);
          console.log(`[closing-notes] ${saNumber}: captured (${note.length} chars).`);
          summary.succeeded++;
        }
      } catch (err) {
        console.log(`[closing-notes] ${saNumber}: FAILED -- ${err.message}`);
        summary.failed++;
        summary.errors.push({ saNumber, error: err.message });
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

module.exports = { runClosingNotesPass };
