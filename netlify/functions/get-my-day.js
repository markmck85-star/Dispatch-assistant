// get-my-day.js
// A technician's stops for one day, in the order the dispatch app sorted them.
// Order comes from the published dispatch text (numbered lines) when it matches the date,
// else assignments.sequence_order, else name. Read only.

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

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const techId = params.technician_id;
    const date = params.date;
    if (!techId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json(400, { ok: false, error: 'technician_id and date required' });

    const { data: tech } = await supabase.from('technicians').select('id, name, home_state, additional_states').eq('id', techId).single();
    if (!tech) return json(404, { ok: false, error: 'Technician not found' });

    const { data: asg, error } = await supabase
      .from('assignments')
      .select('id, site_id, ticket_id, sequence_order, status')
      .eq('technician_id', techId)
      .eq('dispatch_date', date)
      .neq('status', 'removed');
    if (error) return json(500, { ok: false, error: error.message });
    if (!asg || !asg.length) return json(200, { ok: true, date, stops: [], order_source: 'none' });

    const siteIds = [...new Set(asg.map((a) => a.site_id).filter(Boolean))];
    const ticketIds = [...new Set(asg.map((a) => a.ticket_id).filter(Boolean))];
    const { data: sites } = await supabase.from('sites').select('id, site_code, name, address, lat, lng').in('id', siteIds);
    const siteById = {};
    for (const s of sites || []) siteById[s.id] = s;

    let ticketById = {};
    if (ticketIds.length) {
      const { data: tk } = await supabase.from('tickets').select('id, ticket_kind, description, wo_number').in('id', ticketIds);
      for (const t of tk || []) ticketById[t.id] = t;
    }

    // reader numbers: reader_lookup by site code, plus the tag read from the latest visit
    const codes = (sites || []).map((s) => s.site_code).filter(Boolean);
    const readerBySite = {};
    if (codes.length) {
      const { data: rl } = await supabase.from('reader_lookup').select('num, site_code').in('site_code', codes);
      for (const r of rl || []) {
        const s = (sites || []).find((x) => x.site_code === r.site_code);
        if (s) (readerBySite[s.id] = readerBySite[s.id] || new Set()).add(r.num);
      }
    }

    // order from the published dispatch text
    let orderSource = 'sequence';
    const rank = {};
    try {
      const from = new Date(date + 'T00:00:00Z'); from.setUTCDate(from.getUTCDate() - 7);
      const { data: pubs } = await supabase
        .from('published_dispatches')
        .select('dispatch_date, published_at, messages')
        .gte('dispatch_date', from.toISOString().slice(0, 10))
        .order('published_at', { ascending: false })
        .limit(20);
      const label = dateLabel(date);
      for (const p of pubs || []) {
        const msgs = p.messages || {};
        const key = Object.keys(msgs).find((k) => norm(k) === norm(tech.name));
        const text = key ? String(msgs[key] || '') : '';
        if (!text || text.indexOf(label) === -1) continue;
        const parsed = parseMessageStops(text);
        if (!parsed.length) continue;
        const used = new Set();
        for (const ps of parsed) {
          const hit = matchSite(ps.text, sites || [], used);
          if (hit) { used.add(hit.id); rank[hit.id] = ps.n; }
        }
        if (Object.keys(rank).length) { orderSource = 'dispatch_text'; break; }
      }
    } catch (e) { /* fall back to sequence_order */ }

    const stops = asg.map((a) => {
      const s = siteById[a.site_id] || {};
      const t = ticketById[a.ticket_id] || {};
      return {
        assignment_id: a.id,
        site_id: a.site_id,
        site_code: s.site_code || null,
        name: s.name || 'Stop',
        address: s.address || null,
        lat: s.lat != null ? Number(s.lat) : null,
        lng: s.lng != null ? Number(s.lng) : null,
        kind: t.ticket_kind || null,
        description: t.description || null,
        readers: Array.from(readerBySite[a.site_id] || []),
        _rank: rank[a.site_id] != null ? rank[a.site_id] : null,
        _seq: a.sequence_order != null ? a.sequence_order : 9999,
      };
    });
    stops.sort((x, y) => {
      if (orderSource === 'dispatch_text') {
        const rx = x._rank != null ? x._rank : 999, ry = y._rank != null ? y._rank : 999;
        if (rx !== ry) return rx - ry;
      }
      if (x._seq !== y._seq) return x._seq - y._seq;
      return String(x.name).localeCompare(String(y.name));
    });
    for (const s of stops) { delete s._rank; delete s._seq; }
    return json(200, { ok: true, date, order_source: orderSource, stops });
  } catch (e) {
    return json(500, { ok: false, error: String(e && e.message || e) });
  }
};
