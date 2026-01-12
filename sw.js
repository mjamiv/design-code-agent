/**
 * Service Worker for northstar.LM
 * Provides offline support and faster repeat loads via caching
 */

const CACHE_NAME = 'northstar-lm-v2';
const urlsToCache = [
    './',
    './index.html',
    './orchestrator.html',
    './css/styles.css',
    './js/app.js',
    './js/orchestrator.js',
    // Fonts will be cached on first load
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching static assets');
            return cache.addAll(urlsToCache.map(url => {
                // Handle query params in cache
                return new Request(url, { cache: 'reload' });
            })).catch(err => {
                console.warn('[SW] Failed to cache some assets:', err);
            });
        })
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip API calls (always go to network)
    if (event.request.url.includes('api.openai.com')) {
        return;
    }

    // Skip external CDN resources (let browser handle)
    if (event.request.url.includes('cdn.') ||
        event.request.url.includes('unpkg.com') ||
        event.request.url.includes('googleapis.com') ||
        event.request.url.includes('gstatic.com')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((response) => {
            // Cache hit - return cached version
            if (response) {
                return response;
            }

            // Not in cache - fetch from network
            return fetch(event.request).then((response) => {
                // Don't cache non-successful responses
                if (!response || response.status !== 200 || response.type !== 'basic') {
                    return response;
                }

                // Clone the response (can only be consumed once)
                const responseToCache = response.clone();

                // Cache the fetched resource
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });

                return response;
            }).catch(() => {
                // Network failed - could return offline page here
                return new Response('Offline - please check your connection', {
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: new Headers({
                        'Content-Type': 'text/plain'
                    })
                });
            });
        })
    );
});
