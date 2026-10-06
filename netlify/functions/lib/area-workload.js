/**
 * lib/area-workload.js  (v1, 2026-10-06)   PREVIEW / SHADOW MODE
 * SAVE AS: netlify/functions/lib/area-workload.js
 *
 * "Workload by area" for the Morning brief. The existing Heavy / Regular / Light
 * label divides ALL of a territory's stops by ALL of its technicians. In Georgia
 * that blends Atlanta with Savannah, Macon, South Carolina and North Carolina, so a
 * crunch in Atlanta is diluted by techs who cannot help there (and the extra calls
 * they cover). This module measures each AREA against the technicians who can
 * actually reach it, using only data the app already has (technician home
 * coordinates, site coordinates, assignments, time off). Nothing here changes the
 * existing label or the attention list; it is shown beside them to compare.
 *
 * HOW IT WORKS
 *  1. AREAS come from where the technicians live: homes within AREA_LINK_MIN
 *     drive-minutes of each other (directly or through a chain) form one area.
 *     Hire, lose or move a technician and the areas follow; no list to maintain.
 *  2. Every stop belongs to the area of the NEAREST technician home (all active
 *     technicians, whether or not they are out that day).
 *  3. REACH: a technician counts fully toward an area when the area's stops are
 *     within REACH_FULL_MIN of their home, tapering in a straight line to nothing at
 *     REACH_ZERO_MIN. Distance is measured to the centre of that day's stops in the
 *     area, so a day weighted toward the south end of Atlanta gives Macon more
 *     credit than a day weighted north. An area's EFFECTIVE TECHS for a day is the
 *     sum of the reach of every technician who is working that day.
 *  4. LOAD for an area on a day = its stops / its effective techs, compared with the
 *     same figure over the recent baseline days (same method as the existing label,
 *     so the "x usual" number reads the same way). Labels use the same Heavy-Day
 *     Trigger and light threshold as the existing one.
 *  5. An area with fewer than two fully-reaching technicians shows counts only (one
 *     tech and two extra stops would swing a ratio far too much to be a fair label).
 *
 * APPROXIMATION: drive time is estimated from straight-line distance
 * (DRIVE_BASE_MIN + DRIVE_MIN_PER_MILE x miles). The app also stores real drive
 * times from each tech's home to each site (tech_site_distances); a later version
 * can use those. Not modelled yet: a tech whose own stops pull them the other way
 * on a given day (their credit should drop), and travel time between areas.
 */
const AREA_LINK_MIN = 60;        // technician homes this close (drive minutes) are one area
const REACH_FULL_MIN = 60;       // full credit within this many minutes
const REACH_ZERO_MIN = 120;      // no credit at or beyond this many minutes
const DRIVE_BASE_MIN = 10;       // fixed minutes for any trip (parking, local roads)
const DRIVE_MIN_PER_MILE = 1.0;  // plus this per straight-line mile
const MIN_BASIS_DAYS = 5;
const MIN_FULL_TECHS_FOR_LABEL = 2;
const NAME_MATCH_MILES = 45;     // an area is named after a listed city within this distance

// [name, lat, lng] for readable area names; anything not near one falls back to technician names.
const METROS = [
  ["Atlanta", 33.75, -84.39], ["Athens", 33.96, -83.38], ["Macon", 32.84, -83.63], ["Augusta", 33.47, -81.97],
  ["Savannah", 32.08, -81.09], ["Columbus", 32.46, -84.99], ["Albany", 31.58, -84.16], ["Valdosta", 30.83, -83.28],
  ["Columbia", 34.0, -81.03], ["Charleston", 32.78, -79.93], ["Greenville", 34.85, -82.4], ["Raleigh", 35.78, -78.64],
  ["Charlotte", 35.23, -80.84], ["Greensboro", 36.07, -79.79], ["Wilmington", 34.23, -77.94], ["Asheville", 35.6, -82.55],
  ["Chattanooga", 35.05, -85.31], ["Knoxville", 35.96, -83.92], ["Nashville", 36.16, -86.78], ["Birmingham", 33.52, -86.8],
  ["Huntsville", 34.73, -86.59], ["Montgomery", 32.37, -86.3], ["Mobile", 30.69, -88.04], ["Jackson", 32.3, -90.18],
  ["Jacksonville", 30.33, -81.66], ["Tallahassee", 30.44, -84.28], ["Orlando", 28.54, -81.38], ["Tampa", 27.95, -82.46],
  ["Miami", 25.76, -80.19], ["Indianapolis", 39.77, -86.16], ["Fort Wayne", 41.08, -85.14], ["Evansville", 37.97, -87.57],
  ["Louisville", 38.25, -85.76], ["Cincinnati", 39.1, -84.51], ["Columbus OH", 39.96, -83.0], ["Cleveland", 41.5, -81.69],
  ["Detroit", 42.33, -83.05], ["Grand Rapids", 42.96, -85.67], ["Lansing", 42.73, -84.55], ["Minneapolis", 44.98, -93.27],
  ["Las Vegas", 36.17, -115.14], ["Reno", 39.53, -119.81], ["Portland", 45.52, -122.68], ["Boise", 43.62, -116.2],
  ["Denver", 39.74, -104.99], ["Colorado Springs", 38.83, -104.82], ["Los Angeles", 34.05, -118.24], ["San Diego", 32.72, -117.16],
  ["Sacramento", 38.58, -121.49], ["San Francisco", 37.77, -122.42], ["Fresno", 36.74, -119.79], ["Charleston WV", 38.35, -81.63],
  ["Pittsburgh", 40.44, -79.99], ["Richmond", 37.54, -77.44], ["Seattle", 47.6, -122.33],
];

const toRad = (d) => (d * Math.PI) / 180;
function miles(a, b) {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const driveMin = (a, b) => DRIVE_BASE_MIN + DRIVE_MIN_PER_MILE * miles(a, b);
function reach(min) {
  if (min <= REACH_FULL_MIN) return 1;
  if (min >= REACH_ZERO_MIN) return 0;
  return (REACH_ZERO_MIN - min) / (REACH_ZERO_MIN - REACH_FULL_MIN);
}
const hasPt = (o) => o && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng)) && o.lat !== null && o.lng !== null;
const pt = (o) => ({ lat: Number(o.lat), lng: Number(o.lng) });
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";
const round = (v, d) => { const k = Math.pow(10, d == null ? 1 : d); return Math.round(v * k) / k; };

/** Group technicians (with home coordinates) into areas by home proximity. */
function buildAreas(techs) {
  const located = (techs || []).filter(hasPt);
  const parent = located.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < located.length; i++) {
    for (let j = i + 1; j < located.length; j++) {
      if (driveMin(pt(located[i]), pt(located[j])) <= AREA_LINK_MIN) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  located.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  const areas = [...groups.values()].map((members, idx) => {
    const center = {
      lat: members.reduce((s, t) => s + Number(t.lat), 0) / members.length,
      lng: members.reduce((s, t) => s + Number(t.lng), 0) / members.length,
    };
    let best = null;
    for (const [name, lat, lng] of METROS) {
      const d = miles(center, { lat, lng });
      if (d <= NAME_MATCH_MILES && (!best || d < best.d)) best = { name, d };
    }
    return { key: "a" + idx, techIds: members.map((t) => t.id), techNames: members.map((t) => t.name), center, metro: best ? best.name : null };
  });
  // Readable, unique names.
  const used = new Map();
  for (const a of areas) used.set(a.metro, (used.get(a.metro) || 0) + 1);
  for (const a of areas) {
    const who = a.techNames.slice(0, 3).map(firstName).join(", ") + (a.techNames.length > 3 ? " +" + (a.techNames.length - 3) : "");
    a.name = a.metro && used.get(a.metro) === 1 ? a.metro : (a.metro ? a.metro + " (" + who + ")" : "Area of " + who);
  }
  return areas;
}

/** site id -> area key of the nearest technician home. */
function mapSitesToAreas(sites, techs, areas) {
  const areaOfTech = new Map();
  areas.forEach((a) => a.techIds.forEach((id) => areaOfTech.set(id, a.key)));
  const located = (techs || []).filter((t) => hasPt(t) && areaOfTech.has(t.id));
  const out = new Map();
  for (const s of sites || []) {
    if (!hasPt(s) || !located.length) continue;
    let best = null;
    for (const t of located) {
      const d = miles(pt(s), pt(t));
      if (!best || d < best.d) best = { d, key: areaOfTech.get(t.id) };
    }
    out.set(s.id, best.key);
  }
  return out;
}

/**
 * @param o.techs        active technicians { id, name, lat, lng }
 * @param o.sites        territory sites { id, lat, lng }
 * @param o.assignments  stops { site_id, status, dispatch_date } covering the baseline window through today
 * @param o.todayStr     YYYY-MM-DD
 * @param o.isBusinessDay(dateStr) -> bool
 * @param o.isOut(dateStr, techId) -> bool   (time off / comp day)
 * @param o.onCallTodayIds  ids working today when only an on-call crew is (Saturday), else []
 * @param o.heavyTrigger, o.lightBelow
 */
function computeAreaWeight(o) {
  const techs = o.techs || [];
  const sites = o.sites || [];
  const located = techs.filter(hasPt);
  const noLocation = techs.filter((t) => !hasPt(t)).map((t) => t.name);
  const areas = buildAreas(techs);
  if (!areas.length) return { shadow: true, areas: [], busiest: null, note: "No technician home locations on file, so areas cannot be worked out.", techsWithoutLocation: noLocation };
  const siteArea = mapSitesToAreas(sites, techs, areas);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const todayStr = o.todayStr;

  const callsOnDay = (day) => (o.assignments || []).filter((a) => a.dispatch_date === day && a.status !== "removed");
  const dayAreaStats = (day, workingIds) => {
    const stops = callsOnDay(day);
    const perArea = new Map();
    let unplaced = 0;
    for (const a of stops) {
      const key = siteArea.get(a.site_id);
      const s = siteById.get(a.site_id);
      if (!key || !s) { unplaced++; continue; }
      if (!perArea.has(key)) perArea.set(key, []);
      perArea.get(key).push(pt(s));
    }
    const stats = new Map();
    for (const area of areas) {
      const pts = perArea.get(area.key) || [];
      const centre = pts.length
        ? { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length }
        : area.center;
      let eff = 0, full = 0;
      const reachers = [];
      for (const t of located) {
        if (!workingIds(t.id)) continue;
        const r = reach(driveMin(pt(t), centre));
        if (r > 0) { eff += r; reachers.push({ name: t.name, reach: r }); }
        if (r >= 0.999) full++;
      }
      stats.set(area.key, { calls: pts.length, eff, full, reachers });
    }
    return { stats, total: stops.length, unplaced };
  };

  const onCall = o.onCallTodayIds || [];
  const workingToday = (id) => (onCall.length ? onCall.includes(id) : !o.isOut(todayStr, id));
  const today = dayAreaStats(todayStr, workingToday);

  // Baseline: the same measurement on each recent business day that had stops.
  const days = [...new Set((o.assignments || []).filter((a) => a.dispatch_date < todayStr && a.status !== "removed").map((a) => a.dispatch_date))]
    .filter((d) => o.isBusinessDay(d));
  const sumCalls = new Map(), sumEff = new Map();
  let basisDays = 0;
  for (const day of days) {
    const st = dayAreaStats(day, (id) => !o.isOut(day, id));
    if (st.total < 1) continue;
    basisDays++;
    for (const area of areas) {
      const x = st.stats.get(area.key);
      sumCalls.set(area.key, (sumCalls.get(area.key) || 0) + x.calls);
      sumEff.set(area.key, (sumEff.get(area.key) || 0) + Math.max(x.eff, 0.0001));
    }
  }

  const rows = areas.map((area) => {
    const x = today.stats.get(area.key);
    const baseline = basisDays >= MIN_BASIS_DAYS && (sumCalls.get(area.key) || 0) > 0 ? sumCalls.get(area.key) / sumEff.get(area.key) : null;
    const perTech = x.eff > 0.05 ? x.calls / x.eff : null;
    let ratio = null, label = null, note = null;
    const small = x.full < MIN_FULL_TECHS_FOR_LABEL;
    if (x.calls === 0) label = "none";
    else if (x.eff < 0.05) { label = "uncovered"; note = "No working technician within about 2 hours of these stops."; }
    else if (baseline != null && !small) {
      ratio = perTech / baseline;
      label = ratio >= o.heavyTrigger ? "heavy" : (ratio < o.lightBelow ? "light" : "regular");
    } else if (small) note = "Fewer than " + MIN_FULL_TECHS_FOR_LABEL + " technicians fully cover this area, so it shows counts only.";
    else note = "Not enough history yet.";
    return {
      key: area.key, name: area.name, techNames: area.techNames,
      calls: x.calls, effectiveTechs: round(x.eff, 1), fullTechs: x.full,
      reachers: x.reachers.sort((a, b) => b.reach - a.reach).map((r) => ({ name: r.name, reach: round(r.reach, 2) })),
      callsPerTech: perTech == null ? null : round(perTech, 1),
      baselineCallsPerTech: baseline == null ? null : round(baseline, 1),
      ratio: ratio == null ? null : round(ratio, 2), label, note,
    };
  }).filter((r) => r.calls > 0 || r.label === "uncovered");
  rows.sort((a, b) => (b.ratio == null ? -1 : b.ratio) - (a.ratio == null ? -1 : a.ratio) || b.calls - a.calls);
  const busiest = rows.find((r) => r.ratio != null) || null;
  return {
    shadow: true, basisDays, heavyTrigger: o.heavyTrigger, lightBelow: o.lightBelow,
    areas: rows, busiest: busiest ? { name: busiest.name, label: busiest.label, ratio: busiest.ratio, calls: busiest.calls, effectiveTechs: busiest.effectiveTechs } : null,
    stopsWithoutLocation: today.unplaced, techsWithoutLocation: noLocation,
    assumptions: { areaLinkMin: AREA_LINK_MIN, reachFullMin: REACH_FULL_MIN, reachZeroMin: REACH_ZERO_MIN },
  };
}

module.exports = { computeAreaWeight, buildAreas, mapSitesToAreas, driveMin, reach, miles, _consts: { AREA_LINK_MIN, REACH_FULL_MIN, REACH_ZERO_MIN } };
