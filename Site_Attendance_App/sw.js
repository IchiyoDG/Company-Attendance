const CACHE = 'site-attendance-v1';
const ASSETS = ['./', './index.html', './style.css', './app.js', './face-api.js', './xlsx.full.min.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './model/tiny_face_detector_model-weights_manifest.json', './model/tiny_face_detector_model.bin',
  './model/face_landmark_68_model-weights_manifest.json', './model/face_landmark_68_model.bin',
  './model/face_recognition_model-weights_manifest.json', './model/face_recognition_model.bin'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => { if (e.request.method !== 'GET') return; e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request))); });
