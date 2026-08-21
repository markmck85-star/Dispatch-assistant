// salesforce-report-sync-background.mjs
//
// v5 (2026-08-08): iframe-aware Export search (confirmed by local watchdog success). Previous v4
// appearing. Changes:
//   - Removed the pre-export "Last 7 Days" filter narrowing. Mark confirmed
//     the default Current+Previous Month range is fine and that changing the
//     filter actually adds delay; the previous filter code also ran after
//     the Export button was already expected to be ready.
//   - Stronger recovery: up to 3 page reloads when lightningReportApp aborts
//     (or after 45 s with no button), instead of a single reload.
//   - Richer request/response logging around lightningReportApp and report
//     resources so the next failure log is more actionable.
//   - More robust Export click (scrollIntoView → normal click → force → JS
//     click) and slightly longer download timeout.
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

  // ── Auto-sync enable/disable check (2026-08-08) ──────────────────────────
  // Settings live in the "dispatch" Blobs store under settings/global.
  // When salesforceReportSyncEnabled is explicitly false, scheduled/automatic
  // runs exit immediately so we don't keep hammering Salesforce with a
  // known-broken Playwright flow. Manual "Refresh Now" from the State Console
  // always proceeds (the UI sends ?force=1).
  let forceRun = false;
  try {
    const url = new URL(req.url || '', 'http://localhost');
    forceRun = url.searchParams.get('force') === '1';
  } catch (_) { /* ignore */ }

  if (!forceRun) {
    try {
      const settingsStore = getStore('dispatch');
      const settings = (await settingsStore.get('settings/global', { type: 'json' })) || {};
      if (settings.salesforceReportSyncEnabled === false) {
        console.log('[salesforce-report-sync] Auto-sync is disabled in settings (salesforceReportSyncEnabled=false). Exiting without running. Use Refresh Now (force=1) to override.');
        return new Response(JSON.stringify({ skipped: true, reason: 'auto-sync-disabled' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (settingsErr) {
      console.log('[salesforce-report-sync] Could not read settings for enable flag — proceeding anyway:', settingsErr.message);
    }
  } else {
    console.log('[salesforce-report-sync] Force/manual run requested — ignoring auto-sync disable flag.');
  }

  // Concurrency guard added 2026-07-31: discovered up to 5-6 overlapping
  // invocations firing within about a minute of each other during
  // troubleshooting (likely from repeated Run Now/Refresh Now clicks),
  // all logging into the same Salesforce account at nearly the same
  // moment. Concurrent logins to one account can invalidate each other's
  // sessions, which could itself explain pages that never load correctly.
  // Skip starting a new run if a previous one is still marked in-progress
  // and started recently; a flag older than 6 minutes is treated as
  // orphaned (from a crashed run that never reached the `finally` cleanup)
  // and allowed to proceed rather than blocking forever.
  const existingRaw = await store.get('in-progress').catch(() => null);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      const ageMs = Date.now() - new Date(existing.startedAt).getTime();
      if (ageMs < 6 * 60 * 1000) {
        console.log(`[salesforce-report-sync] Skipping this run -- another run is already in progress (started ${Math.round(ageMs / 1000)}s ago).`);
        return;
      }
      console.log(`[salesforce-report-sync] Found a stale in-progress flag (${Math.round(ageMs / 1000)}s old, likely orphaned from a crashed run) -- proceeding anyway.`);
    } catch (e) {
      console.log('[salesforce-report-sync] Could not parse existing in-progress flag -- proceeding anyway.');
    }
  }

  await store.set('in-progress', JSON.stringify({ startedAt: new Date().toISOString(), trigger: forceRun ? 'manual' : (req.method === 'POST' ? 'manual-or-cron' : 'scheduled'), stage: 'Logging in' }));

  // Staged progress for state.html's Refresh Now progress bar (added
  // 2026-08-21). There's no real byte-level progress available here -- the
  // work happens in a headless browser server-side, not a file the
  // frontend can watch upload/download -- so this reports discrete STAGES
  // instead, updating the same in-progress record at each real transition
  // the code already goes through. Startedat/trigger are preserved on
  // every update so elapsed-time display and the stale-run check both
  // keep working unchanged.
  async function setStage(stage) {
    try {
      const raw = await store.get('in-progress');
      const existing = raw ? JSON.parse(raw) : {};
      await store.set('in-progress', JSON.stringify({ ...existing, stage }));
    } catch (e) {
      // Non-fatal -- worst case the progress bar just doesn't advance for
      // this one stage, the sync itself is unaffected either way.
    }
  }

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
      args: [...chromium.args, '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    // 2026-08-01: added after confirming navigator.webdriver spoofing alone
    // wasn't enough -- three separate runs showed the reload-retry doing
    // nothing, with the SAME lightningReportApp.app request getting
    // re-aborted identically every single time, even right after a fresh
    // reload. That consistency suggests deliberate, repeatable detection
    // rather than a random network hiccup a retry could fix. Two more
    // standard stealth measures: the AutomationControlled launch flag
    // (hides several other Chrome automation signals beyond just
    // navigator.webdriver), and an explicit, ordinary-looking desktop
    // Chrome user agent -- headless Chrome's default UA self-identifies
    // with "HeadlessChrome", which some detection systems check directly
    // regardless of navigator.webdriver.
    page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    page.setDefaultTimeout(30000);

    // 2026-07-31: added after discovering the REAL failure screenshot
    // (Mark's browser had been showing a stale cached copy of an old
    // screenshot via view-sync-screenshot.js the whole time -- the actual
    // current Blobs content, confirmed by downloading it directly, is a
    // completely blank white page with zero rendered content, matching
    // the empty page-text snippet also captured on failure) -- this fits
    // Salesforce silently serving nothing to automated browsers rather
    // than blocking outright. Playwright (like Selenium/Puppeteer) sets
    // navigator.webdriver = true on any page it controls, which some
    // bot-detection systems check directly. This mitigation was built
    // and added to local-sync.js on 2026-07-28 during an earlier pass at
    // this same theory, but never actually ported into this cloud script
    // -- that investigation got overtaken by the URL-fix discovery before
    // it was ever live-tested here. Overrides navigator.webdriver to
    // report undefined before any page script runs.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // 2026-08-01: added after finding that the stuck state is completely
    // deterministic -- two separate runs at 8:25 PM and 8:48 PM produced
    // byte-for-byte identical screenshots (same page shell rendered, same
    // report component never appearing). That rules out a flaky timing
    // race and points at something concrete blocking the report
    // component's own async init every time. Capturing browser console
    // messages, uncaught page errors, and failed network requests so the
    // next failure's log shows the actual JS error (if any) instead of
    // just "nothing happened".
    let reportAppRequestFailed = false;
    let reportAppFailureDetail = '';
    page.on('console', (msg) => {
      console.log(`[salesforce-report-sync] Page console [${msg.type()}]: ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      console.log(`[salesforce-report-sync] Page error: ${err.message}`);
    });
    page.on('requestfailed', (request) => {
      const failText = request.failure()?.errorText || 'unknown';
      console.log(`[salesforce-report-sync] Request failed: ${request.url()} -- ${failText}`);
      if (request.url().includes('lightningReportApp')) {
        reportAppRequestFailed = true;
        reportAppFailureDetail = `${request.url()} → ${failText}`;
      }
    });
    // Also log successful responses that look report-related so we can see
    // whether the app resource ever actually completes.
    page.on('response', (response) => {
      const u = response.url();
      if (u.includes('lightningReportApp') || u.includes('/report/') || u.includes('ReportExport')) {
        console.log(`[salesforce-report-sync] Response: ${response.status()} ${u.slice(0, 160)}`);
      }
    });

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
    await setStage('Waiting for report to load');
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
    // 2026-08-08 v5: Export button lives INSIDE an iframe on the Experience
    // Cloud report page. Confirmed by the successful local-sync-watchdog run
    // which found it via frame(...)-role-Export. Previous cloud attempts only
    // searched the main document, so they never saw it. We now search all
    // frames with multiple locator strategies, keep the recovery reloads,
    // and log richer diagnostics.
    const diagStart = Date.now();
    let exportLocator = null;
    let exportStrategy = null;
    let reloadCount = 0;
    const MAX_RELOADS = 3;

    async function findExportInAllFrames() {
      const candidates = [];

      // Main page strategies
      candidates.push({ name: 'main-role-Export', loc: page.getByRole('button', { name: 'Export', exact: true }).first() });
      candidates.push({ name: 'main-role-Export-i', loc: page.getByRole('button', { name: /export/i }).first() });
      candidates.push({ name: 'main-css-ReportExportAction', loc: page.locator('button.action-bar-action-ReportExportAction').first() });
      candidates.push({ name: 'main-text-Export', loc: page.getByText('Export', { exact: true }).first() });
      candidates.push({ name: 'main-css-title', loc: page.locator('[title="Export"], [aria-label="Export"], [aria-label*="Export" i]').first() });

      // Every frame (this is what fixed the local watchdog)
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const short = (frame.url() || 'about:blank').slice(0, 50);
        candidates.push({ name: `frame(${short})-role-Export`, loc: frame.getByRole('button', { name: 'Export', exact: true }).first() });
        candidates.push({ name: `frame(${short})-role-Export-i`, loc: frame.getByRole('button', { name: /export/i }).first() });
        candidates.push({ name: `frame(${short})-css-ReportExportAction`, loc: frame.locator('button.action-bar-action-ReportExportAction').first() });
        candidates.push({ name: `frame(${short})-text-Export`, loc: frame.getByText('Export', { exact: true }).first() });
      }

      for (const c of candidates) {
        try {
          const count = await c.loc.count().catch(() => 0);
          if (count === 0) continue;
          // Prefer visible, but accept present (Salesforce sometimes reports not-visible)
          const visible = await c.loc.isVisible().catch(() => false);
          console.log(`[salesforce-report-sync] findExport candidate ${c.name}: count=${count}, visible=${visible}`);
          if (visible || count > 0) {
            return { locator: c.loc, strategy: c.name + (visible ? '' : ' (not-visible)') };
          }
        } catch (_) { /* try next */ }
      }
      return null;
    }

    while (Date.now() - diagStart < 8 * 60 * 1000) {
      const found = await findExportInAllFrames();
      if (found) {
        exportLocator = found.locator;
        exportStrategy = found.strategy;
        console.log(`[salesforce-report-sync] Export found via ${exportStrategy} @ ${Math.round((Date.now() - diagStart) / 1000)}s`);
        await setStage('Preparing export');
        break;
      }

      // Diagnostic snapshot
      const frameCount = page.frames().length;
      let spinnerCount = 0;
      try {
        spinnerCount = await page.locator('.slds-spinner, lightning-spinner, [role="status"]').count();
      } catch (_) {}
      console.log(
        `[salesforce-report-sync] Export still not found @ ${Math.round((Date.now() - diagStart) / 1000)}s -- frames=${frameCount}, spinnerCount=${spinnerCount}, reportAppFailed=${reportAppRequestFailed}`
      );

      const elapsed = Date.now() - diagStart;
      if (reloadCount < MAX_RELOADS && (reportAppRequestFailed || elapsed > 45000)) {
        reloadCount++;
        console.log(
          `[salesforce-report-sync] Attempting recovery reload #${reloadCount}/${MAX_RELOADS}` +
            (reportAppRequestFailed ? ` (lightningReportApp aborted: ${reportAppFailureDetail})` : ' (timeout without button)')
        );
        reportAppRequestFailed = false;
        try {
          await page.reload({ waitUntil: 'commit', timeout: 60000 });
          await page.waitForTimeout(3000);
        } catch (e) {
          console.log('[salesforce-report-sync] Reload threw (often benign):', e.message);
        }
      }
      await page.waitForTimeout(12000);
    }

    if (!exportLocator) {
      throw new Error(
        `Export button never found after ${Math.round((Date.now() - diagStart) / 1000)}s and ${reloadCount} reload(s) (searched main page + all iframes).` +
          (reportAppFailureDetail ? ` Last lightningReportApp failure: ${reportAppFailureDetail}.` : '')
      );
    }

    // Robust click sequence
    await exportLocator.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);

    let clicked = false;
    try {
      await exportLocator.click({ timeout: 10000 });
      clicked = true;
      console.log('[salesforce-report-sync] Export clicked (normal)');
    } catch (clickErr) {
      console.log('[salesforce-report-sync] Normal click failed, trying force/JS:', clickErr.message);
      try {
        await exportLocator.click({ force: true, timeout: 5000 });
        clicked = true;
        console.log('[salesforce-report-sync] Export clicked (force)');
      } catch (forceErr) {
        try {
          await exportLocator.evaluate((el) => el.click());
          clicked = true;
          console.log('[salesforce-report-sync] Export clicked (JS)');
        } catch (jsErr) {
          throw new Error('Could not click Export after finding it: ' + jsErr.message);
        }
      }
    }
    if (!clicked) throw new Error('Could not click the Export button after it was found.');
    await setStage('Downloading file');

    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);

    // Prefer "Details Only" if present
    await dialog.getByText('Details Only', { exact: false }).click().catch(() => {});
    await page.getByText('Details Only', { exact: false }).first().click().catch(() => {});

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      (async () => {
        try {
          await dialog.getByRole('button', { name: /export/i }).click({ timeout: 8000 });
        } catch {
          await page.getByRole('button', { name: /export/i }).last().click({ timeout: 5000 }).catch(() => {});
        }
      })(),
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
        woNumber: (() => {
          const raw = r['Work Order Number'];
          if (raw == null || raw === '') return null;
          let s = String(raw).split('.')[0];
          // 2026-08-12: mirrors the same fix already applied to state.html's
          // manual-upload parser on 2026-08-08 -- when this column is read as
          // a JS number (cell format General/Number rather than Text), any
          // leading zeros are silently lost ("00149242" becomes "149242").
          // That fix only ever landed in the manual-upload path; this
          // automated background sync (runs every 20 min per netlify.toml)
          // had its own separate, unfixed WO-number extraction, so trouble
          // tickets synced through this path could silently fail to
          // auto-close in perform-import.js's WO-number match against
          // `tickets.wo_number` even when genuinely completed. Every real WO
          // number seen so far is 8 digits -- pad back up whenever shorter
          // and purely numeric, safe even if the true un-stripped number
          // happened to be shorter for some reason, since matching
          // tickets.wo_number would have the same original value in that case
          // too.
          if (/^[0-9]+$/.test(s) && s.length < 8) s = s.padStart(8, '0');
          return s;
        })(),
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
    await setStage('Importing rows');

    let totalInserted = 0, totalSkipped = 0, totalNeedsReview = 0, allRowErrors = [], allInsertedSamples = [];
    const BATCH_SIZE = 250;
    for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
      const batch = mapped.slice(i, i + BATCH_SIZE);
      const result = await performImport(supabase, batch);
      totalInserted += result.inserted;
      totalSkipped += result.skippedExisting;
      totalNeedsReview += result.needsReview;
      allRowErrors = allRowErrors.concat(result.rowErrors);
      // Capped at 25 total across all batches (not 25 per batch) -- this is
      // for a dispatcher glancing at the Refresh Now result to confirm a
      // specific ticket landed, not a full audit log, so a smaller than-
      // total sample is fine as long as it's not misleadingly large.
      if (allInsertedSamples.length < 25) {
        allInsertedSamples = allInsertedSamples.concat(result.insertedSamples).slice(0, 25);
      }
    }

    await recordSuccess({
      totalRows: mapped.length,
      inserted: totalInserted,
      skippedExisting: totalSkipped,
      needsReview: totalNeedsReview,
      rowErrorCount: allRowErrors.length,
      insertedSamples: allInsertedSamples,
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
