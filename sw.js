/**
 * Offline cache.
 *
 * Everything is served from the cache and the network is never consulted, so
 * a weak connection at an event never stalls the screen and the product list
 * never changes mid-sale. A new version arrives only through the app's update
 * button (the "refresh" message).
 *
 * If FILES changes, bump CACHE; VERSIONED_FILES in
 * scripts/event-counter-export.ts must list the same files.
 */
const CACHE = "plumie-event-counter-v5";
const FILES = ["./", "app.js", "qr.js", "data.js", "manifest.webmanifest", "icon.png", "icon-512.png", "favicon-32.png", "favicon-16.png", "nunito-900.woff2", "sale.m4a", "version.json"];

async function sha256(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Downloads and verifies everything before writing anything, so a half-done
 * update or a file the CDN has not refreshed yet never mixes old and new. If
 * any file does not match its fingerprint in version.json, nothing is written
 * and the old version stays.
 *
 * Errors carry a code the app turns into a message: "stale" (deploy not fully
 * live yet) or "network".
 */
async function refresh() {
  const blobs = await Promise.all(
    FILES.map(async (file) => {
      const response = await fetch(`${file}?fresh=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("network");
      return { blob: await response.blob(), headers: response.headers, status: response.status };
    }),
  );
  const expected = JSON.parse(await blobs[FILES.indexOf("version.json")].blob.text()).files;
  if (expected) {
    for (const [i, file] of FILES.entries()) {
      const name = file === "./" ? "index.html" : file;
      if (expected[name] && expected[name] !== (await sha256(blobs[i].blob))) throw new Error("stale");
    }
  }
  // A redirected response cannot serve a navigation; rebuild it from the body.
  const responses = blobs.map(({ blob, headers, status }) => new Response(blob, { status, headers }));
  const cache = await caches.open(CACHE);
  await Promise.all(FILES.map((file, i) => cache.put(file, responses[i])));
}

self.addEventListener("install", (event) => {
  event.waitUntil(refresh().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.searchParams.has("fresh")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = event.request.mode === "navigate" ? "./" : event.request;
      return (await cache.match(key, { ignoreSearch: true })) ?? fetch(event.request);
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "refresh") return;
  const port = event.ports[0];
  event.waitUntil(
    refresh().then(
      () => port.postMessage({ ok: true }),
      (error) => port.postMessage({ ok: false, error: error?.message === "stale" ? "stale" : "network" }),
    ),
  );
});
