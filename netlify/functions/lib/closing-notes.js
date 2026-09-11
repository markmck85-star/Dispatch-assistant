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

async function getSaNumbersNeedingNotes(supabase, daysBack, limit) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('site_visits')
    .select('appointment_number')
    .is('closing_note', null)
    .not('appointment_number', 'is', null)
    .gte('started_at', cutoff)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error('Query for SA numbers needing notes failed: ' + error.message);
  return (data || []).map((r) => r.appointment_number);
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
 * @param {number} [options.daysBack=3] - only look at recent visits, since
 *   the 20-min cycle's job is staying current, not backfilling. Kept small
 *   deliberately -- each run should mostly be catching up on the handful
 *   of tickets closed since the last cycle, not re-scanning weeks of data
 *   every 20 minutes.
 * @param {number} [options.limit=15] - cap per run, so one slow/stuck
 *   extraction pass can't meaningfully delay the next report-sync cycle.
 * @returns {Promise<{attempted:number, succeeded:number, notFound:number, failed:number, errors:Array}>}
 */
async function runClosingNotesPass(page, supabase, options = {}) {
  const daysBack = options.daysBack ?? 3;
  const limit = options.limit ?? 15;
  const summary = { attempted: 0, succeeded: 0, notFound: 0, failed: 0, errors: [] };

  try {
    const targets = await getSaNumbersNeedingNotes(supabase, daysBack, limit);
    summary.attempted = targets.length;
    if (!targets.length) return summary;

    console.log(`[closing-notes] ${targets.length} record(s) to process this cycle.`);

    await page.goto(LIST_VIEW_URL, { waitUntil: 'domcontentloaded' }).catch((err) => {
      console.log('[closing-notes] Navigation to list view threw (often benign):', err.message);
    });
    await page.waitForTimeout(3000);

    let ctx = await getListViewContext(page);

    for (const saNumber of targets) {
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
    // Outer catch: something failed before even getting into the per-record
    // loop (e.g. the query itself, or the initial navigation). Still return
    // a summary rather than throwing, per this module's contract.
    console.log('[closing-notes] Pass failed before processing any records:', err.message);
    summary.errors.push({ saNumber: null, error: err.message });
  }

  return summary;
}

module.exports = { runClosingNotesPass };
