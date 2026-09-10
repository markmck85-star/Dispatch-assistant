/**
 * lib/placeholder-sites.js — new 2026-09-10
 *
 * Backs the site-survey/install placeholder feature: a site_survey or
 * install ticket almost never carries a real Neumo site code (Neumo hasn't
 * assigned one -- the kiosk doesn't exist yet), so until now these tickets
 * sat with site_id null and were deliberately excluded from auto-add-to-
 * board (see mailgun-inbound.js/index.html comments dated 2026-08-06 and
 * get-unmatched-tickets.js) -- invisible on the actual dispatch board a
 * dispatcher works from, even after the watchdog log made them visible
 * there. Trigger: Mark's 11 AM Mundy Mill install (2026-09-10) not showing
 * up anywhere a dispatcher would look before assigning the day's resources.
 *
 * Design: create a temporary site record (STATE+TMP+NNN code -- MCR's own
 * namespace, mirrors the existing STATE+T+NNN testing-station convention
 * in get-unmatched-tickets.js, no collision risk with Neumo's real numeric
 * codes) so the ticket can flow through the exact same auto-add-to-board
 * path trouble/maintenance tickets already use. That path requires
 * technician_id NOT NULL on assignments, so every placeholder gets
 * assigned to a per-state "Unassigned (New Site)" technician -- it shows
 * up on the board as its own clearly-labeled group, and the dispatcher
 * reassigns it to a real tech the same way they'd reassign any other stop.
 *
 * Promotion: when a later ticket carrying a REAL Neumo site code
 * address-matches a placeholder (mailgun-inbound.js's address-fallback
 * block), the placeholder is flagged (promotion_candidate_code/
 * promotion_candidate_wo_number) rather than silently renamed -- MCR's
 * site-matching history (see dispatch-platform.md's collision-cleanup
 * campaign) has enough near-miss address collisions that an unconfirmed
 * auto-rename isn't safe. get-pending-promotions.js surfaces the flag as a
 * board toast; promote-placeholder-site.js performs the rename once a
 * dispatcher confirms it.
 *
 * Requires two new sites columns (migration given separately):
 *   is_placeholder boolean not null default false
 *   promotion_candidate_code text
 *   promotion_candidate_wo_number text
 */

const { addressesLooselyMatch } = require('./address-match');

const UNASSIGNED_TECH_NAME = 'Unassigned (New Site)';

async function getOrCreateUnassignedTech(supabase, state) {
  const { data: existing, error: findErr } = await supabase
    .from('technicians')
    .select('id')
    .eq('name', UNASSIGNED_TECH_NAME)
    .eq('home_state', state)
    .maybeSingle();
  if (findErr) throw new Error('Unassigned-tech lookup failed: ' + findErr.message);
  if (existing) return existing.id;

  // 2026-09-10 fix: technicians.slug is NOT NULL + UNIQUE with no DB
  // default (confirmed via information_schema against the live table) --
  // the very first version of this insert omitted it entirely, so every
  // attempt to create the per-state Unassigned tech failed outright on a
  // NOT NULL violation, caught non-fatally by the caller in
  // mailgun-inbound.js and logged only -- which meant the ENTIRE
  // placeholder-site creation silently never happened for anyone (real
  // case: today's Mundy Mill install, WO 00152003 -- no placeholder, no
  // board entry, no error visible anywhere except the Netlify function
  // log). Slugged per-state (not a single global slug) since the
  // UNIQUE constraint would otherwise reject the second state's attempt
  // to create its own "Unassigned (New Site)" row -- matches the
  // lowercase-hyphenated slug format every other technician row already
  // uses (e.g. "randy-thomas").
  const slug = `unassigned-new-site-${state.toLowerCase()}`;
  const { data: created, error: createErr } = await supabase
    .from('technicians')
    .insert({ name: UNASSIGNED_TECH_NAME, slug, home_state: state, active: true })
    .select('id')
    .single();
  if (createErr) throw new Error('Unassigned-tech creation failed: ' + createErr.message);
  console.log(`[placeholder-sites] Created "${UNASSIGNED_TECH_NAME}" technician for ${state}`);
  return created.id;
}

async function nextPlaceholderCode(supabase, state) {
  const { data: rows, error } = await supabase
    .from('sites')
    .select('site_code')
    .ilike('site_code', `${state}TMP%`);
  if (error) throw new Error('Placeholder-code lookup failed: ' + error.message);
  let maxN = 0;
  const re = new RegExp(`^${state}TMP(\\d+)$`);
  for (const r of (rows || [])) {
    const m = r.site_code.match(re);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `${state}TMP${String(maxN + 1).padStart(3, '0')}`;
}

// Creates a placeholder site for a brand-new install/site_survey ticket
// that matched nothing existing, by code or by address. rawName is
// typically the ticket's own Location field text (e.g. "GA - Mundy Mill
// Kroger") -- stripped of its state prefix for a cleaner board label.
async function createPlaceholderSite(supabase, { state, rawName, address }) {
  const code = await nextPlaceholderCode(supabase, state);
  const techId = await getOrCreateUnassignedTech(supabase, state);
  const cleanName = (rawName || '').replace(/^[A-Z]{2}\s*[-\u2013]\s*/, '').trim();
  const name = ('SURVEY/INSTALL: ' + (cleanName || 'new site pending install')).slice(0, 120);

  const { data: site, error } = await supabase
    .from('sites')
    .insert({
      site_code: code,
      state,
      name,
      address: address || null,
      is_placeholder: true,
      primary_tech_id: techId,
    })
    .select('id, site_code, name, address, primary_tech_id')
    .single();
  if (error) throw new Error('Placeholder site creation failed: ' + error.message);
  console.log(`[placeholder-sites] Created placeholder ${code} ("${name}") for ${state}`);
  return site;
}

// Looks for an existing placeholder at this address/state -- used to avoid
// creating a second placeholder when e.g. a site_survey ticket is followed
// later by a separate install ticket at the same not-yet-coded address.
async function findPlaceholderByAddress(supabase, address, state) {
  if (!address || !state) return null;
  const { data: candidates, error } = await supabase
    .from('sites')
    .select('id, site_code, name, address')
    .eq('state', state)
    .eq('is_placeholder', true);
  if (error || !candidates) return null;
  for (const c of candidates) {
    if (addressesLooselyMatch(address, c.address)) return c;
  }
  return null;
}

// Flags a placeholder as ready to promote once a real-coded ticket lands
// at its address. Doesn't rename anything yet -- see file header. A
// second real ticket flagging the same placeholder just overwrites the
// candidate fields with the newer one; harmless, since nothing commits
// until a dispatcher confirms via promote-placeholder-site.js.
async function flagPlaceholderForPromotion(supabase, placeholderId, { realCode, woNumber }) {
  const { error } = await supabase
    .from('sites')
    .update({ promotion_candidate_code: realCode, promotion_candidate_wo_number: woNumber || null })
    .eq('id', placeholderId);
  if (error) console.error('[placeholder-sites] Failed to flag promotion candidate:', error.message);
  else console.log(`[placeholder-sites] Flagged placeholder ${placeholderId} for promotion to ${realCode} (WO ${woNumber})`);
}

module.exports = {
  UNASSIGNED_TECH_NAME,
  getOrCreateUnassignedTech,
  nextPlaceholderCode,
  createPlaceholderSite,
  findPlaceholderByAddress,
  flagPlaceholderForPromotion,
};
