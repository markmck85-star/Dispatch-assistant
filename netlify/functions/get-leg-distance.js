// get-leg-distance.js
// Returns the matrix distance for one mileage-log leg so the page can
// pre-fill the leading digits of the ending odometer.
// Home <-> site uses tech_site_distances; site <-> site uses site_site_distances.
// Read-only. Returns distance_mi: null when the matrix has no answer.

const { createClient } = require('@supabase/supabase-js');

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

const SAFE_ID = /^[0-9A-Za-z_-]+$/;

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const techId = p.technician_id;
  const fromKind = p.from_kind || '';
  const toKind = p.to_kind || '';
  const fromId = p.from_site_id || '';
  const toId = p.to_site_id || '';

  if (!techId || !SAFE_ID.test(techId)) return json(400, { ok: false, error: 'technician_id required' });
  if (fromId && !SAFE_ID.test(fromId)) return json(400, { ok: false, error: 'bad from_site_id' });
  if (toId && !SAFE_ID.test(toId)) return json(400, { ok: false, error: 'bad to_site_id' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  async function homeDistance(siteId) {
    const { data, error } = await supabase
      .from('tech_site_distances')
      .select('distance_mi')
      .eq('technician_id', techId)
      .eq('site_id', siteId)
      .limit(1);
    if (error) throw new Error(error.message);
    return data && data.length && data[0].distance_mi != null ? Number(data[0].distance_mi) : null;
  }

  try {
    let mi = null;
    if (fromKind === 'home' && toKind === 'home') {
      mi = 0;
    } else if (fromKind === 'home' && toId) {
      mi = await homeDistance(toId);
    } else if (toKind === 'home' && fromId) {
      mi = await homeDistance(fromId);
    } else if (fromId && toId) {
      if (fromId === toId) {
        mi = 0;
      } else {
        const { data, error } = await supabase
          .from('site_site_distances')
          .select('distance_mi')
          .or('and(site_a.eq.' + fromId + ',site_b.eq.' + toId + '),and(site_a.eq.' + toId + ',site_b.eq.' + fromId + ')')
          .limit(1);
        if (error) throw new Error(error.message);
        if (data && data.length && data[0].distance_mi != null) mi = Number(data[0].distance_mi);
      }
    }
    return json(200, { ok: true, distance_mi: mi });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
