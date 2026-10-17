// extract-leftover-counts.js -- 2026-10-17
//
// Fills restock_leftover_counts from closing notes that already carry the "forms left before
// the restock" number ("The left form count was 142 prior to restock."), so the data builds
// whether or not a tech uses the portal's Done prompt. Notes arrive through the Salesforce
// report sync; this reads what is already in site_visits and never touches the sync itself.
//
// Runs hourly (see netlify.toml). Safe to run any time and as often as wanted: a visit is
// skipped when its site and date already have a row, so nothing doubles up, and a count typed
// in the portal is never overwritten by one read from a note.
//
// By hand (logged-in dispatcher). Netlify blocks URL calls to a scheduled function, so use the
// unscheduled twin extract-leftover-counts-now.js, which runs this same handler:
//   /.netlify/functions/extract-leftover-counts-now?days=400      backfill the last 400 days
//   /.netlify/functions/extract-leftover-counts-now?days=30&dry=1 show what would be added, write nothing
//
// A row from here has assignment_id null and source 'closing_note'. rolls uses the portal's
// keys: LF / RF, plus F when the note gave a count but not which printer side.
// Florida and North Carolina techs pull about 100 forms off the roll before installing it
// (so they do not rub the back of the surfboard), which makes their count a guess; those
// rows get source 'closing_note_approx' so anything using the counts can leave them out.
//
// Never throws: a scheduled function that errors repeatedly only adds noise.

const { createClient } = require('@supabase/supabase-js');
const { parseLeftoverCounts } = require('./lib/leftover-from-notes.js');

// Local calendar date of a visit, so an evening visit is not filed under tomorrow's UTC date.
const STATE_TZ = {
  NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', CA: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  CO: 'America/Denver', ID: 'America/Boise',
  AR: 'America/Chicago', MS: 'America/Chicago', MN: 'America/Chicago', IL: 'America/Chicago',
  TX: 'America/Chicago', AL: 'America/Chicago',
  MI: 'America/Detroit', IN: 'America/Indiana/Indianapolis',
};
const APPROX_STATES = new Set(['FL', 'NC']);
function localDate(iso, state) {
  const tz = STATE_TZ[String(state || '').toUpperCase()] || 'America/New_York';
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  try {
    const params = (event && event.queryStringParameters) || {};
    const days = Math.min(Math.max(parseInt(params.days, 10) || 3, 1), 800);
    const dry = params.dry === '1' || params.dry === 'true';

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: 'Supabase env vars not configured' });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Visits whose note mentions the phrase. Paged, since a long backfill can pass 1000 rows.
    const visits = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('site_visits')
        .select('id, site_id, state, started_at, technician_id, closing_note')
        .not('site_id', 'is', null)
        .not('started_at', 'is', null)
        .gte('started_at', since)
        .or('closing_note.ilike.%prior to%restock%,closing_note.ilike.%forms at%,closing_note.ilike.%form count%')
        .order('started_at', { ascending: true })
        .range(from, from + 999);
      if (error) return json(500, { ok: false, error: error.message });
      visits.push(...(data || []));
      if (!data || data.length < 1000) break;
    }

    // One candidate per site and day; the first visit of the day wins.
    const candidates = new Map(); // "siteId|date" -> row
    let unreadable = 0;
    for (const v of visits) {
      const rolls = parseLeftoverCounts(v.closing_note);
      if (!Object.keys(rolls).length) { unreadable++; continue; }
      const date = localDate(v.started_at, v.state);
      const key = v.site_id + '|' + date;
      if (candidates.has(key)) continue;
      candidates.set(key, {
        site_id: v.site_id,
        assignment_id: null,
        technician_id: v.technician_id || null,
        dispatch_date: date,
        rolls,
        source: APPROX_STATES.has(String(v.state || '').toUpperCase()) ? 'closing_note_approx' : 'closing_note',
      });
    }

    // Drop anything that already has a row for that site and day (portal or earlier run).
    const siteIds = [...new Set([...candidates.values()].map(c => c.site_id))];
    const have = new Set();
    for (let i = 0; i < siteIds.length; i += 150) {
      const { data, error } = await supabase
        .from('restock_leftover_counts')
        .select('site_id, dispatch_date')
        .in('site_id', siteIds.slice(i, i + 150))
        .gte('dispatch_date', since.slice(0, 10));
      if (error) return json(500, { ok: false, error: error.message });
      (data || []).forEach(r => have.add(r.site_id + '|' + r.dispatch_date));
    }
    const fresh = [...candidates.entries()].filter(([k]) => !have.has(k)).map(([, row]) => row);

    let added = 0;
    if (!dry) {
      for (let i = 0; i < fresh.length; i += 200) {
        const chunk = fresh.slice(i, i + 200);
        const { error } = await supabase.from('restock_leftover_counts').insert(chunk);
        if (error) return json(500, { ok: false, error: error.message, added });
        added += chunk.length;
      }
    }

    return json(200, {
      ok: true, dry, days,
      notesWithPhrase: visits.length,
      readable: candidates.size,
      unreadable,
      alreadyHad: candidates.size - fresh.length,
      added: dry ? 0 : added,
      wouldAdd: dry ? fresh.length : undefined,
      sample: dry ? fresh.slice(0, 5).map(r => ({ date: r.dispatch_date, rolls: r.rolls })) : undefined,
    });
  } catch (e) {
    console.error('[extract-leftover-counts] error:', e.message);
    return json(200, { ok: false, error: 'Run failed.' });
  }
};
