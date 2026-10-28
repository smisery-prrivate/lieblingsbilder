'use strict';
if (self !== top) { try { document.documentElement.hidden = true; } catch (e) {} throw new Error('Lieblingsbilder does not run inside another page.'); }      // never framed by another site
/* Lieblingsbilder core: helpers, settings, encrypted storage, the photo list, the work queue,
   screens and the back button. Built the Snapdoc way: several plain script files that share one
   scope (no build step); index.html loads them in order. Nothing readable is ever written to the
   device: every image, thumbnail, the photo list and the sign-in token are sealed by the vault. */
const VERSION = 'v5';
const $ = id => document.getElementById(id);
const CFG = self.APP_CONFIG || {};
const SYNC = CFG.supabaseUrl && CFG.supabaseKey ? { url: String(CFG.supabaseUrl).replace(/\/$/, ''), key: CFG.supabaseKey } : null;
const SET_KEY = 'lb.settings', TICK_KEY = 'lb.tick', RESUME_KEY = 'lb.resume', OWNER_KEY = 'lb.owner';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dateStamp = t => { const d = t ? new Date(t) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtMonth = t => new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const monthKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
const utf8 = s => new TextEncoder().encode(s);
const errText = e => (e && (e.message || e.name)) || (e == null ? 'unknown error' : String(e));
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'];
const safeType = t => IMAGE_TYPES.includes(String(t || '').toLowerCase()) ? String(t).toLowerCase() : 'application/octet-stream';      // a stored type is only ever one of these
const extOf = t => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif' }[t] || 'bin');

// ---------- one active instance ----------
// Only one tab or window writes at a time. Whoever is active puts its id into localStorage, which
// every tab reads synchronously; every write checks it first, so a tab that was replaced (or was
// frozen in the background and wakes up late) cannot write stale data over newer data.
const INSTANCE_ID = uid(), BOOT_ID = INSTANCE_ID.slice(0, 8);
let passive = false;
let markNeeded = false, lockHeld = false;      // markNeeded: another window has shown itself; lockHeld: this window holds the Web Lock
const isOwner = () => { try { const o = localStorage.getItem(OWNER_KEY); return !o || o === INSTANCE_ID; } catch (e) { return lockHeld || !markNeeded; } };
function writeGuard() {
  if (!passive && isOwner()) return;
  if (!passive && typeof instanceLost === 'function') instanceLost();
  throw new Error('Lieblingsbilder is active in another tab or window.');
}

// ---------- settings (not sensitive, plain) ----------
let settings = { lockAfter: 0, keepAll: false };      // lockAfter: 0 = lock as soon as the app leaves the screen; keepAll: download every full-size photo to this device
const LOCK_AFTER = [0, 5, 60, 300, 1800];
try { Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch (e) {}
if (!LOCK_AFTER.includes(+settings.lockAfter)) settings.lockAfter = 0;      // only the offered values: nothing in plain storage can switch the lock off
const saveSettings = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {} };

// ---------- IndexedDB ----------
const idb = (() => {
  const STORES = ['images', 'thumbs', 'meta', 'shared'];      // 'shared': the parking slot of the share sheet, written by sw.js
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('lieblingsbilder', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
    r.onblocked = () => { try { fatal('An older Lieblingsbilder window is still open. Close it, then open the app again.'); } catch (e) {} };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = async () => {
        try { while (qLen > 0) await new Promise(f => setTimeout(f, 100)); } catch (e) {}
        try { db.close(); } catch (e) {} dbp = null; try { instanceLost(); } catch (e) {}
      };
      res(db);
    };
    r.onerror = () => rej(r.error);
  }));
  const txOpts = (store, mode) => mode === 'readwrite' && store === 'meta' ? { durability: 'strict' } : undefined;      // the key record and the list are on disk before the next step relies on them
  const fail = (t, e) => t.error || (e && e.target && e.target.error) || new Error('storage request failed');
  const tx = async (store, mode, fn) => {
    if (mode === 'readwrite') writeGuard();
    const d = await open();
    return new Promise((res, rej) => { const t = d.transaction(store, mode, txOpts(store, mode)); const rq = fn(t.objectStore(store)); t.oncomplete = () => res(rq && rq.result); t.onerror = e => rej(fail(t, e)); t.onabort = e => rej(fail(t, e)); });
  };
  return {
    get: (s, k) => tx(s, 'readonly', o => o.get(k)), put: (s, v) => tx(s, 'readwrite', o => o.put(v)), del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
    keys: s => tx(s, 'readonly', o => o.getAllKeys()), all: s => tx(s, 'readonly', o => o.getAll()),
    // change a record only if it still is what the caller read: fn(current) returns the new record or nothing
    async cas(s, k, fn) {
      writeGuard(); const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(s, 'readwrite', txOpts(s, 'readwrite')), o = t.objectStore(s); let did = false;
        const g = o.get(k); g.onsuccess = () => { const nv = fn(g.result); if (nv) { o.put(nv); did = true; } };
        t.oncomplete = () => res(did); t.onerror = e => rej(fail(t, e)); t.onabort = e => rej(fail(t, e));
      });
    },
    async wipe() { for (const s of STORES) await tx(s, 'readwrite', o => o.clear()).catch(() => {}); }
  };
})();
const metaStore = { get: id => idb.get('meta', id), put: rec => idb.put('meta', rec), del: id => idb.del('meta', id), keys: () => idb.keys('meta') };

// ---------- encrypted records: nothing readable is written to the device ----------
const imgLabel = id => 'lb|img|' + id, thLabel = id => 'lb|th|' + id;
const sameIv = (a, b) => { if (!a || !b || a.byteLength !== b.byteLength) return false; const x = new Uint8Array(a, 0, 12), y = new Uint8Array(b, 0, 12); return x.every((v, i) => v === y[i]); };
// Record writes and the key renewal: a write that began under the previous key is sealed and
// stored once more under the new one, so no record ever lands under a key that is about to go.
let recWrites = 0, recSeq = 0;
async function sealedPut(store, id, blob, aad) {
  recWrites++; recSeq++;
  try { let gen; do { gen = Vault.keyGen(); await idb.put(store, { id, data: await Vault.sealBlob(blob, aad), t: Date.now() }); } while (Vault.keyGen() !== gen); }
  finally { recWrites--; recSeq++; }
}
const imgPut = (id, blob) => sealedPut('images', id, blob, imgLabel(id));
async function imgGet(id, type) { const r = await idb.get('images', id); return r ? Vault.openBlob(r.data, imgLabel(id), type || 'image/jpeg') : null; }
const imgHas = async id => !!(await idb.get('images', id));
const thumbPut = (id, blob) => sealedPut('thumbs', id, blob, thLabel(id));
async function thumbGet(id) { const r = await idb.get('thumbs', id); return r ? Vault.openBlob(r.data, thLabel(id), 'image/jpeg') : null; }
// After the local key was renewed: bring every stored record under the new key, one at a time,
// then let go of the previous key (the Snapdoc pass, with this app's stores).
let resealing = false;
async function resealAll() {
  if (resealing || !photosLoaded || locked || passive || !Vault.isOpen() || !Vault.hasOldKeys()) return;
  resealing = true;
  try {
    const STORES = { images: imgLabel, thumbs: thLabel };
    for (let round = 0; round < 6; round++) {
      const gen = Vault.keyGen(), rid = Vault.renewalId(), seq0 = recSeq;
      let mark = null; try { mark = await idb.get('meta', 'reseal'); } catch (e) {}
      if (!mark || mark.gen !== rid) mark = { id: 'reseal', gen: rid, last: {} };
      let failed = 0, lost = 0, n = 0;
      outer: for (const store of Object.keys(STORES)) {
        const after = mark.last[store] || '';
        for (const id of await idb.keys(store)) {
          if (after && id <= after) continue;
          if (passive || locked || !Vault.isOpen()) return;
          try {
            const r = await idb.get(store, id); if (!r || !r.data) continue;
            let nb = null;
            try { nb = await Vault.reseal(r.data, STORES[store](id)); } catch (e) { if (e && e.name === 'NoKey') { lost++; mark.last[store] = id; continue; } throw e; }
            if (nb) await idb.cas(store, id, cur => cur && sameIv(cur.data, r.data) ? Object.assign(cur, { data: nb }) : undefined);
            mark.last[store] = id; if (++n % 20 === 0) await idb.put('meta', mark).catch(() => {});
          } catch (e) {
            mark.tries = mark.tries || {}; const k = store + '/' + id; mark.tries[k] = (mark.tries[k] || 0) + 1;
            if (mark.tries[k] >= 3) { lost++; mark.last[store] = id; continue; }
            failed++; break outer;
          }
        }
      }
      try { await idb.put('meta', mark); } catch (e) {}
      if (failed) break;
      if (!(await persist())) break;
      const SMALL = [['session', 'lb|session'], ['drive', 'lb|drive']];
      for (const [id, aad] of SMALL) {
        const sr = await idb.get('meta', id);
        if (sr && sr.data) { const nb = await Vault.reseal(sr.data, aad); if (nb) await idb.cas('meta', id, c => c && sameIv(c.data, sr.data) ? { id, data: nb } : undefined); }
      }
      if (!(await Vault.resealCloudKey(session ? session.uid : ''))) break;
      if (!(await Vault.resealRoomKeys(session ? session.uid : account))) break;
      let under = true;
      for (const [id, aad] of [['photos', 'lb|photos']].concat(SMALL)) { const r = await idb.get('meta', id); if (r && r.data && (await Vault.reseal(r.data, aad)) !== null) under = false; }
      if (!under) break;
      while (recWrites > 0) await new Promise(r => setTimeout(r, 50));
      if (passive || locked || !Vault.isOpen()) return;
      if (recSeq !== seq0 || Vault.keyGen() !== gen) continue;
      if (await Vault.dropOldKeys(gen)) {
        await idb.del('meta', 'reseal').catch(() => {});
        if (lost) toast(lost + (lost === 1 ? ' stored item' : ' stored items') + ' could not be read with any key and ' + (lost === 1 ? 'was' : 'were') + ' left behind.');
        renderLockBox();
      }
      break;
    }
  } catch (e) {} finally { resealing = false; }
}

// ---------- the photo list: one encrypted record; images and thumbnails live in their own records ----------
/* One photo:
   id, name (file name), type, w, h, size (bytes of the original), taken_at (ms; from the picture's
   EXIF date, else the file date), created_at (when it was added), folder, caption, star (one of
   the best: the "Top" view shows only these), deleted,
   updated_at (last change of the fields above: the entry the cloud holds is sealed with it),
   room ('' = the person's own space, else the id of the shared room it lives in), uid (who added
   it; '' = added here before any sign-in, which counts as mine).
   On this device: have (the full image is stored here), th (the thumbnail is stored here).
   Cloud: tag (the name part of the uploaded files), pk (this photo's own key, wrapped by the cloud
   key), st ('sb': the files are in the Supabase bucket, 'gd': in the owner's Google Drive, then
   df and dt are the Drive file ids), up (both files accepted for this tag),
   srv (the updated_at the cloud entry carries; -1 = send ours again), seen (server stamp of the
   entry last seen), cloudPurged, owed (object names still to be removed). */
let photos = [], snap = {}, foreignDirty = false, photosLoaded = false, cursors = {}, account = '';
// rooms: the shared spaces this person is in: { id, name, token (invite token: members may invite), created_by, joined_at }
let rooms = [], space = '';      // space: '' = own photos, else a room id (the screen that is open)
try { space = localStorage.getItem('lb.space') || ''; } catch (e) {}
const isMine = p => !p.uid || (session ? p.uid === session.uid : p.uid === account);
const roomById = id => rooms.find(r => r.id === id);
const spaceName = id => id ? ((roomById(id) || {}).name || 'Room') : 'My photos';
const spaceList = () => [{ id: '', name: 'My photos' }].concat(rooms.map(r => ({ id: r.id, name: r.name || 'Room' })));
const sigOf = p => JSON.stringify([p.taken_at, p.folder, p.caption, !!p.star, !!p.deleted]);
function migrate(p) {
  p.name = p.name == null ? '' : String(p.name); p.type = safeType(p.type); p.w = +p.w || 0; p.h = +p.h || 0; p.size = +p.size || 0;
  p.created_at = p.created_at || Date.now(); p.taken_at = p.taken_at || p.created_at; p.updated_at = p.updated_at || p.created_at;
  p.folder = p.folder ? String(p.folder) : ''; p.caption = p.caption ? String(p.caption) : ''; p.star = !!p.star;
  p.have = !!p.have; p.th = !!p.th; p.up = !!p.up; p.tag = p.tag || ''; p.pk = p.pk || ''; p.srv = p.srv || 0; p.seen = p.seen || 0;
  p.room = p.room ? String(p.room) : ''; p.uid = p.uid ? String(p.uid) : '';
  p.st = p.st === 'gd' ? 'gd' : 'sb'; p.df = p.df ? String(p.df) : ''; p.dt = p.dt ? String(p.dt) : '';
  return p;
}
const unpackList = v => v && Array.isArray(v.photos) ? { photos: v.photos, cursors: v.cursors || {}, account: v.account || '', rooms: Array.isArray(v.rooms) ? v.rooms : [] } : { photos: [], cursors: {}, account: '', rooms: [] };
async function loadPhotos() {
  const r = await idb.get('meta', 'photos'); let v = null;
  if (r) v = await Vault.openJson(r.data, 'lb|photos');
  const u = unpackList(v);
  photos = u.photos.map(migrate); cursors = u.cursors; account = u.account; rooms = u.rooms; snap = {};
  for (const p of photos) snap[p.id] = sigOf(p);
  if (space && !roomById(space)) space = '';
  photosLoaded = true;
}
async function mergeStored() {           // another tab wrote meanwhile: adopt what is newer there
  let stored; try { const r = await idb.get('meta', 'photos'); if (!r) return; stored = unpackList(await Vault.openJson(r.data, 'lb|photos')); } catch (e) { return; }
  for (const k in stored.cursors) cursors[k] = Math.max(cursors[k] || 0, stored.cursors[k] || 0);
  if (stored.account && !account) account = stored.account;
  for (const r of stored.rooms) if (!roomById(r.id)) rooms.push(r);
  for (const s of stored.photos) {
    migrate(s); const p = photos.find(x => x.id === s.id);
    if (!p) { photos.push(s); snap[s.id] = sigOf(s); }
    else if (s.updated_at > p.updated_at) { Object.assign(p, s); snap[s.id] = sigOf(s); }
  }
}
// Resolves to true once the list (with every change made before the call) is stored, false when it
// could not be stored or this window is not the active one.
let persistChain = Promise.resolve(false), persistQueued = false, persistFailed = false;
function persist() {
  if (passive || !photosLoaded) return Promise.resolve(false);      // never before the stored list has been read: an empty list must not replace it
  if (persistQueued) return persistChain;
  persistQueued = true;
  persistChain = persistChain.then(async () => {
    persistQueued = false;
    if (passive) return false;
    if (foreignDirty) { foreignDirty = false; await mergeStored(); }
    await idb.put('meta', { id: 'photos', data: await Vault.sealJson({ photos, cursors, account, rooms }, 'lb|photos') });
    persistFailed = false;
    try { localStorage.setItem(TICK_KEY, Date.now() + '.' + Math.random()); } catch (e) {}
    return true;
  }).catch(e => { persistQueued = false; persistFailed = true; if (!passive) toast('Saving failed: ' + errText(e)); return false; });
  return persistChain;
}
// a delete marker older than 60 days goes only when nothing is owed to the cloud any more
const settledTombstone = p => !(p.owed && p.owed.length) && ((p.cloudPurged && p.srv === p.updated_at) || (!p.srv && !p.up));
function save(opts) {
  const now = Date.now();
  for (const p of photos) { const s = sigOf(p); if (snap[p.id] !== s) { p.updated_at = Math.max(now, p.updated_at + 1); snap[p.id] = s; } }
  photos = photos.filter(p => !(p.deleted && now - p.updated_at > 60 * 864e5 && settledTombstone(p)));
  const stored = persist();
  if (!opts || opts.sync !== false) scheduleSync();
  return stored;
}
const alive = () => photos.filter(p => !p.deleted).sort((a, b) => b.taken_at - a.taken_at || b.created_at - a.created_at);
const byId = id => photos.find(p => p.id === id);
async function purgePhotoData(p) {
  await idb.del('images', p.id).catch(() => {}); await idb.del('thumbs', p.id).catch(() => {});
  p.have = false; p.th = false; dropThumbUrl(p.id);
}
const inSpace = () => alive().filter(p => p.room === space);
const folderNames = () => [...new Set(inSpace().map(p => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// ---------- work queue (imports, downloads on demand) ----------
let q = Promise.resolve(), qLen = 0, busyN = 0;
function queue(fn) { qLen++; busy(true); q = q.then(fn).catch(e => toast('Failed: ' + errText(e))).then(() => { qLen--; busy(false); }); return q; }
function busy(on) { busyN = Math.max(0, busyN + (on ? 1 : -1)); $('busy').classList.toggle('on', busyN > 0); }
async function waitForQueue() { while (qLen > 0) await q; }

// ---------- screens and the back button ----------
const BASE = ['home', 'view'];
const stack = ['home'];
let popupState = null;
function applyStack() {
  const base = current();
  for (const s of BASE) $(s).hidden = s !== base;
  $('sheet').classList.toggle('open', stack.includes('sheet'));
  $('popup').classList.toggle('open', stack.includes('popup'));
}
function current() { return stack.slice().reverse().find(s => BASE.includes(s)) || 'home'; }
const histState = () => ({ n: stack.length, b: BOOT_ID });      // every history entry carries the id of this start
function push(name) { stack.push(name); history.pushState(histState(), ''); applyStack(); }
let navPending = 0; const navQueue = [];
const afterPop = fn => { if (navPending) navQueue.push(fn); else fn(); };
function drainNav() { const qq = navQueue.splice(0); for (const fn of qq) fn(); }
const lockTop = () => { const t = stack[stack.length - 1]; return t === 'popup' || t === 'sheet'; };      // under the lock screen only its own popup may close
function back() { if (navPending || (locked && !lockTop())) return; if (stack.length > 1) { navPending++; history.back(); } }
// close the viewer, whatever lies on top of it, exactly once
function closeView() { const go = () => { if (locked) { navQueue.push(go); return; } if (stack.includes('view') && !navPending) { navPending++; history.go(-(stack.length - stack.indexOf('view'))); } }; afterPop(go); }
function leave(name) {
  if (name === 'view') leaveView();
  if (name === 'sheet') sheetClosed();
  if (name === 'popup') { const p = popupState; popupState = null; if (p && p.after) setTimeout(p.after, 0); }
}
window.addEventListener('popstate', e => {
  const st = e.state; navPending = 0;
  if (/[#&](access_token|error|error_code|join)=/.test(location.hash)) { linkOpened(); return; }
  if (locked && !lockTop()) { history.pushState(histState(), ''); drainNav(); return; }
  if (!st || st.b !== BOOT_ID) {
    if (stack.length > 1) { leave(stack.pop()); history.replaceState(histState(), ''); applyStack(); renderAll(); }
    else history.back();
    drainNav(); return;
  }
  const depth = st.n || 1;
  if (depth > stack.length) { history.go(stack.length - depth); return; }
  while (stack.length > depth && stack.length > 1) leave(stack.pop());
  applyStack(); renderAll(); afterNav();
  drainNav();
});
function renderAll() { renderHome(); renderSyncLine(); if (current() === 'view') renderView(); }

// ---------- popups and toasts ----------
function popup(title, text, buttons, opts) {
  const lockOk = !!(opts && opts.lockOk);
  if ((locked && !lockOk) || passive) return;
  if (stack[stack.length - 1] === 'popup') return;
  const box = $('popupBox');
  box.innerHTML = '<h3>' + esc(title) + '</h3>' + (text ? '<p>' + esc(text) + '</p>' : '');
  for (const b of buttons) {
    const el = document.createElement('button'); el.textContent = b.label; el.className = b.cls || '';
    el.addEventListener('click', () => { if (popupState) popupState.after = (locked && !popupState.lockOk) ? null : (b.fn || null); back(); });
    box.appendChild(el);
  }
  popupState = { after: null, lockOk }; push('popup');
}
$('popup').addEventListener('click', e => { if (e.target === $('popup')) back(); });
let toastTimer = null, toastAction = null, heldToast = ''; const toastQueue = [];
function endToast(settle) { const t = $('toast'); clearTimeout(toastTimer); t.classList.remove('show'); const a = toastAction; toastAction = null; if (settle && a && a.expire) a.expire(); if (settle) flushToast(); }
function flushToast() { if (toastQueue.length && !toastAction && !$('toast').classList.contains('show')) toast(toastQueue.shift()); }
function toast(msg, action) {
  if (locked) { if (action) { if (action.expire) action.expire(); return; } heldToast = msg; return; }
  const t = $('toast');
  if (!action && toastAction) { if (!toastQueue.includes(msg)) toastQueue.push(msg); return; }
  clearTimeout(toastTimer);
  if (toastAction && toastAction.expire) toastAction.expire();
  toastAction = action || null;
  t.innerHTML = ''; t.appendChild(document.createTextNode(msg));
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.addEventListener('click', () => { endToast(false); action.fn(); flushToast(); }); t.appendChild(b); }
  t.classList.add('show');
  toastTimer = setTimeout(() => endToast(true), action ? 6000 : 2800);
}
