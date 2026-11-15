/* Public static shell only. API responses, owned photos and map tiles are never cached.
   The shell cache name lives HERE and nowhere else: page code asks this worker to purge via postMessage. */
const SHELL_CACHE = 'jk-v75';
const SHELL_ASSETS = [
  '/', '/index.html', '/manifest.webmanifest?v=3',
  '/privacy.html', '/terms.html', '/legal.css?v=1', '/landing.css?v=11', '/landing.js?v=3',
  '/polyfills.js?v=1', '/feature-loader.js?v=1', '/error-report.js?v=1', '/actions.js?v=1', '/app.js?v=54', '/styles.css?v=48', '/ui-kit.css?v=5', '/design-tokens.css?v=2', '/native-adapter.js?v=20',
  '/vendor/gsap.min.js?v=1', '/vendor/ScrollTrigger.min.js?v=1', '/vendor/three.min.js?v=1',
  '/offline-store.js?v=15', '/offline-sync.js?v=19', '/session.js?v=2', '/google-signin.js?v=1', '/scan-flow.js?v=10', '/shell.js?v=4',
  '/workflow-state.js?v=1', '/daily-log.js?v=7', '/workflow-ui.js?v=16', '/local-media.js?v=5',
  '/vendor/piexifjs/piexif.js',
  '/tour.js?v=7', '/tour.css?v=3', '/plot-summary.js?v=4',
  '/farm-membership.js?v=2', '/problem-registry.js?v=1', '/assessment-ui.js?v=16', '/assessment.css?v=13',
  '/vendor/tailwind.generated.css?v=26',
  '/vendor/lucide-0.468.0.umd.min.js',
  '/vendor/leaflet/leaflet-1.9.4.js', '/vendor/leaflet/leaflet-1.9.4.css',
  '/vendor/leaflet/images/layers.png', '/vendor/leaflet/images/layers-2x.png',
  '/vendor/leaflet/images/marker-icon.png', '/vendor/leaflet/images/marker-icon-2x.png',
  '/vendor/leaflet/images/marker-shadow.png',
  '/vendor/leaflet-geoman.min.js', '/vendor/leaflet-geoman.css', '/vendor/turf.min.js',
  '/vendor/exifr/exifr-7.1.3.umd.js', '/vendor/fonts/google-sans/GoogleSans-latin.woff',
  '/icons/favicon-32.png?v=3', '/icons/logo-256.png?v=3', '/icons/icon-192.png?v=3',
  '/icons/icon-512.png?v=3', '/icons/maskable-512.png?v=3', '/icons/apple-touch-icon.png?v=3',
  '/img/login-hero.svg',
];
const STATIC_PATHS = new Set(SHELL_ASSETS.map(asset => new URL(asset, self.location.origin).pathname));
// Decorative desktop art is cached on demand; phones need not download it at install.
STATIC_PATHS.add('/img/landing-farmer.webp');
STATIC_PATHS.add('/img/landing-app-home.png');
STATIC_PATHS.add('/img/landing-app-home-scrolled.png');
STATIC_PATHS.add('/img/landing-app-map.png');
STATIC_PATHS.add('/img/landing-app-history.png');
STATIC_PATHS.add('/img/landing-app-mobile.png');
STATIC_PATHS.add('/img/mobile-home-scrolled.png');
STATIC_PATHS.add('/img/mobile-hud.png');
STATIC_PATHS.add('/img/mobile-scan.png');
STATIC_PATHS.add('/img/mobile-map.png');
STATIC_PATHS.add('/img/mobile-history.png');
STATIC_PATHS.add('/img/jagakebond-explainer-poster.png');
STATIC_PATHS.add('/img/jagakebond-explainer-opt-a.webm');
STATIC_PATHS.add('/img/jagakebond-explainer-opt-a.mp4');
STATIC_PATHS.add('/tutorial-3d.html');
STATIC_PATHS.add('/img/camera-target.webp');
STATIC_PATHS.add('/img/crops/crop-cabai.webp');
STATIC_PATHS.add('/img/crops/crop-kopi.webp');
STATIC_PATHS.add('/img/crops/crop-jagung.webp');
STATIC_PATHS.add('/img/crops/crop-teh.webp');
const NEVER_CACHE = ['/api/', '/uploads/'];
const isNeverCachePath = pathname => NEVER_CACHE.some(prefix => pathname.startsWith(prefix));

/* A captive portal or an error page answers 200 with HTML for a script URL. Never cache that. */
function expectedType(pathname) {
  if (pathname === '/' || pathname.endsWith('.html')) return /^text\/html/i;
  if (pathname.endsWith('.js')) return /javascript|ecmascript/i;
  if (pathname.endsWith('.css')) return /^text\/css/i;
  if (pathname.endsWith('.webmanifest') || pathname.endsWith('.json')) return /json|manifest/i;
  if (/\.(png|webp|jpe?g|gif|ico)$/i.test(pathname)) return /^image\//i;
  if (pathname.endsWith('.svg')) return /^image\/svg/i;
  if (/\.(woff2?|ttf)$/i.test(pathname)) return /font|octet-stream/i;
  return null;
}
function isValidShellResponse(url, response) {
  if (!response || response.status !== 200 || response.type === 'opaque' || response.type === 'error') return false;
  const pattern = expectedType(url.pathname);
  if (!pattern) return true;
  return pattern.test(response.headers.get('content-type') || '');
}

self.addEventListener('install', event => {
  // Every required file must arrive intact, or the previous working service worker stays in charge.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    for (const asset of SHELL_ASSETS) {
      const url = new URL(asset, self.location.origin);
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!isValidShellResponse(url, response)) throw new Error('Berkas aplikasi tidak valid: ' + asset);
      await cache.put(asset, response);
    }
    // No skipWaiting() here: a running page must not have its worker swapped underneath it.
    // The page offers "Muat ulang" and sends 'jk-skip-waiting' when the user agrees.
  })());
});

async function purgeOtherCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('jk-') && key !== SHELL_CACHE).map(key => caches.delete(key)));
}
/* Another page's purge (or the old worker's) may have emptied this cache: refill what is missing, best effort. */
async function repairShell() {
  const cache = await caches.open(SHELL_CACHE);
  for (const asset of SHELL_ASSETS) {
    if (await cache.match(asset)) continue;
    try {
      const url = new URL(asset, self.location.origin);
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (isValidShellResponse(url, response)) await cache.put(asset, response);
    } catch (_) { /* offline: the next online visit repairs it */ }
  }
}
self.addEventListener('activate', event => {
  event.waitUntil(purgeOtherCaches().then(repairShell).then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const url = new URL(request.url);
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (isValidShellResponse(url, response)) { await cache.put(request, response.clone()); return response; }
    const stored = (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true }));
    return stored || response;
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    throw error;
  }
}
async function navigationResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // Keep the cached shell as fresh as the page that was just served, so a later offline start opens the same version.
    if (isValidShellResponse(new URL('/index.html', self.location.origin), response)) await cache.put('/index.html', response.clone());
    return response;
  } catch (error) {
    return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
  }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Includes all basemap tile providers.
  if (isNeverCachePath(url.pathname)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (request.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    event.respondWith(navigationResponse(request));
    return;
  }
  if (STATIC_PATHS.has(url.pathname)) event.respondWith(networkFirst(request));
});
self.addEventListener('message', event => {
  const data = event.data;
  const type = data && typeof data === 'object' ? data.type : data;
  if (type === 'jk-skip-waiting') self.skipWaiting();
  if (type === 'jk-purge-caches') {
    const reply = () => {
      const port = event.ports && event.ports[0];
      if (port) port.postMessage({ type: 'jk-purged', cache: SHELL_CACHE });
    };
    event.waitUntil(purgeOtherCaches().then(repairShell).then(reply, reply));
  }
  if (type === 'jk-version') {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ type: 'jk-version', cache: SHELL_CACHE });
  }
});

