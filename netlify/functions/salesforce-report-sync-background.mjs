// salesforce-report-sync-background.mjs
//
// v2 (2026-07-27, second pass): rewritten as a proper Netlify v2 Background
// Function after finding the real cause of every prior test run dying
// around 10 seconds -- this was combining the "-background" filename
// suffix with a `schedule` config in netlify.toml, but Netlify's own
// current docs (pulled via the Netlify MCP tool mid-debugging) describe
// Background Functions and Scheduled Functions as two DISTINCT primitives
// with different limits: Scheduled Functions cap at 30 seconds, full stop,
// regardless of filename -- only a function invoked directly via HTTP with
// a "-background" suffix gets the real 15-minute background execution.
// So this file no longer has any schedule attached to it at all. The
// 20-minute cron trigger now lives in the separate, tiny
// salesforce-report-sync-trigger.mjs, which just pings this function's URL
// and returns well within the 30-second scheduled-function limit -- the
// actual browser work happens here, in the background function it kicks
// off. The "Refresh Now" button on state.html already calls this function
// directly by name, so no changes needed there.
//
// Also switched from the older `exports.handler = async (event, context)`
// (CommonJS) format to the current `export default async (req, context)`
// (ESM, web-standard Request) format Netlify's docs now show as current --
// this also incidentally simplifies the @sparticuz/chromium ESM-only
// problem from the first debugging pass: since this whole file is ESM now,
// chromium can be a normal static import instead of needing the dynamic
// import() workaround.
//
// IMPORTANT -- READ BEFORE FIRST DEPLOY:
// v3 (2026-07-29): the real, final blocker turned out to be the URL, not
// the login-page selectors, resource limits, or anything else -- every
// test all day (this Netlify version, the local PC version, page.type(),
// navigator.webdriver spoofing, even a fully human-typed manual login)
// went through iti4dmv.my.salesforce.com/lightning, the direct org login,
// and got rejected identically every time. The actual working path was
// iti4dmv.my.site.com/dispatchconsole/... -- an Experience Cloud portal
// login, which is what restock tracker's own report link and state.html's
// link had been pointing to the whole time. REPORT_URL below is now
// corrected and confirmed working live (via local-sync-watchdog.js, the
// PC version, same fix). This Netlify version has NOT itself been
// re-tested since the URL fix -- the login-page selectors should carry
// over fine (this portal's login page visually matches Salesforce's
// standard hosted form), and the report-export selectors (Export button,
// "Details Only" card, modal's own Export button) were built from Mark's
// real screenshots -- but this specific file's first live run since the
// fix is still the next thing to confirm. Every failure point captures a
// screenshot to Blobs and includes the current URL + a page-text snippet
// in the alert email so a failure is diagnosable rather than a bare
// stack trace.
//
// Required Netlify environment variables (Mark must set these):
//   SALESFORCE_USERNAME, SALESFORCE_PASSWORD, MAILGUN_API_KEY (already
//   set), ALERT_EMAIL, optional ALERT_SMS_ADDRESS. SALESFORCE_REPORT_URL
//   optional, defaults to the dispatchconsole portal report URL now.

import { getStore } from '@netlify/blobs';
import { createClient } from '@supabase/supabase-js';
import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';
import * as XLSX from 'xlsx';
import fs from 'fs';
import perfImportPkg from './lib/perform-import.js';
const { performImport } = perfImportPkg;

const REPORT_URL = process.env.SALESFORCE_REPORT_URL
  || 'https://iti4dmv.my.site.com/dispatchconsole/s/report/00OVN000003SjTV2A0/completed-service-appointments?queryScope=mru';

function getSyncStore() {
  return getStore('report-sync');
}

async function sendAlert(subject, body) {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN || 'mcrdispatch.net';
  const alertEmail = process.env.ALERT_EMAIL;
  const alertSms = process.env.ALERT_SMS_ADDRESS;
  if (!apiKey) {
    console.error('[salesforce-report-sync] Cannot send alert -- MAILGUN_API_KEY not set:', subject);
    return;
  }
  const to = [alertEmail, alertSms].filter(Boolean).join(',');
  if (!to) {
    console.error('[salesforce-report-sync] Cannot send alert -- no ALERT_EMAIL/ALERT_SMS_ADDRESS set:', subject);
    return;
  }
  try {
    const params = new URLSearchParams({
      from: `MCR Dispatch <dispatch@${domain}>`,
      to,
      subject,
      text: body,
    });
    await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (err) {
    console.error('[salesforce-report-sync] Alert send itself failed:', err.message);
  }
}

async function recordFailure(reason, page) {
  const store = getSyncStore();
  let screenshotNote = '(no screenshot captured)';
  try {
    if (page) {
      const shot = await page.screenshot({ fullPage: true });
      await store.set('last-failure-screenshot', shot);
      screenshotNote = 'Screenshot saved to Blobs key report-sync/last-failure-screenshot';
    }
  } catch (shotErr) {
    screenshotNote = 'Screenshot capture also failed: ' + shotErr.message;
  }
  let pageInfo = '';
  try {
    if (page) {
      const url = page.url();
      const text = (await page.innerText('body').catch(() => '')).slice(0, 500);
      pageInfo = `\nURL at failure: ${url}\nPage text snippet: ${text}`;
    }
  } catch (e) { /* best effort only */ }

  const failureRecord = { reason, at: new Date().toISOString(), pageInfo };
  await store.set('last-failure', JSON.stringify(failureRecord));

  await sendAlert(
    '⚠️ Salesforce report sync failed',
    `The automated closed-ticket report sync failed:\n\n${reason}${pageInfo}\n\n${screenshotNote}\n\nClosed-ticket data will keep getting stale until this is fixed or run manually. Check the Netlify function log for salesforce-report-sync-background for full detail.`
  );
}

async function recordSuccess(summary) {
  const store = getSyncStore();
  await store.set('last-success', JSON.stringify({ at: new Date().toISOString(), ...summary }));
  try { await store.delete('stale-alert-sent'); } catch (e) { /* fine if it didn't exist */ }
}

export default async (req, context) => {
  const store = getSyncStore();
  await store.set('in-progress', JSON.stringify({ startedAt: new Date().toISOString(), trigger: req.method === 'POST' ? 'manual-or-cron' : 'unknown' }));

  const username = (process.env.SALESFORCE_USERNAME || '').trim();
  const password = (process.env.SALESFORCE_PASSWORD || '').trim();
  console.log(`[salesforce-report-sync] Credential check -- username length: ${username.length}, password length: ${password.length}. (Never logging actual values.)`);
  const rawUsername = process.env.SALESFORCE_USERNAME || '';
  const rawPassword = process.env.SALESFORCE_PASSWORD || '';
  if (rawUsername !== username || rawPassword !== password) {
    console.log('[salesforce-report-sync] NOTE: trimmed leading/trailing whitespace from one or both env vars before use -- the stored value had extra whitespace.');
  }
  if (!username || !password) {
    await recordFailure('SALESFORCE_USERNAME/SALESFORCE_PASSWORD not set in Netlify environment variables.', null);
    await store.delete('in-progress').catch(() => {});
    return;
  }

  let browser;
  let page;
  try {
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json');
      const ipData = await ipRes.json();
      console.log(`[salesforce-report-sync] Outbound IP for this run: ${ipData.ip}`);
    } catch (ipErr) {
      console.log('[salesforce-report-sync] Could not determine outbound IP:', ipErr.message);
    }

    browser = await playwright.launch({
      args: [...chromium.args, '--disable-dev-shm-usage'],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Navigating directly to the report while unauthenticated should bounce
    // through Salesforce's standard login page and land back here on success.
    // 'commit' (not 'domcontentloaded') avoids a known Playwright race where
    // a page that does its own internal client-side redirect right after
    // loading can throw "interrupted by another navigation" even though the
    // navigation actually succeeds -- caught defensively either way, since
    // the browser is usually in a fine state to proceed regardless.
    try {
      await page.goto(REPORT_URL, { waitUntil: 'commit' });
    } catch (navErr) {
      console.log('Initial navigation threw (often benign -- Salesforce doing its own internal redirect):', navErr.message);
    }
    await page.waitForTimeout(2000);

    // Give Salesforce's login page a real chance to render before deciding
    // whether we're on it -- an instant check right after domcontentloaded
    // can fire before the login form has actually painted.
    const onLoginPage = await page.waitForSelector('#username', { timeout: 8000 }).then(() => true).catch(() => false);
    if (onLoginPage) {
      await page.fill('#username', username);
      await page.fill('#password', password);

      // Verify the fields actually hold what we just typed before
      // submitting -- never logging the real values, only lengths, so a
      // mismatch (e.g. fields cleared by page JS, or the fill racing
      // against the form not being fully ready) is caught here instead of
      // silently submitting an empty or wrong form and burning 45+ seconds
      // waiting on a page we never actually reached.
      const filledUsername = await page.inputValue('#username').catch(() => '');
      const filledPassword = await page.inputValue('#password').catch(() => '');
      console.log(`[salesforce-report-sync] Field check before submit -- username field length: ${filledUsername.length} (expected ${username.length}), password field length: ${filledPassword.length} (expected ${password.length})`);
      if (filledUsername.length !== username.length || filledPassword.length !== password.length) {
        await recordFailure(
          `Login fields did not hold the expected values right before submit (username field had ${filledUsername.length} chars, expected ${username.length}; password field had ${filledPassword.length} chars, expected ${password.length}). The form may have been submitted empty or partially filled.`,
          page
        );
        return;
      }

      await page.click('#Login');
      await page.waitForLoadState('domcontentloaded');

      const needsVerification = await page
        .getByText(/verify your identity/i)
        .isVisible()
        .catch(() => false);
      if (needsVerification) {
        await recordFailure(
          'Salesforce is asking for identity verification (a code sent to email/SMS) -- this needs a human to complete once. Automation cannot proceed past this on its own.',
          page
        );
        return;
      }

      const loginError = await page
        .locator('#error')
        .isVisible()
        .catch(() => false);
      if (loginError) {
        const errText = await page.locator('#error').innerText().catch(() => '(could not read error text)');
        await recordFailure('Salesforce login rejected: ' + errText, page);
        return;
      }
    }

    // Confirm we actually landed on the report (in case of an unexpected
    // redirect elsewhere).
    if (!page.url().includes('/dispatchconsole/s/report/')) {
      try {
        await page.goto(REPORT_URL, { waitUntil: 'commit' });
      } catch (navErr) {
        console.log('Fallback navigation threw (often benign):', navErr.message);
      }
      await page.waitForTimeout(2000);
    }
    // Wait for the literal text "Export" anywhere on the page -- reverted
    // 2026-07-29 from a more specific button-role locator, which failed
    // twice in a row (once even after a full 4-minute wait) while a
    // screenshot right after showed the page fully loaded with a visible
    // Export button -- suggests that locator was latching onto a
    // different, hidden "Export"-labeled element. This plain text search
    // has an actual track record of eventually resolving, in the 90-170s
    // range across multiple earlier runs.
    await page.waitForSelector('text=Export', { timeout: 4 * 60 * 1000 });

    // Narrow the date range to Last 7 Days before exporting -- Mark's ask
    // 2026-07-29: the report defaults to Current + Previous Month
    // (3,300+ rows), but everything older than a few days is already in
    // Supabase from prior runs, so a much lighter recent window is all
    // that's actually needed each time. This also directly helps the
    // report-render timeout, since a smaller report loads faster. Built
    // from Mark's own screenshots of the manual filter flow (funnel icon
    // -> Created Date -> Range dropdown -> Last 7 Days -> Apply), but
    // unlike the Export button this hasn't been live-tested yet -- wrapped
    // so a selector mismatch here just skips the narrowing (falls back to
    // whatever range was already set) rather than failing the whole run.
    try {
      await page.getByRole('button', { name: /filter/i }).first().click({ timeout: 8000 });
      await page.getByText(/Current and Previous Month|Last \d+ Days|Custom/i).first().click({ timeout: 8000 });
      const rangeDropdown = page.getByRole('combobox', { name: /range/i }).first();
      await rangeDropdown.click({ timeout: 8000 });
      await page.getByText('Last 7 Days', { exact: true }).click({ timeout: 8000 });
      await page.getByRole('button', { name: /^apply$/i }).click({ timeout: 8000 });
      await page.waitForTimeout(1500); // let the report re-run with the new filter
      console.log('Narrowed date range to Last 7 Days.');
    } catch (rangeErr) {
      console.log('Could not narrow the date range (selectors may not match this run) -- continuing with whatever range was already set:', rangeErr.message);
    }

    // Trigger the export flow: nav-bar Export button -> modal already
    // defaults to "Details Only" / "Excel Format .xls" per Mark's
    // screenshot, so this only needs to open the modal and confirm.
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15000 });

    await dialog.getByText('Details Only', { exact: false }).click().catch(() => {});

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      dialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);

    const buffer = await (async () => {
      const tmpPath = '/tmp/sf-export-' + Date.now() + '.xls';
      await download.saveAs(tmpPath);
      return fs.readFileSync(tmpPath);
    })();

    await browser.close();
    browser = null;

    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: '' });
    if (!rows.length) {
      await recordFailure('Downloaded report parsed to zero rows -- export may have failed silently or the report is genuinely empty.', null);
      return;
    }
    rows = rows.map((r) => {
      const out = {};
      for (const k of Object.keys(r)) out[k.trim()] = r[k];
      return out;
    });
    const required = ['Account Name', 'Jurisdiction', 'Appointment Number'];
    for (const col of required) {
      if (!(col in rows[0])) {
        await recordFailure(`Downloaded file is missing expected column "${col}". Columns found: ${Object.keys(rows[0]).join(', ')}`, null);
        return;
      }
    }

    const mapped = rows
      .map((r) => ({
        accountName: String(r['Account Name'] || '').trim(),
        state: String(r['Jurisdiction'] || '').trim(),
        woNumber: (r['Work Order Number'] != null && r['Work Order Number'] !== '') ? String(r['Work Order Number']).split('.')[0] : null,
        appointmentNumber: String(r['Appointment Number'] || '').trim(),
        actualStart: r['Actual Start'] || null,
        actualEnd: r['Actual End'] || null,
        durationMin: (r['Actual Duration (Minutes)'] != null && r['Actual Duration (Minutes)'] !== '') ? Number(r['Actual Duration (Minutes)']) : null,
        techName: String(r['Service Resource: Name'] || '').trim(),
        remediation: String(r['Remediation'] || '').trim(),
        remediationDetail: String(r['Remediation Detail'] || '').trim(),
      }))
      .filter((r) => r.appointmentNumber);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    let totalInserted = 0, totalSkipped = 0, totalNeedsReview = 0, allRowErrors = [];
    const BATCH_SIZE = 250;
    for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
      const batch = mapped.slice(i, i + BATCH_SIZE);
      const result = await performImport(supabase, batch);
      totalInserted += result.inserted;    console.error('[salesforce-report-sync] Alert send itself failed:', err.message);
  }
}

async function recordFailure(reason, page) {
  const store = getSyncStore();
  let screenshotNote = '(no screenshot captured)';
  try {
    if (page) {
      const shot = await page.screenshot({ fullPage: true });
      await store.set('last-failure-screenshot', shot);
      screenshotNote = 'Screenshot saved to Blobs key report-sync/last-failure-screenshot';
    }
  } catch (shotErr) {
    screenshotNote = 'Screenshot capture also failed: ' + shotErr.message;
  }
  let pageInfo = '';
  try {
    if (page) {
      const url = page.url();
      const text = (await page.innerText('body').catch(() => '')).slice(0, 500);
      pageInfo = `\nURL at failure: ${url}\nPage text snippet: ${text}`;
    }
  } catch (e) { /* best effort only */ }

  const failureRecord = { reason, at: new Date().toISOString(), pageInfo };
  await store.set('last-failure', JSON.stringify(failureRecord));

  await sendAlert(
    '⚠️ Salesforce report sync failed',
    `The automated closed-ticket report sync failed:\n\n${reason}${pageInfo}\n\n${screenshotNote}\n\nClosed-ticket data will keep getting stale until this is fixed or run manually. Check the Netlify function log for salesforce-report-sync-background for full detail.`
  );
}

async function recordSuccess(summary) {
  const store = getSyncStore();
  await store.set('last-success', JSON.stringify({ at: new Date().toISOString(), ...summary }));
  try { await store.delete('stale-alert-sent'); } catch (e) { /* fine if it didn't exist */ }
}

export default async (req, context) => {
  const store = getSyncStore();
  await store.set('in-progress', JSON.stringify({ startedAt: new Date().toISOString(), trigger: req.method === 'POST' ? 'manual-or-cron' : 'unknown' }));

  const username = (process.env.SALESFORCE_USERNAME || '').trim();
  const password = (process.env.SALESFORCE_PASSWORD || '').trim();
  console.log(`[salesforce-report-sync] Credential check -- username length: ${username.length}, password length: ${password.length}. (Never logging actual values.)`);
  const rawUsername = process.env.SALESFORCE_USERNAME || '';
  const rawPassword = process.env.SALESFORCE_PASSWORD || '';
  if (rawUsername !== username || rawPassword !== password) {
    console.log('[salesforce-report-sync] NOTE: trimmed leading/trailing whitespace from one or both env vars before use -- the stored value had extra whitespace.');
  }
  if (!username || !password) {
    await recordFailure('SALESFORCE_USERNAME/SALESFORCE_PASSWORD not set in Netlify environment variables.', null);
    await store.delete('in-progress').catch(() => {});
    return;
  }

  let browser;
  let page;
  try {
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json');
      const ipData = await ipRes.json();
      console.log(`[salesforce-report-sync] Outbound IP for this run: ${ipData.ip}`);
    } catch (ipErr) {
      console.log('[salesforce-report-sync] Could not determine outbound IP:', ipErr.message);
    }

    browser = await playwright.launch({
      args: [...chromium.args, '--disable-dev-shm-usage'],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Navigating directly to the report while unauthenticated should bounce
    // through Salesforce's standard login page and land back here on success.
    // 'commit' (not 'domcontentloaded') avoids a known Playwright race where
    // a page that does its own internal client-side redirect right after
    // loading can throw "interrupted by another navigation" even though the
    // navigation actually succeeds -- caught defensively either way, since
    // the browser is usually in a fine state to proceed regardless.
    try {
      await page.goto(REPORT_URL, { waitUntil: 'commit' });
    } catch (navErr) {
      console.log('Initial navigation threw (often benign -- Salesforce doing its own internal redirect):', navErr.message);
    }
    await page.waitForTimeout(2000);

    // Give Salesforce's login page a real chance to render before deciding
    // whether we're on it -- an instant check right after domcontentloaded
    // can fire before the login form has actually painted.
    const onLoginPage = await page.waitForSelector('#username', { timeout: 8000 }).then(() => true).catch(() => false);
    if (onLoginPage) {
      await page.fill('#username', username);
      await page.fill('#password', password);

      // Verify the fields actually hold what we just typed before
      // submitting -- never logging the real values, only lengths, so a
      // mismatch (e.g. fields cleared by page JS, or the fill racing
      // against the form not being fully ready) is caught here instead of
      // silently submitting an empty or wrong form and burning 45+ seconds
      // waiting on a page we never actually reached.
      const filledUsername = await page.inputValue('#username').catch(() => '');
      const filledPassword = await page.inputValue('#password').catch(() => '');
      console.log(`[salesforce-report-sync] Field check before submit -- username field length: ${filledUsername.length} (expected ${username.length}), password field length: ${filledPassword.length} (expected ${password.length})`);
      if (filledUsername.length !== username.length || filledPassword.length !== password.length) {
        await recordFailure(
          `Login fields did not hold the expected values right before submit (username field had ${filledUsername.length} chars, expected ${username.length}; password field had ${filledPassword.length} chars, expected ${password.length}). The form may have been submitted empty or partially filled.`,
          page
        );
        return;
      }

      await page.click('#Login');
      await page.waitForLoadState('domcontentloaded');

      const needsVerification = await page
        .getByText(/verify your identity/i)
        .isVisible()
        .catch(() => false);
      if (needsVerification) {
        await recordFailure(
          'Salesforce is asking for identity verification (a code sent to email/SMS) -- this needs a human to complete once. Automation cannot proceed past this on its own.',
          page
        );
        return;
      }

      const loginError = await page
        .locator('#error')
        .isVisible()
        .catch(() => false);
      if (loginError) {
        const errText = await page.locator('#error').innerText().catch(() => '(could not read error text)');
        await recordFailure('Salesforce login rejected: ' + errText, page);
        return;
      }
    }

    // Confirm we actually landed on the report (in case of an unexpected
    // redirect elsewhere).
    if (!page.url().includes('/dispatchconsole/s/report/')) {
      try {
        await page.goto(REPORT_URL, { waitUntil: 'commit' });
      } catch (navErr) {
        console.log('Fallback navigation threw (often benign):', navErr.message);
      }
      await page.waitForTimeout(2000);
    }
    // Wait for the specific Export BUTTON (same locator the click below
    // uses), not just the literal text "Export" anywhere on the page --
    // Mark's own manual experience is that Export is clickable well before
    // 150s, so a generic text match may be getting held up by something
    // else on the page also containing that word, while the actual
    // toolbar button he clicks could genuinely be ready much sooner.
    // 2026-07-29: bumped to 4 min after several real runs consistently took
    // 90-170s total, every time -- looks like genuine cold-start cost (a
    // fresh, cache-free browser has to fully load Salesforce's whole
    // Experience Cloud framework from scratch every single run, unlike
    // Mark's own browser which has weeks of cached assets) rather than a
    // broken selector. Plenty of budget to spare (15 min total), so give
    // it real room instead of nudging the number up incrementally again.
    // 2026-07-29: reverted from the button-role locator back to the
    // original generic text search. The button-specific version
    // (getByRole('button', {name:'Export'}).first()) failed TWO real runs
    // in a row -- once even after a full 4-minute wait -- while a
    // subsequent screenshot showed the page fully loaded with a visible
    // Export button. That pattern (worse results from a MORE specific
    // locator) suggests .first() may be latching onto a different, hidden
    // "Export"-labeled element elsewhere in the DOM (e.g. inside a dialog
    // template that's present but never shown) rather than the real
    // toolbar button. The plain text search has an actual track record of
    // eventually resolving, in the 90-170s range across multiple runs, so
    // reverting to it with generous headroom.
    await page.waitForSelector('text=Export', { timeout: 4 * 60 * 1000 });

    // Narrow the date range to Last 7 Days before exporting -- Mark's ask
    // 2026-07-29: the report defaults to Current + Previous Month
    // (3,300+ rows), but everything older than a few days is already in
    // Supabase from prior runs, so a much lighter recent window is all
    // that's actually needed each time. This also directly helps the
    // report-render timeout, since a smaller report loads faster. Built
    // from Mark's own screenshots of the manual filter flow (funnel icon
    // -> Created Date -> Range dropdown -> Last 7 Days -> Apply), but
    // unlike the Export button this hasn't been live-tested yet -- wrapped
    // so a selector mismatch here just skips the narrowing (falls back to
    // whatever range was already set) rather than failing the whole run.
    try {
      await page.getByRole('button', { name: /filter/i }).first().click({ timeout: 8000 });
      await page.getByText(/Current and Previous Month|Last \d+ Days|Custom/i).first().click({ timeout: 8000 });
      const rangeDropdown = page.getByRole('combobox', { name: /range/i }).first();
      await rangeDropdown.click({ timeout: 8000 });
      await page.getByText('Last 7 Days', { exact: true }).click({ timeout: 8000 });
      await page.getByRole('button', { name: /^apply$/i }).click({ timeout: 8000 });
      await page.waitForTimeout(1500); // let the report re-run with the new filter
      console.log('Narrowed date range to Last 7 Days.');
    } catch (rangeErr) {
      console.log('Could not narrow the date range (selectors may not match this run) -- continuing with whatever range was already set:', rangeErr.message);
    }

    // Trigger the export flow: nav-bar Export button -> modal already
    // defaults to "Details Only" / "Excel Format .xls" per Mark's
    // screenshot, so this only needs to open the modal and confirm.
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15000 });

    await dialog.getByText('Details Only', { exact: false }).click().catch(() => {});

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      dialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);

    const buffer = await (async () => {
      const tmpPath = '/tmp/sf-export-' + Date.now() + '.xls';
      await download.saveAs(tmpPath);
      return fs.readFileSync(tmpPath);
    })();

    await browser.close();
    browser = null;

    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: '' });
    if (!rows.length) {
      await recordFailure('Downloaded report parsed to zero rows -- export may have failed silently or the report is genuinely empty.', null);
      return;
    }
    rows = rows.map((r) => {
      const out = {};
      for (const k of Object.keys(r)) out[k.trim()] = r[k];
      return out;
    });
    const required = ['Account Name', 'Jurisdiction', 'Appointment Number'];
    for (const col of required) {
      if (!(col in rows[0])) {
        await recordFailure(`Downloaded file is missing expected column "${col}". Columns found: ${Object.keys(rows[0]).join(', ')}`, null);
        return;
      }
    }

    const mapped = rows
      .map((r) => ({
        accountName: String(r['Account Name'] || '').trim(),
        state: String(r['Jurisdiction'] || '').trim(),
        woNumber: (r['Work Order Number'] != null && r['Work Order Number'] !== '') ? String(r['Work Order Number']).split('.')[0] : null,
        appointmentNumber: String(r['Appointment Number'] || '').trim(),
        actualStart: r['Actual Start'] || null,
        actualEnd: r['Actual End'] || null,
        durationMin: (r['Actual Duration (Minutes)'] != null && r['Actual Duration (Minutes)'] !== '') ? Number(r['Actual Duration (Minutes)']) : null,
        techName: String(r['Service Resource: Name'] || '').trim(),
        remediation: String(r['Remediation'] || '').trim(),
        remediationDetail: String(r['Remediation Detail'] || '').trim(),
      }))
      .filter((r) => r.appointmentNumber);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    let totalInserted = 0, totalSkipped = 0, totalNeedsReview = 0, allRowErrors = [];
    const BATCH_SIZE = 250;
    for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
      const batch = mapped.slice(i, i + BATCH_SIZE);
      const result = await performImport(supabase, batch);
      totalInserted += result.inserted;
      totalSkipped += result.skippedExisting;
      totalNeedsReview += result.needsReview;
      allRowErrors = allRowErrors.concat(result.rowErrors);
    }

    await recordSuccess({
      totalRows: mapped.length,
      inserted: totalInserted,
      skippedExisting: totalSkipped,
      needsReview: totalNeedsReview,
      rowErrorCount: allRowErrors.length,
    });

    if (allRowErrors.length) {
      await sendAlert(
        `Salesforce report sync: ${allRowErrors.length} row(s) failed`,
        `Sync succeeded overall (${totalInserted} imported, ${totalSkipped} already on file), but ${allRowErrors.length} row(s) failed individually:\n\n` +
          allRowErrors.slice(0, 20).map(e => `${e.appointmentNumber} -- ${e.accountName}: ${e.reason}`).join('\n')
      );
    }

    console.log(`[salesforce-report-sync] Success: ${totalInserted} imported, ${totalSkipped} already on file, ${totalNeedsReview} need review, ${allRowErrors.length} row errors.`);
  } catch (err) {
    console.error('[salesforce-report-sync] Unhandled error:', err);
    await recordFailure('Unhandled error: ' + err.message, page);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* already closing */ }
    }
    try { await store.delete('in-progress'); } catch (e) { /* fine if already gone */ }
  }
};
