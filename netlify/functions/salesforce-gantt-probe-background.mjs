// salesforce-gantt-probe-background.mjs
//
// ONE-TIME DISCOVERY RUN (2026-10-27). Not part of the regular sync and nothing on the board
// reads it. Goal: learn how the Salesforce dispatch console Gantt exposes each technician's
// appointment status (Scheduled / Dispatched / In Progress / etc.) so a real status pass can be
// built. It logs in the same way the report sync does, opens the console home page (where the
// Gantt lives), waits for it to load, then records:
//   - every JSON/text response the page received: path (no query string), size, and whether it
//     mentions status / service appointments / resources
//   - the body (first 8000 chars) of the most promising few responses
//   - the visible text and class-name structure of the page and each iframe
//   - a small screenshot
// Everything is written to Supabase table gantt_probe_results (run_id groups one run), nothing
// else. Request bodies and cookies are never recorded. Read-only: it only loads pages.
//
// Run it by opening /.netlify/functions/salesforce-gantt-probe-background while signed in.
// Takes about 1-2 minutes. It sets the same in-progress flag the report sync uses, so the
// 20-minute sync skips itself instead of logging in at the same moment.

import { getStore } from '@netlify/blobs';
import { createClient } from '@supabase/supabase-js';
import { chromium as playwright } from 'playwright-core';
import chromium from '@sparticuz/chromium';

const HOME_URL = process.env.SALESFORCE_CONSOLE_URL || 'https://iti4dmv.my.site.com/dispatchconsole/s/';

export default async (req) => {
  const store = getStore('report-sync');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const runId = 'probe-' + new Date().toISOString();
  let order = 0;
  async function save(kind, note, payload) {
    try {
      await supabase.from('gantt_probe_results').insert({ run_id: runId, kind, note: note || null, payload: payload == null ? null : payload });
    } catch (e) { console.log('[gantt-probe] save failed', kind, e.message); }
  }

  // do not log in at the same time as the report sync
  const existingRaw = await store.get('in-progress').catch(() => null);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      const ageMs = Date.now() - new Date(existing.startedAt).getTime();
      if (ageMs < 6 * 60 * 1000) {
        await save('skipped', 'The report sync is running right now (started ' + Math.round(ageMs / 1000) + 's ago). Try again in a few minutes.', null);
        return;
      }
    } catch (e) { /* proceed */ }
  }
  await store.set('in-progress', JSON.stringify({ startedAt: new Date().toISOString(), trigger: 'probe', stage: 'Gantt probe' }));

  const username = (process.env.SALESFORCE_USERNAME || '').trim();
  const password = (process.env.SALESFORCE_PASSWORD || '').trim();
  let browser;
  try {
    if (!username || !password) { await save('error', 'SALESFORCE_USERNAME/PASSWORD not set', null); return; }

    browser = await playwright.launch({
      args: [...chromium.args, '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    page.setDefaultTimeout(30000);
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'font' || t === 'media') return route.abort();
      return route.continue();
    });

    // collect responses (bodies are read after load; kept in memory only until summarized)
    const seen = [];
    const pending = [];
    page.on('response', (resp) => {
      const p = (async () => {
        try {
          const url = resp.url();
          const ct = (resp.headers()['content-type'] || '').toLowerCase();
          if (!(ct.includes('json') || ct.includes('text'))) return;
          if (!/salesforce|force\.com|site\.com/.test(url)) return;
          const body = await resp.text().catch(() => '');
          if (!body || body.length > 3000000) { seen.push({ path: url.split('?')[0].slice(0, 200), status: resp.status(), bytes: body ? body.length : 0, skipped: 'size' }); return; }
          const hasSA = /ServiceAppointment|AppointmentNumber|"SA-\d+/.test(body);
          const hasStatus = /"Status"|"status"|StatusCategory|InProgress|Dispatched|Travel/.test(body);
          const hasRes = /ServiceResource|AssignedResource|"resourceId"|"ResourceId"/.test(body);
          seen.push({ path: url.split('?')[0].slice(0, 200), status: resp.status(), bytes: body.length, ct, hasSA, hasStatus, hasRes, body: (hasSA || hasRes) ? body : null });
        } catch (e) { /* ignore */ }
      })();
      pending.push(p);
    });

    try { await page.goto(HOME_URL, { waitUntil: 'commit' }); } catch (e) { /* often benign */ }
    await page.waitForTimeout(2500);
    const onLogin = await page.waitForSelector('#username', { timeout: 8000 }).then(() => true).catch(() => false);
    if (onLogin) {
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.click('#Login');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const verify = await page.getByText(/verify your identity/i).isVisible().catch(() => false);
      if (verify) { await save('error', 'Salesforce asked for identity verification', null); return; }
    }
    if (!/dispatchconsole\/s\/?(\?|$)/.test(page.url())) {
      try { await page.goto(HOME_URL, { waitUntil: 'commit' }); } catch (e) { /* ignore */ }
    }
    // let the Gantt load; check for its text a few times
    let ganttText = false;
    for (let i = 0; i < 12 && !ganttText; i++) {
      await page.waitForTimeout(3000);
      ganttText = await page.getByText(/Search resources/i).first().isVisible().catch(() => false);
    }
    await page.waitForTimeout(6000);
    await Promise.allSettled(pending);

    await save('summary', 'url=' + page.url() + ' gantt_text_seen=' + ganttText, {
      finalUrl: page.url(), ganttTextSeen: ganttText,
      responses: seen.map((s) => ({ path: s.path, status: s.status, bytes: s.bytes, hasSA: s.hasSA, hasStatus: s.hasStatus, hasRes: s.hasRes, skipped: s.skipped })).slice(0, 150),
    });

    // promising bodies: prefer ones that mention both appointments and resources
    const cands = seen.filter((s) => s.body).sort((a, b) => ((b.hasSA ? 2 : 0) + (b.hasRes ? 2 : 0) + (b.hasStatus ? 1 : 0)) - ((a.hasSA ? 2 : 0) + (a.hasRes ? 2 : 0) + (a.hasStatus ? 1 : 0))).slice(0, 8);
    for (const c of cands) await save('response', c.path + ' (' + c.bytes + ' bytes)', { path: c.path, bytes: c.bytes, flags: { sa: c.hasSA, status: c.hasStatus, resource: c.hasRes }, head: c.body.slice(0, 8000) });

    // page and iframe structure
    const frames = [];
    for (const f of page.frames()) {
      try {
        const info = await f.evaluate(() => {
          const txt = (document.body && document.body.innerText || '').slice(0, 3500);
          const classes = {};
          document.querySelectorAll('[class]').forEach((el) => {
            String(el.getAttribute('class') || '').split(/\s+/).forEach((c) => { if (/gantt|resource|appointment|bar|status|slds-.*row/i.test(c)) classes[c] = (classes[c] || 0) + 1; });
          });
          const rows = Array.from(document.querySelectorAll('[class*="resource"][class*="row"], [class*="gantt"][class*="row"]')).slice(0, 2).map((e) => e.outerHTML.slice(0, 3500));
          const bars = Array.from(document.querySelectorAll('[class*="appointment"], [class*="gantt-bar"], [class*="ganttBar"]')).slice(0, 3).map((e) => e.outerHTML.slice(0, 2500));
          return { txt, classes: Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 60), rows, bars };
        });
        frames.push({ url: f.url().split('?')[0].slice(0, 200), ...info });
      } catch (e) { frames.push({ url: f.url().split('?')[0].slice(0, 200), error: e.message }); }
    }
    await save('dom', 'page and frame structure', { frames });

    // small screenshot (jpeg) so the layout can be seen
    try {
      const shot = await page.screenshot({ type: 'jpeg', quality: 45 });
      await save('screenshot', 'jpeg base64, ' + shot.length + ' bytes', { b64: shot.toString('base64') });
    } catch (e) { await save('error', 'screenshot failed: ' + e.message, null); }

    await save('done', 'finished', null);
  } catch (err) {
    await save('error', 'Unhandled: ' + err.message, null);
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* closing */ } }
    try { await store.delete('in-progress'); } catch (e) { /* fine */ }
  }
};
