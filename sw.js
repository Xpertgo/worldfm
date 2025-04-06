// sw.js - Service Worker for World FM Radio

const CACHE_NAME = 'world-fm-radio-cache-v1';
const STATIC_ASSETS = [
    '/', // Cache the root HTML
    '/index.html',
    '/styles.css', // Replace with your actual CSS file path
    '/app.js',     // Replace with your actual JS file path (the main script above)
    '/languageNormalization.js',
    '/staticCountries.js',
    'https://flagcdn.com/24x18/in.png', // Example flag, add more as needed
    'https://via.placeholder.com/96x96', // Placeholder artwork
    'https://via.placeholder.com/128x128'
];

// Install event: Cache static assets
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching static assets');
            return cache.addAll(STATIC_ASSETS);
        }).then(() => {
            console.log('[Service Worker] Installation complete, skipping waiting');
            return self.skipWaiting(); // Force immediate activation
        }).catch((err) => {
            console.error('[Service Worker] Installation failed:', err);
        })
    );
});

// Activate event: Clean up old caches and claim clients
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating...');
    event.waitUntil(
        Promise.all([
            // Clean up old caches
            caches.keys().then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== CACHE_NAME) {
                            console.log('[Service Worker] Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            }),
            // Claim clients immediately
            self.clients.claim()
        ]).then(() => {
            console.log('[Service Worker] Activation complete');
        }).catch((err) => {
            console.error('[Service Worker] Activation failed:', err);
        })
    );
});

// Fetch event: Handle requests for static assets and audio streams
self.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);

    // Handle static assets from cache
    if (STATIC_ASSETS.includes(requestUrl.pathname) || requestUrl.pathname === '/') {
        event.respondWith(
            caches.match(event.request).then((response) => {
                return response || fetch(event.request).then((networkResponse) => {
                    return caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });
                });
            }).catch((err) => {
                console.error('[Service Worker] Fetch failed for static asset:', err);
                return caches.match('/index.html'); // Fallback to offline page
            })
        );
    }
    // Handle audio streams (do not cache, fetch directly)
    else if (
        requestUrl.href.includes('radio-browser.info') ||
        requestUrl.href.match(/\.(mp3|m3u|pls)$/) ||
        requestUrl.href.includes('stream') // Broad match for streaming URLs
    ) {
        event.respondWith(
            fetch(event.request).catch((err) => {
                console.error('[Service Worker] Fetch failed for audio stream:', err);
                return new Response('Stream unavailable', { status: 503, statusText: 'Service Unavailable' });
            })
        );
    }
    // Let other requests pass through (e.g., API calls for station data)
    else {
        event.respondWith(
            fetch(event.request).catch((err) => {
                console.error('[Service Worker] Fetch failed for other resource:', err);
                return new Response('Resource unavailable', { status: 503, statusText: 'Service Unavailable' });
            })
        );
    }
});

// Message event: Handle playback control from the main thread
self.addEventListener('message', (event) => {
    const { action } = event.data;
    console.log('[Service Worker] Message received:', action);

    // Broadcast the action to all clients (open tabs)
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
        clients.forEach((client) => {
            client.postMessage({ action });
        });
    });

    // Handle specific actions if needed (e.g., keep-alive logic)
    switch (action) {
        case 'play':
            console.log('[Service Worker] Play action received');
            // No direct audio control here; main thread handles it
            break;
        case 'pause':
            console.log('[Service Worker] Pause action received');
            break;
        case 'stop':
            console.log('[Service Worker] Stop action received');
            break;
        case 'previous':
            console.log('[Service Worker] Previous action received');
            break;
        case 'next':
            console.log('[Service Worker] Next action received');
            break;
        default:
            console.warn('[Service Worker] Unknown action:', action);
    }
});

// Periodic event (if supported): Keep the service worker alive
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'keep-alive') {
        console.log('[Service Worker] Periodic sync triggered to keep alive');
        event.waitUntil(
            self.clients.matchAll().then((clients) => {
                clients.forEach((client) => {
                    client.postMessage({ action: 'heartbeat' });
                });
            })
        );
    }
});

// Optional: Register periodic sync to keep the service worker active
async function registerPeriodicSync() {
    if ('periodicSync' in self.registration) {
        try {
            const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
            if (status.state === 'granted') {
                await self.registration.periodicSync.register('keep-alive', {
                    minInterval: 24 * 60 * 60 * 1000 // Once per day (adjust as needed)
                });
                console.log('[Service Worker] Periodic sync registered');
            } else {
                console.warn('[Service Worker] Periodic sync permission not granted');
            }
        } catch (err) {
            console.error('[Service Worker] Periodic sync registration failed:', err);
        }
    }
}

// Initialize periodic sync on activation
self.addEventListener('activate', (event) => {
    event.waitUntil(
        registerPeriodicSync().then(() => {
            console.log('[Service Worker] Periodic sync setup complete');
        })
    );
});