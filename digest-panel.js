/* digest-panel.js
 *
 * Shared "Morning brief / End of day" panel for the MCR dispatch app.
 * Used by state.html (collapsible, dark theme) and daily-digest.html (full page).
 *
 *   DigestPanel.mount(hostElement, {
 *     theme: 'light' | 'dark',
 *     collapsible: true | false,        // header you tap to open/close; loads only when opened
 *     getState: () => 'GA',             // which territory to show
 *     stateSelectEl: <select>,          // optional: reload when this changes
 *     storageKey: 'mcr_digest_open',    // remembers open/closed when collapsible
 *   })
 *
 * Data comes from /.netlify/functions/get-daily-digest. Special projects
 * (ribbon cuttings, delayed installs, etc.) are added/updated through
 * /.netlify/functions/special-projects.
 */
(function (global) {
  'use strict';

  var FN_DIGEST = '/.netlify/functions/get-daily-digest';
  var FN_PROJECTS = '/.netlify/functions/special-projects';

  var STATUS_LABEL = {
    planned: 'Planned', confirmed: 'Confirmed', waiting: 'Waiting on store or carrier',
    on_hold: 'On hold', rescheduled: 'Rescheduled', cancelled: 'Cancelled', done: 'Done',
  };
  var TYPE_LABEL = {
    ribbon_cutting: 'Ribbon cutting', install: 'Install', site_survey: 'Site survey',
    armored_truck_meet: 'Armored truck meet', other: 'Other',
  };
  var REASON = { vacation: 'Vacation', personal: 'Personal', pto: 'PTO', comp_day: 'Comp day', manual: 'Out', other: 'Out', last_day: 'Last day' };
  var MEET = { awaiting_response: 'Waiting on carrier', proposed: 'Time proposed', confirmed: 'Confirmed', needs_reschedule: 'Needs new time' };
  var ORIGIN = { carried_over: 'Carried over', overnight: 'Overnight', today: 'Today' };
  var SLA_TAG = { overdue: ['Past SLA', 'red'], due_today: ['Due today', 'amber'], later: ['Later', 'green'], stale: ['Likely closed', ''], unknown: ['No deadline', ''] };

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  // ------------------------------------------------------------------ styles
  var CSS = [
    '.dp-root{--dp-text:#1f2933;--dp-muted:#52606d;--dp-card:#f7f9fb;--dp-border:#e3e8ee;--dp-title:#1f3a5f;--dp-bg:#ffffff;--dp-accent:#1a56a8;--dp-input:#ffffff;--dp-inputborder:#c5cdd8;--dp-pill:#f3f5f8;font-size:14px;color:var(--dp-text);line-height:1.45;}',
    '.dp-root.dp-dark{--dp-text:#e6e6e6;--dp-muted:#a0a6ad;--dp-card:#242424;--dp-border:#3a3a3a;--dp-title:#f0a500;--dp-bg:#1e1e1e;--dp-accent:#4a9eda;--dp-input:#2a2a2a;--dp-inputborder:#555;--dp-pill:#262626;}',
    '.dp-root *{box-sizing:border-box;}',
    '.dp-wrap{background:var(--dp-bg);border:1px solid var(--dp-border);border-radius:8px;margin:0 0 14px;}',
    '.dp-head{display:flex;align-items:center;gap:8px;width:100%;padding:11px 12px;background:none;border:0;cursor:pointer;color:var(--dp-title);font-size:15px;font-weight:700;text-align:left;}',
    '.dp-head .dp-chev{color:var(--dp-muted);font-size:12px;}',
    '.dp-head .dp-badge{margin-left:auto;font-size:12px;font-weight:600;color:var(--dp-muted);}',
    '.dp-body{padding:0 12px 12px;}',
    '.dp-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:2px 0 8px;}',
    '.dp-btn{font-size:13px;font-weight:600;padding:6px 11px;border-radius:6px;border:1px solid var(--dp-accent);background:transparent;color:var(--dp-accent);cursor:pointer;}',
    '.dp-btn.on{background:var(--dp-accent);color:#fff;}',
    '.dp-btn.primary{background:var(--dp-accent);color:#fff;}',
    '.dp-btn.danger{border-color:#b03a3a;color:#b03a3a;}',
    '.dp-btn.small{font-size:12px;padding:3px 9px;margin-top:6px;}',
    '.dp-btn:disabled{opacity:.6;cursor:default;}',
    '.dp-status{font-size:12px;color:var(--dp-muted);margin:0 0 8px;}',
    '.dp-err{color:#c0392b;font-size:13.5px;padding:8px 0;}',
    '.dp-sec{border:1px solid var(--dp-border);border-radius:8px;margin-bottom:8px;background:var(--dp-bg);}',
    '.dp-sec>summary,.dp-sub>summary{cursor:pointer;padding:9px 11px;font-weight:700;color:var(--dp-title);font-size:14px;list-style:none;display:flex;gap:7px;align-items:center;}',
    '.dp-sec>summary::-webkit-details-marker,.dp-sub>summary::-webkit-details-marker{display:none;}',
    '.dp-sec>summary::before,.dp-sub>summary::before{content:"\\25B8";color:var(--dp-muted);}',
    '.dp-sec[open]>summary::before,.dp-sub[open]>summary::before{content:"\\25BE";}',
    '.dp-count{font-weight:500;color:var(--dp-muted);font-size:12.5px;}',
    '.dp-sbody{padding:0 11px 10px;}',
    '.dp-sub{margin-top:6px;}',
    '.dp-sub>summary{font-size:12.5px;color:var(--dp-muted);padding:5px 0;text-transform:uppercase;letter-spacing:.03em;}',
    '.dp-sub-note{font-size:12px;color:var(--dp-muted);margin:2px 0 8px;}',
    '.dp-empty{color:var(--dp-muted);font-size:13px;padding:3px 0;}',
    '.dp-lab{color:var(--dp-muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin:9px 0 4px;}',
    '.dp-item{border-left:4px solid #8d99a8;background:var(--dp-card);border-radius:4px;padding:7px 9px;margin-bottom:5px;}',
    '.dp-item .t{font-weight:600;font-size:14px;}',
    '.dp-item .m{color:var(--dp-muted);font-size:12.5px;margin-top:1px;}',
    '.dp-item.high,.dp-item.overdue{border-left-color:#b03a3a;}',
    '.dp-item.warn,.dp-item.due_today{border-left-color:#b45309;}',
    '.dp-item.ok,.dp-item.later{border-left-color:#2f7a68;}',
    '.dp-item.info{border-left-color:#2f5f8f;}',
    '.dp-item.muted,.dp-item.stale{border-left-color:#aab4c1;opacity:.85;}',
    '.dp-tag{display:inline-block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:1px 6px;border-radius:4px;background:#dfe5ec;color:#3e4c59;margin-left:6px;vertical-align:middle;}',
    '.dp-tag.red{background:#f3dcdc;color:#8a2b2b;}.dp-tag.amber{background:#f6e6cf;color:#8a5210;}.dp-tag.green{background:#d9ece6;color:#1f5f4f;}',
    '.dp-pills{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px;}',
    '.dp-pill{flex:1 1 180px;border-radius:8px;padding:9px 12px;background:var(--dp-pill);border:1px solid var(--dp-border);}',
    '.dp-pill .big{font-size:18px;font-weight:700;color:var(--dp-title);}',
    '.dp-pill .big.heavy{color:#c0504d;}.dp-pill .big.light{color:#2f9a80;}',
    '.dp-pill .sm{font-size:12px;color:var(--dp-muted);}',
    '.dp-pill.click{cursor:pointer;}.dp-pill.click:hover{border-color:var(--dp-accent);}',
    '.dp-overlay{position:fixed;inset:0;z-index:20000;background:rgba(16,24,40,.55);display:flex;align-items:center;justify-content:center;padding:12px;}',
    '.dp-modal{background:var(--dp-bg);color:var(--dp-text);border:1px solid var(--dp-border);border-radius:10px;padding:16px;width:100%;max-width:440px;max-height:92vh;overflow-y:auto;}',
    '.dp-modal h3{color:var(--dp-title);font-size:17px;margin:0 0 10px;}',
    '.dp-fg{margin-bottom:10px;}',
    '.dp-fg label{display:block;font-size:12px;font-weight:600;color:var(--dp-muted);margin-bottom:3px;}',
    '.dp-fg input,.dp-fg select,.dp-fg textarea{width:100%;padding:8px;font-size:14px;border-radius:6px;border:1px solid var(--dp-inputborder);background:var(--dp-input);color:var(--dp-text);font-family:inherit;}',
    '.dp-row{display:flex;gap:8px;}.dp-row>.dp-fg{flex:1;}',
    '.dp-act{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;flex-wrap:wrap;}',
  ].join('\n');

  function injectCss() {
    if (document.getElementById('dp-css')) return;
    var st = document.createElement('style');
    st.id = 'dp-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function item(cls, title, meta, tagHtml, extraHtml) {
    return '<div class="dp-item ' + cls + '"><div class="t">' + title + (tagHtml || '') + '</div>' +
      (meta ? '<div class="m">' + meta + '</div>' : '') + (extraHtml || '') + '</div>';
  }
  function tag(text, color) { return '<span class="dp-tag ' + (color || '') + '">' + esc(text) + '</span>'; }
  function sec(title, count, body, open) {
    return '<details class="dp-sec"' + (open ? ' open' : '') + '><summary>' + title +
      (count == null ? '' : ' <span class="dp-count">(' + count + ')</span>') + '</summary><div class="dp-sbody">' + body + '</div></details>';
  }
  function sub(title, count, body, open) {
    return '<details class="dp-sub"' + (open ? ' open' : '') + '><summary>' + title +
      (count == null ? '' : ' <span class="dp-count">(' + count + ')</span>') + '</summary>' + body + '</details>';
  }
  var empty = function (t) { return '<div class="dp-empty">' + esc(t) + '</div>'; };

  // ------------------------------------------------------------------ mount
  function mount(host, opts) {
    opts = Object.assign({ theme: 'light', collapsible: false, getState: null, stateSelectEl: null, storageKey: 'mcr_digest_open' }, opts || {});
    injectCss();

    var root = document.createElement('div');
    root.className = 'dp-root dp-' + opts.theme;
    host.appendChild(root);

    var mode = (new Date().getHours() < 14) ? 'morning' : 'evening';
    var data = null;
    var loadedFor = null;       // "STATE|mode" the current data belongs to
    var isOpen = !opts.collapsible;
    var loading = false;
    var wxOpen = false;         // weather detail list expanded (tap the Weather card)
    if (opts.collapsible) {
      try { isOpen = localStorage.getItem(opts.storageKey) === '1'; } catch (e) { isOpen = false; }
    }

    function getState() {
      if (typeof opts.getState === 'function') return String(opts.getState() || '').toUpperCase();
      if (opts.stateSelectEl) return String(opts.stateSelectEl.value || '').toUpperCase();
      return 'GA';
    }

    // Weather alerts are shown only through the Weather card, so they are not
    // repeated in the Needs attention list (or counted twice in the badge).
    // Same for "Out today/Out Mon, Oct 5: ..." lines: the Technicians out
    // section below already lists who is out and when.
    function attentionItems(d) {
      return ((d && d.attention) || []).filter(function (a) {
        var t = String((a && a.text) || '');
        return t.indexOf('Weather:') !== 0 && !/^Out [^:]*:/.test(t);
      });
    }
    function outCount(d) {
      var av = (d && d.availability) || {};
      return (av.outToday || []).length + (av.outNext || []).length;
    }
    function badgeText(d) {
      if (!d) return '';
      var parts = [];
      var n = attentionItems(d).length;
      if (n) parts.push(n + ' to review');
      var wx = (d.weather && d.weather.alerts) || [];
      if (wx.length) parts.push(wx.length + ' weather');
      var oc = outCount(d);
      if (oc) parts.push(oc + ' out');
      return parts.length ? parts.join(' \u00B7 ') : 'all clear';
    }

    // ---- shell
    function shell() {
      var title = mode === 'morning' ? 'Morning brief' : 'End of day';
      var badge = '';
      if (data && data.attention) badge = badgeText(data);
      var head = opts.collapsible
        ? '<button type="button" class="dp-head" data-dp-toggle><span class="dp-chev">' + (isOpen ? '\u25BE' : '\u25B8') + '</span>' +
          '<span>\uD83D\uDCCB ' + esc(title) + '</span><span class="dp-badge">' + esc(badge) + '</span></button>'
        : '';
      var body = '<div class="dp-body"' + (isOpen ? '' : ' style="display:none"') + '>' +
        '<div class="dp-bar">' +
        '<button type="button" class="dp-btn' + (mode === 'morning' ? ' on' : '') + '" data-dp-mode="morning">Morning brief</button>' +
        '<button type="button" class="dp-btn' + (mode === 'evening' ? ' on' : '') + '" data-dp-mode="evening">End of day</button>' +
        '<button type="button" class="dp-btn" data-dp-refresh>Refresh</button>' +
        '<button type="button" class="dp-btn primary" data-dp-add>+ Special project</button>' +
        '</div><div class="dp-status" data-dp-statusline></div><div data-dp-out></div></div>';
      root.innerHTML = (opts.collapsible ? '<div class="dp-wrap">' + head + body + '</div>' : '<div>' + body + '</div>');
    }

    function setStatus(t) { var el = root.querySelector('[data-dp-statusline]'); if (el) el.textContent = t || ''; }
    function out() { return root.querySelector('[data-dp-out]'); }

    // ---- load
    var seq = 0;   // newest request wins if the state or mode changes mid-load
    function load(force) {
      var state = getState();
      var key = state + '|' + mode;
      if (!force && data && loadedFor === key) { return render(); }
      var mine = ++seq;
      loading = true;
      setStatus('Loading\u2026');
      var o = out(); if (o) o.innerHTML = '';
      fetch(FN_DIGEST + '?state=' + encodeURIComponent(state) + '&mode=' + mode)
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (mine !== seq) return;
          if (!res.ok || !res.j.ok) throw new Error(res.j.error || 'Request failed');
          data = res.j; loadedFor = key; loading = false;
          shell(); render();
        })
        .catch(function (err) {
          if (mine !== seq) return;
          loading = false; data = null; loadedFor = null;
          shell();
          var o2 = out(); if (o2) o2.innerHTML = '<div class="dp-err">Could not load the brief: ' + esc(err.message) + '</div>';
          setStatus('');
        });
    }

    // ---- render
    function render() {
      var d = data; if (!d) return;
      var tzName = String(d.timezone || '').replace('America/', '').replace('_', ' ');
      setStatus(d.date + ' \u00B7 ' + tzName + ' \u00B7 generated ' +
        new Date(d.generatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
      var h = '';
      var tlUsedNext = false;

      // Needs attention
      var att = attentionItems(d);
      var alerts = (d.weather && d.weather.alerts) || [];
      h += sec('Needs attention', att.length,
        att.length ? att.map(function (a) { return item(a.level === 'high' ? 'high' : 'info', esc(a.text)); }).join('') : empty('Nothing flagged right now.'), true);

      // Workload + weather
      var w = d.dayWeight || {};
      var wl = { heavy: 'Heavy', light: 'Light', regular: 'Regular', none_yet: 'No stops yet', unknown: 'Not enough history' }[w.label] || '\u2014';
      var wSmall = esc(w.note || '');
      if (w.ratio != null) {
        wSmall = w.callsToday + ' stops, ' + w.availableTechs + ' techs available (' + w.callsPerTech + ' per tech vs ' + w.baselineCallsPerTech +
          ' usual, ' + w.ratio + 'x). Heavy at ' + w.heavyTrigger + 'x, light under ' + w.lightBelow + 'x.';
      }
      var wxBig = 'No severe alerts', wxSmall = '';
      if (d.weather && !d.weather.ok) { wxBig = 'Weather unavailable'; wxSmall = esc(d.weather.error || ''); }
      else if (alerts.length) { wxBig = alerts.length + ' severe alert' + (alerts.length === 1 ? '' : 's'); wxSmall = wxOpen ? 'Tap to hide details' : 'Tap for details'; }
      h += '<div class="dp-pills"><div class="dp-pill"><div class="sm">Workload</div><div class="big ' + esc(w.label) + '">' + esc(wl) + '</div><div class="sm">' + wSmall + '</div></div>' +
        '<div class="dp-pill' + (alerts.length ? ' click' : '') + '"' + (alerts.length ? ' data-dp-wx role="button" tabindex="0"' : '') + '><div class="sm">Weather</div><div class="big">' +
        (alerts.length ? '<span data-dp-wxchev>' + (wxOpen ? '\u25BE' : '\u25B8') + '</span> ' : '') + esc(wxBig) + '</div><div class="sm" data-dp-wxsm>' + wxSmall + '</div></div></div>';
      if (alerts.length) {
        h += '<div data-dp-wxlist style="' + (wxOpen ? '' : 'display:none;') + 'margin:0 0 10px;">' + alerts.map(function (a) {
          return item(a.severity === 'Extreme' ? 'high' : 'warn', esc(a.event), esc(a.areas) +
            (a.ends ? ' \u00B7 until ' + esc(new Date(a.ends).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : ''));
        }).join('') + '</div>';
      }

      // Workload by area (preview): same stops, but each area is compared with the techs who can reach it
      var aw = d.areaWeight;
      if (aw && (aw.areas || []).length) {
        var awLvl = { heavy: 'high', light: 'ok', regular: 'info', uncovered: 'high' };
        var awRows = aw.areas.map(function (a) {
          var meta = a.calls + (a.calls === 1 ? ' stop' : ' stops') + ' \u00B7 about ' + a.effectiveTechs + ' tech' + (a.effectiveTechs === 1 ? '' : 's') + ' can reach it';
          if (a.ratio != null) meta += ' \u00B7 ' + a.callsPerTech + ' per tech vs ' + a.baselineCallsPerTech + ' usual (' + a.ratio + 'x)';
          var tg = a.label === 'heavy' ? tag('Heavy', 'red') : (a.label === 'light' ? tag('Light', 'green') : (a.label === 'regular' ? tag('Regular') : (a.label === 'uncovered' ? tag('No one in range', 'red') : '')));
          var who = (a.reachers || []).slice(0, 8).map(function (r) { return esc(r.name.split(' ')[0]) + (r.reach < 0.995 ? ' (' + Math.round(r.reach * 100) + '%)' : ''); }).join(', ');
          return item(awLvl[a.label] || 'info', esc(a.name), esc(meta) + (a.note ? '<br>' + esc(a.note) : '') + (who ? '<br>Reach: ' + who : ''), tg);
        }).join('');
        var awHead = aw.busiest ? 'Busiest: ' + esc(aw.busiest.name) + ' \u00B7 ' + esc({ heavy: 'Heavy', light: 'Light', regular: 'Regular' }[aw.busiest.label] || '') + ' (' + aw.busiest.ratio + 'x usual)' : '';
        h += sec('Workload by area <span class="dp-count">(preview)</span>', null,
          (awHead ? '<div class="dp-sub-note">' + awHead + '</div>' : '') + awRows +
          '<div class="dp-sub-note">Preview only: it does not change the Workload label above. Each area is measured against the technicians who can reach it (full credit within an hour, tapering to none at two hours).</div>', false);
      }

      // Availability
      var av = d.availability || {};
      var names = function (arr) { return arr.map(function (t) { return esc(t.name) + (t.reason ? ' (' + esc(REASON[t.reason] || 'Out') + ')' : ''); }).join(', '); };
      var avHtml = '';
      [['Out today', av.outToday], ['Back today', av.returningToday], ['Out next workday', av.outNext], ['Back next workday', av.returningNext]].forEach(function (p) {
        if (!(p[1] && p[1].length)) return;
        var note = p[0] === 'Out next workday'
          ? '<br>If a next-day ticket comes in near their home, consider giving it to them today so another tech does not have to cover that drive while they are out.'
          : '';
        avHtml += item('info', esc(p[0]), names(p[1]) + note);
      });
      var avCount = (av.outToday || []).length + (av.outNext || []).length;
      h += sec('Technicians out', avCount, avHtml || empty('Everyone is in today and the next workday.'), avCount > 0);

      // Trouble tickets
      var tt = d.troubleTickets || [];
      var live = tt.filter(function (t) { return t.slaStatus !== 'stale'; });
      var stale = tt.filter(function (t) { return t.slaStatus === 'stale'; });
      var tItem = function (t) {
        var st = SLA_TAG[t.slaStatus] || SLA_TAG.unknown;
        var meta = esc(t.issueCategory || '') + (t.issueDetail ? ' \u00B7 ' + esc(t.issueDetail) : '') + '<br>' +
          (t.dueText ? 'Due ' + esc(t.dueText) + ' \u00B7 ' : '') + esc(ORIGIN[t.origin] || '') + (t.matched ? '' : ' \u00B7 site not matched') + (t.routedTo ? ' \u00B7 routed to ' + esc(t.routedTo) : '');
        return item(t.slaStatus, esc(t.siteText) + ' <span class="m">WO ' + esc(t.woNumber) + '</span>', meta, tag(st[0], st[1]));
      };
      h += sec('Trouble tickets', live.length, live.length ? live.map(tItem).join('') : empty('No open trouble tickets.'), live.length > 0);
      if (stale.length) h += sec('Overdue more than a few days (likely already closed)', stale.length, stale.map(tItem).join(''), false);

      // Special projects
      var sp = d.specialProjects || {};
      var projects = sp.projects || [];
      var onHold = sp.onHold || [];
      var meets = sp.armoredTruckMeets || [];
      var installs = sp.installs || [];
      var cal = sp.calendarProjects || [];
      var activeInstalls = installs.filter(function (i) { return i.when !== 'past'; });
      var pastInstalls = installs.filter(function (i) { return i.when === 'past'; });
      var spHtml = '';

      var projItem = function (p) {
        var cls = p.needsNudge ? 'high' : (p.when === 'today' ? 'warn' : (p.quiet ? 'muted' : 'info'));
        var st = (p.status === 'confirmed') ? tag(STATUS_LABEL[p.status], 'green') : (p.status === 'waiting' ? tag(STATUS_LABEL[p.status], 'amber') : tag(STATUS_LABEL[p.status] || p.status));
        var meta = esc(p.typeLabel) + ' \u00B7 ' + esc(p.whenText) + (p.location ? ' \u00B7 ' + esc(p.location) : '') +
          (p.holdUntilText ? ' \u00B7 hold until ' + esc(p.holdUntilText) : '') + (p.woNumber ? ' \u00B7 WO ' + esc(p.woNumber) : '');
        if (p.nudgeReason) meta += '<br><b>' + esc(p.nudgeReason) + '</b>';
        if (p.note) meta += '<br>' + esc(p.note);
        return item(cls, esc(p.title), meta, st,
          '<button type="button" class="dp-btn small" data-dp-edit="' + esc(p.id) + '">Update</button>');
      };
      if (projects.length) spHtml += '<div class="dp-lab">Dispatcher list</div>' + projects.map(projItem).join('');
      if (onHold.length) spHtml += sub('On hold', onHold.length, onHold.map(projItem).join(''), false);

      if (meets.length) {
        spHtml += '<div class="dp-lab">Armored truck meets</div>' + meets.map(function (m) {
          var cls = (m.needsNudge || m.meetStatus === 'needs_reschedule') ? 'high' : (m.when === 'today' ? 'warn' : 'info');
          var when = m.confirmedWallClock ? ' \u00B7 ' + esc(m.confirmedWallClock) : '';
          var last = m.daysSinceContact != null ? ' \u00B7 last carrier contact ' + (m.daysSinceContact === 0 ? 'today' : m.daysSinceContact + ' day' + (m.daysSinceContact === 1 ? '' : 's') + ' ago') : '';
          return item(cls, esc(m.siteText) + ' <span class="m">WO ' + esc(m.woNumber) + '</span>', esc(MEET[m.meetStatus] || m.meetStatus) + when + last);
        }).join('');
      }

      var WHEN = { today: 'Today', next: 'Next workday', later: 'Later', past: 'Past date', unscheduled: 'No date yet' };
      var instItem = function (i) {
        var late = i.daysLate > 0 ? ' \u00B7 ' + i.daysLate + ' day' + (i.daysLate === 1 ? '' : 's') + ' past' : '';
        return item(i.when === 'today' ? 'warn' : (i.when === 'past' ? 'muted' : 'info'),
          esc(i.siteText) + ' <span class="m">WO ' + esc(i.woNumber) + '</span>',
          esc(i.ticketKind === 'install' ? 'Install' : 'Site survey') + ' \u00B7 ' + (i.startText ? esc(i.startText) : esc(WHEN[i.when])) + late,
          '', '<button type="button" class="dp-btn small" data-dp-ticket="' + esc(i.ticketId) + '">Set status</button>');
      };
      if (activeInstalls.length) spHtml += '<div class="dp-lab">Installs and site surveys</div>' + activeInstalls.map(instItem).join('');
      if (pastInstalls.length) {
        spHtml += sub('Past date, still open', pastInstalls.length,
          '<div class="dp-empty">Not assumed closed. Delays happen, so mark each one on hold, waiting, or done.</div>' + pastInstalls.map(instItem).join(''), false);
      }

      if (cal.length) {
        spHtml += '<div class="dp-lab">From the team calendar</div>' + cal.map(function (c) {
          return item(c.when === 'today' ? 'warn' : 'info', esc(c.note || c.type), esc(c.type) + ' \u00B7 ' + esc(c.technicianName || '') + ' \u00B7 ' + (c.when === 'today' ? 'Today' : 'Next workday'));
        }).join('');
      }
      var spCount = projects.length + meets.length + activeInstalls.length + cal.length;
      h += sec('Special projects', spCount, spHtml || empty('Nothing scheduled. Use + Special project to add one.'),
        projects.length > 0 || meets.length > 0 || cal.length > 0 || activeInstalls.some(function (i) { return i.when === 'today'; }));

      // Restocks
      var r = d.restocks || { completed: [], stillOpen: [], removed: [], pushedFromPrevious: [] };
      var stop = function (cls) {
        return function (x) {
          return item(cls, esc(x.siteName), esc(x.siteCode || '') + (x.technicianName ? ' \u00B7 ' + esc(x.technicianName) : ''),
            x.pushedFromPrevious ? tag('Pushed from yesterday', 'amber') : '');
        };
      };
      var rHtml = '';
      if (r.stillOpen.length) rHtml += '<div class="dp-lab">Still open</div>' + r.stillOpen.map(stop('info')).join('');
      if (r.completed.length) rHtml += '<div class="dp-lab">Completed</div>' + r.completed.map(stop('ok')).join('');
      if (r.removed.length) rHtml += '<div class="dp-lab">Removed</div>' + r.removed.map(stop('muted')).join('');
      var pushedN = (r.pushedFromPrevious || []).length;
      h += sec('Restocks' + (pushedN ? ' \u00B7 ' + pushedN + ' pushed from yesterday' : ''), r.completed.length + r.stillOpen.length,
        rHtml || empty('No stops on the board for today.'), pushedN > 0);

      // Technician load
      var tl = d.techLoad || [];
      var tlTitle = 'Technician load';
      // When today has no stops (a Sunday, or before the board is built) but the
      // next workday does, show that day's load here instead of an empty section.
      if (!tl.length && (d.techLoadNext || []).length) {
        tl = d.techLoadNext;
        tlUsedNext = true;
        var tlDate = (d.preview && d.preview.date) || (d.availability && d.availability.nextDate);
        if (tlDate) {
          tlTitle += ' \u00B7 ' + new Date(tlDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        }
      }
      var over = tl.filter(function (t) { return t.overloaded; });
      h += sec(tlTitle, over.length ? over.length + ' flagged' : null,
        tl.length ? tl.map(function (t) {
          return item(t.overloaded ? 'high' : 'ok', esc(t.technicianName || 'Unassigned'),
            t.stops + ' stop' + (t.stops === 1 ? '' : 's') + ' \u00B7 about ' + esc(t.driveText) + ' driving' + (t.incompleteEstimate ? ' (some distances missing)' : '') + (t.reasons.length ? ' \u00B7 ' + esc(t.reasons.join(', ')) : ''));
        }).join('') : empty('No assigned stops yet.'), over.length > 0);

      // Saturday on-call
      if (d.saturday) {
        var s = d.saturday;
        var label = new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        var disp = s.dispatcher ? s.dispatcher.charAt(0).toUpperCase() + s.dispatcher.slice(1) : null;
        h += sec('On call ' + (s.isToday ? 'today' : 'this Saturday') + ' (' + esc(label) + ')', null,
          (disp ? item('info', esc(disp), 'On-call dispatcher') : '') +
          (s.technicians || []).map(function (t) { return item('info', esc(t.name || ''), 'On-call technician \u00B7 ' + esc(t.state)); }).join(''), s.isToday);
      }

      // Review + shipments
      var nr = d.needsReview || [];
      h += sec('Flagged for review', nr.length, nr.length ? nr.map(function (t) {
        return item('warn', esc(t.siteText) + ' <span class="m">WO ' + esc(t.woNumber) + '</span>', esc(t.issueCategory || '') + (t.issueDetail ? ' \u00B7 ' + esc(t.issueDetail) : ''));
      }).join('') : empty('Nothing flagged.'), false);
      var sh = d.openShipments || [];
      h += sec('Open return shipments', sh.length, sh.length ? sh.map(function (x) {
        return item('info', esc(x.siteName), esc(x.siteCode || '') + (x.needsReturn ? ' \u00B7 broken part to return' : '') + (x.warehouseName ? ' \u00B7 ' + esc(x.warehouseName) : ''));
      }).join('') : empty('None outstanding.'), false);

      // Evening preview
      if (d.preview) {
        var p = d.preview;
        var pl = new Date(p.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        var pHtml = '';
        if ((p.projects || []).length) pHtml += '<div class="dp-lab">Special projects</div>' + p.projects.map(function (x) { return item('info', esc(x.title), esc(x.typeLabel) + ' \u00B7 ' + esc(x.whenText)); }).join('');
        if (p.restocksQueued.length) pHtml += '<div class="dp-lab">Restocks already queued</div>' + p.restocksQueued.map(function (x) { return item('info', esc(x.siteName), esc(x.siteCode || '')); }).join('');
        if (p.installs.length) pHtml += '<div class="dp-lab">Installs and surveys</div>' + p.installs.map(function (i) { return item('info', esc(i.siteText), esc(i.startText || '')); }).join('');
        var tln = d.techLoadNext || [];
        if (tln.length && !tlUsedNext) pHtml += '<div class="dp-lab">Load so far</div>' + tln.map(function (t) { return item(t.overloaded ? 'high' : 'ok', esc(t.technicianName || 'Unassigned'), t.stops + ' stops \u00B7 about ' + esc(t.driveText) + ' driving'); }).join('');
        h += sec('Preview: ' + esc(pl), null, pHtml || empty('Nothing queued yet.'), true);
      }

      var o = out(); if (o) o.innerHTML = h;
      // keep the collapsed-header badge current
      var badgeEl = root.querySelector('.dp-badge');
      if (badgeEl) badgeEl.textContent = badgeText(d);
    }

    // ---- special project form
    function openForm(init) {
      init = init || {};
      var editing = !!init.id;
      var ov = document.createElement('div');
      ov.className = 'dp-root dp-' + opts.theme + ' dp-overlay';
      var typeOpts = Object.keys(TYPE_LABEL).map(function (k) { return '<option value="' + k + '"' + (init.type === k ? ' selected' : '') + '>' + TYPE_LABEL[k] + '</option>'; }).join('');
      var statusOpts = Object.keys(STATUS_LABEL).map(function (k) { return '<option value="' + k + '"' + ((init.status || 'planned') === k ? ' selected' : '') + '>' + STATUS_LABEL[k] + '</option>'; }).join('');
      ov.innerHTML =
        '<div class="dp-modal"><h3>' + (editing ? 'Update special project' : (init.ticketId ? 'Set status' : 'Add special project')) + '</h3>' +
        '<div class="dp-fg"><label>Type</label><select data-f="type">' + typeOpts + '</select></div>' +
        '<div class="dp-fg"><label>Title</label><input type="text" data-f="title" maxlength="120" placeholder="e.g. Ribbon cutting, Cobb DMV" value="' + esc(init.title || '') + '"></div>' +
        '<div class="dp-fg"><label>Location (optional)</label><input type="text" data-f="location" maxlength="160" value="' + esc(init.location || '') + '"></div>' +
        '<div class="dp-row"><div class="dp-fg"><label>Date</label><input type="date" data-f="date" value="' + esc(init.date || '') + '"></div>' +
        '<div class="dp-fg"><label>Time</label><input type="text" data-f="time" maxlength="20" placeholder="10:00 AM" value="' + esc(init.time || '') + '"></div></div>' +
        '<div class="dp-fg"><label>Status</label><select data-f="status">' + statusOpts + '</select></div>' +
        '<div class="dp-fg" data-hold style="display:none"><label>On hold until (optional)</label><input type="date" data-f="hold" value="' + esc(init.hold || '') + '"></div>' +
        '<div class="dp-fg"><label>Note (optional)</label><textarea rows="3" maxlength="500" data-f="note" placeholder="e.g. waiting on store manager to confirm">' + esc(init.note || '') + '</textarea></div>' +
        '<div class="dp-err" data-err style="display:none"></div>' +
        '<div class="dp-act">' + (editing ? '<button type="button" class="dp-btn danger" data-del>Delete</button>' : '') +
        '<button type="button" class="dp-btn" data-cancel>Cancel</button><button type="button" class="dp-btn primary" data-save>Save</button></div></div>';
      document.body.appendChild(ov);

      var q = function (sel) { return ov.querySelector(sel); };
      var statusSel = q('[data-f="status"]');
      var syncHold = function () { q('[data-hold]').style.display = statusSel.value === 'on_hold' ? '' : 'none'; };
      statusSel.addEventListener('change', syncHold); syncHold();
      var close = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
      q('[data-cancel]').addEventListener('click', close);
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      var showErr = function (m) { var e = q('[data-err]'); e.textContent = m; e.style.display = m ? '' : 'none'; };

      function post(payload, btn) {
        btn.disabled = true; showErr('');
        return fetch(FN_PROJECTS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (!res.ok || !res.j.ok) throw new Error(res.j.error || 'Save failed');
            close(); load(true);
          })
          .catch(function (err) { btn.disabled = false; showErr(err.message); });
      }

      q('[data-save]').addEventListener('click', function () {
        var title = q('[data-f="title"]').value.trim();
        if (!title) { showErr('Give it a title.'); return; }
        var status = statusSel.value;
        var payload = {
          action: 'save',
          project_type: q('[data-f="type"]').value,
          title: title,
          location: q('[data-f="location"]').value,
          scheduled_date: q('[data-f="date"]').value || null,
          scheduled_time: q('[data-f="time"]').value,
          status: status,
          hold_until: status === 'on_hold' ? (q('[data-f="hold"]').value || null) : null,
          note: q('[data-f="note"]').value,
        };
        if (editing) payload.id = init.id; else payload.state = getState();
        if (init.ticketId) payload.ticket_id = init.ticketId;
        post(payload, q('[data-save]'));
      });
      var del = q('[data-del]');
      if (del) del.addEventListener('click', function () {
        if (!confirm('Delete this special project?')) return;
        post({ action: 'delete', id: init.id }, del);
      });
    }

    // ---- events
    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-dp-toggle],[data-dp-mode],[data-dp-refresh],[data-dp-add],[data-dp-edit],[data-dp-ticket],[data-dp-wx]');
      if (!t) return;
      if (t.hasAttribute('data-dp-toggle')) {
        isOpen = !isOpen;
        try { localStorage.setItem(opts.storageKey, isOpen ? '1' : '0'); } catch (err) { /* ignore */ }
        var body = root.querySelector('.dp-body');
        if (body) body.style.display = isOpen ? '' : 'none';
        var chev = root.querySelector('.dp-chev'); if (chev) chev.textContent = isOpen ? '\u25BE' : '\u25B8';
        if (isOpen) load(false);
        return;
      }
      if (t.hasAttribute('data-dp-wx')) {
        wxOpen = !wxOpen;
        var wl2 = root.querySelector('[data-dp-wxlist]'); if (wl2) wl2.style.display = wxOpen ? '' : 'none';
        var wc = root.querySelector('[data-dp-wxchev]'); if (wc) wc.textContent = wxOpen ? '\u25BE' : '\u25B8';
        var ws = root.querySelector('[data-dp-wxsm]'); if (ws) ws.textContent = wxOpen ? 'Tap to hide details' : 'Tap for details';
        return;
      }
      if (t.hasAttribute('data-dp-mode')) { mode = t.getAttribute('data-dp-mode'); data = null; shell(); load(true); return; }
      if (t.hasAttribute('data-dp-refresh')) { load(true); return; }
      if (t.hasAttribute('data-dp-add')) { openForm({ type: 'ribbon_cutting', status: 'planned' }); return; }
      if (t.hasAttribute('data-dp-edit')) {
        var id = t.getAttribute('data-dp-edit');
        var all = ((data && data.specialProjects && data.specialProjects.projects) || []).concat((data && data.specialProjects && data.specialProjects.onHold) || []);
        var p = all.filter(function (x) { return x.id === id; })[0];
        if (p) openForm({ id: p.id, type: p.type, title: p.title, location: p.location, date: p.scheduledDate, time: p.scheduledTime,
          status: p.status, hold: p.holdUntil, note: p.note, ticketId: p.ticketId });
        return;
      }
      if (t.hasAttribute('data-dp-ticket')) {
        var tid = t.getAttribute('data-dp-ticket');
        var ins = ((data && data.specialProjects && data.specialProjects.installs) || []).filter(function (x) { return x.ticketId === tid; })[0];
        if (ins) openForm({ type: ins.ticketKind === 'install' ? 'install' : 'site_survey', title: ins.siteText, date: ins.startDate, time: ins.startTimeText,
          status: 'waiting', ticketId: ins.ticketId });
      }
    });

    if (opts.stateSelectEl) {
      opts.stateSelectEl.addEventListener('change', function () {
        data = null; loadedFor = null;
        if (isOpen) load(true);
      });
    }

    shell();
    if (isOpen) load(false);
    return { reload: function () { load(true); } };
  }

  global.DigestPanel = { mount: mount };
})(window);
