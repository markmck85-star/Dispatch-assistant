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
  const MAX_PULL_PER_TECH = 3;     // extra Friday stops one tech takes on Thursday (near-a-Thursday-stop pulls)
  const THURSDAY_SHARE = 0.4;      // target share of a tech's Thu+Fri stops done Thursday (matches Sep/Oct history)

  // Rough drive time for one tech's day: nearest-neighbour loop from the tech's home through the
  // given points and back, straight-line miles x road factor at an average speed. Matches the
  // board's own estimates closely enough (e.g. 396 mi round trip ~ 8 hr). Returns 0 when the
  // tech has no home coordinates, so the cap simply does not apply.
  const ROAD_FACTOR = 1.3;
  const AVG_MPH = 50;
  const ON_SITE_MIN = 25;             // typical on-site time per kiosk (median ~28 min, trimmed average ~26, Jul-Oct 2026)
  const MAX_THURSDAY_DAY_HOURS = 8;   // drive plus on-site; balancing never pulls a stop forward past this
  // Uses the real driving-time matrix (_dmCache.IN, loaded from get-distance-matrix) for tech-to-site
  // and site-to-site legs; a leg missing from the matrix falls back to the straight-line estimate.
  // Points are site codes.
  function matrixOf() {
    return (typeof _dmCache !== 'undefined' && _dmCache.IN && _dmCache.IN.matrix) || null;
  }
  function legMin(mx, techSlug, a, b) {
    // a is 'HOME' (the tech) or a site code; b is a site code or 'HOME'
    const home = a === 'HOME' ? b : (b === 'HOME' ? a : null);
    if (home !== null) {
      const e = mx && mx[techSlug + '|' + home];
      if (e && e.durationMin != null) return e.durationMin;
    } else {
      const e = mx && (mx[a + '|' + b] || mx[b + '|' + a]);
      if (e && e.durationMin != null) return e.durationMin;
    }
    return null;
  }
  function estDriveHours(tech, codes) {
    const t = (typeof TECHS !== 'undefined' && TECHS[tech]) || null;
    const mx = matrixOf();
    const slug = String(tech || '').toLowerCase().replace(/\s+/g, '-');
    const homePt = (t && t.lat != null && t.lng != null && isFinite(Number(t.lat)) && isFinite(Number(t.lng))) ? { lat: t.lat, lng: t.lng } : null;
    const pt = (c) => (c === 'HOME' ? homePt : LOCATIONS[c]);
    const leg = (a, b) => {
      const m = legMin(mx, slug, a, b);
      if (m !== null) return m;
      const d = miles(pt(a), pt(b));
      return d === null ? null : d * ROAD_FACTOR / AVG_MPH * 60;
    };
    const left = codes.filter(c => c && leg('HOME', c) !== null);
    if (!left.length) return 0;
    let cur = 'HOME', total = 0;
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((c, i) => { const d = leg(cur, c); if (d !== null && d < bd) { bd = d; bi = i; } });
      total += isFinite(bd) ? bd : 0; cur = left.splice(bi, 1)[0];
    }
    total += leg(cur, 'HOME') || 0;
    return total / 60;
  }

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

  // ---- Multi-kiosk sites -------------------------------------------------
  // Some locations (Hoku sites, "Indy North 1-4", "Lafayette 1-3") have several
  // kiosks at ONE address and each kiosk has its own site code and ticket. They
  // must go to one technician together, so the planner works on whole sites.
  function addrKey(code) {
    const a = String((LOCATIONS[code] || {}).address || '').toLowerCase();
    const m = a.match(/^\s*(\d+[a-z]?)\s+([a-z0-9.' ]+?)(?:,|$)/); // street number + street
    return m ? (m[1] + ' ' + m[2].replace(/[^a-z0-9]/g, '')) : '';
  }
  function baseName(code) {
    // "Mishawaka Hoku 3" -> "mishawaka hoku"; "Indy North 1" -> "indy north"
    const n = cleanName(code).toLowerCase().replace(/\s+/g, ' ').trim();
    const m = n.match(/^(.*?)\s+\d{1,2}$/);
    return m ? m[1] : '';
  }
  function buildClusters(codes) {
    const parent = {};
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent[ry] = rx; };
    codes.forEach(c => { parent[c] = c; });
    // Kiosks at one address share the same geocoded point. A point shared by many
    // sites is a city-centre fallback rather than a real address, so it is ignored.
    const coordKey = (c) => {
      const l = LOCATIONS[c] || {};
      return (isFinite(Number(l.lat)) && isFinite(Number(l.lng)) && l.lat != null && l.lng != null)
        ? 'c:' + Number(l.lat).toFixed(4) + ',' + Number(l.lng).toFixed(4) : '';
    };
    const coordCount = {};
    codes.forEach(c => { const k = coordKey(c); if (k) coordCount[k] = (coordCount[k] || 0) + 1; });
    const byKey = {};
    codes.forEach(c => {
      const ck = coordKey(c);
      [addrKey(c) ? 'a:' + addrKey(c) : '', baseName(c) ? 'n:' + baseName(c) : '', (ck && coordCount[ck] <= 6) ? ck : ''].forEach(k => {
        if (!k) return;
        if (byKey[k]) union(byKey[k], c); else byKey[k] = c;
      });
    });
    const id = {};
    codes.forEach(c => { id[c] = find(c); });
    return id;
  }

  function suggestTechForSite(members, availableTechs, loadByTech, historicalPrefs) {
    // Score as one unit: the site's usual tech (most common among its kiosks) wins.
    const votes = {};
    members.forEach(m => {
      const loc = (LOCATIONS[m.code] || {});
      const pr = loc.primaryTech || loc.defaultTech;
      if (pr) votes[pr] = (votes[pr] || 0) + 1;
      const h = historicalPrefs[m.code];
      if (h) votes[h] = (votes[h] || 0) + 0.5;
    });
    // 2026-10-22: the site's fallback tech counts too (it is who covers when the primary is out),
    // and a tech who is far from the site or based outside Indiana is penalized, so a light load
    // alone no longer sends a site to someone hours away.
    const fbVotes = {};
    members.forEach(m => {
      const fb = (LOCATIONS[m.code] || {}).fallbackTech;
      if (fb) fbVotes[fb] = (fbVotes[fb] || 0) + 1;
    });
    const mx = matrixOf();
    const travelPenalty = (tech) => {
      const code = members[0].code;
      const e = mx && mx[String(tech).toLowerCase().replace(/\s+/g, '-') + '|' + code];
      if (e && e.durationMin != null) return Number(e.durationMin) / 30; // 60 min away = 2 points
      const t = (typeof TECHS !== 'undefined' && TECHS[tech]) || {};
      if (t.state && String(t.state).toUpperCase() !== 'IN') return 8;   // not an Indiana tech, no matrix data
      const d = miles(t, LOCATIONS[code]);
      return d === null ? 0 : d / 25;                                     // 50 mi away = 2 points
    };
    let best = null, bestScore = -Infinity;
    availableTechs.forEach(tech => {
      const score = (votes[tech] || 0) * 10 / members.length + (fbVotes[tech] || 0) * 6 / members.length
        - (loadByTech[tech] || 0) * 1.5 - travelPenalty(tech);
      if (score > bestScore) { bestScore = score; best = tech; }
    });
    return best || (availableTechs[0] || null);
  }

  async function buildPlan(formCounts) {
    const groups = groupByRestockDay(formCounts);
    const historicalPrefs = await fetchHistoricalPrefs();
    const isos = Object.keys(groups).sort();
    const thuIso = isos.find(i => dayOfWeek(i) === 4) || null;
    const friIso = isos.find(i => dayOfWeek(i) === 5) || null;
    const allCodes = [];
    isos.forEach(i => groups[i].forEach(it => allCodes.push(it.code)));
    const cid = buildClusters(allCodes);
    const clusterNo = {}; let nextNo = 1;
    const noOf = (code) => { const k = cid[code]; if (!clusterNo[k]) clusterNo[k] = nextNo++; return clusterNo[k]; };

    const days = {};
    const mk = (iso) => ({ iso, dayLabel: dayOfWeek(iso) === 4 ? 'Thursday' : 'Friday', assignments: [] });
    const byCluster = (items) => {
      const m = {}; const order = [];
      items.forEach(it => { const k = cid[it.code]; if (!m[k]) { m[k] = []; order.push(k); } m[k].push(it); });
      return order.map(k => m[k]);
    };
    const mkAssign = (item, tech, extra) => Object.assign({
      code: item.code, tech, name: cleanName(item.code), restockBy: item.fc.restockBy, cluster: noOf(item.code)
    }, extra || {});

    // Thursday: fixed day, due Thursday. A site's kiosks go to one technician.
    const thuTechOfCluster = {};
    if (thuIso) {
      const d = days[thuIso] = mk(thuIso);
      const avail = availableFor(thuIso);
      const load = {};
      byCluster(groups[thuIso]).forEach(members => {
        const tech = suggestTechForSite(members, avail, load, historicalPrefs);
        if (!tech) return;
        load[tech] = (load[tech] || 0) + members.length;
        thuTechOfCluster[cid[members[0].code]] = tech;
        members.forEach(item => d.assignments.push(mkAssign(item, tech)));
      });
    }

    // Friday: pull whole sites forward to Thursday when they share an address with, or sit
    // near, a Thursday stop. Otherwise the site stays on Friday with one technician.
    if (friIso) {
      const d = days[friIso] = mk(friIso);
      const thuAvail = thuIso ? availableFor(thuIso) : [];
      const thuStops = thuIso ? days[thuIso].assignments : [];
      const pulled = {};
      // A tech already going to a site on Thursday for another ticket (a trouble ticket, say)
      // catches that site's Friday restock on the same visit (2026-10-22).
      let thuExisting = {};
      if (thuIso && typeof fetchExistingAssignments === 'function') {
        try { thuExisting = (await fetchExistingAssignments(thuIso)) || {}; } catch (e) { thuExisting = {}; }
      }
      const existingThuTech = (members) => {
        for (const m of members) {
          const ex = thuExisting[m.code];
          if (ex && (ex.status === 'planned' || ex.status === 'notified') && ex.techName &&
              thuAvail.indexOf(ex.techName) !== -1) return { tech: ex.techName, code: m.code };
        }
        return null;
      };
      const sites = byCluster(groups[friIso]);
      const plans = sites.map(members => {
        const key = cid[members[0].code];
        let near = null;
        const already = thuIso ? existingThuTech(members) : null;
        if (already) {
          near = { tech: already.tech, code: already.code, miles: 0, same: true, existing: true };
        } else if (thuIso && thuTechOfCluster[key] && thuAvail.indexOf(thuTechOfCluster[key]) !== -1) {
          // Same site already has kiosks due Thursday: they go together, no distance test.
          const t = thuStops.find(x => cid[x.code] === key);
          near = { tech: thuTechOfCluster[key], code: t ? t.code : '', miles: 0, same: true };
        } else if (thuIso) {
          const loc = LOCATIONS[members[0].code];
          thuStops.forEach(t => {
            if (thuAvail.indexOf(t.tech) === -1) return;
            const m = miles(loc, LOCATIONS[t.code]);
            if (m !== null && m <= PULL_FORWARD_MILES && (!near || m < near.miles)) near = { tech: t.tech, code: t.code, miles: m };
          });
          if (near && (pulled[near.tech] || 0) + members.length > MAX_PULL_PER_TECH) near = null;
        }
        if (near) pulled[near.tech] = (pulled[near.tech] || 0) + members.length;
        return { members, near };
      });
      // Day-length cap for the near-a-Thursday-stop pulls too (2026-10-22). If a tech's Thursday
      // (drive loop plus on-site time) runs past the limit, hand the farthest pulled site to another
      // available tech who can fit it, or leave it on Friday. A site that shares an address with a
      // Thursday-due site always goes with it.
      if (thuIso) {
        const dayCodes = {}, dayKiosks = {};
        const addTo = (tech, code, n) => {
          (dayCodes[tech] = dayCodes[tech] || []).push(code);
          dayKiosks[tech] = (dayKiosks[tech] || 0) + n;
        };
        thuStops.forEach(t => addTo(t.tech, t.code, 1));
        plans.forEach(pl => { if (pl.near) addTo(pl.near.tech, pl.members[0].code, pl.members.length); });
        const hrs = (tech, codes, k) => estDriveHours(tech, codes) + k * ON_SITE_MIN / 60;
        plans.filter(pl => pl.near && !pl.near.same)
          .sort((a, b) => (b.near.miles || 0) - (a.near.miles || 0))
          .forEach(pl => {
            const tech = pl.near.tech, code = pl.members[0].code, n = pl.members.length;
            if (hrs(tech, dayCodes[tech], dayKiosks[tech]) <= MAX_THURSDAY_DAY_HOURS) return;
            dayCodes[tech].splice(dayCodes[tech].indexOf(code), 1);
            dayKiosks[tech] -= n;
            let alt = null, altCost = Infinity;
            thuAvail.forEach(c => {
              if (c === tech) return;
              const ti = (typeof TECHS !== 'undefined' && TECHS[c]) || {};
              if (ti.state && String(ti.state).toUpperCase() !== 'IN') return; // out-of-state techs are not used for this
              const have = dayCodes[c] || [];
              if (hrs(c, have.concat([code]), (dayKiosks[c] || 0) + n) > MAX_THURSDAY_DAY_HOURS) return;
              const cost = estDriveHours(c, have.concat([code])) - estDriveHours(c, have);
              if (cost < altCost) { altCost = cost; alt = c; }
            });
            if (alt) {
              pl.near = { tech: alt, code: '', miles: null, balance: true, rehomed: true, from: tech };
              addTo(alt, code, n);
            } else {
              pl.near = null; // stays on Friday
            }
          });
      }

      const avail = availableFor(friIso);
      const load = {};
      plans.filter(pl => !pl.near).forEach(pl => {
        const tech = suggestTechForSite(pl.members, avail, load, historicalPrefs);
        if (!tech) return;
        load[tech] = (load[tech] || 0) + pl.members.length;
        pl.friTech = tech;
      });

      // Balance the two days (2026-10-22). Any Friday stop may be done Thursday; Thursday-due
      // stops never move to Friday. History (Sep/Oct) shows Thursday carrying about 40% of a
      // tech's Thu+Fri restocks. For each tech whose Thursday is light, pull whole Friday sites
      // forward, nearest to that tech's Thursday stops first (or a compact group when the tech
      // has none), until Thursday reaches THURSDAY_SHARE of the tech's two-day total.
      if (thuIso) {
        const thuBy = {};
        thuStops.forEach(t => { thuBy[t.tech] = (thuBy[t.tech] || 0) + 1; });
        const anchorsBy = {}; // tech -> site codes already on that tech's Thursday
        thuStops.forEach(t => { (anchorsBy[t.tech] = anchorsBy[t.tech] || []).push(t.code); });
        plans.filter(pl => pl.near).forEach(pl => {
          thuBy[pl.near.tech] = (thuBy[pl.near.tech] || 0) + pl.members.length;
          (anchorsBy[pl.near.tech] = anchorsBy[pl.near.tech] || []).push(pl.members[0].code);
        });
        const poolBy = {};
        plans.filter(pl => !pl.near && pl.friTech && thuAvail.indexOf(pl.friTech) !== -1)
          .forEach(pl => { (poolBy[pl.friTech] = poolBy[pl.friTech] || []).push(pl); });
        const dist = (pl, codes) => {
          let best = Infinity;
          codes.forEach(c => { const m = miles(LOCATIONS[pl.members[0].code], LOCATIONS[c]); if (m !== null && m < best) best = m; });
          return best;
        };
        Object.keys(poolBy).forEach(tech => {
          const pool = poolBy[tech].slice();
          const friN = pool.reduce((n, pl) => n + pl.members.length, 0);
          let have = thuBy[tech] || 0;
          const want = Math.round((have + friN) * THURSDAY_SHARE);
          const anchors = (anchorsBy[tech] || []).slice();
          while (have < want && pool.length) {
            let pick = null, pickD = Infinity;
            if (anchors.length) {
              pool.forEach(pl => { const d = dist(pl, anchors); if (pick === null || d < pickD) { pick = pl; pickD = d; } });
            } else {
              // no Thursday stop yet: start from the site closest to the rest of this tech's Friday sites
              pool.forEach(pl => {
                const d = dist(pl, pool.filter(o => o !== pl).map(o => o.members[0].code));
                const dd = isFinite(d) ? d : 1e9;
                if (pick === null || dd < pickD) { pick = pl; pickD = dd; }
              });
            }
            pool.splice(pool.indexOf(pick), 1);
            if (have + pick.members.length > want + 1) continue; // would overshoot; try a smaller site
            // avoid overtime: drive (home loop, return included) plus on-site time stays within the
            // day limit, otherwise the site stays on Friday
            if (estDriveHours(tech, anchors.concat([pick.members[0].code])) +
                (have + pick.members.length) * ON_SITE_MIN / 60 > MAX_THURSDAY_DAY_HOURS) continue;
            pick.near = { tech, code: '', miles: isFinite(pickD) && pickD < 1e8 ? pickD : null, balance: true,
                          thu: have + pick.members.length, fri: friN };
            have += pick.members.length;
            anchors.push(pick.members[0].code);
          }
        });
      }

      plans.forEach(pl => {
        const friTech = pl.friTech || suggestTechForSite(pl.members, avail, load, historicalPrefs);
        pl.members.forEach(item => {
          const extra = { friTech };
          let tech = friTech;
          if (pl.near) {
            tech = pl.near.tech;
            extra.pullTech = pl.near.tech;
            extra.pull = true;
            extra.pullNote = pl.near.existing
              ? 'already on Thursday for another ticket (' + pl.near.tech + ')'
              : pl.near.rehomed
              ?pl.near.tech + ' has room Thursday (keeps ' + pl.near.from + ' under the day limit)'
              : pl.near.balance
              ? 'evens out ' + pl.near.tech + '’s week' + (pl.near.miles != null ? ' (' + Math.round(pl.near.miles) + ' mi from another Thu stop)' : '')
              : pl.near.same
                ? 'same site as ' + pl.near.code + ' (' + pl.near.tech + ' Thu)'
                : Math.round(pl.near.miles) + ' mi from ' + pl.near.code + ' (' + pl.near.tech + ' Thu)';
          }
          d.assignments.push(mkAssign(item, tech, extra));
        });
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
    html += '<div style="font-size:13px; color:#aaa; margin-bottom:12px;">Only Indiana sites are shown. Sites with several kiosks at one address stay together with one technician. Thursday stops are due Thursday. Any Friday stop can be done Thursday, and the plan moves some to even out each technician’s two days, starting with sites near that technician’s Thursday stops: leave "Do Thursday" checked to move it, or uncheck it to keep it on Friday. Change a technician with the dropdown. Nothing is written until you click Apply.</div>';

    plan.forEach(day => {
      html += '<div style="margin-bottom:14px;">';
      html += '<div class="in-day-title" data-iso="' + day.iso + '" style="font-weight:600; color:#7edb8e; margin-bottom:4px;">' + day.dayLabel + ' (' + day.iso + ')</div>';
      html += '<table style="width:100%; border-collapse:collapse; font-size:13px;">';
      html += '<tr style="background:#2a2a3e;"><th style="text-align:left; padding:4px;">Site</th><th style="text-align:left; padding:4px;">Tech</th>' + (day.dayLabel === 'Friday' && thu ? '<th style="text-align:left; padding:4px;">Do Thursday</th>' : '') + '</tr>';
      day.assignments.forEach(a => {
        html += '<tr class="in-row" data-code="' + esc(a.code) + '" data-iso="' + day.iso + '" data-cluster="' + a.cluster + '"' +
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

    // A site's kiosks always move together: toggling "Do Thursday" or changing the
    // technician on one row applies to every row of the same site and day.
    const sameSite = (tr) => [...container.querySelectorAll('.in-row')].filter(r =>
      r.getAttribute('data-cluster') === tr.getAttribute('data-cluster') && r.getAttribute('data-iso') === tr.getAttribute('data-iso'));
    container.querySelectorAll('.in-pull').forEach(cb => {
      cb.addEventListener('change', () => {
        sameSite(cb.closest('tr')).forEach(tr => {
          const box = tr.querySelector('.in-pull');
          if (box) box.checked = cb.checked;
          const want = cb.checked ? tr.getAttribute('data-pull-tech') : tr.getAttribute('data-fri-tech');
          if (want) tr.querySelector('.in-tech').value = want;
        });
      });
    });
    container.querySelectorAll('.in-tech').forEach(sel => {
      sel.addEventListener('change', () => {
        sameSite(sel.closest('tr')).forEach(tr => { tr.querySelector('.in-tech').value = sel.value; });
      });
    });
    container.querySelector('#in-apply-all').addEventListener('click', () => applyPlan(container, thu ? thu.iso : null));
    container.querySelector('#in-dismiss').addEventListener('click', () => container.remove());
  }

  async function applyPlan(container, thuIso) {
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
    // The dispatch list first loads every stop onto the board date (Wednesday).
    // Once a stop is planned for Thursday/Friday, that Wednesday copy is a stale
    // duplicate, so clear it. Only touches copies still planned/notified.
    let cleared = 0;
    try {
      const boardEl = document.getElementById('dispatchDate');
      const boardIso = boardEl && boardEl.value ? boardEl.value : '';
      if (boardIso && typeof fetchExistingAssignments === 'function') {
        const onBoard = await fetchExistingAssignments(boardIso);
        rows.forEach(r => {
          if (r.iso === boardIso || r.origIso === boardIso) return;
          const ex = onBoard[r.code];
          if (ex && (ex.status === 'planned' || ex.status === 'notified') && ex.techName) {
            syncAssignmentToSupabase(ex.techName, { code: r.code }, 'removed', 'manual', { dispatchDateOverride: boardIso });
            cleared++;
          }
        });
      }
    } catch (e) { console.error('[IN planner] board-day cleanup failed (non-fatal)', e); }
    const msg = 'Applied ' + rows.length + ' Indiana stops (' + thuN + ' Thursday, ' + (rows.length - thuN) + ' Friday)' + (cleared ? '; cleared ' + cleared + ' leftover copies from the board day' : '');
    if (typeof showToast === 'function') showToast(msg, 6000); else alert(msg);
    container.remove();
  }

  window.checkIndianaRestockPlanner = async function () {
    const counts = window.parsedFormCounts || {};
    if (!isIndianaWednesdayBulk(counts)) {
      alert('No Indiana Thursday or Friday restocks found. Paste the dispatch list on the Indiana board first.');
      return;
    }
    // Real driving times for the day-length cap (falls back to straight-line estimates if unavailable).
    try { if (typeof loadDistanceMatrix === 'function') await loadDistanceMatrix('IN'); } catch (e) { /* estimate instead */ }
    const plan = await buildPlan(counts);
    if (plan.length) renderPlanner(plan);
    else alert('No Indiana Thursday or Friday restocks found in this list.');
  };

  // Auto-check after a short delay on load / after processDispatch if desired
  // Callers in index.html can also invoke window.checkIndianaRestockPlanner() explicitly.
})();
