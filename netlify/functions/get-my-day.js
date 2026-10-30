// get-my-day.js
// A technician's stops, taken only from the schedule the dispatcher actually sent them
// (published_dispatches message text), in the order of that text. Days are labelled by the
// date in the message header. Read only.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return WD[dt.getUTCDay()] + ', ' + MO[m - 1] + ' ' + d;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// numbered lines "N. Site name - Type ..." -> [{n, text}] (site names can contain " - " themselves)
function parseMessageStops(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (m) out.push({ n: Number(m[1]), text: m[2] });
  }
  return out;
}

function matchSite(line, sites, used) {
  const ln = norm(line);
  let best = null;
  for (const s of sites) {
    if (used.has(s.id)) continue;
    const sn = norm(s.name);
    if (sn && ln.startsWith(sn) && (!best || sn.length > norm(best.name).length)) best = s;
  }
  if (best) return best;
  // the dispatch text may omit a trailing code on the site name: compare against the part before the last " - "
  const cut = line.lastIndexOf(' - ');
  const ln2 = norm(cut > 0 ? line.slice(0, cut) : line);
  for (const s of sites) {
    if (used.has(s.id)) continue;
    const sn = norm(s.name);
    if (ln2 && sn.startsWith(ln2) && (!best || sn.length < norm(best.name).length)) best = s;
  }
  return best;
}


const MONTH_IDX = {}; MO.forEach((m, i) => { MONTH_IDX[m.toLowerCase()] = i; });

// "...dispatches for Thursday, October 29:" -> ISO date, year taken from when it was published
function headerDate(text, publishedAt) {
  const m = String(text).match(/for\s+([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})/);
  if (!m || MONTH_IDX[m[2].toLowerCase()] == null) return null;
  const pub = new Date(publishedAt || Date.now());
  let year = pub.getUTCFullYear();
  const mi = MONTH_IDX[m[2].toLowerCase()];
  if (mi < pub.getUTCMonth() - 6) year += 1;
  else if (mi > pub.getUTCMonth() + 6) year -= 1;
  return year + '-' + String(mi + 1).padStart(2, '0') + '-' + String(Number(m[3])).padStart(2, '0');
}

function easternToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const techId = params.technician_id;
    if (!techId) return json(400, { ok: false, error: 'technician_id required' });
    const { data: tech } = await supabase.from('technicians').select('id, name').eq('id', techId).single();
    if (!tech) return json(404, { ok: false, error: 'Technician not found' });

    const since = new Date(Date.now() - 10 * 86400000).toISOString();
    const { data: pubs } = await supabase
      .from('published_dispatches')
      .select('dispatch_date, published_at, messages')
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .limit(40);

    // newest sent message per date for this tech
    const byDate = {};
    for (const p of pubs || []) {
      const msgs = p.messages || {};
      const key = Object.keys(msgs).find((k) => norm(k) === norm(tech.name));
      const text = key ? String(msgs[key] || '') : '';
      if (!text) continue;
      const d = headerDate(text, p.published_at);
      if (d && !byDate[d]) byDate[d] = text;
    }
    const today = easternToday();
    const dates = Object.keys(byDate).filter((d) => d >= today).sort();
    // also keep today if sent earlier; otherwise nothing to show
    const days = dates.map((d) => ({ date: d, label: dateLabel(d) }));
    if (!days.length) return json(200, { ok: true, today, days: [], date: null, stops: [] });

    const date = params.date && byDate[params.date] ? params.date : days[0].date;
    const parsed = parseMessageStops(byDate[date]);

    const { data: allSites } = await supabase.from('sites').select('id, site_code, name, address, lat, lng');
    const { data: asg } = await supabase
      .from('assignments').select('site_id, ticket_id, status')
      .eq('technician_id', techId).eq('dispatch_date', date).neq('status', 'removed');
    const ticketIds = [...new Set((asg || []).map((a) => a.ticket_id).filter(Boolean))];
    const ticketBySite = {};
    if (ticketIds.length) {
      const { data: tk } = await supabase.from('tickets').select('id, ticket_kind').in('id', ticketIds);
      const tById = {}; for (const t of tk || []) tById[t.id] = t;
      for (const a of asg || []) if (a.ticket_id && tById[a.ticket_id]) ticketBySite[a.site_id] = tById[a.ticket_id];
    }

    const used = new Set();
    const picked = [];
    for (const ps of parsed) {
      const hit = matchSite(ps.text, allSites || [], used);
      if (hit) { used.add(hit.id); picked.push({ site: hit, text: ps.text }); }
      else picked.push({ site: null, text: ps.text });
    }
    const codes = picked.map((x) => x.site && x.site.site_code).filter(Boolean);
    const readerByCode = {};
    if (codes.length) {
      const { data: rl } = await supabase.from('reader_lookup').select('num, site_code').in('site_code', codes);
      for (const r of rl || []) (readerByCode[r.site_code] = readerByCode[r.site_code] || new Set()).add(r.num);
    }
    const stops = picked.map((x, i) => {
      const s = x.site;
      const typeMatch = x.text.match(/\s-\s([A-Z][^⚡]*?)\s*(?:⚡.*)?$/);
      const tk = s ? ticketBySite[s.id] : null;
      return {
        site_id: s ? s.id : 'msg' + i,
        site_code: s ? s.site_code : null,
        name: s ? s.name : x.text.replace(/\s-\s[A-Z][^-]*$/, ''),
        address: s ? s.address : null,
        lat: s && s.lat != null ? Number(s.lat) : null,
        lng: s && s.lng != null ? Number(s.lng) : null,
        kind: tk ? tk.ticket_kind : (typeMatch ? typeMatch[1].trim() : null),
        readers: s && s.site_code ? Array.from(readerByCode[s.site_code] || []) : [],
      };
    });
    return json(200, { ok: true, today, days, date, label: dateLabel(date), stops });
  } catch (e) {
    return json(500, { ok: false, error: String(e && e.message || e) });
  }
};
