/**
 * indiana-restock-planner.js
 *
 * Special planner for Indiana Wednesday bulk restock lists.
 * The list holds Indiana restocks dated for the coming Thursday and Friday
 * ("Restock By Day"), and it is pasted together with every other state's rows.
 *
 * Rules (from the Indiana dispatcher / Neumo):
 *   - Only sites that belong to the Indiana board are planned. Rows for other
 *     states in the same paste are ignored.
 *   - A Thursday-dated stop is due Thursday (Neumo is worried about running
 *     out), so it is planned for Thursday.
 *   - A Friday-dated stop can be caught early. If it is close to a Thursday
 *     stop the planner offers to do it Thursday with that technician
 *     ("Do Thursday" box, on by default). Otherwise it stays on Friday.
 *
 * Suggestion strategy (advisory only, nothing is written until Apply):
 *   1. Prefer the site's primaryTech / defaultTech from LOCATIONS.
 *   2. Blend with historical restock technician for that site (when available).
 *   3. Balance stop counts across available technicians for that day.
 *   4. Respect availability for the target date.
 *
 * Applying a plan calls syncAssignmentToSupabase with dispatchDateOverride so
 * the stops land on the correct day's board.
 */

(function () {
  'use strict';

  const PLANNER_ID = 'indianaRestockPlanner';

  function isoFromMDY(mdy) {
    if (!mdy) return null;
    const parts = String(mdy).split('/');
    if (parts.length !== 3) return null;
    const mm = parts[0].padStart(2, '0');
    const dd = parts[1].padStart(2, '0');
    const yyyy = parts[2].length === 2 ? '20' + parts[2] : parts[2];
    return `${yyyy}-${mm}-${dd}`;
  }

  function dayOfWeek(iso) {
    if (!iso) return null;
    return new Date(iso + 'T12:00:00').getDay(); // 0=Sun ... 4=Thu 5=Fri
  }

  function isIndianaWednesdayBulk(formCounts) {
    if (typeof CURRENT_STATE === 'undefined' || CURRENT_STATE !== 'IN') return false;
    if (!formCounts || typeof formCounts !== 'object') return false;

    const dates = new Set();
    Object.entries(formCounts).forEach(([code, fcx]) => {
      const fc = fcx;
      if (!inBoard(code)) return; // other states in the same paste
      if (fc && fc.restockBy) {
        const iso = isoFromMDY(fc.restockBy);
        if (iso) dates.add(iso);
      }
    });

    if (dates.size < 1) return false;

    // Look for Thu (4) and/or Fri (5) dates in the near future
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let hasThu = false, hasFri = false;
    for (const iso of dates) {
      const d = new Date(iso + 'T12:00:00');
      const dow = d.getDay();
      const diffDays = Math.round((d - today) / 86400000);
      if (diffDays >= 0 && diffDays <= 4) {
        if (dow === 4) hasThu = true;
        if (dow === 5) hasFri = true;
      }
    }
    return hasThu || hasFri;
  }

  // Tunables for pulling a Friday stop forward to Thursday.
  const PULL_FORWARD_MILES = 25;   // straight-line miles from one of that tech's Thursday stops
  const MAX_PULL_PER_TECH = 3;     // extra Friday stops one tech takes on Thursday

  // A row belongs to this planner only if it is an Indiana site. The paste holds
  // every state's rows, and the board can also hold sites from other states.
  function inBoard(code) {
    if (typeof LOCATIONS === 'undefined') return false;
    const loc = LOCATIONS[code];
    if (!loc) return false;
    if (loc.state) return String(loc.state).toUpperCase() === 'IN';
    return /^IN\d/i.test(String(code));
  }

  function groupByRestockDay(formCounts) {
    const groups = {}; // iso -> [{code, fc, iso}]
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    Object.entries(formCounts || {}).forEach(([code, fc]) => {
      if (!fc || !fc.restockBy) return;
      if (!inBoard(code)) return; // other states in the same paste
      const iso = isoFromMDY(fc.restockBy);
      if (!iso) return;
      const dow = dayOfWeek(iso);
      if (dow !== 4 && dow !== 5) return; // only Thu/Fri for this planner
      if (new Date(iso + 'T12:00:00') < today) return;
      if (!groups[iso]) groups[iso] = [];
      groups[iso].push({ code, fc, iso });
    });
    return groups;
  }

  async function fetchHistoricalPrefs() {
    // Optional: call a small endpoint if present; otherwise fall back to empty.
    try {
      const res = await fetch('/.netlify/functions/get-in-restock-history', { cache: 'no-store' });
      if (!res.ok) return {};
      const data = await res.json();
      return data.prefs || {};
    } catch (e) {
      return {};
    }
  }

  function suggestTech(item, availableTechs, loadByTech, historicalPrefs) {
    const loc = (typeof LOCATIONS !== 'undefined' && LOCATIONS[item.code]) || {};
    const primary = loc.primaryTech || loc.defaultTech;
    const hist = historicalPrefs[item.code];
    let best = null;
    let bestScore = -Infinity;
    availableTechs.forEach(tech => {
      let score = 0;
      if (tech === primary) score += 10;
      if (hist && tech === hist) score += 6;
      score -= (loadByTech[tech] || 0) * 1.5;
      if (score > bestScore) { bestScore = score; best = tech; }
    });
    return best || (availableTechs[0] || null);
  }

  function availableFor(iso) {
    if (typeof TECHS === 'undefined') return [];
    let all = Object.keys(TECHS);
    if (typeof getUnavailableTechsForDate === 'function') {
      const unavail = getUnavailableTechsForDate(iso);
      all = all.filter(t => !unavail.has(t));
    }
    return all;
  }

  function miles(a, b) {
    if (!a || !b) return null;
    const la1 = Number(a.lat), lo1 = Number(a.lng), la2 = Number(b.lat), lo2 = Number(b.lng);
    if (![la1, lo1, la2, lo2].every(isFinite)) return null;
    const r = (d) => d * Math.PI / 180;
    const h = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(h));
  }

  function cleanName(code) {
    const n = (LOCATIONS[code] || {}).name || code;
    return String(n).replace(new RegExp('\\s*[-\u2013\u2014]?\\s*' + code + '\\b.*$'), '').trim() || code;
  }

  async function buildPlan(formCounts) {
    const groups = groupByRestockDay(formCounts);
    const historicalPrefs = await fetchHistoricalPrefs();
    const isos = Object.keys(groups).sort();
    const thuIso = isos.find(i => dayOfWeek(i) === 4) || null;
    const friIso = isos.find(i => dayOfWeek(i) === 5) || null;
    const days = {};
    const mk = (iso) => ({ iso, dayLabel: dayOfWeek(iso) === 4 ? 'Thursday' : 'Friday', assignments: [] });

    // Thursday: fixed day, due Thursday.
    if (thuIso) {
      const d = days[thuIso] = mk(thuIso);
      const avail = availableFor(thuIso);
      const load = {};
      groups[thuIso].forEach(item => {
        const tech = suggestTech(item, avail, load, historicalPrefs);
        if (!tech) return;
        load[tech] = (load[tech] || 0) + 1;
        d.assignments.push({ code: item.code, tech, name: cleanName(item.code), restockBy: item.fc.restockBy });
      });
    }

    // Friday: pull forward to Thursday when near a Thursday stop.
    if (friIso) {
      const d = days[friIso] = mk(friIso);
      const thuAvail = thuIso ? availableFor(thuIso) : [];
      const thuStops = thuIso ? days[thuIso].assignments : [];
      const pulled = {};
      const rest = [];
      groups[friIso].forEach(item => {
        let near = null;
        if (thuIso) {
          const loc = LOCATIONS[item.code];
          thuStops.forEach(t => {
            if (thuAvail.indexOf(t.tech) === -1) return;
            const m = miles(loc, LOCATIONS[t.code]);
            if (m !== null && m <= PULL_FORWARD_MILES && (!near || m < near.miles)) near = { tech: t.tech, code: t.code, miles: m };
          });
        }
        if (near && (pulled[near.tech] || 0) < MAX_PULL_PER_TECH) {
          pulled[near.tech] = (pulled[near.tech] || 0) + 1;
          item._near = near;
        }
        rest.push(item);
      });
      const avail = availableFor(friIso);
      const load = {};
      // Stops that stay on Friday are balanced first; pulled ones are only an option.
      rest.filter(i => !i._near).forEach(item => {
        const tech = suggestTech(item, avail, load, historicalPrefs);
        if (!tech) return;
        load[tech] = (load[tech] || 0) + 1;
        item._friTech = tech;
      });
      rest.forEach(item => {
        const friTech = item._friTech || suggestTech(item, avail, load, historicalPrefs);
        const a = { code: item.code, tech: friTech, name: cleanName(item.code), restockBy: item.fc.restockBy, friTech };
        if (item._near) {
          a.pullTech = item._near.tech;
          a.pullNote = Math.round(item._near.miles) + ' mi from ' + item._near.code + ' (' + item._near.tech + ' Thu)';
          a.tech = item._near.tech;
          a.pull = true;
        }
        d.assignments.push(a);
      });
    }

    return Object.keys(days).sort().map(k => days[k]);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function techSelect(selected) {
    const names = typeof TECHS !== 'undefined' ? Object.keys(TECHS) : [];
    if (selected && names.indexOf(selected) === -1) names.unshift(selected);
    return '<select class="in-tech" style="background:#2a2a3e;color:#eee;border:1px solid #555;border-radius:4px;padding:3px;max-width:150px;">' +
      names.map(n => '<option value="' + esc(n) + '"' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>').join('') + '</select>';
  }

  function renderPlanner(plan) {
    let existing = document.getElementById(PLANNER_ID);
    if (existing) existing.remove();
    if (!plan || plan.length === 0) return;

    const thu = plan.find(d => d.dayLabel === 'Thursday');
    const container = document.createElement('div');
    container.id = PLANNER_ID;
    container.style.cssText = 'margin:12px 0; padding:14px; background:#1a1a2e; border:1px solid #444; border-radius:8px; color:#eee;';

    let html = '<div style="font-weight:bold; font-size:16px; margin-bottom:8px; color:#ffa500;">Indiana Restock Planner (Wed list \u2192 Thu / Fri)</div>';
    html += '<div style="font-size:13px; color:#aaa; margin-bottom:12px;">Only Indiana sites are shown. Thursday stops are due Thursday. A Friday stop close to a Thursday stop can be caught Thursday: leave "Do Thursday" checked to move it, or uncheck it to keep it on Friday. Change a technician with the dropdown. Nothing is written until you click Apply.</div>';

    plan.forEach(day => {
      html += '<div style="margin-bottom:14px;">';
      html += '<div class="in-day-title" data-iso="' + day.iso + '" style="font-weight:600; color:#7edb8e; margin-bottom:4px;">' + day.dayLabel + ' (' + day.iso + ')</div>';
      html += '<table style="width:100%; border-collapse:collapse; font-size:13px;">';
      html += '<tr style="background:#2a2a3e;"><th style="text-align:left; padding:4px;">Site</th><th style="text-align:left; padding:4px;">Tech</th>' + (day.dayLabel === 'Friday' && thu ? '<th style="text-align:left; padding:4px;">Do Thursday</th>' : '') + '</tr>';
      day.assignments.forEach(a => {
        html += '<tr class="in-row" data-code="' + esc(a.code) + '" data-iso="' + day.iso + '"' +
          (a.pullTech ? ' data-fri-tech="' + esc(a.friTech || '') + '" data-pull-tech="' + esc(a.pullTech) + '"' : '') + '>' +
          '<td style="padding:3px 4px;">' + esc(a.code) + (a.name && a.name !== a.code ? ' \u2014 ' + esc(a.name) : '') + '</td>' +
          '<td style="padding:3px 4px;">' + techSelect(a.tech) + '</td>';
        if (day.dayLabel === 'Friday' && thu) {
          html += '<td style="padding:3px 4px;">' + (a.pullTech
            ? '<label><input type="checkbox" class="in-pull"' + (a.pull ? ' checked' : '') + '> ' + esc(a.pullNote) + '</label>'
            : '<span style="color:#777;">no Thursday stop nearby</span>') + '</td>';
        }
        html += '</tr>';
      });
      html += '</table></div>';
    });

    html += '<button id="in-apply-all" style="padding:8px 16px; background:#28a745; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600;">Apply plan</button>';
    html += '<button id="in-dismiss" style="margin-left:8px; padding:8px 16px; background:#6c757d; color:white; border:none; border-radius:4px; cursor:pointer;">Dismiss</button>';
    container.innerHTML = html;

    const results = document.getElementById('results') || document.querySelector('.results-panel') || document.body;
    if (results.parentNode) results.parentNode.insertBefore(container, results);
    else document.body.prepend(container);

    // Checking / unchecking "Do Thursday" swaps the tech between the Thursday and Friday suggestion.
    container.querySelectorAll('.in-pull').forEach(cb => {
      cb.addEventListener('change', () => {
        const tr = cb.closest('tr');
        const sel = tr.querySelector('.in-tech');
        const want = cb.checked ? tr.getAttribute('data-pull-tech') : tr.getAttribute('data-fri-tech');
        if (want) sel.value = want;
      });
    });
    container.querySelector('#in-apply-all').addEventListener('click', () => applyPlan(container, thu ? thu.iso : null));
    container.querySelector('#in-dismiss').addEventListener('click', () => container.remove());
  }

  function applyPlan(container, thuIso) {
    if (typeof syncAssignmentToSupabase !== 'function') {
      alert('syncAssignmentToSupabase not available \u2014 cannot apply plan.');
      return;
    }
    const rows = [...container.querySelectorAll('.in-row')].map(tr => {
      const pull = tr.querySelector('.in-pull');
      const iso = (pull && pull.checked && thuIso) ? thuIso : tr.getAttribute('data-iso');
      const origIso = tr.getAttribute('data-iso');
      return { code: tr.getAttribute('data-code'), tech: tr.querySelector('.in-tech').value, iso, origIso,
               friTech: tr.getAttribute('data-fri-tech') || tr.querySelector('.in-tech').value };
    }).filter(r => r.code && r.tech);
    const thuN = rows.filter(r => r.iso === thuIso).length;
    if (!confirm('Apply ' + rows.length + ' stops (' + thuN + ' on Thursday, ' + (rows.length - thuN) + ' on Friday)?')) return;
    rows.forEach(r => {
      syncAssignmentToSupabase(r.tech, { code: r.code }, 'planned', 'manual', { dispatchDateOverride: r.iso });
      // A Friday stop pulled onto Thursday must leave Friday's board, or it would
      // show on both days. Same remove-then-recreate pattern as Push to Tomorrow.
      if (r.iso !== r.origIso) {
        syncAssignmentToSupabase(r.friTech, { code: r.code }, 'removed', 'manual', { dispatchDateOverride: r.origIso });
      }
    });
    const msg = 'Applied ' + rows.length + ' Indiana stops (' + thuN + ' Thursday, ' + (rows.length - thuN) + ' Friday)';
    if (typeof showToast === 'function') showToast(msg, 'success'); else alert(msg);
    container.remove();
  }

  window.checkIndianaRestockPlanner = async function () {
    const counts = window.parsedFormCounts || {};
    if (!isIndianaWednesdayBulk(counts)) {
      alert('No Indiana Thursday or Friday restocks found. Paste the dispatch list on the Indiana board first.');
      return;
    }
    const plan = await buildPlan(counts);
    if (plan.length) renderPlanner(plan);
    else alert('No Indiana Thursday or Friday restocks found in this list.');
  };

  // Auto-check after a short delay on load / after processDispatch if desired
  // Callers in index.html can also invoke window.checkIndianaRestockPlanner() explicitly.
})();
