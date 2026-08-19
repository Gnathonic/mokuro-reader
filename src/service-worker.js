/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';

// Create a unique cache name for this deployment
const CACHE = `cache-${version}`;

const ASSETS = [
  ...build, // the app itself
  ...files // everything in `static`
];

self.addEventListener('install', (event) => {
  // Create a new cache and add all files to it
  async function addFilesToCache() {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
  }

  event.waitUntil(addFilesToCache());

  // Don't call skipWaiting() here - we want to show an "Update Available" banner
  // and let the user choose when to update. skipWaiting will be triggered via
  // a message from the client when the user clicks "Update".
});

// Listen for messages from the client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  // Remove previous cached data from disk
  async function deleteOldCaches() {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
  }

  event.waitUntil(deleteOldCaches());

  // Take control of all clients immediately (don't wait for reload)
  self.clients.claim();
});

// Cross-origin hosts the service worker may still handle: small, fast
// requests whose responses are worth keeping in the offline cache (the
// Noto Sans JP webfont loaded from app.html).
const CROSS_ORIGIN_CACHE_ALLOWLIST = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('fetch', (event) => {
  // ignore POST requests etc
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never proxy cross-origin requests (external catalogs, Google Drive,
  // WebDAV, OneDrive, MEGA, ...) through the service worker. Firefox tears
  // down an idle service worker ~30s after respondWith() settles, which
  // aborts any large response body still streaming through it and surfaces
  // as "Error in input stream" / "A ServiceWorker intercepted the request and
  // encountered an unexpected error" (#177, #261). Not calling respondWith()
  // lets the browser perform the fetch natively with the SW out of the path.
  if (url.origin !== self.location.origin && !CROSS_ORIGIN_CACHE_ALLOWLIST.includes(url.origin)) {
    return;
  }

  async function respond() {
    const cache = await caches.open(CACHE);

    // `build`/`files` can always be served from the cache
    if (ASSETS.includes(url.pathname)) {
      const cachedResponse = await cache.match(url.pathname);
      if (cachedResponse) {
        return cachedResponse;
      }
      // If not in cache, fall through to network
    }

    // for everything else, try the network first, but
    // fall back to the cache if we're offline
    try {
      const response = await fetch(event.request);

      // Only cache successful (status 200) responses smaller than 10MB
      if (response.status === 200) {
        // Check response size before caching
        const contentLength = response.headers.get('content-length');
        const sizeInMB = contentLength ? parseInt(contentLength) / (1024 * 1024) : 0;

        // Only cache if smaller than 10MB
        if (sizeInMB < 10) {
          cache.put(event.request, response.clone());
        }
      }

      return response;
    } catch {
      const cachedResponse = await cache.match(event.request);
      // Return cached response or a basic offline response
      return (
        cachedResponse ||
        new Response('Offline', { status: 503, statusText: 'Service Unavailable' })
      );
    }
  }

  event.respondWith(respond());
});
