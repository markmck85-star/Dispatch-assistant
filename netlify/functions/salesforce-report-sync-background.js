// salesforce-report-sync-background.js
//
// Renamed from salesforce-report-sync.js 2026-07-27 to add manual on-demand
// triggering (Mark's "refresh button" idea) alongside the existing 20-min
// schedule. The "-background" filename suffix is a Netlify convention:
// it makes ANY invocation of this function -- whether cron-triggered or
// hit directly via HTTP from the "Refresh Now" button -- get acknowledged
// immediately while the actual work (which can take 10-60+ seconds: launch
// browser, log in, export, parse, import) keeps running for up to 15
// minutes. Without this, a manual trigger from the browser would just sit
// there waiting and likely time out.
//
// Scheduled function (netlify.toml: every 20 min) that automates the manual
// "Open Salesforce Report -> Export -> Details Only -> Export" flow Mark's
// been doing by hand, using a headless browser (Playwright + a serverless
// Chromium build). Built 2026-07-27 after confirming this org almost
// certainly can't get real Salesforce API access (restricted partner
// license -- no custom reports, no populated Manager/Delegated Approver
// fields), so browser automation is the realistic option, not a stopgap.
//
// IMPORTANT -- READ BEFORE FIRST DEPLOY:
// The login-page selectors (username/password/login button, and the
// "Verify Your Identity" detection) are Salesforce's own standard hosted
// login flow and have been stable across orgs for years -- reasonably
// confident in those. The report-export selectors (the Export button, the
// "Details Only" card, the modal's own Export button) are built from Mark's
// actual screenshots of this report on 2026-07-27, but have NOT been
// live-tested against this specific org end-to-end -- Salesforce Lightning
// UI can have per-org quirks. Expect to iterate on these selectors after
// watching the first few runs. Every failure point below captures a
// screenshot to Blobs and includes the current URL + a page-text snippet in
// the alert email specifically so a failed run is diagnosable rather than a
// bare stack trace.
//
// Required Netlify environment variables (Mark must set these -- not
// something I can set from here):
//   SALESFORCE_USERNAME       - login for this ITI org
//   SALESFORCE_PASSWORD       - login for this ITI org
//   SALESFORCE_REPORT_URL     - defaults to the Completed Service
//                                Appointments report Mark linked
//                                (https://iti4dmv.my.salesforce.com/lightning/r/Report/00OVN000003SjTV2A0/view)
//   MAILGUN_API_KEY           - already set (used elsewhere)
//   ALERT_EMAIL                - where failure/staleness alerts go
//   ALERT_SMS_ADDRESS          - optional, carrier email-to-SMS gateway address for a text alert
//
// On success: writes a timestamp + row-count summary to Blobs
// (report-sync/last-success) -- this is what check-report-sync-health.js
// reads to detect staleness, per Mark's ask 2026-07-27 for something that
// actively flags a failed/stalled sync instead of silently going stale.
// On failure: writes report-sync/last-failure (reason + screenshot) and
// sends an immediate alert -- doesn't wait for the separate staleness
// check, so a clearly-detected failure (e.g. an identity verification
// challenge) surfaces right away instead of up to 45 minutes later.

const { getStore, connectLambda } = require('@netlify/blobs');
const { createClient } = require('@supabase/supabase-js');
const { chromium: playwright } = require('playwright-core');
const chromium = require('@sparticuz/chromium');
const XLSX = require('xlsx');
const fs = require('fs');
const { performImport } = require('./lib/perform-import');

const REPORT_URL = process.env.SALESFORCE_REPORT_URL
  || 'https://iti4dmv.my.salesforce.com/lightning/r/Report/00OVN000003SjTV2A0/view';

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
    `The automated closed-ticket report sync failed:\n\n${reason}${pageInfo}\n\n${screenshotNote}\n\nClosed-ticket data will keep getting stale until this is fixed or run manually. Check the Netlify function log for salesforce-report-sync for full detail.`
  );
}

async function recordSuccess(summary) {
  const store = getSyncStore();
  await store.set('last-success', JSON.stringify({ at: new Date().toISOString(), ...summary }));
  // Clear any prior "already alerted" flag so a future stale episode alerts again.
  try { await store.delete('stale-alert-sent'); } catch (e) { /* fine if it didn't exist */ }
}

exports.handler = async (event, context) => {
  connectLambda(event);
  const store = getSyncStore();
  await store.set('in-progress', JSON.stringify({ startedAt: new Date().toISOString(), trigger: event.httpMethod === 'POST' ? 'manual' : 'scheduled' }));

  const username = process.env.SALESFORCE_USERNAME;
  const password = process.env.SALESFORCE_PASSWORD;
  if (!username || !password) {
    await recordFailure('SALESFORCE_USERNAME/SALESFORCE_PASSWORD not set in Netlify environment variables.', null);
    return { statusCode: 200, body: 'missing credentials' };
  }

  let browser;
  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);

    // Navigating directly to the report while unauthenticated should bounce
    // through Salesforce's standard login page and land back here on success.
    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });

    const onLoginPage = await page.locator('#username').isVisible().catch(() => false);
    if (onLoginPage) {
      await page.fill('#username', username);
      await page.fill('#password', password);
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
        return { statusCode: 200, body: 'needs manual verification' };
      }

      const loginError = await page
        .locator('#error')
        .isVisible()
        .catch(() => false);
      if (loginError) {
        const errText = await page.locator('#error').innerText().catch(() => '(could not read error text)');
        await recordFailure('Salesforce login rejected: ' + errText, page);
        return { statusCode: 200, body: 'login rejected' };
      }
    }

    // Confirm we actually landed on the report (in case of an unexpected
    // redirect elsewhere -- e.g. a Lightning "choose your experience" page
    // some orgs show on first login from a new session).
    if (!page.url().includes('/lightning/r/Report/')) {
      await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('text=Export', { timeout: 30000 });

    // Trigger the export flow: nav-bar Export button -> modal already
    // defaults to "Details Only" / "Excel Format .xls" per Mark's
    // screenshot, so this only needs to open the modal and confirm.
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15000 });

    // Make sure "Details Only" is selected even if the default ever
    // changes -- clicking it when already selected is a harmless no-op.
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

    // Parse exactly like state.html's autoImport does (same library, same
    // column mapping) so behavior is identical regardless of which path
    // the data came in through.
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: '' });
    if (!rows.length) {
      await recordFailure('Downloaded report parsed to zero rows -- export may have failed silently or the report is genuinely empty.', null);
      return { statusCode: 200, body: 'zero rows' };
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
        return { statusCode: 200, body: 'unexpected columns' };
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
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[salesforce-report-sync] Unhandled error:', err);
    await recordFailure('Unhandled error: ' + err.message, null);
    return { statusCode: 200, body: 'error handled' };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* already closing */ }
    }
    try { await store.delete('in-progress'); } catch (e) { /* fine if already gone */ }
  }
};
