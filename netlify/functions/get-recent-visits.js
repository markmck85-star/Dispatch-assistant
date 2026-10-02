// netlify/functions/get-recent-visits.js
//
// Returns recent site_visits directly, filtered by state (required) and an
// optional single date or date range, sorted newest-first (by started_at).
// Built 2026-09-12 for Location Lookup and the Closing Email
// Reconstructor's state-wide browse view -- both pages previously required
// searching for a specific site first, which made it slow to hunt for
// whichever recent visits happened to have a captured closing note. This
// lets a dispatcher browse a whole state's stream of visits directly,
// newest first, without picking a site up front.
//
// Query params:
//   state      (optional) - 2-letter state code. Required UNLESS `q` (note
//              text search) is present, in which case omitting it searches
//              across all states.
//   date       (optional) - single day, YYYY-MM-DD -- filters to that one
//              calendar day (based on started_at)
//   from / to  (optional) - date range, YYYY-MM-DD each, inclusive.
//              Ignored if `date` is also present -- date wins.
//   tech       (optional) - exact tech_name_raw match, from the
//              Technician dropdown (populated by get-state-techs.js)
//   q          (optional) - free-text search against the captured
//              closing_note (case-insensitive substring match). Combines
//              with state/date/tech -- all provided filters apply together.
//              Added 2026-09-15 so a dispatcher can search note contents
//              directly instead of only browsing/filtering by state+date+tech.
//   limit      (optional) - default 50, max 200
//   offset     (optional) - default 0, for "Load more" pagination
//
// 2026-10-02: ALSO returns the email-derived closings (ITI Technician
// Service Response close-outs for OTC / PM / testing stations in MI, OH, NV,
// CO and OR), merged into the same newest-first list as source "email" rows,
// so one search covers kiosk visits and email closings. They come from
// list-service-responses.js (tickets a response closed plus the response
// emails themselves), shaped like visits: the email's resolution notes are
// the closing_note, so note-text search, state, date and tech filters all
// work on them. Pass email=0 to get kiosk visits only (the old behavior), or
// kiosk=0 to get the email closings only.
// The lossy site_visits stubs the TechWeb forward parser wrote for those same
// five states (one ticket-number key, so every PM with ticket "0" collapsed
// into one row, and no note text) are left out of the merge, since the email
// rows cover them completely. If the email side fails, kiosk visits still
// come back and `emailMerged` is false.
//
// Joins to `sites` for display name/code, since site_visits only stores
// site_id plus the raw Salesforce account name (account_name_raw), which
// doesn't always match the site's real display name.

const { createClient } = require('@supabase/supabase-js');
const serviceResponses = require('./list-service-responses');

const EMAIL_STATES = ['MI', 'OH', 'NV', 'CO', 'OR'];

function isoOrNull(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function ms(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return isNaN(t) ? -Infinity : t;
}

// Email-derived closings as visit-shaped rows, with this request's filters
// applied here (they are not SQL-backed).
async function loadEmailVisits(params, state) {
  const res = await serviceResponses.handler({
    httpMethod: 'GET',
    queryStringParameters: state ? { state, limit: '500' } : { limit: '500' },
  });
  if (res.statusCode !== 200) throw new Error('service responses failed (' + res.statusCode + ')');
  const rows = (JSON.parse(res.body).rows) || [];

  const q = (params.q || '').trim().toLowerCase();
  const tech = (params.tech || '').trim().toLowerCase();
  const out = [];
  for (const r of rows) {
    const startedAt = isoOrNull(r.arrivalTime);
    const endedAt = isoOrNull(r.endTime);
    const day = startedAt ? startedAt.slice(0, 10) : null;
    if (params.date) {
      if (day !== params.date) continue;
    } else {
      if (params.from && (!day || day < params.from)) continue;
      if (params.to && (!day || day > params.to)) continue;
    }
    if (tech && String(r.technician || '').trim().toLowerCase() !== tech) continue;
    if (q && !String(r.notes || '').toLowerCase().includes(q)) continue;

    const rowState = r.state || (r.siteCode && /^[A-Z]{2}/.test(r.siteCode) ? r.siteCode.slice(0, 2) : '') || state || '';
    const wo = r.ticketNumber && String(r.ticketNumber).replace(/^0+$/, '') ? r.ticketNumber : (r.wo || '');
    out.push({
      id: 'email:' + (r.ticketNumber || r.wo || '') + '|' + (r.arrivalTime || r.closedAt || '') + '|' + (r.technician || ''),
      site_id: null,
      account_name_raw: r.location || null,
      state: rowState,
      appointment_number: null,
      wo_number: wo || null,
      started_at: startedAt,
      ended_at: endedAt,
      duration_min: r.onsiteMin == null ? null : r.onsiteMin,
      tech_name_raw: r.technician || null,
      remediation: r.callType || 'Service response',
      remediation_detail: null,
      is_restock: false,
      needs_review: !r.siteCode,
      closing_note: r.notes ? String(r.notes) : null,
      closing_note_captured_at: r.closedAt || null,
      site_name: r.siteName || r.location || null,
      site_code: r.siteCode || null,
      source: 'email',
      travel_min: r.travelTime === '' || r.travelTime == null ? null : r.travelTime,
      mileage: r.mileage === '' || r.mileage == null ? null : r.mileage,
    });
  }
  return out;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const params = event.queryStringParameters || {};
    const state = (params.state || '').trim().toUpperCase();
    const noteQuery = (params.q || '').trim();
    // 2026-10-02: state is optional. With no state and no q this returns the
    // newest visits across all states (the Closing Notes page's default view).
    const limit = Math.min(parseInt(params.limit, 10) || 50, 200);
    const offset = parseInt(params.offset, 10) || 0;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Email-derived closings only exist for these states (or when searching
    // across all states). email=0 turns the merge off.
    const wantEmail = params.email !== '0' && (!state || EMAIL_STATES.includes(state));
    // kiosk=0 leaves kiosk visits out (email closings only). Together with
    // email=0 this is what the Closing Notes page's two checkboxes send.
    const wantKiosk = params.kiosk !== '0';

    let query = supabase
      .from('site_visits')
      .select(
        'id, site_id, account_name_raw, state, appointment_number, wo_number, started_at, ended_at, ' +
        'duration_min, tech_name_raw, remediation, remediation_detail, is_restock, needs_review, ' +
        'closing_note, closing_note_captured_at, source, remediation_detail, sites(name, site_code)',
        { count: 'exact' }
      )
      .order('started_at', { ascending: false, nullsFirst: false })
      .range(wantEmail ? 0 : offset, offset + limit - 1);

    // The TechWeb forward stubs for the email states are replaced by the
    // email rows below (see header).
    if (wantEmail) {
      query = query.or('source.is.null,source.neq.closing_note_email,state.is.null,state.not.in.(' + EMAIL_STATES.join(',') + ')');
    }

    if (state) query = query.eq('state', state);
    if (noteQuery) query = query.ilike('closing_note', `%${noteQuery}%`);

    if (params.date) {
      query = query.gte('started_at', `${params.date}T00:00:00`).lte('started_at', `${params.date}T23:59:59`);
    } else {
      if (params.from) query = query.gte('started_at', `${params.from}T00:00:00`);
      if (params.to) query = query.lte('started_at', `${params.to}T23:59:59`);
    }
    if (params.tech) {
      query = query.ilike('tech_name_raw', params.tech.trim());
    }

    const { data, error, count } = wantKiosk ? await query : { data: [], error: null, count: 0 };
    if (error) throw new Error(error.message);

    let visits = (data || []).map((v) => ({
      ...v,
      // TechWeb-format rows keep the tech's notes in remediation_detail.
      closing_note: v.closing_note || (v.source === 'closing_note_email' ? v.remediation_detail : null) || null,
      site_name: v.sites ? v.sites.name : v.account_name_raw,
      site_code: v.sites ? v.sites.site_code : null,
      sites: undefined,
    }));

    if (!wantEmail) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          visits,
          total: count ?? null,
          hasMore: count != null ? offset + visits.length < count : visits.length === limit,
        }),
      };
    }

    let emailVisits = [];
    let emailMerged = true;
    try {
      emailVisits = await loadEmailVisits(params, state);
    } catch (err) {
      console.error('[get-recent-visits] email merge failed, returning kiosk visits only:', err.message);
      emailMerged = false;
    }

    // `visits` holds the newest offset+limit kiosk rows, `emailVisits` every
    // matching email row; the newest offset+limit of the union is correct,
    // and the requested page is a slice of that.
    const merged = visits.concat(emailVisits).sort((a, b) => ms(b.started_at || b.ended_at) - ms(a.started_at || a.ended_at));
    const page = merged.slice(offset, offset + limit);
    const total = count != null ? count + emailVisits.length : null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        visits: page,
        total,
        hasMore: total != null ? offset + page.length < total : page.length === limit,
        emailMerged,
        emailRows: emailVisits.length,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
