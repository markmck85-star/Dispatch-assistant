/**
 * netlify/functions/bluefolder-attachments-probe.js
 *
 * BlueFolder will not list attachments globally — list.aspx requires a
 * serviceRequestId (error 400 "servicerequestId is missing or invalid").
 * This probe therefore samples SRs we already stored in
 * bluefolder_service_requests, lists attachments per id, and estimates
 * volume from that rate. No files are saved.
 *
 * POST { sampleSrs?: number, sampleDownloads?: number }
 */

const { createClient } = require('@supabase/supabase-js');
const { XMLParser } = require('fast-xml-parser');

const BF_ATTACH_BASE = 'https://api.bluefolder.com/api/2.0';
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function json(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function bfAttachRequest(endpoint, bodyXml) {
  const token = process.env.BLUEFOLDER_API_TOKEN;
  if (!token) throw new Error('BLUEFOLDER_API_TOKEN not configured');
  const auth = Buffer.from(`${token}:x`).toString('base64');
  const res = await fetch(`${BF_ATTACH_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/xml' },
    body: bodyXml,
    redirect: 'manual',
  });
  const loc = res.headers.get('location') || res.headers.get('Location');
  if (loc && (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308)) {
    return { redirect: loc, status: res.status };
  }
  const text = await res.text();
  let parsed;
  try { parsed = xmlParser.parse(text); }
  catch (e) { throw new Error(`XML parse failed on ${endpoint}: ${e.message} body=${text.slice(0, 300)}`); }
  if (parsed?.response?.['@_status'] === 'fail') {
    throw new Error(`BlueFolder API error on ${endpoint}: ${JSON.stringify(parsed.response.error)}`);
  }
  return parsed.response;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let payload = {};
  if (event.httpMethod === 'POST') {
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON body' }); }
  }

  const sampleSrs = Math.min(120, Math.max(10, parseInt(payload.sampleSrs || '60', 10) || 60));
  const sampleDownloads = Math.min(20, Math.max(0, parseInt(payload.sampleDownloads || '10', 10) || 10));

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase env vars not configured' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { count: totalSrs } = await supabase
    .from('bluefolder_service_requests')
    .select('id', { count: 'exact', head: true });

  const half = Math.ceil(sampleSrs / 2);
  const [{ data: recentRows, error: recentErr }, { data: olderRows, error: olderErr }] = await Promise.all([
    supabase.from('bluefolder_service_requests')
      .select('service_request_id, date_time_closed, customer_location_name')
      .not('service_request_id', 'is', null)
      .order('date_time_closed', { ascending: false, nullsFirst: false })
      .limit(half),
    supabase.from('bluefolder_service_requests')
      .select('service_request_id, date_time_closed, customer_location_name')
      .not('service_request_id', 'is', null)
      .order('date_time_closed', { ascending: true, nullsFirst: false })
      .limit(half),
  ]);
  if (recentErr || olderErr) {
    return json(500, { error: (recentErr || olderErr).message });
  }

  const seen = new Set();
  const srs = [];
  for (const r of [...(recentRows || []), ...(olderRows || [])]) {
    const id = String(r.service_request_id);
    if (seen.has(id)) continue;
    seen.add(id);
    srs.push(r);
  }

  const summary = {
    ok: true,
    host: BF_ATTACH_BASE,
    mode: 'per-service-request sample (global list is not allowed by BlueFolder)',
    totalSrsInDb: totalSrs || 0,
    srsSampled: 0,
    srsWithFiles: 0,
    srsWithLinksOnly: 0,
    listed: 0,
    files: 0,
    links: 0,
    extCounts: {},
    earliestPosted: null,
    latestPosted: null,
    sample: [],
    sampleBytes: 0,
    sampleOk: 0,
    sampleFailed: 0,
    estimatedFiles: null,
    estimatedTotalBytes: null,
    estimatedTotalPretty: null,
    errors: [],
  };

  for (const sr of srs) {
    const sid = String(sr.service_request_id);
    let resp;
    try {
      resp = await bfAttachRequest(
        'attachments/list.aspx',
        `<request><attachmentList>` +
          `<type>ServiceRequest</type>` +
          `<serviceRequestId>${sid}</serviceRequestId>` +
          `<includeExternalLinks>true</includeExternalLinks>` +
          `<page>1</page><perPage>100</perPage>` +
        `</attachmentList></request>`
      );
    } catch (e) {
      summary.errors.push(`SR ${sid}: ${e.message}`);
      continue;
    }
    summary.srsSampled += 1;
    const items = asArray(resp?.attachments?.attachment);
    if (!items.length) continue;

    let fileCount = 0;
    let linkCount = 0;
    for (const a of items) {
      summary.listed += 1;
      const isLink = String(a.isExternalLink) === 'true' || String(a.isExternalLink) === '1';
      if (isLink) { summary.links += 1; linkCount += 1; }
      else { summary.files += 1; fileCount += 1; }
      const name = String(a.fileName || '');
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (ext && ext !== name.toLowerCase()) {
        summary.extCounts[ext] = (summary.extCounts[ext] || 0) + 1;
      }
      const posted = a.postedOn ? String(a.postedOn) : null;
      if (posted) {
        if (!summary.earliestPosted || posted < summary.earliestPosted) summary.earliestPosted = posted;
        if (!summary.latestPosted || posted > summary.latestPosted) summary.latestPosted = posted;
      }
      if (!isLink && a.token && summary.sample.length < sampleDownloads) {
        summary.sample.push({
          fileName: name,
          parentId: sid,
          location: sr.customer_location_name || null,
          postedOn: posted,
          token: String(a.token),
          bytes: null,
        });
      }
    }
    if (fileCount) summary.srsWithFiles += 1;
    else if (linkCount) summary.srsWithLinksOnly += 1;
  }

  for (const s of summary.sample) {
    try {
      const dl = await bfAttachRequest(
        'attachments/download.aspx',
        `<request><attachmentDownload><attachmentToken>${s.token}</attachmentToken></attachmentDownload></request>`
      );
      const url = dl && dl.redirect;
      if (!url) {
        summary.sampleFailed += 1;
        summary.errors.push(`no redirect for ${s.fileName}`);
        delete s.token;
        continue;
      }
      const head = await fetch(url, { method: 'HEAD' });
      const len = head.headers.get('content-length');
      const n = len ? parseInt(len, 10) : NaN;
      if (Number.isFinite(n)) {
        s.bytes = n;
        summary.sampleBytes += n;
        summary.sampleOk += 1;
      } else {
        const get = await fetch(url, { method: 'GET' });
        const buf = Buffer.from(await get.arrayBuffer());
        s.bytes = buf.length;
        summary.sampleBytes += buf.length;
        summary.sampleOk += 1;
      }
    } catch (e) {
      summary.sampleFailed += 1;
      summary.errors.push(`download sample ${s.fileName}: ${e.message}`);
    }
    delete s.token;
  }

  if (summary.srsSampled > 0 && summary.totalSrsInDb > 0) {
    const filesPerSr = summary.files / summary.srsSampled;
    summary.estimatedFiles = Math.round(filesPerSr * summary.totalSrsInDb);
    if (summary.sampleOk > 0) {
      const avg = summary.sampleBytes / summary.sampleOk;
      summary.estimatedTotalBytes = Math.round(avg * summary.estimatedFiles);
      summary.estimatedTotalPretty = fmtBytes(summary.estimatedTotalBytes);
    }
  }

  summary.sampleBytesPretty = fmtBytes(summary.sampleBytes);
  summary.note = `BlueFolder requires serviceRequestId on attachment list. Sampled ${summary.srsSampled} of ${summary.totalSrsInDb} backed-up SRs (half newest, half oldest). Estimates assume the sample rate holds across the rest.`;

  console.log('BlueFolder attachments probe:', JSON.stringify({
    srsSampled: summary.srsSampled,
    files: summary.files,
    estimatedFiles: summary.estimatedFiles,
    estimatedTotalPretty: summary.estimatedTotalPretty,
    errors: summary.errors.length,
  }));

  return json(200, summary);
};
