/**
 * Service Worker de Republic Wings POS.
 *
 * Regla importante: NUNCA se cachean las llamadas a /api/ (menú, ventas,
 * precios). Si se cachearan, un mesero podría cobrar con precios viejos o
 * ver un resumen desactualizado. Solo se guarda el "cascarón" de la app.
 */
const CACHE = 'rw-pos-v3';
const ARCHIVOS = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(claves => Promise.all(claves.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // NO interceptar recursos externos (CDNs: Tailwind, Lucide, Google Fonts,
  // imágenes). El navegador los carga directo y la CSP se aplica normal;
  // si el SW hiciera fetch() interno, quedarían sujetos a connect-src y fallarían.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // siempre a la red

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
