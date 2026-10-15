/* auth-shim.js -- shown only when a function call is refused for lack of a
 * sign-in. Opens a small sign-in box, signs in through login.js (which sets
 * the secure cookie), then repeats the refused call so the page carries on.
 * Loaded into every page by netlify/edge-functions/inject-auth.js.
 */
(function () {
  'use strict';
  if (window.__mcrAuthShim) return;
  window.__mcrAuthShim = true;

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!nativeFetch) return;

  var waiting = null; // one shared sign-in promise

  function isFunctionCall(input) {
    try {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      var a = new URL(u, location.href);
      return a.origin === location.origin && a.pathname.indexOf('/.netlify/functions/') === 0;
    } catch (e) { return false; }
  }

  function isLogin(input) {
    try {
      var u = typeof input === 'string' ? input : (input && input.url) || '';
      return /\/\.netlify\/functions\/login(\?|$)/.test(new URL(u, location.href).pathname + (new URL(u, location.href).search || ''));
    } catch (e) { return false; }
  }

  function buildBox() {
    var wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.72);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px';
    wrap.innerHTML =
      '<form style="background:#fff;color:#1f2937;width:100%;max-width:340px;border-radius:12px;padding:22px;box-shadow:0 10px 40px rgba(0,0,0,.35)">' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:4px">Sign in</div>' +
      '<div style="font-size:13px;color:#6b7280;margin-bottom:14px">Your session ended or this page needs a sign-in.</div>' +
      '<input name="u" autocomplete="username" placeholder="Username" autocapitalize="none" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:8px;font-size:15px">' +
      '<input name="p" type="password" autocomplete="current-password" placeholder="PIN or passphrase" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:8px;font-size:15px">' +
      '<div data-err style="color:#b91c1c;font-size:13px;min-height:18px;margin-bottom:6px"></div>' +
      '<button type="submit" style="width:100%;padding:11px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;font-size:15px;font-weight:600;cursor:pointer">Sign in</button>' +
      '</form>';
    return wrap;
  }

  function promptSignIn() {
    if (waiting) return waiting;
    waiting = new Promise(function (resolve) {
      function show() {
        var box = buildBox();
        var form = box.querySelector('form');
        var err = box.querySelector('[data-err]');
        document.body.appendChild(box);
        form.u.focus();
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          err.textContent = '';
          var btn = form.querySelector('button');
          btn.disabled = true;
          nativeFetch('/.netlify/functions/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: form.u.value.trim(), pin: form.p.value }),
            credentials: 'same-origin'
          }).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
          }).then(function (res) {
            btn.disabled = false;
            if (!res.ok) { err.textContent = res.d.error || 'Sign in failed'; form.p.value = ''; form.p.focus(); return; }
            try {
              if (!sessionStorage.getItem('dispatchUser')) sessionStorage.setItem('dispatchUser', JSON.stringify(res.d));
            } catch (e) {}
            box.remove();
            waiting = null;
            resolve(true);
          }).catch(function () {
            btn.disabled = false;
            err.textContent = 'Connection error. Try again.';
          });
        });
      }
      if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
    });
    return waiting;
  }

  function refused(res) {
    return res && res.status === 401 && res.headers && res.headers.get('x-mcr-gate') === 'deny';
  }

  window.fetch = function (input, init) {
    if (!isFunctionCall(input) || isLogin(input)) return nativeFetch(input, init);
    var retryInput = input;
    try { if (typeof Request !== 'undefined' && input instanceof Request) retryInput = input.clone(); } catch (e) {}
    return nativeFetch(input, init).then(function (res) {
      if (!refused(res)) return res;
      return promptSignIn().then(function () { return nativeFetch(retryInput, init); });
    });
  };
})();
