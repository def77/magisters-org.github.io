// Service worker: makes PolyArb installable and opens offline with the last version.
// Own files: network first (updates show up immediately), cache as fallback.
// API calls (Polymarket, OddsPapi, The Odds API, Telegram) are never cached.
const CACHE = 'polyarb-v3';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon.svg',
  'js/app.js', 'js/arb.js', 'js/config.js', 'js/demo.js', 'js/esports.js', 'js/journal.js',
  'js/match.js', 'js/oddspapi.js', 'js/scanner.js', 'js/sources.js', 'js/value.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))),
  );
});

// Tapping an alert focuses the open scanner, or opens the link it carries.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (target) return self.clients.openWindow(target);
    const open = list.find(c => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow('./');
  }));
});
