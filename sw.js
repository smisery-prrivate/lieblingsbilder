// Bump CACHE on every release; keep it equal to VERSION in app-core.js.
// One release = one complete set of files, fetched past the browser's HTTP cache in one go at
// install time and served only from this set, so the page never runs a mix of two versions and
// starts at once without waiting for the network. A new release arrives as a new worker that
// WAITS; the page asks for the switch itself at a quiet moment and restarts (see app-boot.js).
const CACHE = 'lieblingsbilder-v3';
const ASSETS = ['.', 'index.html', 'vault.js', 'app-core.js', 'app-photos.js', 'app-lock.js', 'app-sync.js', 'app-boot.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('message', e => { if (e.data && e.data.t === 'skip') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // only this app's own old caches: other apps on the same web address keep theirs
      .then(keys => Promise.all(keys.filter(k => k.startsWith('lieblingsbilder-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---------- the share sheet: "Share → Lieblingsbilder" from the gallery or any other app ----------
// The system hands the pictures to the worker as a form POST. They are parked in the app's
// database for the seconds until the page has taken them over, encrypted them and removed the
// parking slot. Honest limit: for that moment the picture lies in browser storage as it was shared
// (it comes from the phone's gallery, where it lies unencrypted anyway). The worker has no key.
const SHARE_DB = 'lieblingsbilder', SHARE_STORE = 'shared';
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SHARE_DB, 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['images', 'thumbs', 'meta', 'shared']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
  });
}
async function parkShared(files) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const t = db.transaction(SHARE_STORE, 'readwrite'), o = t.objectStore(SHARE_STORE), now = Date.now();
    files.forEach((f, i) => o.put({ id: now + '-' + i + '-' + Math.random().toString(36).slice(2, 8), blob: f, name: f.name || '', lastModified: f.lastModified || now, t: now }));
    t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  try { db.close(); } catch (e) {}
}

// Same-origin GETs only; cloud calls never pass through here. Nothing is written to the cache at
// run time, so no error page, no half-loaded file and no address with sign-in tokens can end up in it.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url), scope = new URL(self.registration.scope).pathname;
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname === scope + 'share-target') {
    e.respondWith((async () => {
      let n = 0;
      try { const fd = await e.request.formData(); const files = fd.getAll('photos').filter(f => f && typeof f.size === 'number' && f.size > 0); n = files.length; if (n) await parkShared(files); }
      catch (err) { n = -1; }
      return Response.redirect(scope + (n > 0 ? '?shared=' + n : n < 0 ? '?shared=err' : ''), 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin || !url.pathname.startsWith(scope)) return;
  e.respondWith(
    caches.open(CACHE)
      .then(c => c.match(url.origin + url.pathname, { ignoreSearch: true }))
      .then(hit => hit || fetch(e.request))
  );
});
