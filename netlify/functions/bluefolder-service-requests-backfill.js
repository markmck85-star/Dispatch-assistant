/**
 * netlify/functions/bluefolder-service-requests-backfill.js
 * ======================================================================
 * Manually-triggered historical backfill companion to
 * bluefolder-service-requests-sync.js, which only ever pulls forward
 * from whenever it first ran (see that file's own header). This exists
 * for the separate, deliberate project of pulling OLDER closed Service
 * Requests in, one chunk at a time.
 *
 * WHY A SEPARATE FUNCTION, NOT FOLDED INTO THE DAILY SYNC:
 *   The daily scheduled sync is an incremental "what changed since last
 *   time" job (rolling 7-day window, run forever). A backfill is a
 *   one-time bulk historical pull -- baking that into the daily cron
 *   would mean re-fetching months/years of already-synced data every
 *   single day for no reason. Kept as its own manually-triggered
 *   function instead (admin.html's Closed Tickets tab has a "Run
 *   Backfill Chunk" button), matching the Distance Matrix tab's existing
 *   pattern of an admin-triggered one-off build rather than a background
 *   job. Safe to run unattended/repeatedly unlike the Salesforce sync --
 *   this hits BlueFolder's API directly with a token (see
 *   BLUEFOLDER_API_TOKEN), not a headless-browser login, so there's no
 *   concurrent-session risk to worry about.
 *
 * WHY ONE CHUNK PER CALL, NOT A LOOP OVER THE WHOLE HISTORY:
 *   BlueFolder caps every list.aspx date range at 180 days (a wider
 *   range is rejected, not truncated), so a real backfill has to be
 *   chunked regardless. Doing exactly one chunk per invocation (rather
 *   than looping internally over many chunks) keeps each call
 *   comfortably inside Netlify's function timeout and makes progress
 *   visible/interruptible from the admin panel -- each response tells
 *   the caller the next chunk's end date to call again with, and how
 *   many rows that chunk found, so Mark can watch it walk backward and
 *   see for himself where real data stops (Mike has been periodically
 *   deleting old BlueFolder records -- a known ~2-3 month gap already
 *   exists around 2024 -- so there's no way to know the real surviving
 *   depth in advance).
 *
 * POST body: { chunkEndDate?: 'YYYY-MM-DD', chunkDays?: number }
 *   chunkEndDate  exclusive-ish upper bound of this chunk's window
 *                 (defaults to 7 days ago, i.e. right where the daily
 *                 sync's own rolling window begins, so the very first
 *                 backfill call picks up immediately behind it with no
 *                 gap or overlap).
 *   chunkDays     window size going backward from chunkEndDate, default
 *                 175 (kept a few days under BlueFolder's 180-day cap
 *                 as a safety margin).
 *
 * Response: { fetched, upserted, chunkStart, chunkEnd, nextChunkEndDate }
 *   Call again with chunkEndDate: nextChunkEndDate to walk one more
 *   chunk further back. fetched: 0 on a chunk is a signal (not a
 *   guarantee) that real data may have run out around there -- BlueFolder
 *   deletions could just as easily mean a real gap rather than the true
 *   edge of history, so this doesn't auto-stop on Mark's behalf.
 */

const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const BF_BASE = 'https://app.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false });
const DEFAULT_CHUNK_DAYS = 175;

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

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

// Same "MM-DD-YYYY HH:MM AM/PM" format bluefolder-service-requests-sync.js
// confirmed live for serviceRequests/list.aspx's dateRange -- kept
// identical here rather than shared via a lib import, matching that
// file's own choice to keep this small helper inline.
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const chunkDays = Number.isInteger(payload.chunkDays) && payload.chunkDays > 0 && payload.chunkDays <= 179
    ? payload.chunkDays
    : DEFAULT_CHUNK_DAYS;

  // Default chunkEnd = 7 days ago, matching BF_SR_SYNC_DAYS' default in
  // the daily sync -- the first backfill call (no chunkEndDate given)
  // picks up immediately behind the daily sync's own rolling window,
  // with no gap and no overlap.
  let chunkEnd;
  if (payload.chunkEndDate) {
    chunkEnd = new Date(String(payload.chunkEndDate) + 'T00:00:00Z');
    if (isNaN(chunkEnd)) return json(400, { error: 'chunkEndDate must be a valid YYYY-MM-DD date' });
  } else {
    chunkEnd = new Date();
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() - 7);
  }
  const chunkStart = new Date(chunkEnd);
  chunkStart.setUTCDate(chunkStart.getUTCDate() - chunkDays);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }
  if (!process.env.BLUEFOLDER_API_TOKEN) {
    return json(500, { error: 'BLUEFOLDER_API_TOKEN not configured' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const summary = {
    fetched: 0,
    upserted: 0,
    chunkStart: chunkStart.toISOString().slice(0, 10),
    chunkEnd: chunkEnd.toISOString().slice(0, 10),
    nextChunkEndDate: chunkStart.toISOString().slice(0, 10),
    errors: [],
  };

  let listResp;
  try {
    listResp = await bfRequest('serviceRequests/list.aspx', `<request><serviceRequestList>` +
      `<listType>basic</listType>` +
      `<dateRange dateField="dateTimeClosed">` +
      `<startDate>${bfDateRangeStr(chunkStart, false)}</startDate>` +
      `<endDate>${bfDateRangeStr(chunkEnd, true)}</endDate>` +
      `</dateRange>` +
      `</serviceRequestList></request>`);
  } catch (e) {
    summary.errors.push(`list call: ${e.message}`);
    return json(500, summary);
  }

  if (listResp?.['@_streamed'] === 'true' && listResp?.result?.['@_status'] !== 'ok') {
    summary.errors.push('streamed response did not complete successfully -- see BlueFolder API docs on streamed lists');
    return json(500, summary);
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

  // Same upsert-on-service_request_id, never-touch-site_id/needs_review
  // pattern as the daily sync -- a backfill chunk that happens to overlap
  // a row the matching pass already linked must not silently null that
  // back out.
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase
      .from('bluefolder_service_requests')
      .upsert(batch, { onConflict: 'service_request_id', ignoreDuplicates: false });
    if (error) summary.errors.push(`upsert batch starting at ${i}: ${error.message}`);
    else summary.upserted += batch.length;
  }

  console.log('BlueFolder Service Requests BACKFILL chunk summary:', JSON.stringify(summary, null, 2));
  return json(200, summary);
};
