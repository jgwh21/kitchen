// Caches the app's own files so it opens with no internet connection.
// Bump VERSION whenever any file changes so installed copies pick up the update
// (run `python build-upload.py --bump`, which also updates the stamps below).
const VERSION = 'kitchen-v2';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/images.js', 'js/ai.js', 'js/share.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];
// Files that carry VERSION as a stamp. If the host serves a copy without it (an upload that
// hasn't finished publishing), installing fails and the previous version keeps running; the
// next launch tries again. This stops a mixed set of old and new files being saved.
const STAMPED = ['index.html', 'js/app.js'];

// A download that stalls (weak signal) must fail rather than hang, so the next launch tries again.
const INSTALL_TIMEOUT_MS = 120_000;

self.addEventListener('install', (e) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INSTALL_TIMEOUT_MS);
  e.waitUntil((async () => {
    try {
      // cache: 'reload' skips the browser's HTTP cache; GitHub Pages lets browsers keep files for
      // 10 minutes, which could otherwise mix new and old files in one version. Each file is read
      // in full as soon as it arrives, so unread responses can't hold up the remaining requests.
      const files = await Promise.all(ASSETS.map(async (url) => {
        const res = await fetch(new Request(url, { cache: 'reload', signal: abort.signal }));
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return { url, body: await res.blob(), type: res.headers.get('Content-Type') || '' };
      }));
      for (const { url, body } of files) {
        if (STAMPED.includes(url) && !(await body.text()).includes(VERSION)) {
          throw new Error(`${url} on the server is not ${VERSION} yet`);
        }
      }
      const cache = await caches.open(VERSION);
      await Promise.all(files.map(({ url, body, type }) =>
        cache.put(url, new Response(body, { headers: { 'Content-Type': type } }))));
    } catch (err) {
      await caches.delete(VERSION); // don't leave a half-filled cache behind
      throw err;
    } finally {
      clearTimeout(timer);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
