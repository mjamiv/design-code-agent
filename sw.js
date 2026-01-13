/**
 * Service Worker for northstar.LM
 * Provides offline support and automatic cache clearing on updates
 * 
 * IMPORTANT: Increment CACHE_VERSION when deploying new changes!
 */

const CACHE_VERSION = 4;
const CACHE_NAME = `northstar-lm-v${CACHE_VERSION}`;

/**
 * Add Cross-Origin Isolation headers to enable SharedArrayBuffer
 * Required for synchronous sub_lm() calls in the RLM REPL
 */
function addCOIHeaders(response) {
    // Opaque responses (status 0) cannot be modified
    if (response.status === 0) {
        return response;
    }
    
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
    
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
    });
}

// Core app files - always try to get fresh versions
const CORE_FILES = [
    './',
    './index.html',
    './orchestrator.html',
    './northstar-overview.html',
    './css/styles.css',
    './js/app.js',
    './js/orchestrator.js',
    './js/rlm/index.js',
    './js/rlm/context-store.js',
    './js/rlm/query-decomposer.js',
    './js/rlm/sub-executor.js',
    './js/rlm/aggregator.js',
    './js/rlm/repl-environment.js',
    './js/rlm/repl-worker.js',
    './js/rlm/code-generator.js',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log(`[SW] Installing version ${CACHE_VERSION}`);
    
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching core assets');
            return cache.addAll(CORE_FILES.map(url => {
                return new Request(url, { cache: 'reload' });
            })).catch(err => {
                console.warn('[SW] Failed to cache some assets:', err);
            });
        })
    );
    
    // Activate immediately without waiting for old SW to finish
    self.skipWaiting();
});

// Activate event - clean up ALL old caches
self.addEventListener('activate', (event) => {
    console.log(`[SW] Activating version ${CACHE_VERSION}`);
    
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    // Delete ANY cache that doesn't match current version
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => {
            // Notify all clients that cache has been cleared
            return self.clients.matchAll().then(clients => {
                clients.forEach(client => {
                    client.postMessage({
                        type: 'CACHE_CLEARED',
                        version: CACHE_VERSION
                    });
                });
            });
        })
    );
    
    // Take control of all clients immediately
    self.clients.claim();
});

// Fetch event - Network-first for core files, Cache-first for others
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip API calls (always go to network)
    if (event.request.url.includes('api.openai.com')) {
        return;
    }

    // Skip external CDN resources
    if (event.request.url.includes('cdn.') ||
        event.request.url.includes('unpkg.com') ||
        event.request.url.includes('googleapis.com') ||
        event.request.url.includes('gstatic.com') ||
        event.request.url.includes('pyodide')) {
        return;
    }

    const url = new URL(event.request.url);
    const isCoreFile = CORE_FILES.some(file => 
        url.pathname.endsWith(file.replace('./', '/')) || 
        url.pathname === '/' ||
        url.pathname.endsWith('.html') ||
        url.pathname.endsWith('.js') ||
        url.pathname.endsWith('.css')
    );

    if (isCoreFile) {
        // Network-first for core files (always try to get fresh version)
        event.respondWith(networkFirst(event.request));
    } else {
        // Cache-first for other assets (images, fonts, etc.)
        event.respondWith(cacheFirst(event.request));
    }
});

// Network-first strategy: Try network, fall back to cache
async function networkFirst(request) {
    try {
        const networkResponse = await fetch(request, { cache: 'no-cache' });
        
        // Cache the fresh response (without COI headers for storage)
        if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        
        // Add COI headers for the response we return
        return addCOIHeaders(networkResponse);
    } catch (error) {
        // Network failed, try cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            console.log('[SW] Serving from cache (offline):', request.url);
            return addCOIHeaders(cachedResponse);
        }
        
        // Nothing in cache either
        return new Response('Offline - please check your connection', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

// Cache-first strategy: Try cache, fall back to network
async function cacheFirst(request) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        return addCOIHeaders(cachedResponse);
    }
    
    try {
        const networkResponse = await fetch(request);
        
        if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        
        // Add COI headers for the response we return
        return addCOIHeaders(networkResponse);
    } catch (error) {
        return new Response('Resource unavailable', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

// Handle messages from the app
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data && event.data.type === 'GET_VERSION') {
        event.source.postMessage({
            type: 'VERSION',
            version: CACHE_VERSION
        });
    }
    
    // Force clear all caches
    if (event.data && event.data.type === 'CLEAR_ALL_CACHES') {
        event.waitUntil(
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => caches.delete(cacheName))
                );
            }).then(() => {
                event.source.postMessage({ type: 'CACHES_CLEARED' });
            })
        );
    }
});
