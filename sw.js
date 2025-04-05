// sw.js
const CACHE_NAME = 'world-fm-radio-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/script.js', // Add your main script
    'https://cdn.jsdelivr.net/npm/hls.js@latest', // Cache hls.js
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/js/all.min.js',
    'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap',
    '/manifest.json' // If you have a manifest
];

self.addEventListener('install', (event) => {
    console.log('Service Worker: Installed');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('Service Worker: Caching Files');
            return cache.addAll(urlsToCache).catch(err => {
                console.error('Service Worker: Cache addAll failed:', err);
            });
        })
    );
    self.skipWaiting(); // Take control immediately
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker: Activated');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Service Worker: Clearing Old Cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim(); // Take control of clients immediately
});

self.addEventListener('fetch', (event) => {
    const requestUrl = new URL(event.request.url);

    // Handle audio stream requests (no caching, direct fetch)
    if (requestUrl.pathname.match(/\.(mp3|aac|ogg|wav|m3u|pls|m3u8)$/i) || event.request.url.includes('stream')) {
        console.log('Service Worker: Handling audio stream fetch:', event.request.url);
        event.respondWith(
            fetch(event.request, { mode: 'no-cors' })
                .then(response => response)
                .catch(error => {
                    console.error('Service Worker: Fetch failed for audio stream:', error);
                    return new Response('Stream unavailable', { status: 503 });
                })
        );
    } else {
        // Cache-first strategy for other resources
        event.respondWith(
            caches.match(event.request).then((response) => {
                return response || fetch(event.request).then((fetchResponse) => {
                    return caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, fetchResponse.clone());
                        return fetchResponse;
                    });
                }).catch(error => {
                    console.error('Service Worker: Fetch failed:', error);
                    return new Response('Resource unavailable offline', { status: 503 });
                });
            })
        );
    }
});
