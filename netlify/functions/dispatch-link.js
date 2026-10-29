// dispatch-link.js -- 2026-10-29
//
// The page behind the short link in a long dispatch text:  https://mcrdispatch.net/d/<token>
// (_redirects sends /d/<token> here). Shows the full list for one technician and one day in a
// clean phone layout with a Save / Print as PDF button.
//
// No sign-in: the token is long and random and lives only in the text on the technician's own
// phone (same approach as the /ack receipt link). Rows expire after 14 days. The page is not
// indexed and is never cached.
//
// GET /.netlify/functions/dispatch-link?t=<token>
const { createClient } = require('@supabase/supabase-js');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(status, title, inner) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    body: '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="robots" content="noindex,nofollow"><title>' + esc(title) + '</title>' +
      '<style>' +
      'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f4f5f7;color:#1c1f24;margin:0;padding:16px;}' +
      '.wrap{max-width:560px;margin:0 auto;}' +
      'h1{font-size:19px;margin:4px 0 2px;} .sub{color:#5a6270;font-size:14px;margin:0 0 14px;}' +
      '.card{background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:12px 14px;margin:0 0 10px;}' +
      '.card .t{font-weight:700;font-size:15px;margin:0 0 4px;} .card .l{font-size:14px;color:#333;margin:2px 0;}' +
      '.foot{font-size:14px;color:#333;margin:12px 2px;} .btn{display:block;width:100%;box-sizing:border-box;padding:12px;font-size:16px;font-weight:600;border:0;border-radius:8px;background:#1a5fb4;color:#fff;margin:14px 0 4px;}' +
      '@media print{body{background:#fff;padding:0}.btn{display:none}.card{break-inside:avoid}}' +
      '</style></head><body><div class="wrap">' + inner + '</div></body></html>',
  };
}

// The dispatch text: an opening line, then stops that start "1.", "2." with indented detail lines,
// then closing lines. Anything that does not fit that shape is still shown, line by line.
function render(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const head = [], foot = [], cards = [];
  for (const ln of lines) {
    if (!ln.trim()) continue;
    if (/^\s*\d+\.\s/.test(ln)) cards.push({ t: ln.trim().replace(/^\d+\.\s*/, ''), n: ln.trim().match(/^\d+/)[0], l: [] });
    else if (cards.length && /^\s/.test(ln)) cards[cards.length - 1].l.push(ln.trim());
    else if (cards.length) foot.push(ln.trim());
    else head.push(ln.trim());
  }
  return { head, cards, foot };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return page(405, 'Not allowed', '<p class="sub">Not allowed.</p>');
  // The code is the last part of the address the person opened (/d/<code>). The redirect rule does not
  // carry it into a query value, so read it from the path; a ?t= value is still accepted.
  const fromPath = (String(event.rawUrl || '').split('?')[0].match(/\/d\/([A-Za-z0-9_-]+)\/?$/) || String(event.path || '').match(/\/d\/([A-Za-z0-9_-]+)\/?$/) || [])[1];
  const token = String(fromPath || (event.queryStringParameters || {}).t || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (token.length < 12) return page(404, 'Link not found', '<h1>Link not found</h1><p class="sub">This link looks incomplete. Check the text message it came in.</p>');
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await sb.from('dispatch_links').select('subject, body, expires_at').eq('token', token).maybeSingle();
    if (error) return page(500, 'Error', '<h1>Something went wrong</h1><p class="sub">Try again in a minute.</p>');
    if (!data) return page(404, 'Link not found', '<h1>Link not found</h1><p class="sub">This link is not valid. It may be from an older message.</p>');
    if (new Date(data.expires_at).getTime() < Date.now()) return page(410, 'Link expired', '<h1>This link has expired</h1><p class="sub">Check your email for the full list, or contact dispatch.</p>');
    const r = render(data.body);
    const title = (data.subject || 'MCR Dispatch').replace(/^MCR Dispatch\s*[—-]\s*/, 'Dispatch for ');
    let h = '<h1>' + esc(title) + '</h1>';
    if (r.head.length) h += '<p class="sub">' + r.head.map(esc).join('<br>') + '</p>';
    for (const c of r.cards) {
      h += '<div class="card"><div class="t">' + esc(c.n) + '. ' + esc(c.t) + '</div>' + c.l.map((x) => '<div class="l">' + esc(x) + '</div>').join('') + '</div>';
    }
    if (r.foot.length) h += '<div class="foot">' + r.foot.map(esc).join('<br>') + '</div>';
    h += '<button class="btn" onclick="window.print()">Save or print as PDF</button>';
    return page(200, title, h);
  } catch (e) {
    return page(500, 'Error', '<h1>Something went wrong</h1><p class="sub">Try again in a minute.</p>');
  }
};
