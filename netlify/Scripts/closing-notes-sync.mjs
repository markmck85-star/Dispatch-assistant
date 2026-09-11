// closing-notes-sync.mjs
//
// Standalone/manual runner for the closing-notes extraction pass -- for
// testing, ad-hoc backfill runs, or debugging outside the normal 20-min
// cycle. Handles its own login/browser lifecycle, then delegates the
// actual query/search/extract/write logic entirely to lib/closing-notes.js
// (runClosingNotesPass) -- the SAME function salesforce-report-sync-
// background.mjs calls.
//
// 2026-09-11: REWRITTEN to import from lib/closing-notes.js instead of
// keeping its own separate copy of the query/extract/write logic. The
// duplication was exactly how the attempt-tracking fix (added the same
// day) initially only reached the real cycle and not this script -- one
// shared implementation means a future fix here can't happen again.
//
// ENV VARS NEEDED (in the same .env as SALESFORCE_USERNAME/PASSWORD):
//   SALESFORCE_USERNAME, SALESFORCE_PASSWORD
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Usage:
//   node closing-notes-sync.mjs                  (last 14 days, default)
//   node closing-notes-sync.mjs --days=30         (custom lookback window)
//   node closing-notes-sync.mjs --limit=10        (cap how many to process this run)
//   node closing-notes-sync.mjs --state=NC        (only this state's backlog, then fills remaining capacity with the rest)
//   node closing-notes-sync.mjs --minutes=10      (time budget for this run, default 30 -- no 15-min Background Function ceiling here since this isn't Netlify, but still worth bounding a manual run)
//   node closing-notes-sync.mjs --dry-run         (extract but don't write back -- for safe testing)

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import closingNotesPkg from './lib/closing-notes.js';
const { runClosingNotesPass } = closingNotesPkg;

const REPORT_URL = 'https://iti4dmv.my.site.com/dispatchconsole/s/report/00OVN000003SjTV2A0/completed-service-appointments?queryScope=mru';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : fallback;
};
const DAYS_BACK = parseInt(getArg('days', '14'), 10);
const LIMIT = parseInt(getArg('limit', '50'), 10);
const MINUTES = parseInt(getArg('minutes', '30'), 10);
const PRIORITY_STATE = getArg('state', null);
const DRY_RUN = args.includes('--dry-run');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
  }
  return createClient(url, key);
}

async function login(page) {
  const username = process.env.SALESFORCE_USERNAME;
  const password = process.env.SALESFORCE_PASSWORD;
  if (!username || !password) {
    throw new Error('Set SALESFORCE_USERNAME and SALESFORCE_PASSWORD env vars first.');
  }
  console.log('Navigating to report URL (will redirect to login if needed)...');
  try {
    await page.goto(REPORT_URL, { waitUntil: 'commit' });
  } catch (navErr) {
    console.log('Initial navigation threw (often benign):', navErr.message);
  }
  await page.waitForTimeout(2000);

  const onLoginPage = await page.waitForSelector('#username', { timeout: 8000 }).then(() => true).catch(() => false);
  if (onLoginPage) {
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('#Login');
    await page.waitForLoadState('domcontentloaded');
    const loginError = await page.locator('#error').isVisible().catch(() => false);
    if (loginError) {
      const errText = await page.locator('#error').innerText().catch(() => '(could not read error text)');
      throw new Error('Salesforce login rejected: ' + errText);
    }
  } else {
    console.log('No login form appeared -- likely already authenticated.');
  }
  console.log('Logged in. Landed on:', page.url());
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will write to Supabase)'}`);
  console.log(`Lookback window: ${DAYS_BACK} days, limit: ${LIMIT} records, time budget: ${MINUTES} min${PRIORITY_STATE ? `, priority state: ${PRIORITY_STATE}` : ''}\n`);

  const supabase = getSupabase();
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();

  let summary;
  try {
    await login(page);
    await page.waitForTimeout(1500);

    summary = await runClosingNotesPass(page, supabase, {
      daysBack: DAYS_BACK,
      limit: LIMIT,
      deadlineAt: Date.now() + MINUTES * 60 * 1000,
      priorityState: PRIORITY_STATE,
      dryRun: DRY_RUN,
    });
  } finally {
    console.log('\nDone. Leaving the browser open for 10s, then closing.');
    await page.waitForTimeout(10000);
    await browser.close();
  }

  console.log('\n=== SUMMARY ===');
  console.log(`${summary.succeeded} captured, ${summary.blank} blank note, ${summary.notFound} not found, ${summary.failed} failed (of ${summary.attempted} attempted${summary.stoppedByDeadline ? ', stopped early by time budget' : ''}).`);
  if (summary.errors.length) {
    console.log('\nErrors:');
    for (const e of summary.errors) {
      console.log(`  ${e.saNumber || '(pass-level)'}: ${e.error}`);
    }
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
