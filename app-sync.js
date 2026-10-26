'use strict';
/* Lieblingsbilder cloud sync: local-first, optional. Sign-in by e-mail link (no password), then an
   encryption password that never leaves the device. The cloud only ever receives ciphertext: one
   encrypted picture and one encrypted thumbnail per photo, and one entry whose details (file name,
   date taken, folder, caption) are encrypted too.

   Simpler than Snapdoc's because a picture never changes: the files of a photo are written once,
   under a random tag, and only the small entry (date, folder, caption, deletion) moves. What the
   server cannot do: read anything, change an entry (it is sealed with the cloud key together with
   its change time and delete flag), delete a photo on a device by forging a delete marker, or hand
   out another picture for an entry (the file carries the photo id and tag inside the encryption). */
const LINK_KEY = 'lb.linkAsked', OK_KEY = 'lb.lastOk', PKCE_KEY = 'lb.pkce';
let session = null, syncTimer = null, syncing = false, syncAgain = false, syncState = '', syncMsg = '';
let keyNeed = '', keyEnv = null, keyBusy = false;      // keyNeed: '' | 'create' | 'enter' | 'change'

const jwtPayload = t => JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
const newTag = () => uid().replace(/-/g, '').slice(0, 12);
const tick = () => { try { localStorage.setItem(TICK_KEY, Date.now() + '.' + Math.random()); } catch (e) {} };
const photoLabel = p => p.name || fmtDate(p.taken_at);
const myLabel = () => session && session.email ? session.email.split('@')[0] : '';      // how the others in a room see who added a picture
const spaceKey = (u, room) => room ? u + '/r/' + room : u;      // the pull bookmark of each space

// ---------- session (stored encrypted like everything else) ----------
async function loadSession() {
  session = null;
  try { const r = await idb.get('meta', 'session'); if (r) session = await Vault.openJson(r.data, 'lb|session'); } catch (e) { session = null; }
  if (session) { await Vault.loadCloudKey(session.uid).catch(() => {}); await Vault.loadRoomKeys(session.uid).catch(() => {}); }
  else if (account) await Vault.loadRoomKeys(account).catch(() => {});      // signed out: the rooms' pictures stay readable here
}
async function storeSession() {
  if (session) await idb.put('meta', { id: 'session', data: await Vault.sealJson(session, 'lb|session') }); else await idb.del('meta', 'session');
  tick();
}
// Tokens from a sign-in link. Accepted only when this browser asked for a link within the last
// hour, nobody is signed in, and the cloud confirms the token. Returns '' or the reason it was refused.
async function adoptLink(t) {
  let asked = 0; try { asked = +localStorage.getItem(LINK_KEY) || 0; localStorage.removeItem(LINK_KEY); } catch (e) {}
  if (!SYNC) return 'Cloud sync is not switched on in this version.';
  if (session) return 'A sign-in link was opened, but this device is already signed in. Sign out first to use another account.';
  if (!asked || Date.now() - asked > 3600000) return 'This sign-in link was not requested from this browser, or it is older than an hour. Request a new one in the menu.';
  if (t.code) {
    let verifier = ''; try { verifier = localStorage.getItem(PKCE_KEY) || ''; localStorage.removeItem(PKCE_KEY); } catch (e) {}
    if (!verifier) return 'This sign-in link was not requested from this browser. Request a new one in the menu.';
    try {
      const r = await fetch(SYNC.url + '/auth/v1/token?grant_type=pkce', { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ auth_code: t.code, code_verifier: verifier }) });
      if (!r.ok) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
      const j = await r.json(); if (!j.access_token || !j.refresh_token) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
      t = { access_token: j.access_token, refresh_token: j.refresh_token };
    } catch (e) { return 'The sign-in link could not be confirmed (no connection). Request a new one in the menu.'; }
  }
  let u, p;
  try {
    p = jwtPayload(t.access_token);
    const r = await fetch(SYNC.url + '/auth/v1/user', { credentials: 'omit', cache: 'no-store', headers: { apikey: SYNC.key, Authorization: 'Bearer ' + t.access_token } });
    if (!r.ok) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
    u = await r.json();
  } catch (e) { return 'The sign-in link could not be confirmed (no connection). Request a new one in the menu.'; }
  if (!u || !u.id || u.id !== p.sub) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
  session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: p.exp, email: u.email || '', uid: u.id };
  await storeSession();
  if (account !== session.uid) {                                    // first sign-in, or another account: this cloud knows nothing from here yet
    for (const p of photos) { p.srv = 0; p.up = false; p.tag = ''; p.pk = ''; p.seen = 0; p.cloudPurged = false; delete p.owed; }
    for (const p of photos) if (p.room) await purgePhotoData(p);
    photos = photos.filter(p => p.have && !p.room);                 // a photo that was only in the old cloud is not here any more; the old account's rooms go with it
    for (const r of rooms) await Vault.dropRoomKey(r.id).catch(() => {});
    rooms = []; if (space) { space = ''; try { localStorage.setItem('lb.space', ''); } catch (e) {} }
    snap = {}; for (const p of photos) snap[p.id] = sigOf(p);
    cursors[session.uid] = 0; try { localStorage.removeItem(OK_KEY); } catch (e) {}
    await Vault.dropCloudKey();
  }
  account = session.uid;
  persist();
  await Vault.loadCloudKey(session.uid).catch(() => {});
  await Vault.loadRoomKeys(session.uid).catch(() => {});
  return '';
}
// Signing out keeps every cloud mark: the account may come back, and then the cloud's newer
// entries must still win over what waited here.
async function signOut() {
  session = null; keyNeed = ''; keyEnv = null;
  await storeSession(); await Vault.dropCloudKey();
  setSyncState(''); renderAll();
}
async function ensureSession() {
  if (!SYNC || !session) return false;
  if (Date.now() / 1000 < session.expires_at - 60) return true;
  try {
    const r = await fetch(SYNC.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', credentials: 'omit', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) {
      const mine = session.access_token; await loadSession();
      if (session && session.access_token !== mine && Date.now() / 1000 < session.expires_at - 60) return true;
      setSyncState('error', 'The sign-in has expired. Sign out and sign in again.'); return false;
    }
    const t = await r.json(), p = jwtPayload(t.access_token);
    if (!session || p.sub !== session.uid) return false;
    session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: p.exp, email: session.email, uid: session.uid };
    await storeSession();
    return true;
  } catch (e) { return false; }
}
// One request to the cloud. During a sync pass it carries the pass's abort signal. A 401 from the
// data API refreshes the session once and repeats the request.
async function api(method, path, opts) {
  const r = await fetch(SYNC.url + path, { method, credentials: 'omit', cache: 'no-store', signal: (opts && opts.signal) || (syncing && syncCtl ? syncCtl.signal : undefined),
    headers: Object.assign({ apikey: SYNC.key, Authorization: 'Bearer ' + session.access_token }, (opts && opts.headers) || {}), body: opts && opts.body });
  if (r.status === 401 && session && !(opts && opts.retried) && !path.startsWith('/auth/')) {
    session.expires_at = 0;
    if (await ensureSession()) return api(method, path, Object.assign({}, opts, { retried: true }));
  }
  return r;
}
async function httpError(what, r) {
  let t = ''; try { t = await r.text(); } catch (e) {}
  if (/PGRST205|Bucket not found|schema cache|does not exist/i.test(t) || (r.status === 404 && /rest\/v1/.test(r.url || '')))
    return new Error('The cloud is not set up yet. Run supabase-schema.sql once in the Supabase SQL editor.');
  if (r.status === 413) return new Error(what + ' failed: the file is too large for the cloud.');
  return new Error(what + ' failed (' + r.status + ') ' + t.slice(0, 100));
}

// ---------- the encryption password ----------
async function ensureCloudKey() {
  if (Vault.hasCloudKey(session.uid)) return true;
  if (keyNeed) return false;
  const r = await api('GET', '/rest/v1/lb_keys?select=salt,iter,wrapped&user_id=eq.' + session.uid);
  if (!r.ok) throw await httpError('Checking the cloud', r);
  const rows = await r.json();
  keyEnv = rows[0] || null; keyNeed = keyEnv ? 'enter' : 'create';
  setSyncState('needkey');
  return false;
}
async function submitKey(pw, pw2, hint) {
  if (keyBusy) return;
  if (keyNeed !== 'enter') {
    if (pw.length < 10) { hint.textContent = 'Use at least 10 characters. A few random words work well.'; return; }
    if (pw !== pw2) { hint.textContent = 'The two entries differ.'; return; }
  } else if (!pw) return;
  keyBusy = true; hint.textContent = 'Working…';
  try {
    if (!(await ensureSession())) throw new Error('Not signed in.');
    const json = { 'Content-Type': 'application/json', Prefer: 'return=minimal' };
    if (keyNeed === 'create') {
      const ne = await Vault.newEnvelope(pw, session.uid);
      const r = await api('POST', '/rest/v1/lb_keys', { headers: json, body: JSON.stringify(Object.assign({ user_id: session.uid, created_at: Date.now() }, ne.env)) });
      if (r.status === 409) { keyNeed = ''; keyEnv = null; await ensureCloudKey(); toast('Another device set the password meanwhile. Enter that one.'); return; }
      if (!r.ok) throw await httpError('Saving the key', r);
      await ne.commit();
    } else if (keyNeed === 'change') {
      const env = await Vault.rewrapEnvelope(pw, session.uid);
      const r = await api('PATCH', '/rest/v1/lb_keys?user_id=eq.' + session.uid, { headers: json, body: JSON.stringify(env) });
      if (!r.ok) throw await httpError('Saving the key', r);
      keyNeed = ''; toast('Encryption password changed'); renderSyncBox(); return;
    } else await Vault.openEnvelope(keyEnv, pw, session.uid);
    keyNeed = ''; keyEnv = null; setSyncState(''); toast('Encrypted sync is on'); renderAll(); syncNow();
  } catch (e) { hint.textContent = errText(e); }
  finally { keyBusy = false; }
}

// ---------- sync loop ----------
function setSyncState(s, msg) { syncState = s; syncMsg = msg || ''; renderSyncLine(); renderSyncBox(); }
function scheduleSync() { if (!SYNC || !session || passive) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1500); }
let syncCtl = null; const upFail = new Map();
function abortSync() { if (syncCtl) syncCtl.abort(); }
function syncRetry() { upFail.clear(); if (syncState === 'error') setSyncState(''); syncNow(); }
const sealedMeta = p => { const obj = p.deleted ? { del: true, u: p.updated_at }
  : { name: p.name, type: p.type, w: p.w, h: p.h, size: p.size, taken_at: p.taken_at, created_at: p.created_at, folder: p.folder, caption: p.caption, star: !!p.star, tag: p.tag, pk: p.pk || '', by: p.room ? (p.by || myLabel()) : '', u: p.updated_at, del: false };
  return p.room ? Vault.rsealJson(p.room, obj, 'lb|meta|' + p.id) : Vault.csealJson(obj, 'lb|meta|' + p.id); };
const objName = (u, p, tag, thumb) => (p.room ? 'room/' + p.room : u) + '/' + p.id + '.' + tag + (thumb ? '.t' : '');
// One entry from the cloud, applied here.
async function applyRow(row, room) {
  const id = String(row.id), upd = +row.updated_at || 0, del = !!row.deleted, stamp = +row.synced_at || 0, who = String(row.user_id || '');
  room = room || '';
  const p0 = byId(id);
  if (!p0 && del) return 'skip';
  if (!row.meta) throw new Error('entry without a seal');
  const m = room ? await Vault.ropenJson(room, row.meta, 'lb|meta|' + id) : await Vault.copenJson(row.meta, 'lb|meta|' + id);     // throws unless it was sealed with the right key for this photo
  if (!!m.del !== del || +m.u !== upd) throw new Error('entry does not match its seal');
  if (!p0) {
    const n = migrate({ id, name: String(m.name || ''), type: safeType(m.type), w: +m.w || 0, h: +m.h || 0, size: +m.size || 0, taken_at: +m.taken_at || upd, created_at: +m.created_at || upd,
      folder: String(m.folder || ''), caption: String(m.caption || ''), star: !!m.star, deleted: false, updated_at: upd, srv: upd, seen: stamp, have: false, th: false, up: true, tag: String(m.tag || ''), pk: String(m.pk || ''), room, uid: who, by: String(m.by || '').slice(0, 40) });
    photos.push(n); snap[id] = sigOf(n); return 'new';
  }
  const p = p0, before = sigOf(p), wasDeleted = p.deleted;
  if (p.room !== room) return 'skip';                              // the same id in another space: never
  p.seen = stamp; if (who && !p.uid) p.uid = who; if (m.by) p.by = String(m.by).slice(0, 40);
  if (!del && !p.up && m.tag) { p.up = true; p.tag = String(m.tag); p.pk = String(m.pk || ''); }      // another device holds the files up already (or ours were accepted before the list was saved)
  if (!del && m.tag && p.tag && m.tag !== p.tag && p.up) { p.owed = p.owed || []; for (const n of [objName(session.uid, p, p.tag, false), objName(session.uid, p, p.tag, true)]) if (!p.owed.includes(n)) p.owed.push(n); p.tag = String(m.tag); p.pk = String(m.pk || ''); }      // two devices uploaded the same photo: one set of files is enough
  if (upd > p.updated_at) {                                       // the later change wins
    if (!del) { p.taken_at = +m.taken_at || p.taken_at; p.folder = String(m.folder || ''); p.caption = String(m.caption || ''); p.star = !!m.star; if (!p.name) p.name = String(m.name || ''); }
    p.deleted = del; p.updated_at = upd; p.srv = upd;
    if (del && !wasDeleted) await deletedElsewhere(p);
    else if (!del && wasDeleted) { p.cloudPurged = false; p.have = false; p.th = false; }      // it comes back on another device: fetched again from the cloud
  } else if (upd === p.updated_at) {
    if (!!m.del !== !!p.deleted) {                                 // two devices stamped alike: a delete beats a live change, on both of them
      if (del) { p.deleted = true; p.srv = upd; await deletedElsewhere(p); } else { p.srv = -1; p.cloudPurged = false; }
    } else if (!del && (p.folder !== String(m.folder || '') || p.caption !== String(m.caption || '') || p.taken_at !== +m.taken_at || !!p.star !== !!m.star)) {      // equal stamps, different fields: decided alike everywhere
      const mine = JSON.stringify([p.taken_at, p.folder, p.caption, !!p.star]), theirs = JSON.stringify([+m.taken_at, String(m.folder || ''), String(m.caption || ''), !!m.star]);
      if (theirs > mine) { p.taken_at = +m.taken_at || p.taken_at; p.folder = String(m.folder || ''); p.caption = String(m.caption || ''); p.star = !!m.star; p.srv = upd; } else p.srv = -1;
    } else p.srv = upd;
  } else if (del && !p.deleted) {                                   // our later change keeps the photo, but the other device removed the files
    if (p.have && isMine(p)) { p.up = false; p.tag = ''; p.pk = ''; p.srv = -1; }           // the picture here is the only one left: it goes up again under a fresh name and key
    else { p.deleted = true; p.updated_at = upd; p.srv = upd; await deletedElsewhere(p); }
  } else { p.srv = -1; if (p.deleted) p.cloudPurged = false; }    // the cloud holds an older entry than ours: send ours again
  if (snap[id] === before) snap[id] = sigOf(p);                   // a local change that is not saved yet is never swallowed
  return 'ok';
}
async function deletedElsewhere(p) {
  if (curPhoto === p) { toast('This photo was deleted on another device.'); closeView(); }
  selected.delete(p.id);
  await purgePhotoData(p);
}
const owedFail = new Map();
async function dropObj(u, p, name) {
  let ok = false;
  try { const r = await api('DELETE', '/storage/v1/object/lb/' + name); ok = r.ok || r.status === 404 || (r.status === 400 && /not.?found/i.test(await r.text().catch(() => ''))); } catch (e) {}
  if (ok) { owedFail.delete(name); if (p.owed) { p.owed = p.owed.filter(n => n !== name); if (!p.owed.length) delete p.owed; } }
  else { p.owed = p.owed || []; if (!p.owed.includes(name)) p.owed.push(name); const f = owedFail.get(name), n = (f ? f.n : 0) + 1; owedFail.set(name, { n, until: Date.now() + Math.min(3600000, 60000 * Math.pow(4, n - 1)) }); }
  return ok;
}
const entryDue = p => isMine(p) && (p.deleted ? ((p.srv !== 0 || p.up) && p.srv !== p.updated_at) : p.up && p.srv !== p.updated_at);
// One conditional write of the entry. true: accepted. false: another device wrote first (the entry is pulled again).
async function writeEntry(p, u) {
  const row = { id: p.id, user_id: u, room_id: p.room || null, updated_at: p.updated_at, deleted: !!p.deleted, meta: await sealedMeta(p) };
  const headers = { 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const r = p.seen ? await api('PATCH', '/rest/v1/lb_photos?select=synced_at&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(p.id) + '&synced_at=eq.' + p.seen, { headers, body: JSON.stringify(row) })
    : await api('POST', '/rest/v1/lb_photos?select=synced_at', { headers, body: JSON.stringify(row) });
  if (r.status === 409) return false;
  if (!r.ok) throw await httpError('Saving the list', r);
  const out = await r.json(); if (!Array.isArray(out) || !out.length) return false;
  p.seen = +out[0].synced_at || p.seen;
  if (p.updated_at === row.updated_at) p.srv = p.updated_at;
  return true;
}
async function pullOne(p, u) {
  const r = await api('GET', '/rest/v1/lb_photos?select=id,meta,updated_at,deleted,synced_at&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(p.id));
  if (!r.ok) throw await httpError('Loading the entry', r);
  const rows = await r.json(); if (!rows.length) { p.seen = 0; return; }
  p.seen = +rows[0].synced_at || 0;
  await applyRow(rows[0], p.room);
}
// The sealed file: a small header (photo id, tag, kind) in front of the bytes, so a file can never
// stand in for another one. Every photo has its own key (wrapped by the cloud key, carried in the
// entry), and the full picture and the thumbnail use two keys derived from it: a key that leaks
// opens one picture, and thumbnail keys open no full pictures.
const itemKey = p => { if (!p.pk) throw new Error('the key of this photo is missing'); return p.room ? Vault.runwrapItemKey(p.room, p.pk, 'lb|pk|' + p.id) : Vault.unwrapItemKey(p.pk, 'lb|pk|' + p.id); };
const haveKeyFor = p => !!session && (p.room ? Vault.hasRoomKey(p.room) : Vault.hasCloudKey(session.uid));
async function sealFile(p, raw, blob, kind) {
  const head = utf8(JSON.stringify({ id: p.id, tag: p.tag, k: kind })), bytes = new Uint8Array(await blob.arrayBuffer());
  const plain = new Uint8Array(4 + head.length + bytes.length);
  new DataView(plain.buffer).setUint32(0, head.length); plain.set(head, 4); plain.set(bytes, 4 + head.length);
  return Vault.sealItem(raw, kind, plain, 'lb|file|' + p.id + '|' + kind);
}
async function openFile(p, buf, kind) {
  const u8 = new Uint8Array(await Vault.openItem(await itemKey(p), kind, buf, 'lb|file|' + p.id + '|' + kind)), hl = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0);
  const h = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hl)));
  if (h.id !== p.id || h.k !== kind) throw new Error('the file does not belong to this photo');
  return new Blob([u8.subarray(4 + hl)], { type: kind === 't' ? 'image/jpeg' : p.type });
}
const progressMsg = (verb, i, n, p) => n > 1 ? verb + ' ' + i + ' of ' + n + ' · ' + Math.round((i - 1) / n * 100) + '% · ' + photoLabel(p) : verb + ' ' + photoLabel(p);
async function uploadPhoto(p, u) {
  const tag = newTag(), full = await imgGet(p.id, p.type); if (!full) { p.have = false; throw new Error('"' + photoLabel(p) + '" is not on this device any more.'); }
  if (full.size + 4096 > MAX_FILE) throw new Error('"' + photoLabel(p) + '" is larger than 50 MB and cannot be synced.');
  const was = p.tag, wasPk = p.pk, raw = Vault.newItemKey();
  p.tag = tag; p.pk = p.room ? await Vault.rwrapItemKey(p.room, raw, 'lb|pk|' + p.id) : await Vault.wrapItemKey(raw, 'lb|pk|' + p.id); if (!p.uid) p.uid = u;
  try {
    const put = async (blob, kind) => {
      const body = await sealFile(p, raw, blob, kind);
      const r = await api('POST', '/storage/v1/object/lb/' + objName(u, p, tag, kind === 't'), { headers: { 'Content-Type': 'application/octet-stream' }, body });
      if (!r.ok) throw await httpError('Uploading "' + photoLabel(p) + '"', r);
    };
    await put(full, 'f');
    const th = p.th ? await thumbGet(p.id) : null;
    if (th) await put(th, 't');
    p.up = true;
  } catch (e) { p.tag = was; p.pk = wasPk; if (session) { p.owed = p.owed || []; for (const n of [objName(u, p, tag, false), objName(u, p, tag, true)]) if (!p.owed.includes(n)) p.owed.push(n); } throw e; }
}
async function syncNow() {
  if (!SYNC || !session || !Vault.isOpen() || locked || passive) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; syncCtl = new AbortController();
  const ctl = syncCtl;
  try {
    if (!(await ensureSession())) return;
    if (!(await ensureCloudKey())) return;
    const u = session.uid, stop = () => !session || session.uid !== u || passive || locked || !isOwner() || ctl.signal.aborted;
    await syncRooms(u); if (stop()) return;
    await tryPendingJoin(); if (stop()) return;
    let unreadable = 0, moved = false;
    for (const sp of [''].concat(rooms.map(r => r.id))) {          // each space has its own bookmark, so a room joined later is read from its beginning
      if (sp && !Vault.hasRoomKey(sp)) continue;
      const ck = spaceKey(u, sp), cursor = cursors[ck] || 0, from = Math.max(0, cursor - 3000);
      let maxSeen = cursor, after = null;
      for (;;) {                                                  // pull what changed since the last visit; pages by stamp and id, never by offset
        const where = (sp ? '&room_id=eq.' + encodeURIComponent(sp) : '&room_id=is.null') + (after ? '&or=(synced_at.gt.' + after.s + ',and(synced_at.eq.' + after.s + ',id.gt.' + encodeURIComponent(after.id) + '))' : '&synced_at=gt.' + from);
        const r = await api('GET', '/rest/v1/lb_photos?select=id,user_id,meta,updated_at,deleted,synced_at' + where + '&order=synced_at.asc,id.asc&limit=500');
        if (!r.ok) throw await httpError('Loading the list', r);
        const rows = await r.json();
        for (const row of rows) { maxSeen = Math.max(maxSeen, +row.synced_at || 0); try { await applyRow(row, sp); } catch (e) { unreadable++; } }
        if (rows.length < 500) break;
        const last = rows[rows.length - 1]; after = { s: +last.synced_at || 0, id: String(last.id) };
      }
      if (stop()) return;
      if (maxSeen > cursor) { cursors[ck] = maxSeen; moved = true; }
    }
    if (moved && !(await persist())) throw new Error('The photo list could not be saved.');      // the bookmarks move only with the list
    renderAll();
    let upFailed = 0, upWhy = '';
    const needsUp = p => !p.deleted && p.have && !p.up && isMine(p) && (!p.room || Vault.hasRoomKey(p.room));
    const upTotal = photos.filter(needsUp).length; let upDone = 0;
    for (const p of photos.slice()) {                             // upload the pictures added here; one failing photo does not hold up the rest
      if (stop()) return;
      if (!needsUp(p)) continue;
      upDone++;
      const f = upFail.get(p.id);
      if (f && Date.now() < f.until) { upFailed++; upWhy = f.why; continue; }
      try {
        if (!(await ensureSession())) return;
        setSyncState('busy', progressMsg('Uploading', upDone, upTotal, p));
        await uploadPhoto(p, u);
        upFail.delete(p.id); persist();
      } catch (e) {
        upFailed++; upWhy = errText(e);
        if (e instanceof TypeError || navigator.onLine === false || ctl.signal.aborted) break;
        const n = (f ? f.n : 0) + 1;
        upFail.set(p.id, { n, why: upWhy, until: Date.now() + Math.min(3600000, 60000 * Math.pow(4, n - 1)) });
      }
    }
    if (stop()) return;
    let entryFailed = 0, entryWhy = '';
    for (const p of photos.slice()) {                             // write the entries that changed here, each one conditionally
      if (!entryDue(p)) continue;
      if (stop()) return;
      try {
        let done = await writeEntry(p, u);
        if (!done) { await pullOne(p, u); if (stop()) return; if (entryDue(p)) done = await writeEntry(p, u); }
      } catch (e) {
        entryFailed++; entryWhy = errText(e);
        if (e instanceof TypeError || navigator.onLine === false || ctl.signal.aborted) break;
      }
    }
    for (const p of photos) if (p.deleted && isMine(p) && !p.cloudPurged && (p.srv === p.updated_at || (!p.srv && !p.up))) {      // the files of a deleted photo go too; counted as done only when the cloud confirms
      if (stop()) return;
      try {
        if (p.srv) {
          const c = await api('GET', '/rest/v1/lb_photos?select=updated_at,deleted&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(p.id));
          if (!c.ok) continue;
          const cur = (await c.json())[0];
          if (cur && (!cur.deleted || +cur.updated_at !== p.updated_at)) continue;      // the cloud moved on meanwhile: not ours to remove
        }
        let gone = true;
        if (p.tag) for (const name of [objName(u, p, p.tag, false), objName(u, p, p.tag, true)]) { if (stop()) return; if (!(await dropObj(u, p, name))) gone = false; }
        if (gone) p.cloudPurged = true;
      } catch (e) {}
    }
    for (const p of photos) if (p.owed && p.owed.length) for (const name of p.owed.slice()) { if (stop()) return; const f = owedFail.get(name); if (f && Date.now() < f.until) continue; await dropObj(u, p, name); }
    if (stop()) return;
    try { localStorage.setItem(OK_KEY, String(Date.now())); } catch (e) {}
    if (!(await persist())) throw new Error('The photo list could not be saved.');
    renderAll();
    let failed = 0, why = '';
    const needsTh = p => !p.deleted && !p.th && p.up && haveKeyFor(p), needsFull = p => settings.keepAll && !p.deleted && !p.have && p.up && haveKeyFor(p);
    const thTotal = photos.filter(needsTh).length; let thDone = 0;
    for (const p of photos.slice()) {                             // the small pictures of photos added elsewhere
      if (stop()) return;
      if (!needsTh(p)) continue;
      thDone++;
      try { if (!(await ensureSession())) return; setSyncState('busy', progressMsg('Fetching', thDone, thTotal, p)); await fetchThumb(p); } catch (e) { failed++; why = errText(e); }
    }
    const fTotal = photos.filter(needsFull).length; let fDone = 0;
    for (const p of photos.slice()) {                             // and, if wished, every full picture
      if (stop()) return;
      if (!needsFull(p)) continue;
      fDone++;
      try { if (!(await ensureSession())) return; await fetchFull(p, progressMsg('Fetching', fDone, fTotal, p)); } catch (e) { failed++; why = errText(e); }
    }
    if (unreadable) throw new Error(unreadable + (unreadable === 1 ? ' entry' : ' entries') + ' in the cloud cannot be opened with the key on this device.');
    if (upFailed) throw new Error(upFailed === 1 ? upWhy : upFailed + ' photos could not be uploaded. Last reason: ' + upWhy);
    if (entryFailed) throw new Error(entryFailed === 1 ? entryWhy : entryFailed + ' entries could not be saved. Last reason: ' + entryWhy);
    if (failed) throw new Error('Could not fetch ' + failed + (failed === 1 ? ' photo: ' : ' photos: ') + why);
    setSyncState('ok');
  } catch (e) {
    if (session && !passive && !ctl.signal.aborted) setSyncState(navigator.onLine === false ? 'offline' : 'error', errText(e));
  } finally { syncing = false; if (syncCtl === ctl) syncCtl = null; if (syncAgain) { syncAgain = false; scheduleSync(); } afterNav(); }
}
// A download outside the pass (the viewer, a share) carries no pass signal. Two callers for the
// same picture share one download.
const fetchJobs = new Map();
function fetchShared(key, fn) { if (fetchJobs.has(key)) return fetchJobs.get(key); const j = fn().finally(() => fetchJobs.delete(key)); fetchJobs.set(key, j); return j; }
async function fetchThumb(p) {
  if (!haveKeyFor(p) || !p.up || !p.tag || p.deleted) return null;
  return fetchShared('t' + p.id, async () => {
    const u = session.uid, r = await api('GET', '/storage/v1/object/authenticated/lb/' + objName(u, p, p.tag, true));
    if (r.status === 404 || r.status === 400) {                    // a photo this browser could not make a thumbnail of: the full picture stands in
      const b = await fetchFull(p); if (!b) return null;
      const t = await makeThumb(b); if (!t) return null;
      if (!p.w && t.w) { p.w = t.w; p.h = t.h; }
      await thumbPut(p.id, t.blob); p.th = true; persist(); return t.blob;
    }
    if (!r.ok) throw await httpError('Fetching the small picture', r);
    const blob = await openFile(p, await r.arrayBuffer(), 't');
    if (p.deleted || passive) return blob;
    await thumbPut(p.id, blob); p.th = true; persist(); renderHome();
    return blob;
  });
}
async function fetchFull(p, msg) {
  if (!haveKeyFor(p)) throw new Error(session ? 'The key for this ' + (p.room ? 'room' : 'photo') + ' is not on this device yet.' : 'Not signed in.');
  if (!p.up || !p.tag) throw new Error('This photo has not reached the cloud yet.');
  return fetchShared('f' + p.id, async () => {
    const u = session.uid; if (msg) setSyncState('busy', msg);
    const r = await api('GET', '/storage/v1/object/authenticated/lb/' + objName(u, p, p.tag, false));
    if (!r.ok) throw await httpError('Fetching "' + photoLabel(p) + '"', r);
    const blob = await openFile(p, await r.arrayBuffer(), 'f');
    if (p.deleted || passive) return blob;
    await imgPut(p.id, blob); p.have = true; persist();
    return blob;
  });
}
// The link is requested with a PKCE challenge: it then carries a one-time code that only this
// browser (holding the verifier) can exchange, so a copy of the address in a history is worthless.
async function sendMagicLink(email) {
  const redirect = encodeURIComponent(location.origin + location.pathname);
  const raw = crypto.getRandomValues(new Uint8Array(48)); let verifier = ''; for (const b of raw) verifier += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66];
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode.apply(null, digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try { localStorage.setItem(PKCE_KEY, verifier); } catch (e) { return { ok: false, msg: 'This browser blocks local storage; sign-in is not possible here.' }; }
  let r;
  try { r = await fetch(SYNC.url + '/auth/v1/otp?redirect_to=' + redirect, { method: 'POST', credentials: 'omit', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: true, code_challenge: challenge, code_challenge_method: 's256' }) }); }
  catch (e) { return { ok: false, msg: navigator.onLine === false ? 'No internet connection. Try again when you are online.' : 'The cloud could not be reached. Try again later.' }; }
  if (r.ok) { try { localStorage.setItem(LINK_KEY, String(Date.now())); } catch (e) {} return { ok: true }; }
  let msg = 'Sending failed. Try again later.';
  if (r.status === 429) msg = 'Too many sign-in mails in a short time. Try again in about an hour.';
  else { try { const j = await r.json(); if (j.msg || j.error_description) msg = 'Sending failed: ' + (j.msg || j.error_description); } catch (e) {} }
  return { ok: false, msg };
}

// ---------- status line and the sync part of the menu ----------
function lastOkLabel() {
  const okAt = +localStorage.getItem(OK_KEY) || 0; if (!okAt) return 'never';
  const m = Math.floor((Date.now() - okAt) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ago';
}
function renderSyncLine() {
  const el = $('syncline'); el.className = 'subline';
  if (!SYNC) { el.textContent = 'Encrypted on this device'; return; }
  if (!session) { el.textContent = 'Encrypted on this device · tap to add cloud sync'; return; }
  if (!Vault.hasCloudKey(session.uid)) {
    el.className = 'subline err';
    el.textContent = syncState === 'error' ? '⚠ ' + syncMsg : keyNeed ? 'Cloud sync is waiting for your encryption password · tap here' : 'Connecting to the cloud…';
    return;
  }
  if (syncState === 'error') { el.className = 'subline err'; el.textContent = '⚠ Sync failed · last success ' + lastOkLabel() + ' · tap for details'; return; }
  if (syncState === 'offline') { el.textContent = '⏸ Offline · last synced ' + lastOkLabel(); return; }
  if (syncState === 'busy') { el.textContent = '↻ ' + syncMsg + '…'; return; }
  const waiting = photos.filter(p => !p.deleted && p.have && !p.up).length;
  el.textContent = +localStorage.getItem(OK_KEY) ? '✓ Encrypted sync on · last synced ' + lastOkLabel() + (waiting ? ' · ' + waiting + ' waiting' : '') : 'Connecting to the cloud…';
}
$('syncline').addEventListener('click', () => openSheet());
function renderSyncBox() {
  const box = $('syncBox'); if (!box) return;
  const hasKey = !!session && Vault.hasCloudKey(session.uid);
  const mode = !SYNC ? 'none' : !session ? 'signin' : keyNeed === 'change' ? 'change' : hasKey ? 'on' : keyNeed || 'check';
  if (box.dataset.mode === mode && ['signin', 'create', 'enter', 'change'].includes(mode)) return;      // never wipe a form someone is typing in
  box.dataset.mode = mode;
  const signOutBtn = '<button id="signOut" class="btn quiet">Sign out on this device</button>';
  if (mode === 'none') { box.innerHTML = '<p>Cloud sync is not switched on in this version yet. Your photos stay on this device, encrypted.</p>'; return; }
  if (mode === 'signin') {
    box.innerHTML = '<p>Keep an encrypted copy of your photos in your own cloud account and see them on a second phone or the PC. Sign in by e-mail, without a password.</p>' +
      '<input id="email" type="email" placeholder="you@example.com" autocomplete="email"><button id="sendLink" class="btn primary">Send sign-in link</button><div class="hint" id="authHint"></div>';
    let sending = false;
    $('sendLink').addEventListener('click', async () => {
      const email = $('email').value.trim(), hint = $('authHint');
      if (sending) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { hint.textContent = 'Please enter a valid e-mail address.'; return; }
      sending = true; hint.textContent = 'Sending…';
      try { const r = await sendMagicLink(email); hint.textContent = r.ok ? 'The mail is on its way. Open the link in it in this same browser on this device; the app continues by itself.' : r.msg; }
      catch (e) { hint.textContent = 'Sending failed: ' + errText(e); } finally { sending = false; }
    });
    return;
  }
  if (mode === 'check') {
    box.innerHTML = '<div class="statecard' + (syncState === 'error' ? ' err' : '') + '"><div class="t">Signed in as ' + esc(session.email || '') + '</div><div class="s">' + (syncState === 'error' ? esc(syncMsg) : 'Checking the cloud…') + '</div></div>' +
      '<button id="syncBtn" class="btn">Try again</button>' + signOutBtn;
  } else if (mode === 'create' || mode === 'change') {
    box.innerHTML = '<p>' + (mode === 'create' ? '<b>Choose an encryption password.</b> Your photos are encrypted on this phone before they are uploaded, so nobody else can see them, not even the cloud provider.' : '<b>New encryption password.</b> Other devices ask for it the next time they set up sync.') +
      ' It is needed once on each new device. It cannot be reset: without it the cloud copies cannot be opened.</p>' +
      '<input id="pw1" type="password" autocomplete="new-password" placeholder="Encryption password"><input id="pw2" type="password" autocomplete="new-password" placeholder="Repeat">' +
      '<button id="pwSuggest" class="btn">Suggest a strong one</button><button id="pwGo" class="btn primary">' + (mode === 'create' ? 'Turn on encrypted sync' : 'Change password') + '</button><div class="hint" id="pwHint"></div>' +
      (mode === 'create' ? signOutBtn : '<button id="pwCancel" class="btn quiet">Cancel</button>');
    $('pwSuggest').addEventListener('click', () => { const s = Vault.suggestPassword(); for (const id of ['pw1', 'pw2']) { $(id).type = 'text'; $(id).value = s; } $('pwHint').textContent = 'Save it in your password manager now, before you continue.'; });
    $('pwGo').addEventListener('click', () => submitKey($('pw1').value, $('pw2').value, $('pwHint')));
    if (mode === 'change') $('pwCancel').addEventListener('click', () => { keyNeed = ''; renderSyncBox(); });
  } else if (mode === 'enter') {
    box.innerHTML = '<p><b>Enter your encryption password.</b> It is the one you chose when you first turned on sync. It unlocks your photos on this device and is never sent anywhere.</p>' +
      '<input id="pw1" type="password" autocomplete="current-password" placeholder="Encryption password"><button id="pwGo" class="btn primary">Unlock sync</button><div class="hint" id="pwHint"></div>' + signOutBtn;
    $('pwGo').addEventListener('click', () => submitKey($('pw1').value, '', $('pwHint')));
    $('pw1').addEventListener('keydown', e => { if (e.key === 'Enter') submitKey($('pw1').value, '', $('pwHint')); });
  } else {
    const err = syncState === 'error', off = syncState === 'offline';
    const waiting = photos.filter(p => !p.deleted && ((p.have && !p.up) || p.srv !== p.updated_at)).length;
    box.innerHTML = '<div class="statecard' + (err ? ' err' : '') + '"><div class="t">' + (err ? '⚠ Sync has a problem' : off ? '⏸ Offline' : syncState === 'busy' ? '↻ ' + esc(syncMsg) : '✓ Encrypted sync on') + '</div>' +
      '<div class="s">Signed in as ' + esc(session.email || '') + '<br>Last synced ' + lastOkLabel() + (waiting ? ' · ' + waiting + ' waiting' : '') + (err && syncMsg ? '<br>' + esc(syncMsg) : '') + '</div></div>' +
      '<button id="syncBtn" class="btn">Sync now</button><button id="pwChange" class="btn quiet">Change encryption password</button>' + signOutBtn;
    $('pwChange').addEventListener('click', () => { keyNeed = 'change'; renderSyncBox(); });
  }
  if ($('syncBtn')) $('syncBtn').addEventListener('click', syncRetry);
  if ($('signOut')) $('signOut').addEventListener('click', () => popup('Sign out on this device?', 'Your photos stay on this phone. They stop syncing until you sign in and enter your encryption password again.', [{ label: 'Sign out', fn: signOut }, { label: 'Stay signed in', cls: 'quiet' }]));
}

// ---------- rooms: shared spaces ----------
// A room is a random key that its members hold. The invite link carries the room id, an invite
// token (the server knows its hash and admits whoever presents it) and the key, in the fragment,
// which never reaches the server. Each member keeps the key wrapped with their own cloud key in
// their member row, so their other devices find the room after the encryption password.
const hexOf = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async s => hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s))));
const roomReady = () => !!session && Vault.hasCloudKey(session.uid);
function inviteLink(r) { if (!r || !r.token || !Vault.hasRoomKey(r.id)) return ''; return location.origin + location.pathname + '#join=' + r.id + '.' + r.token + '.' + Vault.roomKeyB64(r.id); }
function parseJoin(s) { const m = /^#?join=([A-Za-z0-9-]{8,64})\.([a-f0-9]{16,64})\.([A-Za-z0-9+/=]{40,48})$/.exec(String(s || '').trim().replace(/^.*#/, '#')); return m ? { id: m[1], token: m[2], key: m[3] } : null; }
async function createRoom(name) {
  if (!roomReady()) throw new Error('Sign in and set the encryption password first (menu).');
  if (!(await ensureSession())) throw new Error('Not signed in.');
  const u = session.uid, id = uid(), token = hexOf(crypto.getRandomValues(new Uint8Array(16))), now = Date.now();
  await Vault.keepRoomKey(id, Vault.newRoomKey(), u);
  try {
    const json = { 'Content-Type': 'application/json', Prefer: 'return=minimal' };
    const info = await Vault.rsealJson(id, { name, token }, 'lb|roominfo|' + id);
    let r = await api('POST', '/rest/v1/lb_rooms', { headers: json, body: JSON.stringify({ id, created_by: u, info, invite_hash: await sha256hex(token), created_at: now }) });
    if (!r.ok) throw await httpError('Creating the room', r);
    r = await api('POST', '/rest/v1/lb_room_members', { headers: json, body: JSON.stringify({ room_id: id, user_id: u, wrapped: await Vault.wrapRoomKey(id, u), joined_at: now }) });
    if (!r.ok) throw await httpError('Joining the room', r);
  } catch (e) { await Vault.dropRoomKey(id).catch(() => {}); throw e; }
  rooms.push({ id, name, token, created_by: u, joined_at: now, members: 1 });
  cursors[spaceKey(u, id)] = 0; persist();
  return id;
}
async function joinRoom(j) {
  if (!roomReady()) { await setPendingJoin(j); return 'later'; }
  if (!(await ensureSession())) throw new Error('Not signed in.');
  const u = session.uid;
  if (roomById(j.id)) return 'already';
  await Vault.keepRoomKey(j.id, Vault.unb64(j.key), u);
  try {
    const r = await api('POST', '/rest/v1/rpc/lb_join_room', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rid: j.id, token: j.token, wrapped_key: await Vault.wrapRoomKey(j.id, u) }) });
    if (!r.ok) throw await httpError('Joining the room', r);
    if ((await r.json()) !== true) throw new Error('This invite link is not valid any more.');
    const rr = await api('GET', '/rest/v1/lb_rooms?select=id,info,created_by&id=eq.' + encodeURIComponent(j.id));
    if (!rr.ok) throw await httpError('Reading the room', rr);
    const row = (await rr.json())[0]; if (!row) throw new Error('The room is gone.');
    const info = await Vault.ropenJson(j.id, row.info, 'lb|roominfo|' + j.id);
    rooms.push({ id: j.id, name: String(info.name || 'Room').slice(0, 40), token: String(info.token || ''), created_by: row.created_by, joined_at: Date.now(), members: 0 });
  } catch (e) { await Vault.dropRoomKey(j.id).catch(() => {}); throw e; }
  cursors[spaceKey(u, j.id)] = 0; persist();
  return 'joined';
}
async function leaveRoom(id) {
  const r = roomById(id); if (!r) return;
  try { if (session && await ensureSession()) { const d = await api('DELETE', '/rest/v1/lb_room_members?room_id=eq.' + encodeURIComponent(id) + '&user_id=eq.' + session.uid); if (!d.ok) throw await httpError('Leaving the room', d); } }
  catch (e) { toast('Could not leave: ' + errText(e)); return; }
  await removeRoomLocal(id); toast('You left "' + (r.name || 'Room') + '".');
}
async function removeRoomLocal(id) {
  for (const p of photos) if (p.room === id) await purgePhotoData(p);
  photos = photos.filter(p => p.room !== id); snap = {}; for (const p of photos) snap[p.id] = sigOf(p);
  rooms = rooms.filter(r => r.id !== id);
  for (const k of Object.keys(cursors)) if (k.endsWith('/r/' + id)) delete cursors[k];
  await Vault.dropRoomKey(id).catch(() => {});
  if (space === id) setSpace(''); else renderAll();
  persist();
}
async function renameRoom(r, name) {
  try {
    if (!(await ensureSession())) throw new Error('Not signed in.');
    const info = await Vault.rsealJson(r.id, { name, token: r.token }, 'lb|roominfo|' + r.id);
    const x = await api('PATCH', '/rest/v1/lb_rooms?id=eq.' + encodeURIComponent(r.id), { headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ info }) });
    if (!x.ok) throw await httpError('Renaming', x);
    r.name = name; persist(); renderAll(); toast('Renamed');
  } catch (e) { toast('Could not rename: ' + errText(e)); }
}
// the rooms this account is in, their names and keys; rooms left elsewhere go
async function syncRooms(u) {
  if (!Vault.hasCloudKey(u)) return;
  const r = await api('GET', '/rest/v1/lb_room_members?select=room_id,user_id,wrapped,joined_at');
  if (!r.ok) throw await httpError('Loading the rooms', r);
  const all = await r.json(), mine = all.filter(x => x.user_id === u), ids = new Set(mine.map(x => x.room_id));
  for (const rm of rooms.slice()) if (!ids.has(rm.id)) await removeRoomLocal(rm.id);
  let changed = false;
  if (mine.length) {
    const rr = await api('GET', '/rest/v1/lb_rooms?select=id,info,created_by');
    const rowsById = {}; if (rr.ok) for (const row of await rr.json()) rowsById[row.id] = row;
    for (const mb of mine) {
      try {
        if (!Vault.hasRoomKey(mb.room_id)) { if (!mb.wrapped) continue; await Vault.keepRoomKey(mb.room_id, await Vault.unwrapRoomKey(mb.wrapped, u, mb.room_id), u); }
        const row = rowsById[mb.room_id]; let info = null;
        if (row && row.info) { try { info = await Vault.ropenJson(mb.room_id, row.info, 'lb|roominfo|' + mb.room_id); } catch (e) {} }
        let rm = roomById(mb.room_id);
        if (!rm) { rm = { id: mb.room_id, name: 'Room', token: '', created_by: row ? row.created_by : '', joined_at: +mb.joined_at || Date.now() }; rooms.push(rm); cursors[spaceKey(u, rm.id)] = cursors[spaceKey(u, rm.id)] || 0; changed = true; }
        if (info) { const n = String(info.name || 'Room').slice(0, 40), t = String(info.token || ''); if (rm.name !== n || rm.token !== t) { rm.name = n; rm.token = t; changed = true; } }
        const cnt = all.filter(x => x.room_id === mb.room_id).length; if (rm.members !== cnt) { rm.members = cnt; changed = true; }
      } catch (e) {}
    }
  }
  if (changed) { persist(); renderAll(); }
}
// a join from a link that arrived before sign-in or the encryption password: kept sealed, done later
async function setPendingJoin(j) { try { await idb.put('meta', { id: 'join', data: await Vault.sealJson(j, 'lb|join') }); } catch (e) {} }
async function tryPendingJoin() {
  if (!roomReady()) return;
  let j = null; try { const r = await idb.get('meta', 'join'); if (r) j = await Vault.openJson(r.data, 'lb|join'); } catch (e) {}
  if (!j) return;
  try { const res = await joinRoom(j); if (res === 'later') return; await idb.del('meta', 'join').catch(() => {}); if (res === 'joined') { toast('You joined "' + spaceName(j.id) + '".'); setSpace(j.id); } }
  catch (e) { await idb.del('meta', 'join').catch(() => {}); toast('Could not join the room: ' + errText(e)); }
}
