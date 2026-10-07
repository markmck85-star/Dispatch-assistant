/* traffic-panel.js — v1 — 2026-10-06
 *
 * "Georgia traffic" panel for the State Console (state.html). Collapsible,
 * dark theme, loads only when opened, same mounting style as digest-panel.js:
 *
 *   TrafficPanel.mount(hostElement, {
 *     theme: 'dark' | 'light',
 *     collapsible: true | false,
 *     getState: () => 'GA',            // which territory is selected
 *     stateSelectEl: <select>,         // optional: follow the State Console dropdown
 *     storageKey: 'mcr_state_traffic_open',
 *   })
 *
 * Only shows for Georgia (the GA territory = GA + NC + SC); for any other
 * state the panel hides itself, because 511GA only covers Georgia roads.
 *
 * Data comes from /.netlify/functions/get-traffic, which keeps one shared
 * cached copy of the 511GA feed. Opening or refreshing the panel never calls
 * 511GA directly and never exposes the key.
 */
(function (global) {
  'use strict';

  var FN_TRAFFIC = '/.netlify/functions/get-traffic';
  var AUTO_REFRESH_MS = 3 * 60 * 1000;
  var SUPPORTED = { GA: true, MI: true };
  var SOURCE_NAME = { GA: '511GA, Georgia DOT', MI: 'MDOT RIDE' };
  var PANEL_TITLE = { GA: 'Georgia traffic', MI: 'Michigan traffic' };

  var TYPE_LABEL = {
    accidentsAndIncidents: 'Incident', closures: 'Closure', specialEvents: 'Special event', roadwork: 'Road closure',
  };

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  var CSS = [
    '.tp-root{--tp-text:#1f2933;--tp-muted:#52606d;--tp-card:#f7f9fb;--tp-border:#e3e8ee;--tp-title:#1f3a5f;--tp-bg:#ffffff;--tp-accent:#1a56a8;--tp-pill:#f3f5f8;font-size:14px;color:var(--tp-text);line-height:1.45;}',
    '.tp-root.tp-dark{--tp-text:#e6e6e6;--tp-muted:#a0a6ad;--tp-card:#242424;--tp-border:#3a3a3a;--tp-title:#f0a500;--tp-bg:#1e1e1e;--tp-accent:#4a9eda;--tp-pill:#262626;}',
    '.tp-root *{box-sizing:border-box;}',
    '.tp-wrap{background:var(--tp-bg);border:1px solid var(--tp-border);border-radius:8px;margin:0 0 14px;}',
    '.tp-head{display:flex;align-items:center;gap:8px;width:100%;padding:11px 12px;background:none;border:0;cursor:pointer;color:var(--tp-title);font-size:15px;font-weight:700;text-align:left;}',
    '.tp-head .tp-chev{color:var(--tp-muted);font-size:12px;}',
    '.tp-head .tp-badge{margin-left:auto;font-size:12px;font-weight:600;color:var(--tp-muted);}',
    '.tp-body{padding:0 12px 12px;}',
    '.tp-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:2px 0 8px;}',
    '.tp-btn{font-size:13px;font-weight:600;padding:6px 11px;border-radius:6px;border:1px solid var(--tp-accent);background:transparent;color:var(--tp-accent);cursor:pointer;}',
    '.tp-btn:disabled{opacity:.6;cursor:default;}',
    '.tp-status{font-size:12px;color:var(--tp-muted);margin:0 0 8px;}',
    '.tp-warn{font-size:12.5px;color:#d99a3d;margin:0 0 8px;}',
    '.tp-err{color:#e07a6e;font-size:13.5px;padding:8px 0;}',
    '.tp-pills{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px;}',
    '.tp-pill{flex:1 1 130px;border-radius:8px;padding:8px 12px;background:var(--tp-pill);border:1px solid var(--tp-border);}',
    '.tp-pill .big{font-size:18px;font-weight:700;color:var(--tp-title);}',
    '.tp-pill .sm{font-size:12px;color:var(--tp-muted);}',
    '.tp-sec{border:1px solid var(--tp-border);border-radius:8px;margin-bottom:8px;background:var(--tp-bg);}',
    '.tp-sec>summary{cursor:pointer;padding:9px 11px;font-weight:700;color:var(--tp-title);font-size:14px;list-style:none;display:flex;gap:7px;align-items:center;}',
    '.tp-sec>summary::-webkit-details-marker{display:none;}',
    '.tp-sec>summary::before{content:"\\25B8";color:var(--tp-muted);}',
    '.tp-sec[open]>summary::before{content:"\\25BE";}',
    '.tp-count{font-weight:500;color:var(--tp-muted);font-size:12.5px;}',
    '.tp-sbody{padding:0 11px 10px;}',
    '.tp-empty{color:var(--tp-muted);font-size:13px;padding:3px 0;}',
    '.tp-site{border-left:4px solid #8d99a8;background:var(--tp-card);border-radius:4px;padding:8px 10px;margin-bottom:6px;}',
    '.tp-site.high{border-left-color:#b03a3a;}',
    '.tp-site.info{border-left-color:#2f5f8f;}',
    '.tp-site .t{font-weight:600;font-size:14px;}',
    '.tp-site .m{color:var(--tp-muted);font-size:12.5px;margin-top:1px;}',
    '.tp-ev{margin-top:6px;padding-top:6px;border-top:1px solid var(--tp-border);font-size:13px;}',
    '.tp-ev:first-of-type{border-top:0;padding-top:0;margin-top:5px;}',
    '.tp-ev .d{color:var(--tp-muted);font-size:12.5px;}',
    '.tp-item{border-left:4px solid #8d99a8;background:var(--tp-card);border-radius:4px;padding:7px 9px;margin-bottom:5px;font-size:13px;}',
    '.tp-item.high{border-left-color:#b03a3a;}',
    '.tp-tag{display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:4px;background:#dfe5ec;color:#3e4c59;margin-left:6px;vertical-align:middle;}',
    '.tp-tag.red{background:#f3dcdc;color:#8a2b2b;}',
    '.tp-tag.amber{background:#f6e6cf;color:#8a5210;}',
    '.tp-foot{font-size:11.5px;color:var(--tp-muted);margin-top:6px;}',
  ].join('\n');

  function injectCss() {
    if (document.getElementById('tp-css')) return;
    var st = document.createElement('style');
    st.id = 'tp-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function timeET(iso) {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
    } catch (e) { return ''; }
  }
  function ago(iso) {
    if (!iso) return '';
    var min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (!isFinite(min)) return '';
    if (min < 2) return 'just now';
    if (min < 90) return min + ' min ago';
    var h = Math.round(min / 60);
    return h < 36 ? h + ' hr ago' : '';
  }
  function tag(text, color) { return '<span class="tp-tag ' + (color || '') + '">' + esc(text) + '</span>'; }
  var secOpen = {}; // remembers which sections the viewer opened or closed across refreshes
  function sec(key, title, count, body, open) {
    if (secOpen[key] !== undefined) open = secOpen[key];
    return '<details class="tp-sec" data-tp-sec="' + key + '"' + (open ? ' open' : '') + '><summary>' + title +
      (count == null ? '' : ' <span class="tp-count">(' + count + ')</span>') + '</summary><div class="tp-sbody">' + body + '</div></details>';
  }
  var empty = function (t) { return '<div class="tp-empty">' + esc(t) + '</div>'; };

  function roadText(e) {
    var r = (e.roadway || 'Road') + (e.direction && !/both|all/i.test(e.direction) ? ' ' + e.direction : '');
    return esc(r);
  }
  function eventTags(e) {
    var label = TYPE_LABEL[e.eventType] || 'Event';
    if (e.eventType === 'accidentsAndIncidents' && e.subtype) label = 'Incident: ' + e.subtype;
    var h = tag(label, e.eventType === 'accidentsAndIncidents' ? 'amber' : '');
    if (e.isFullClosure) h += tag('Full closure', 'red');
    return h;
  }
  function eventLine(e, withDistance) {
    var bits = [];
    if (withDistance && e.distanceMiles != null) bits.push(e.distanceMiles + ' mi away');
    if (e.lanes) bits.push(e.lanes.replace(/\.$/, ''));
    var a = ago(e.updated);
    if (a) bits.push('updated ' + a);
    return '<div class="tp-ev"><div><b>' + roadText(e) + '</b>' + eventTags(e) + '</div>' +
      (e.description ? '<div class="d">' + esc(e.description) + '</div>' : '') +
      (bits.length ? '<div class="d">' + esc(bits.join(' \u00B7 ')) + '</div>' : '') + '</div>';
  }
  function reasonText(r) {
    if (r.kind === 'restock') return 'Restock today' + (r.technician ? ' \u00B7 ' + esc(r.technician) : '');
    if (r.kind === 'trouble') return 'Open trouble ticket' + (r.wo ? ' \u00B7 WO ' + esc(r.wo) : '');
    return esc(r.kind || '');
  }

  function mount(host, opts) {
    opts = Object.assign({ theme: 'light', collapsible: false, getState: null, stateSelectEl: null, storageKey: 'mcr_traffic_open' }, opts || {});
    injectCss();

    var root = document.createElement('div');
    root.className = 'tp-root tp-' + opts.theme;
    host.appendChild(root);

    var data = null;
    var loadedFor = null;
    var isOpen = !opts.collapsible;
    var seq = 0;
    var errorText = null;
    if (opts.collapsible) {
      try { isOpen = localStorage.getItem(opts.storageKey) === '1'; } catch (e) { isOpen = false; }
    }

    function getState() {
      if (typeof opts.getState === 'function') return String(opts.getState() || '').toUpperCase();
      if (opts.stateSelectEl) return String(opts.stateSelectEl.value || '').toUpperCase();
      return 'GA';
    }
    function applyVisibility() {
      var ok = !!SUPPORTED[getState()];
      root.style.display = ok ? '' : 'none';
      return ok;
    }

    function badgeText() {
      if (errorText && !data) return 'unavailable';
      if (!data) return '';
      var n = (data.nearSites || []).length;
      var parts = [];
      if (n) parts.push(n + (n === 1 ? ' stop affected' : ' stops affected'));
      else parts.push('clear near stops');
      if (data.stale) parts.push('old data');
      return parts.join(' \u00B7 ');
    }

    function shell() {
      var head = opts.collapsible
        ? '<button type="button" class="tp-head" data-tp-toggle><span class="tp-chev">' + (isOpen ? '\u25BE' : '\u25B8') + '</span>' +
          '<span>\uD83D\uDEA6 ' + esc(PANEL_TITLE[getState()] || 'Traffic') + '</span><span class="tp-badge">' + esc(badgeText()) + '</span></button>'
        : '';
      var body = '<div class="tp-body"' + (isOpen ? '' : ' style="display:none"') + '>' +
        '<div class="tp-bar"><button type="button" class="tp-btn" data-tp-refresh>Refresh</button></div>' +
        '<div class="tp-status" data-tp-status></div><div data-tp-out></div></div>';
      root.innerHTML = opts.collapsible ? '<div class="tp-wrap">' + head + body + '</div>' : '<div>' + body + '</div>';
    }
    function out() { return root.querySelector('[data-tp-out]'); }
    function setStatus(t) { var el = root.querySelector('[data-tp-status]'); if (el) el.textContent = t || ''; }

    // force = tap on Refresh (asks the server to refresh from 511GA if it has not just done so)
    // poll  = quiet re-read of the server's own cached copy (the auto-refresh timer)
    function load(force, poll) {
      if (!applyVisibility()) return;
      var state = getState();
      if (!force && !poll && data && loadedFor === state) { return render(); }
      var mine = ++seq;
      if (!poll) setStatus('Loading\u2026');
      var btn = root.querySelector('[data-tp-refresh]'); if (btn && !poll) btn.disabled = true;
      fetch(FN_TRAFFIC + '?state=' + encodeURIComponent(state) + (force ? '&refresh=1' : ''))
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (mine !== seq) return;
          if (!res.ok || !res.j.ok) throw new Error((res.j && res.j.error) || 'Request failed');
          data = res.j; loadedFor = state; errorText = null;
          shell(); render();
        })
        .catch(function (err) {
          if (mine !== seq) return;
          if (poll && data) return; // a failed background refresh keeps what is already on screen
          errorText = err.message || 'Request failed';
          shell();
          var o = out();
          if (o) o.innerHTML = '<div class="tp-err">Could not load traffic: ' + esc(errorText) + '</div>' +
            (data ? '<div class="tp-empty">Showing the last data that loaded.</div>' : '');
          if (data) render(true);
          setStatus('');
        });
    }

    function render(keepError) {
      var d = data; if (!d || d.supported === false) return;
      var t = d.totals || {};
      var status = d.fetchedAt ? 'Updated ' + timeET(d.fetchedAt) : '';
      status += (status ? ' \u00B7 ' : '') + (t.feedEvents != null ? t.active + ' active of ' + t.feedEvents + ' events statewide' : '');
      setStatus(status);

      var h = '';
      if (d.stale) h += '<div class="tp-warn">This data is more than a few minutes old' + (d.feedError ? ' (the feed is not responding: ' + esc(d.feedError) + ')' : '') + '.</div>';
      else if (d.feedError) h += '<div class="tp-warn">' + esc(d.feedError) + '</div>';

      h += '<div class="tp-pills">' +
        '<div class="tp-pill"><div class="sm">Incidents</div><div class="big">' + (t.incidents || 0) + '</div></div>' +
        '<div class="tp-pill"><div class="sm">Closures</div><div class="big">' + (t.closures || 0) + '</div><div class="sm">' + (t.fullClosures || 0) + ' full road closures</div></div>' +
        '<div class="tp-pill"><div class="sm">Roadwork</div><div class="big">' + (t.roadwork || 0) + '</div></div></div>';

      // Near today's stops and open trouble tickets
      var near = d.nearSites || [];
      var nearBody = '';
      if (d.nearSitesError) nearBody += '<div class="tp-err">' + esc(d.nearSitesError) + '</div>';
      if (!near.length && !d.nearSitesError) {
        nearBody = d.sitesChecked
          ? empty('Nothing reported within ' + d.radiusMiles + ' miles of the ' + d.sitesChecked + ' site' + (d.sitesChecked === 1 ? '' : 's') + ' on today\u2019s board or with open trouble tickets.')
          : empty('No stops on today\u2019s board or open trouble tickets with a map location.');
      }
      near.forEach(function (s) {
        nearBody += '<div class="tp-site ' + (s.level === 'high' ? 'high' : 'info') + '"><div class="t">' + esc(s.siteCode) + ' ' + esc(s.siteName) + '</div>' +
          '<div class="m">' + (s.reasons || []).map(reasonText).join(' \u00B7 ') + '</div>' +
          (s.events || []).map(function (e) { return eventLine(e, true); }).join('') +
          (s.totalNearby > (s.events || []).length ? '<div class="d tp-empty">and ' + (s.totalNearby - s.events.length) + ' more nearby</div>' : '') + '</div>';
      });
      if (d.sitesWithoutLocation) nearBody += '<div class="tp-foot">' + d.sitesWithoutLocation + ' site' + (d.sitesWithoutLocation === 1 ? ' has' : 's have') + ' no map location yet and could not be checked.</div>';
      h += sec('near', 'Near today\u2019s stops and open trouble tickets', near.length, nearBody, true);

      // Statewide
      var sw = d.statewide || [];
      h += sec('statewide', 'Statewide incidents and closures', sw.length ? sw.length + (((t.incidents || 0) + (t.closures || 0)) > sw.length ? '+' : '') : 0,
        sw.length ? sw.map(function (e) {
          return '<div class="tp-item ' + (e.isFullClosure ? 'high' : '') + '"><div><b>' + roadText(e) + '</b>' + eventTags(e) + '</div>' +
            (e.description ? '<div class="tp-ev"><div class="d">' + esc(e.description) + '</div></div>' : '') + '</div>';
        }).join('') : empty('No active incidents or closures reported.'), false);

      h += '<div class="tp-foot">Source: ' + esc(d.source || SOURCE_NAME[getState()] || 'DOT') + '. Traffic data refreshes about every 3 minutes; incidents are shown within ' + esc(d.radiusMiles) + ' miles of a site.</div>';

      var o = out();
      if (o) o.innerHTML = (keepError && o.innerHTML ? o.innerHTML : '') + h;
      var badge = root.querySelector('.tp-badge'); if (badge) badge.textContent = badgeText();
      var btn = root.querySelector('[data-tp-refresh]'); if (btn) btn.disabled = false;
    }

    root.addEventListener('toggle', function (e) {
      var el = e.target;
      if (el && el.getAttribute && el.getAttribute('data-tp-sec')) secOpen[el.getAttribute('data-tp-sec')] = el.open;
    }, true);

    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-tp-toggle],[data-tp-refresh]');
      if (!t) return;
      if (t.hasAttribute('data-tp-toggle')) {
        isOpen = !isOpen;
        try { localStorage.setItem(opts.storageKey, isOpen ? '1' : '0'); } catch (err) { /* ignore */ }
        var body = root.querySelector('.tp-body'); if (body) body.style.display = isOpen ? '' : 'none';
        var chev = root.querySelector('.tp-chev'); if (chev) chev.textContent = isOpen ? '\u25BE' : '\u25B8';
        if (isOpen) load(false);
        return;
      }
      if (t.hasAttribute('data-tp-refresh')) load(true);
    });

    if (opts.stateSelectEl) {
      opts.stateSelectEl.addEventListener('change', function () {
        data = null; loadedFor = null; errorText = null;
        shell();
        if (applyVisibility() && isOpen) load(true);
      });
    }

    // Keep an open panel current. The server caches the 511GA feed, so this
    // only re-reads our own cached copy and today's stops.
    setInterval(function () {
      if (document.hidden || !isOpen || !SUPPORTED[getState()]) return;
      load(false, true);
    }, AUTO_REFRESH_MS);

    shell();
    if (applyVisibility() && isOpen) load(false);
    return { reload: function () { load(true); } };
  }

  global.TrafficPanel = { mount: mount };
})(window);
