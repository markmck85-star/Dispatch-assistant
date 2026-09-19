/**
 * netlify/functions/bluefolder-service-requests-sync.js
 * ======================================================================
 * Pulls BlueFolder Service Requests (TJ's "Trouble Tickets" -- the OTC
 * and testing-station closing-note system, separate from the Neumo/
 * Salesforce closed-ticket-report pipeline) into a staging table,
 * bluefolder_service_requests, going forward only.
 *
 * WHY A STAGING TABLE, NOT DIRECT INTO site_visits:
 *   Every other closing-note source (Salesforce report, TechWeb parser)
 *   lands raw first, then gets matched to a site separately -- this
 *   mirrors that same pattern rather than trying to do site-matching
 *   inline here. site_id starts null and needs_review starts true; a
 *   separate matching pass (reusing the existing matchSite()/site_aliases
 *   logic in lib/perform-import.js, or a new pass over
 *   customerLocationName/customerLocationStreetAddress) links these to
 *   real sites the same way closed-ticket-report rows get linked.
 *
 * WHY 'basic' LIST, NOT PER-RECORD get.aspx CALLS:
 *   Confirmed via BlueFolder's own API docs (Service Requests API,
 *   Retrieving a List of Service Requests): the 'basic' list response
 *   already includes detailedDescription -- the actual closing-note
 *   field -- directly on each list item. No need for a second get.aspx
 *   round trip per record just to get the note text.
 *
 * DATE RANGE:
 *   BlueFolder caps every list.aspx date range at 180 days; a wider
 *   range is rejected outright rather than truncated. Filters on
 *   dateTimeClosed rather than dateTimeCreated, since a ticket can sit
 *   open a while before it's actually closed with a note -- created-date
 *   filtering would miss anything opened just before the window but
 *   closed just after. Defaults to the last 7 days (comfortably inside
 *   the scheduled-run cadence) unless overridden by BF_SR_SYNC_DAYS.
 *
 * ⚠️ NOT YET LIVE-TESTED. Same caution as bluefolder-sync.js: confirm the
 *   real response shape against a live call before trusting field names
 *   blindly, since BlueFolder's docs have disagreed with themselves
 *   before (see bluefolder-sync.js's note on appointments' date format).
 *
 * ⚠️ HISTORICAL BACKFILL IS A SEPARATE, LATER PROJECT. This only pulls
 *   forward from whenever it first runs. Mike has been periodically
 *   deleting old BlueFolder records to free up space (a known ~2-3 month
 *   gap already exists in 2024), so how far back a backfill can even go
 *   is bounded by what's still there -- worth confirming with TJ/Mike
 *   before scoping that separately, and possibly worth doing sooner
 *   rather than later if deletions are ongoing.
 *
 * ENV VARS REQUIRED
 *   BLUEFOLDER_API_TOKEN   Settings > API > Authorized API Users (same
 *                          token already in use for bluefolder-sync.js
 *                          is fine -- this is a read-only list call)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   BF_SR_SYNC_DAYS        optional, defaults to 7
 *
 * SCHEDULE
 *   Suggest daily via netlify.toml -- closing notes aren't as time-
 *   sensitive as live dispatch, so this doesn't need bluefolder-sync.js's
 *   30-minute cadence.
 */

const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false });

async function bfRequest(endpoint, bodyXml) {
  const token = process.env.BLUEFOLDER_API_TOKEN;
  const auth = Buffer.from(`${token}:x`).toString('base64');
  const res = await fetch(`${BF_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml' },
    body: bodyXml,
  });
  const text = await res.text();
  const parsed = xmlParser.parse(text);
  if (parsed?.response?.['@_status'] === 'fail') {
    throw new Error(`BlueFolder API error on ${endpoint}: ${JSON.stringify(parsed.response.error)}`);
  }
  return parsed.response;
}

// BlueFolder's serviceRequests/list.aspx documents dateRange as
// "MM-DD-YYYY HH:MM AM/PM" -- different from appointments/list.aspx's
// "YYYY.MM.DD HH:MM AM" format seen in bluefolder-sync.js. Per that
// file's own hard-won lesson, BlueFolder's docs have disagreed with
// themselves on date formats before -- confirm this one against a real
// response before trusting it blindly.
function bfDateRangeStr(d, endOfDay) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return endOfDay ? `${mm}-${dd}-${yyyy} 11:59 PM` : `${mm}-${dd}-${yyyy} 12:00 AM`;
}

function toIsoOrNull(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d) ? null : d.toISOString();
}

exports.handler = async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const summary = { fetched: 0, upserted: 0, errors: [] };

  const days = parseInt(process.env.BF_SR_SYNC_DAYS || '7', 10);
  const rangeEnd = new Date();
  const rangeStart = new Date();
  rangeStart.setUTCDate(rangeStart.getUTCDate() - days);

  let listResp;
  try {
    listResp = await bfRequest('serviceRequests/list.aspx', `<request><serviceRequestList>` +
      `<listType>basic</listType>` +
      `<dateRange dateField="dateTimeClosed">` +
      `<startDate>${bfDateRangeStr(rangeStart, false)}</startDate>` +
      `<endDate>${bfDateRangeStr(rangeEnd, true)}</endDate>` +
      `</dateRange>` +
      `</serviceRequestList></request>`);
  } catch (e) {
    summary.errors.push(`list call: ${e.message}`);
    return { statusCode: 500, body: JSON.stringify(summary) };
  }

  // Guard against the streamed-response case the docs call out for very
  // large result sets (streamed="true" + trailing <result> node) -- not
  // expected at a 7-day window, but worth failing loudly rather than
  // silently truncating if it ever happens.
  if (listResp?.['@_streamed'] === 'true' && listResp?.result?.['@_status'] !== 'ok') {
    summary.errors.push('streamed response did not complete successfully -- see BlueFolder API docs on streamed lists');
    return { statusCode: 500, body: JSON.stringify(summary) };
  }

  const requests = listResp?.serviceRequestList?.serviceRequest
    ? [].concat(listResp.serviceRequestList.serviceRequest)
    : [];
  summary.fetched = requests.length;

  const rows = requests.map((sr) => ({
    service_request_id: String(sr.serviceRequestId),
    customer_id: sr.customerId != null ? String(sr.customerId) : null,
    customer_name: sr.customerName != null ? String(sr.customerName) : null,
    customer_location_id: sr.customerLocationId != null ? String(sr.customerLocationId) : null,
    customer_location_name: sr.customerLocationName != null ? String(sr.customerLocationName) : null,
    customer_location_street_address: sr.customerLocationStreetAddress != null ? String(sr.customerLocationStreetAddress) : null,
    customer_location_city: sr.customerLocationCity != null ? String(sr.customerLocationCity) : null,
    customer_location_state: sr.customerLocationState != null ? String(sr.customerLocationState) : null,
    customer_location_postal_code: sr.customerLocationPostalCode != null ? String(sr.customerLocationPostalCode) : null,
    description: sr.description != null ? String(sr.description) : null,
    detailed_description: sr.detailedDescription != null ? String(sr.detailedDescription) : null,
    status: sr.status != null ? String(sr.status) : null,
    type: sr.type != null ? String(sr.type) : null,
    priority: sr.priority != null ? String(sr.priority) : null,
    date_time_created: toIsoOrNull(sr.dateTimeCreated),
    date_time_closed: toIsoOrNull(sr.dateTimeClosed),
    external_id: sr.externalId != null ? String(sr.externalId) : null,
    synced_at: new Date().toISOString(),
  }));

  // Upsert on service_request_id so re-running the same window (or a
  // slightly overlapping one) never creates duplicates. Intentionally
  // does NOT touch site_id or needs_review on conflict -- once a later
  // matching pass links a row to a real site, re-syncing the same
  // service request shouldn't silently null that back out.
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase
      .from('bluefolder_service_requests')
      .upsert(batch, { onConflict: 'service_request_id', ignoreDuplicates: false });
    if (error) {
      summary.errors.push(`upsert batch starting at ${i}: ${error.message}`);
    } else {
      summary.upserted += batch.length;
    }
  }

  console.log('BlueFolder Service Requests sync summary:', JSON.stringify(summary, null, 2));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
