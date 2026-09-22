/**
 * netlify/functions/bluefolder-attachments-probe.js
 *
 * Read-only volume check for BlueFolder attachments BEFORE we pull binaries
 * into Supabase Storage. Lists Service Request attachments (api.bluefolder.com)
 * and samples a handful of downloads for Content-Length.
 *
 * POST {}  or  POST { maxPages?: number, sampleDownloads?: number, postedOn?: 'YYYY-MM-DD' }
 *
 * Does not write files. Safe to re-run.
 */

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

  const maxPages = Math.min(50, Math.max(1, parseInt(payload.maxPages || '30', 10) || 30));
  const sampleDownloads = Math.min(25, Math.max(0, parseInt(payload.sampleDownloads || '12', 10) || 12));
  const perPage = 100;
  const postedOn = payload.postedOn ? String(payload.postedOn) : null;

  const summary = {
    ok: true,
    host: BF_ATTACH_BASE,
    listed: 0,
    apiTotalCount: null,
    pagesFetched: 0,
    files: 0,
    links: 0,
    byParentType: {},
    extCounts: {},
    earliestPosted: null,
    latestPosted: null,
    sample: [],
    sampleBytes: 0,
    sampleOk: 0,
    sampleFailed: 0,
    estimatedTotalBytes: null,
    estimatedTotalPretty: null,
    errors: [],
  };

  try {
    for (let page = 1; page <= maxPages; page++) {
      let xml = `<request><attachmentList>` +
        `<type>ServiceRequest</type>` +
        `<includeExternalLinks>true</includeExternalLinks>` +
        `<page>${page}</page>` +
        `<perPage>${perPage}</perPage>`;
      if (postedOn) xml += `<postedOn>${postedOn}</postedOn>`;
      xml += `</attachmentList></request>`;

      let resp;
      try {
        resp = await bfAttachRequest('attachments/list.aspx', xml);
      } catch (e) {
        summary.errors.push(`list page ${page}: ${e.message}`);
        break;
      }

      const wrap = resp?.attachments || {};
      if (page === 1 && wrap['@_totalCount'] != null) {
        summary.apiTotalCount = parseInt(wrap['@_totalCount'], 10) || 0;
      }
      const items = asArray(wrap.attachment);
      summary.pagesFetched = page;
      if (!items.length) break;

      for (const a of items) {
        summary.listed += 1;
        const isLink = String(a.isExternalLink) === 'true' || String(a.isExternalLink) === '1';
        if (isLink) summary.links += 1;
        else summary.files += 1;
        const ptype = String(a.parentType || 'ServiceRequest');
        summary.byParentType[ptype] = (summary.byParentType[ptype] || 0) + 1;
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
            parentId: a.parentId != null ? String(a.parentId) : null,
            postedOn: posted,
            token: String(a.token),
            bytes: null,
          });
        }
      }

      if (items.length < perPage) break;
      if (summary.apiTotalCount != null && summary.listed >= summary.apiTotalCount) break;
    }
  } catch (e) {
    summary.ok = false;
    summary.errors.push(e.message);
    return json(500, summary);
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

  if (summary.sampleOk > 0 && summary.files > 0) {
    const avg = summary.sampleBytes / summary.sampleOk;
    summary.estimatedTotalBytes = Math.round(avg * summary.files);
    summary.estimatedTotalPretty = fmtBytes(summary.estimatedTotalBytes);
  }

  summary.sampleBytesPretty = fmtBytes(summary.sampleBytes);
  summary.note = summary.apiTotalCount != null && summary.listed < summary.apiTotalCount
    ? `Listed ${summary.listed} of API totalCount ${summary.apiTotalCount} (hit maxPages=${maxPages}). Re-run with a higher maxPages or postedOn window if you need the rest.`
    : null;

  console.log('BlueFolder attachments probe:', JSON.stringify({
    listed: summary.listed,
    apiTotalCount: summary.apiTotalCount,
    files: summary.files,
    links: summary.links,
    estimatedTotalPretty: summary.estimatedTotalPretty,
    errors: summary.errors.length,
  }));

  return json(200, summary);
};
