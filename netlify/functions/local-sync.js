// local-sync.js
//
// Standalone version of salesforce-report-sync-background.mjs, built
// 2026-07-28 to run on Mark's own PC instead of Netlify's servers --
// specifically to test whether Salesforce is blocking on IP reputation
// (Netlify Functions run on AWS) or on automation detection generally
// (which would fail here too, regardless of network). Same login and
// report-export logic as the Netlify version; the only real differences
// are: uses regular `playwright` (downloads its own Chromium) instead of
// playwright-core + @sparticuz/chromium (serverless-only), reads
// credentials from a local .env file instead of Netlify environment
// variables, and runs with headless:false by default so you can actually
// WATCH it log in and click through -- genuinely useful for confirming the
// selectors are hitting the right things, not just for solving the IP
// question.
//
// ── ONE-TIME SETUP ──────────────────────────────────────────────────────
// 1. Install Node.js if you don't have it: https://nodejs.org (LTS version)
// 2. Put this file in its own folder, then in that folder run:
//      npm init -y
//      npm install playwright @supabase/supabase-js xlsx dotenv
//      npx playwright install chromium
// 3. In that same folder, create a file named exactly `.env` (just a dot,
//    then "env" -- some systems hide files starting with a dot; if you
//    can't see it after creating it, it probably still worked) containing:
//      SALESFORCE_USERNAME=your_username_here
//      SALESFORCE_PASSWORD=your_password_here
//      SUPABASE_URL=your_supabase_project_url
//      SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
//    (Same Supabase values already sitting in Netlify's environment
//    variables -- copy them from there rather than hunting them down
//    again.)
//
//    Optional: add a line `DEBUG_SHOW_CREDENTIALS=true` to that same .env
//    file if you want the script to print the actual username/password it
//    typed into the form (only to your own terminal, never sent anywhere)
//    for a byte-for-byte comparison against your password manager --
//    useful if a length-only check isn't enough to rule out a subtle typo
//    or stray character. Leave it out (or set to false) otherwise.
// 4. Copy lib/perform-import.js from the dispatch app's repo into a `lib`
//    subfolder right next to this file (same relative path as in the repo).
//
// ── RUNNING IT ──────────────────────────────────────────────────────────
//    node local-sync.js
//
// A real Chrome window will open and you can watch it work. Close it
// anytime with Ctrl+C in the terminal if something looks wrong.

require('dotenv').config();
const { chromium: playwright } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { performImport } = require('./lib/perform-import');

const REPORT_URL = process.env.SALESFORCE_REPORT_URL
  || 'https://iti4dmv.my.salesforce.com/lightning/r/Report/00OVN000003SjTV2A0/view';

async function main() {
  const username = (process.env.SALESFORCE_USERNAME || '').trim();
  const password = (process.env.SALESFORCE_PASSWORD || '').trim();
  if (!username || !password) {
    console.error('Missing SALESFORCE_USERNAME or SALESFORCE_PASSWORD in .env file.');
    process.exit(1);
  }
  console.log(`Credential check -- username length: ${username.length}, password length: ${password.length}.`);

  console.log('Launching browser (you should see a window open)...');
  const browser = await playwright.launch({ headless: false });
  const page = await browser.newPage();

  // Playwright (and Selenium/Puppeteer) automatically set
  // navigator.webdriver = true on any page they control, even in a normal
  // visible browser window -- some bot-detection systems check specifically
  // for this and react to it regardless of whether the credentials are
  // correct or where the traffic is coming from. This overrides it before
  // any page script runs, which is the standard fix for exactly this.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  page.setDefaultTimeout(30000);

  try {
    console.log('Navigating to report (will bounce through login if needed)...');
    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });

    const onLoginPage = await page.waitForSelector('#username', { timeout: 8000 }).then(() => true).catch(() => false);
    if (onLoginPage) {
      console.log('On login page -- filling credentials...');
      await page.click('#username');
      await page.type('#username', username, { delay: 40 });
      await page.click('#password');
      await page.type('#password', password, { delay: 40 });

      const filledUsername = await page.inputValue('#username').catch(() => '');
      const filledPassword = await page.inputValue('#password').catch(() => '');
      console.log(`Field check before submit -- username field length: ${filledUsername.length} (expected ${username.length}), password field length: ${filledPassword.length} (expected ${password.length})`);
      if (process.env.DEBUG_SHOW_CREDENTIALS === 'true') {
        // Opt-in only (set DEBUG_SHOW_CREDENTIALS=true in .env) -- prints
        // the actual values to YOUR terminal only, nothing sent anywhere,
        // for a byte-for-byte visual check against what's in your password
        // manager. Length checks alone can't catch things like a stray
        // curly quote from autocorrect or an invisible character from
        // copy-paste. Remove/rotate the password after if this makes you
        // uneasy having displayed even locally -- your call.
        console.log(`  [DEBUG] Field holds username: "${filledUsername}"`);
        console.log(`  [DEBUG] Field holds password: "${filledPassword}"`);
        console.log(`  [DEBUG] Expected username:     "${username}"`);
        console.log(`  [DEBUG] Expected password:     "${password}"`);
      }
      if (filledUsername.length !== username.length || filledPassword.length !== password.length) {
        throw new Error('Login fields did not hold the expected values before submit.');
      }

      await page.click('#Login');
      await page.waitForLoadState('domcontentloaded');

      const needsVerification = await page.getByText(/verify your identity/i).isVisible().catch(() => false);
      if (needsVerification) {
        throw new Error('Salesforce is asking for identity verification -- complete it manually in the open browser window, then re-run this script.');
      }

      const loginError = await page.locator('#error').isVisible().catch(() => false);
      if (loginError) {
        const errText = await page.locator('#error').innerText().catch(() => '(could not read error text)');
        throw new Error('Salesforce login rejected: ' + errText);
      }
      console.log('Login accepted.');
    } else {
      console.log('Already logged in (or landed straight on the report) -- skipping login step.');
    }

    if (!page.url().includes('/lightning/r/Report/')) {
      await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
    }
    console.log('Waiting for report to render...');
    await page.waitForSelector('text=Export', { timeout: 45000 });

    console.log('Clicking Export...');
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 15000 });
    await dialog.getByText('Details Only', { exact: false }).click().catch(() => {});

    console.log('Confirming export and waiting for download...');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      dialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);

    const tmpPath = path.join(__dirname, 'sf-export-' + Date.now() + '.xls');
    await download.saveAs(tmpPath);
    const buffer = fs.readFileSync(tmpPath);
    console.log('Download saved and read -- parsing...');

    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(ws, { raw: true, defval: '' });
    console.log(`Parsed ${rows.length} rows.`);
    if (!rows.length) throw new Error('Downloaded report parsed to zero rows.');

    rows = rows.map((r) => {
      const out = {};
      for (const k of Object.keys(r)) out[k.trim()] = r[k];
      return out;
    });
    const required = ['Account Name', 'Jurisdiction', 'Appointment Number'];
    for (const col of required) {
      if (!(col in rows[0])) throw new Error(`Missing expected column "${col}". Columns found: ${Object.keys(rows[0]).join(', ')}`);
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

    console.log('Importing into Supabase...');
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

    fs.unlinkSync(tmpPath); // clean up the downloaded file

    console.log('\n=== SUCCESS ===');
    console.log(`${totalInserted} imported, ${totalSkipped} already on file, ${totalNeedsReview} need site review, ${allRowErrors.length} row error(s).`);
    if (allRowErrors.length) {
      console.log('Row errors:', allRowErrors.slice(0, 10));
    }
  } catch (err) {
    console.log('\n=== FAILED ===');
    console.error(err.message);
    const shotPath = path.join(__dirname, 'failure-screenshot-' + Date.now() + '.png');
    try {
      await page.screenshot({ path: shotPath, fullPage: true });
      console.log('Screenshot saved to:', shotPath);
    } catch (shotErr) {
      console.log('Could not capture screenshot:', shotErr.message);
    }
  } finally {
    console.log('\nLeaving the browser window open for 15 seconds so you can look at it, then closing...');
    await new Promise((r) => setTimeout(r, 15000));
    await browser.close();
  }
}

main();
