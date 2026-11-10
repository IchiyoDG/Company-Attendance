const CACHE = 'site-attendance-v2';
const ASSETS = ['./', './index.html', './style.css', './app.js', './face-api.js', './xlsx.full.min.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './model/tiny_face_detector_model-weights_manifest.json', './model/tiny_face_detector_model.bin',
  './model/face_landmark_68_model-weights_manifest.json', './model/face_landmark_68_model.bin',
  './model/face_recognition_model-weights_manifest.json', './model/face_recognition_model.bin'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
// Big, unchanging files (face models, libraries): cache first. App files: network first so updates arrive, cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  const stable = u.pathname.includes('/model/') || u.pathname.endsWith('face-api.js') || u.pathname.endsWith('xlsx.full.min.js');
  if (stable) { e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request))); return; }
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
