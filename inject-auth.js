// inject-auth.js -- adds the sign-in helper (/auth-shim.js) to every page.
//
// The helper only acts when a function call is refused because nobody is
// signed in: it shows a small sign-in box and repeats the call. Pages that are
// already signed in never see it. Doing this here means no page file has to be
// edited, and any page added later is covered automatically.

export default async (request, context) => {
  const res = await context.next();
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/html')) return res;
  const html = await res.text();
  if (html.indexOf('/auth-shim.js') !== -1) return new Response(html, res);
  const out = html.replace(/<head[^>]*>/i, (tag) => tag + '<script src="/auth-shim.js"></script>');
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
};

export const config = {
  path: ['/', '/:page', '/watchdog/:state'],
  excludedPath: [
    '/*.js', '/*.mjs', '/*.css', '/*.png', '/*.jpg', '/*.jpeg', '/*.gif', '/*.svg', '/*.ico',
    '/*.mp4', '/*.webmanifest', '/*.json', '/*.txt', '/*.map', '/tech-portal.html', '/tech-portal',
    '/.netlify/*', '/ack',
  ],
};
