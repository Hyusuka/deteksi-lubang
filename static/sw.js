self.addEventListener('install', (event) => {
    // Minimal install step
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // We just want to pass through everything for now.
    // This is the bare minimum required for a valid PWA install.
    event.respondWith(fetch(event.request));
});
