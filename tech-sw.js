// Service worker for the MCR Field Portal. Its only job is phone alerts
// (web push). It has no fetch handler on purpose: it never caches or
// intercepts pages, so it cannot cause stale-page problems.

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'MCR Watchdog', body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'MCR Watchdog';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,       // same ticket twice replaces instead of stacking
    renotify: !!data.tag,
    icon: 'tech-portal-icon-192.png',
    badge: 'tech-portal-icon-192.png',
    vibrate: [300, 150, 300, 150, 300],
    requireInteraction: true,
    data: { url: data.url || '/tech-portal.html' },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/tech-portal.html';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf('tech') !== -1 && 'focus' in list[i]) return list[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
