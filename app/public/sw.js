/**
 * Offline support.
 *
 * The room this runs in has bad wifi. A service that loses its corpus mid-sermon because
 * a download failed is worse than one that never claimed to work offline, so the corpus
 * and the app shell are cached on first visit and served from there afterwards.
 *
 * Speech models are not cached here. transformers.js already stores them in the Cache API
 * under its own keys, and duplicating a 40 MB download would be worse than useless.
 */

const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;

/** Enough to boot the control view and the projector with no network at all. */
const SHELL_URLS = ["/", "/index.html", "/projector.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      // A shell file missing at install time must not wedge the worker; the fetch handler
      // falls back to the network anyway.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL && key !== DATA && key.includes(VERSION) === false)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The corpus never changes within a version, so serve it from cache and only reach the
  // network the first time. This is the part that must survive a dead connection.
  if (url.pathname.startsWith("/data/")) {
    event.respondWith(
      caches.open(DATA).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  // Everything else prefers the network so a deploy lands, and falls back to cache when
  // there is none.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        // A navigation with nothing cached still needs to render something.
        if (request.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        throw new Error("offline and not cached");
      }),
  );
});
