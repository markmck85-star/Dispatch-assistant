/**
 * indiana-restock-planner.js
 *
 * Special planner for Indiana Wednesday bulk restock lists.
 * These lists contain restocks that must be divided between Thursday and Friday
 * (Restock By dates already tag the day). Other states treat the daily list
 * as primarily next-day work.
 *
 * Detection: CURRENT_STATE === 'IN' and the parsed form counts contain
 * Restock By dates that fall on the coming Thursday and/or Friday.
 *
 * Suggestion strategy (advisory only):
 *   1. Prefer the site's primaryTech / defaultTech from LOCATIONS.
 *   2. Blend with historical restock technician for that site (when available).
 *   3. Balance stop counts across available technicians for that day,
 *      preferring techs who are not already heavily loaded.
 *   4. Respect availability for the target date.
 *
 * Applying a plan calls the existing syncAssignmentToSupabase with
 * dispatchDateOverride so the suggestions land on the correct future board
 * without overriding the Salesforce Gantt.
 *
 * Loaded from index.html. Call window.checkIndianaRestockPlanner() after
 * processDispatch finishes parsing form counts, or wire a button.
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
    Object.values(formCounts).forEach(fc => {
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

  function groupByRestockDay(formCounts) {
    const groups = {}; // iso -> [{code, fc, iso}]
    Object.entries(formCounts || {}).forEach(([code, fc]) => {
      if (!fc || !fc.restockBy) return;
      const iso = isoFromMDY(fc.restockBy);
      if (!iso) return;
      const dow = dayOfWeek(iso);
      if (dow !== 4 && dow !== 5) return; // only Thu/Fri for this planner
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

    // Score candidates
    const candidates = availableTechs.slice();
    let best = null;
    let bestScore = -Infinity;

    candidates.forEach(tech => {
      let score = 0;
      if (tech === primary) score += 10;
      if (hist && tech === hist) score += 6;
      // Prefer lighter load
      const load = loadByTech[tech] || 0;
      score -= load * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = tech;
      }
    });

    return best || (candidates[0] || null);
  }

  async function buildPlan(formCounts) {
    const groups = groupByRestockDay(formCounts);
    const historicalPrefs = await fetchHistoricalPrefs();
    const plan = []; // { iso, dayLabel, assignments: [{code, tech, name}] }

    for (const iso of Object.keys(groups).sort()) {
      const items = groups[iso];
      const dow = dayOfWeek(iso);
      const dayLabel = dow === 4 ? 'Thursday' : dow === 5 ? 'Friday' : iso;

      // Availability for this future date
      let available = [];
      if (typeof getUnavailableTechsForDate === 'function' && typeof TECHS !== 'undefined') {
        const unavail = getUnavailableTechsForDate(iso);
        available = Object.keys(TECHS).filter(t => !unavail.has(t));
      } else if (typeof TECHS !== 'undefined') {
        available = Object.keys(TECHS);
      }

      const loadByTech = {};
      const assignments = [];

      items.forEach(item => {
        const tech = suggestTech(item, available, loadByTech, historicalPrefs);
        if (tech) {
          loadByTech[tech] = (loadByTech[tech] || 0) + 1;
          const name = (LOCATIONS[item.code] || {}).name || item.code;
          assignments.push({ code: item.code, tech, name, restockBy: item.fc.restockBy });
        }
      });

      plan.push({ iso, dayLabel, assignments });
    }

    return plan;
  }

  function renderPlanner(plan) {
    let existing = document.getElementById(PLANNER_ID);
    if (existing) existing.remove();

    if (!plan || plan.length === 0) return;

    const container = document.createElement('div');
    container.id = PLANNER_ID;
    container.style.cssText = 'margin:12px 0; padding:14px; background:#1a1a2e; border:1px solid #444; border-radius:8px; color:#eee;';

    let html = `<div style="font-weight:bold; font-size:16px; margin-bottom:8px; color:#ffa500;">Indiana Restock Planner (Wed list → Thu / Fri)</div>`;
    html += `<div style="font-size:13px; color:#aaa; margin-bottom:12px;">Suggested technician assignments for the restocks on this Wednesday list. Review, adjust if needed, then apply to the respective boards. Nothing is written until you click Apply.</div>`;

    plan.forEach(day => {
      html += `<div style="margin-bottom:14px;">`;
      html += `<div style="font-weight:600; color:#7edb8e; margin-bottom:4px;">${day.dayLabel} (${day.iso}) — ${day.assignments.length} stop${day.assignments.length === 1 ? '' : 's'}</div>`;
      html += `<table style="width:100%; border-collapse:collapse; font-size:13px;">`;
      html += `<tr style="background:#2a2a3e;"><th style="text-align:left; padding:4px;">Site</th><th style="text-align:left; padding:4px;">Suggested Tech</th></tr>`;
      day.assignments.forEach(a => {
        html += `<tr><td style="padding:3px 4px;">${a.code} ${a.name !== a.code ? '— ' + a.name : ''}</td><td style="padding:3px 4px;">${a.tech}</td></tr>`;
      });
      html += `</table>`;
      html += `<button data-iso="${day.iso}" class="in-apply-day" style="margin-top:6px; padding:6px 12px; background:#007bff; color:white; border:none; border-radius:4px; cursor:pointer;">Apply ${day.dayLabel} plan</button>`;
      html += `</div>`;
    });

    html += `<button id="in-apply-all" style="padding:8px 16px; background:#28a745; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600;">Apply all suggested plans</button>`;
    html += `<button id="in-dismiss" style="margin-left:8px; padding:8px 16px; background:#6c757d; color:white; border:none; border-radius:4px; cursor:pointer;">Dismiss</button>`;

    container.innerHTML = html;

    // Insert near the results area if possible
    const results = document.getElementById('results') || document.querySelector('.results-panel') || document.body;
    if (results.parentNode) {
      results.parentNode.insertBefore(container, results);
    } else {
      document.body.prepend(container);
    }

    // Wire buttons
    container.querySelectorAll('.in-apply-day').forEach(btn => {
      btn.addEventListener('click', () => {
        const iso = btn.getAttribute('data-iso');
        const day = plan.find(d => d.iso === iso);
        if (day) applyDay(day);
      });
    });
    const allBtn = container.querySelector('#in-apply-all');
    if (allBtn) allBtn.addEventListener('click', () => plan.forEach(applyDay));
    const dismiss = container.querySelector('#in-dismiss');
    if (dismiss) dismiss.addEventListener('click', () => container.remove());
  }

  function applyDay(day) {
    if (typeof syncAssignmentToSupabase !== 'function') {
      alert('syncAssignmentToSupabase not available — cannot apply plan.');
      return;
    }
    let applied = 0;
    day.assignments.forEach(a => {
      const item = {
        code: a.code,
        // minimal item shape the sync expects
      };
      // Ensure form counts are present so they get persisted
      if (window.parsedFormCounts && window.parsedFormCounts[a.code]) {
        // already there
      }
      syncAssignmentToSupabase(a.tech, item, 'planned', 'manual', {
        dispatchDateOverride: day.iso
      });
      applied++;
    });
    if (typeof showToast === 'function') {
      showToast(`Applied ${applied} suggested stop${applied === 1 ? '' : 's'} to ${day.dayLabel} (${day.iso})`, 'success');
    } else {
      alert(`Applied ${applied} stops to ${day.dayLabel}`);
    }
  }

  window.checkIndianaRestockPlanner = async function () {
    const counts = window.parsedFormCounts || {};
    if (!isIndianaWednesdayBulk(counts)) return;
    const plan = await buildPlan(counts);
    if (plan.length) renderPlanner(plan);
  };

  // Auto-check after a short delay on load / after processDispatch if desired
  // Callers in index.html can also invoke window.checkIndianaRestockPlanner() explicitly.
})();
