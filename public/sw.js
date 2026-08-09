// Offline app shell.
//
// Plain JS in public/ rather than a bundled module: the service worker must sit
// at the deploy root with a stable name, and it needs no build step.
//
// Strategy is cache-first with a background refresh. Asset filenames are hashed
// by the build, so anything already cached is immutable and safe to serve; the
// HTML entry is revalidated so a new deploy is picked up on the next launch.

// Both lines are rewritten at build time with the real hashed filenames and a
// content-derived cache name (see the precache plugin in vite.config.ts).
// Precaching matters: a service worker does not control the page that
// registered it, so without this list the first visit would cache nothing and
// the app would only work offline from the third launch onwards.
const CACHE = "cactus-dev";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

// `ignoreVary` matters more than it looks. Precached entries are stored from
// plain Requests, which carry no Origin header, while Vite emits its module
// script with `crossorigin` — so the real request DOES send Origin. A server
// answering `Vary: Origin` (vite preview does) then makes every asset lookup
// miss, and the app is silently broken offline. This is a same-origin app
// shell; Vary is noise here.
const MATCH = { ignoreVary: true };

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a new deploy wins, cache as the offline
  // fallback. Everything else: cache first.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() =>
          caches.match("./index.html", MATCH).then((hit) => hit || Response.error()),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request, MATCH).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
