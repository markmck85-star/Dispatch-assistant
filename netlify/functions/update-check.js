/* update-check.js
 *
 * Shared by the dispatch app's pages. A page that stays open all day (a PC left
 * running, a phone that never closes the tab) keeps running the code and the
 * lookup data it loaded when it opened, however many times the site is
 * redeployed. This script notices when that has happened and shows a small
 * "new version available" bar. It NEVER reloads on its own: a dispatcher may be
 * halfway through pasting a list or filling in a form, so reloading is always
 * the dispatcher's choice.
 *
 * How it works (no build step needed, nothing to bump by hand):
 *   - Right after the page loads it fetches fresh copies of the page itself and
 *     of every same-origin script the page loads, and remembers a short
 *     fingerprint (hash) of their contents. That is the baseline.
 *   - Every few minutes while the tab is visible, and again when a hidden tab
 *     comes back to the foreground, it repeats the fetch. If the fingerprint
 *     differs, the deployed files changed, so the bar appears.
 *   - Fetches use cache:'no-cache', so when nothing changed the server answers
 *     "not modified" and almost nothing is downloaded.
 *   - It only compares the page and its own scripts, so a deploy that touched
 *     some other page does not nag this one.
 *
 * Failure is silent: if the network is down or a fetch fails, it just tries
 * again later. It adds no dependencies and never throws into the page.
 */
(function () {
  'use strict';
  if (window.__appUpdateCheckLoaded) return;
  window.__appUpdateCheckLoaded = true;

  var CHECK_EVERY_MS = 10 * 60 * 1000;   // while the tab is visible
  var MIN_GAP_MS = 60 * 1000;            // never check more often than this
  var SNOOZE_MS = 60 * 60 * 1000;        // "Later" hides the bar for an hour

  var baseline = null;       // fingerprint of what this page is running
  var lastCheck = 0;
  var snoozedUntil = 0;
  var bar = null;
  var timer = null;
  var busy = false;

  function hashText(s) {
    // djb2: small, fast, and good enough to tell "same file" from "changed file".
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  // The page itself plus every same-origin script it loads.
  function watchedUrls() {
    var urls = [location.pathname];
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].getAttribute('src');
      if (!src || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src)) continue;   // inline or external host
      try {
        var u = new URL(src, location.href);
        if (u.origin === location.origin && urls.indexOf(u.pathname) < 0) urls.push(u.pathname);
      } catch (e) { /* ignore a malformed src */ }
    }
    return urls;
  }

  function fingerprint() {
    var urls = watchedUrls();
    return Promise.all(urls.map(function (u) {
      return fetch(u, { cache: 'no-cache', credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (t) { return u + '=' + hashText(t); });
    })).then(function (parts) { return parts.join('|'); });
  }

  function showBar() {
    if (bar || Date.now() < snoozedUntil) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)',
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 14px)', 'z-index:30000',
      'display:flex', 'align-items:center', 'gap:10px', 'flex-wrap:wrap', 'justify-content:center',
      'max-width:min(94vw, 460px)', 'padding:10px 14px', 'border-radius:10px',
      'background:#1f3a5f', 'color:#ffffff', 'font:600 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 6px 22px rgba(0,0,0,0.35)'
    ].join(';');
    var msg = document.createElement('span');
    msg.textContent = 'A new version is available. Finish what you are doing, then refresh.';
    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Refresh';
    go.style.cssText = 'cursor:pointer;border:0;border-radius:6px;padding:6px 12px;font:700 13px inherit;background:#ffffff;color:#1f3a5f;';
    go.addEventListener('click', function () { location.reload(); });
    var later = document.createElement('button');
    later.type = 'button';
    later.textContent = 'Later';
    later.style.cssText = 'cursor:pointer;border:1px solid rgba(255,255,255,0.6);border-radius:6px;padding:5px 11px;font:600 13px inherit;background:transparent;color:#ffffff;';
    later.addEventListener('click', function () {
      snoozedUntil = Date.now() + SNOOZE_MS;
      hideBar();
    });
    bar.appendChild(msg);
    bar.appendChild(go);
    bar.appendChild(later);
    document.body.appendChild(bar);
  }

  function hideBar() {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
  }

  function check(force) {
    if (busy) return;
    var now = Date.now();
    if (!force && now - lastCheck < MIN_GAP_MS) return;
    busy = true;
    lastCheck = now;
    fingerprint().then(function (fp) {
      busy = false;
      if (baseline === null) { baseline = fp; return; }
      if (fp !== baseline) {
        // A snoozed bar comes back after the snooze, as long as the files still differ.
        if (Date.now() >= snoozedUntil) showBar();
      } else {
        hideBar();
      }
    }).catch(function () { busy = false; /* offline or a hiccup: try again next time */ });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) check(false); }, CHECK_EVERY_MS);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) check(false);     // a tab (or PC) waking up after a long time
  });
  window.addEventListener('online', function () { check(false); });

  function start() {
    check(true);      // establishes the baseline right after load
    schedule();
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', function () { setTimeout(start, 500); });

  // Exposed for testing / a future "check now" link; harmless otherwise.
  window.AppUpdateCheck = { check: function () { check(true); }, baseline: function () { return baseline; } };
})();
