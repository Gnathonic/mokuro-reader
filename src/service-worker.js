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
});

self.addEventListener('activate', (event) => {
  // Remove previous cached data from disk
  async function deleteOldCaches() {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
  }

  event.waitUntil(deleteOldCaches());
});

self.addEventListener('fetch', (event) => {
  // ignore POST requests etc
  if (event.request.method !== 'GET') return;

  async function respond() {
    const url = new URL(event.request.url);
    const cache = await caches.open(CACHE);

    // `build`/`files` can always be served from the cache
    if (ASSETS.includes(url.pathname)) {
      return cache.match(url.pathname);
    }

    // for everything else, try the network first, but
    // fall back to the cache if we're offline
    try {
      const response = await fetch(event.request);

      // Only cache if:
      // 1. Response is successful (status 200)
      // 2. It's not a Google Drive API request
      // 3. It's not a large file (>10MB)
      if (response.status === 200 && 
          !event.request.url.includes('googleapis.com/drive') && 
          !event.request.url.includes('alt=media')) {
        
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
      return cache.match(event.request);
    }
  }

  event.respondWith(respond());
});
