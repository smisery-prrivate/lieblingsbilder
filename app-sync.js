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
const spaceKey = (u, folder) => folder ? u + '/f/' + folder : u;      // the pull bookmark of each compartment (no folder, or one folder)
const FOLDERS_KEY = u => u + '/folders';

// ---------- session (stored encrypted like everything else) ----------
async function loadSession() {
  session = null;
  try { const r = await idb.get('meta', 'session'); if (r) session = await Vault.openJson(r.data, 'lb|session'); } catch (e) { session = null; }
  if (session) { await Vault.loadCloudKey(session.uid).catch(() => {}); await Vault.loadFolderKeys(session.uid).catch(() => {}); }
  else if (account) await Vault.loadFolderKeys(account).catch(() => {});      // signed out: the folders' pictures stay readable here
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
    photos = photos.filter(p => p.have);                            // a photo that was only in the old cloud is not here any more
    for (const f of folders) { f.srv = 0; f.seen = 0; }               // the folders and their keys stay: they are made here and go up again under the new account
    snap = {}; for (const p of photos) snap[p.id] = sigOf(p); fsnap = {}; for (const f of folders) fsnap[f.id] = fsigOf(f);
    cursors[session.uid] = 0; try { localStorage.removeItem(OK_KEY); } catch (e) {}
    await Vault.dropCloudKey();
  }
  account = session.uid;
  persist();
  await Vault.loadCloudKey(session.uid).catch(() => {});
  await Vault.loadFolderKeys(session.uid).catch(() => {});
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
  : { name: p.name, type: p.type, w: p.w, h: p.h, size: p.size, taken_at: p.taken_at, created_at: p.created_at, folder: p.folder, caption: p.caption, star: !!p.star, tag: p.tag, pk: p.pk || '', st: p.st || 'sb', df: p.df || '', dt: p.dt || '', u: p.updated_at, del: false };
  return p.folder ? Vault.fsealJson(p.folder, obj, 'lb|meta|' + p.id) : Vault.csealJson(obj, 'lb|meta|' + p.id); };
const objName = (u, p, tag, thumb) => u + '/' + p.id + '.' + tag + (thumb ? '.t' : '');
// One entry from the cloud, applied here.
async function applyRow(row, folder) {
  const id = String(row.id), upd = +row.updated_at || 0, del = !!row.deleted, stamp = +row.synced_at || 0;
  folder = folder || '';
  const p0 = byId(id);
  if (!p0 && del) return 'skip';
  if (!row.meta) throw new Error('entry without a seal');
  const m = folder ? await Vault.fopenJson(folder, row.meta, 'lb|meta|' + id) : await Vault.copenJson(row.meta, 'lb|meta|' + id);     // throws unless it was sealed with the right key for this photo
  if (!!m.del !== del || +m.u !== upd) throw new Error('entry does not match its seal');
  if (!p0) {
    const n = migrate({ id, name: String(m.name || ''), type: safeType(m.type), w: +m.w || 0, h: +m.h || 0, size: +m.size || 0, taken_at: +m.taken_at || upd, created_at: +m.created_at || upd,
      caption: String(m.caption || ''), star: !!m.star, deleted: false, updated_at: upd, srv: upd, seen: stamp, have: false, th: false, up: true, tag: String(m.tag || ''), pk: String(m.pk || ''), st: m.st === 'gd' ? 'gd' : 'sb', df: String(m.df || ''), dt: String(m.dt || ''), folder });
    photos.push(n); snap[id] = sigOf(n); return 'new';
  }
  const p = p0, before = sigOf(p), wasDeleted = p.deleted;
  if (upd < p.updated_at && folder !== p.folder) { p.seen = stamp; p.srv = -1; if (snap[id] === before) snap[id] = sigOf(p); return 'ok'; }      // an older entry from the folder it was moved out of: ours goes up again
  p.seen = stamp;
  if (!del && !p.up && m.tag) { p.up = true; p.tag = String(m.tag); p.pk = String(m.pk || ''); p.st = m.st === 'gd' ? 'gd' : 'sb'; p.df = String(m.df || ''); p.dt = String(m.dt || ''); }      // another device holds the files up already (or ours were accepted before the list was saved)
  if (!del && m.tag && p.tag && m.tag !== p.tag && p.up) { p.owed = p.owed || []; for (const n of [objName(session.uid, p, p.tag, false), objName(session.uid, p, p.tag, true)]) if (!p.owed.includes(n)) p.owed.push(n); p.tag = String(m.tag); p.pk = String(m.pk || ''); p.st = m.st === 'gd' ? 'gd' : 'sb'; p.df = String(m.df || ''); p.dt = String(m.dt || ''); }      // two devices uploaded the same photo: one set of files is enough
  if (upd > p.updated_at) {                                       // the later change wins
    if (!del) { p.taken_at = +m.taken_at || p.taken_at; p.folder = folder; p.caption = String(m.caption || ''); p.star = !!m.star; if (!p.name) p.name = String(m.name || ''); if (m.tag && String(m.tag) === p.tag) { if (m.pk) p.pk = String(m.pk); if (m.st) { p.st = m.st === 'gd' ? 'gd' : 'sb'; p.df = String(m.df || ''); p.dt = String(m.dt || ''); } } }      // moved to another folder (the key rewrapped) or the files moved (to Drive) on another device
    p.deleted = del; p.updated_at = upd; p.srv = upd;
    if (del && !wasDeleted) await deletedElsewhere(p);
    else if (!del && wasDeleted) { p.cloudPurged = false; p.have = false; p.th = false; }      // it comes back on another device: fetched again from the cloud
  } else if (upd === p.updated_at) {
    if (!!m.del !== !!p.deleted) {                                 // two devices stamped alike: a delete beats a live change, on both of them
      if (del) { p.deleted = true; p.srv = upd; await deletedElsewhere(p); } else { p.srv = -1; p.cloudPurged = false; }
    } else if (!del && (p.folder !== folder || p.caption !== String(m.caption || '') || p.taken_at !== +m.taken_at || !!p.star !== !!m.star)) {      // equal stamps, different fields: decided alike everywhere
      const mine = JSON.stringify([p.taken_at, p.folder, p.caption, !!p.star]), theirs = JSON.stringify([+m.taken_at, folder, String(m.caption || ''), !!m.star]);
      if (theirs > mine) { p.taken_at = +m.taken_at || p.taken_at; p.folder = folder; if (m.pk) p.pk = String(m.pk); p.caption = String(m.caption || ''); p.star = !!m.star; p.srv = upd; } else p.srv = -1;
    } else p.srv = upd;
  } else if (del && !p.deleted) {                                   // our later change keeps the photo, but the other device removed the files
    if (p.have) { p.up = false; p.tag = ''; p.pk = ''; p.st = 'sb'; p.df = ''; p.dt = ''; p.srv = -1; }           // the picture here is the only one left: it goes up again under a fresh name and key
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
  if (name.startsWith('gd:')) { try { ok = !!(DRIVE && drive && driveTokenOk()) && await driveTrash(name.slice(3)); } catch (e) { if (e && e.reconnect) await driveLost(); } }
  else try { const r = await api('DELETE', '/storage/v1/object/lb/' + name); ok = r.ok || r.status === 404 || (r.status === 400 && /not.?found/i.test(await r.text().catch(() => ''))); } catch (e) {}
  if (ok) { owedFail.delete(name); if (p.owed) { p.owed = p.owed.filter(n => n !== name); if (!p.owed.length) delete p.owed; } }
  else { p.owed = p.owed || []; if (!p.owed.includes(name)) p.owed.push(name); const f = owedFail.get(name), n = (f ? f.n : 0) + 1; owedFail.set(name, { n, until: Date.now() + Math.min(3600000, 60000 * Math.pow(4, n - 1)) }); }
  return ok;
}
const entryDue = p => p.deleted ? ((p.srv !== 0 || p.up) && p.srv !== p.updated_at) : p.up && p.srv !== p.updated_at;
// One conditional write of the entry. true: accepted. false: another device wrote first (the entry is pulled again).
async function writeEntry(p, u) {
  const row = { id: p.id, user_id: u, folder_id: p.folder || null, updated_at: p.updated_at, deleted: !!p.deleted, meta: await sealedMeta(p) };
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
  await applyRow(rows[0], String(rows[0].folder_id || ''));
}
// The sealed file: a small header (photo id, tag, kind) in front of the bytes, so a file can never
// stand in for another one. Every photo has its own key (wrapped by the cloud key, carried in the
// entry), and the full picture and the thumbnail use two keys derived from it: a key that leaks
// opens one picture, and thumbnail keys open no full pictures.
const itemKey = p => { if (!p.pk) throw new Error('the key of this photo is missing'); return p.folder ? Vault.funwrapItemKey(p.folder, p.pk, 'lb|pk|' + p.id) : Vault.unwrapItemKey(p.pk, 'lb|pk|' + p.id); };
const haveKeyFor = p => !!session && (p.folder ? Vault.hasFolderKey(p.folder) : Vault.hasCloudKey(session.uid));
const wrapItemKeyFor = (p, raw) => p.folder ? Vault.fwrapItemKey(p.folder, raw, 'lb|pk|' + p.id) : Vault.wrapItemKey(raw, 'lb|pk|' + p.id);
// into another folder (or none): the photo's small key is rewrapped under the new compartment's key; the files stay
async function moveToFolder(p, fid) {
  if (p.folder === fid) return;
  if (p.pk) { if (!haveKeyFor(p)) throw new Error('The key of its current folder is not on this device.'); const raw = await itemKey(p); p.folder = fid; p.pk = await wrapItemKeyFor(p, raw); }
  else p.folder = fid;
}
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
// a file of a photo that lives in Google Drive: this device needs the same Google account connected
async function driveGet(id) {
  if (!DRIVE) throw new Error('This photo lives in Google Drive, which is not set up in this version.');
  if (!drive) throw new Error('This photo lives in Google Drive. Connect the same Google account in the menu to see it.');
  if (!driveTokenOk()) { setDriveState('reconnect', ''); throw new Error('Google Drive needs a tap to reconnect (menu).'); }
  if (!id) throw new Error('This photo has no file in Drive.');
  try { return await driveDownload(id); } catch (e) { if (e && e.reconnect) { await driveLost(); throw new Error('Google Drive needs a tap to reconnect (menu).'); } throw e; }
}
const progressMsg = (verb, i, n, p) => n > 1 ? verb + ' ' + i + ' of ' + n + ' · ' + Math.round((i - 1) / n * 100) + '% · ' + photoLabel(p) : verb + ' ' + photoLabel(p);
async function uploadPhoto(p, u) {
  const tag = newTag(), full = await imgGet(p.id, p.type); if (!full) { p.have = false; throw new Error('"' + photoLabel(p) + '" is not on this device any more.'); }
  if (full.size + 4096 > MAX_FILE) throw new Error('"' + photoLabel(p) + '" is larger than 50 MB and cannot be synced.');
  const was = p.tag, wasPk = p.pk, raw = Vault.newItemKey(), toDrive = driveWanted(p), made = [];
  p.tag = tag; p.pk = await wrapItemKeyFor(p, raw);
  try {
    const put = async (blob, kind) => {
      const body = await sealFile(p, raw, blob, kind);
      if (toDrive) { const id = await driveUpload(p, p.id + '.' + tag + (kind === 't' ? '.t' : ''), kind, new Blob([body], { type: 'application/octet-stream' })); made.push(id); return id; }
      const r = await api('POST', '/storage/v1/object/lb/' + objName(u, p, tag, kind === 't'), { headers: { 'Content-Type': 'application/octet-stream' }, body });
      if (!r.ok) throw await httpError('Uploading "' + photoLabel(p) + '"', r);
      return '';
    };
    const df = await put(full, 'f');
    const th = p.th ? await thumbGet(p.id) : null;
    const dt = th ? await put(th, 't') : '';
    p.st = toDrive ? 'gd' : 'sb'; p.df = df; p.dt = dt; p.up = true;
  } catch (e) {
    p.tag = was; p.pk = wasPk;
    if (e && e.reconnect) await driveLost();
    p.owed = p.owed || [];
    for (const n of toDrive ? made.map(id => 'gd:' + id) : [objName(u, p, tag, false), objName(u, p, tag, true)]) if (!p.owed.includes(n)) p.owed.push(n);
    throw e;
  }
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
    await migrateFolderNames(); if (stop()) return;
    let unreadable = 0, moved = false;
    if (await syncFolders(u)) moved = true; if (stop()) return;
    for (const sp of [''].concat(folders.map(f => f.id))) {         // each compartment has its own bookmark
      if (sp && !Vault.hasFolderKey(sp)) continue;
      const ck = spaceKey(u, sp), cursor = cursors[ck] || 0, from = Math.max(0, cursor - 3000);
      let maxSeen = cursor, after = null;
      for (;;) {                                                  // pull what changed since the last visit; pages by stamp and id, never by offset
        const where = (sp ? '&folder_id=eq.' + encodeURIComponent(sp) : '&folder_id=is.null') + (after ? '&or=(synced_at.gt.' + after.s + ',and(synced_at.eq.' + after.s + ',id.gt.' + encodeURIComponent(after.id) + '))' : '&synced_at=gt.' + from);
        const r = await api('GET', '/rest/v1/lb_photos?select=id,meta,updated_at,deleted,synced_at' + where + '&order=synced_at.asc,id.asc&limit=500');
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
    const driveOut = !!(DRIVE && drive && !driveTokenOk());      // photos wait for the tap
    if (driveOut) driveNeedsToken();
    const needsUp = p => !p.deleted && p.have && !p.up && (!p.folder || Vault.hasFolderKey(p.folder)) && !driveOut;
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
    // own photos still in the Supabase bucket move to Drive: the sealed bytes as they are (no key
    // needed), one photo at a time; the entry then says where they are, and the bucket's copies go
    // once the entry is accepted (owed objects). Stops by itself when nothing is left.
    const toMove = p => settings.moveToDrive && !p.deleted && p.up && p.st !== 'gd' && !!p.tag;
    if (settings.moveToDrive && DRIVE && drive && driveTokenOk()) {
      const list = photos.filter(toMove); let i = 0;
      for (const p of list) {
        if (stop()) return;
        i++; setSyncState('busy', 'Moving to Drive ' + i + ' of ' + list.length + ' · ' + photoLabel(p));
        try {
          const get = async thumb => { const r = await api('GET', '/storage/v1/object/authenticated/lb/' + objName(u, p, p.tag, thumb)); if (r.status === 404 && thumb) return null; if (!r.ok) throw await httpError('Reading "' + photoLabel(p) + '"', r); return r.arrayBuffer(); };
          const full = await get(false), th = p.th ? await get(true) : null, made = [];
          try {
            const df = await driveUpload(p, p.id + '.' + p.tag, 'f', new Blob([full], { type: 'application/octet-stream' })); made.push(df);
            const dt = th ? await driveUpload(p, p.id + '.' + p.tag + '.t', 't', new Blob([th], { type: 'application/octet-stream' })) : ''; if (dt) made.push(dt);
            p.owed = p.owed || []; for (const n of [objName(u, p, p.tag, false), objName(u, p, p.tag, true)]) if (!p.owed.includes(n)) p.owed.push(n);      // the bucket's copies go after the entry
            p.st = 'gd'; p.df = df; p.dt = dt;
            save({ sync: false });
          } catch (e) { p.owed = p.owed || []; for (const id of made) if (!p.owed.includes('gd:' + id)) p.owed.push('gd:' + id); throw e; }
        } catch (e) {
          if (e && e.reconnect) { await driveLost(); break; }
          if (e instanceof TypeError || navigator.onLine === false || ctl.signal.aborted) break;
          upFailed++; upWhy = 'Moving "' + photoLabel(p) + '" to Drive failed: ' + errText(e);
        }
      }
      if (!photos.some(toMove)) { settings.moveToDrive = false; saveSettings(); renderDriveBox(); }
    }
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
    for (const p of photos) if (p.deleted && !p.cloudPurged && (p.srv === p.updated_at || (!p.srv && !p.up))) {      // the files of a deleted photo go too; counted as done only when the cloud confirms
      if (stop()) return;
      try {
        if (p.srv) {
          const c = await api('GET', '/rest/v1/lb_photos?select=updated_at,deleted&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(p.id));
          if (!c.ok) continue;
          const cur = (await c.json())[0];
          if (cur && (!cur.deleted || +cur.updated_at !== p.updated_at)) continue;      // the cloud moved on meanwhile: not ours to remove
        }
        let gone = true;
        const names = p.st === 'gd' ? [p.df, p.dt].filter(Boolean).map(id => 'gd:' + id) : (p.tag ? [objName(u, p, p.tag, false), objName(u, p, p.tag, true)] : []);
        for (const name of names) { if (stop()) return; if (!(await dropObj(u, p, name))) gone = false; }
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
    if (driveOut && photos.some(p => !p.deleted && p.have && !p.up)) throw new Error('Google Drive needs a tap to reconnect (menu) before your new photos can be uploaded.');
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
    const u = session.uid;
    if (p.st === 'gd') {
      if (!p.dt) { const b = await fetchFull(p); if (!b) return null; const t = await makeThumb(b); if (!t) return null; if (!p.w && t.w) { p.w = t.w; p.h = t.h; } await thumbPut(p.id, t.blob); p.th = true; persist(); return t.blob; }
      const blob = await openFile(p, await driveGet(p.dt), 't');
      if (p.deleted || passive) return blob;
      await thumbPut(p.id, blob); p.th = true; persist(); renderHome();
      return blob;
    }
    const r = await api('GET', '/storage/v1/object/authenticated/lb/' + objName(u, p, p.tag, true));
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
  if (!haveKeyFor(p)) throw new Error(session ? 'The key of this ' + (p.folder ? 'folder' : 'photo') + ' is not on this device yet.' : 'Not signed in.');
  if (!p.up || !p.tag) throw new Error('This photo has not reached the cloud yet.');
  return fetchShared('f' + p.id, async () => {
    const u = session.uid; if (msg) setSyncState('busy', msg);
    let buf;
    if (p.st === 'gd') buf = await driveGet(p.df);
    else { const r = await api('GET', '/storage/v1/object/authenticated/lb/' + objName(u, p, p.tag, false)); if (!r.ok) throw await httpError('Fetching "' + photoLabel(p) + '"', r); buf = await r.arrayBuffer(); }
    const blob = await openFile(p, buf, 'f');
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
  if (DRIVE && drive && driveState === 'reconnect' && (photos.some(p => !p.deleted && p.have && !p.up) || photos.some(p => !p.deleted && p.st === 'gd' && !p.th))) { el.className = 'subline err'; el.textContent = 'Google Drive needs a tap to reconnect · tap here'; return; }
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

// Installs from before v9 kept a folder as a name on each photo. Such a name becomes a folder of
// its own (a new key) and the photo moves into it; a photo whose key is already wrapped by the
// cloud key waits for that key (sign-in and the encryption password), the others move at once.
async function migrateFolderNames() {
  const legacy = photos.filter(p => p.folder && !folders.some(f => f.id === p.folder));
  if (!legacy.length) return;
  const u = session ? session.uid : account; let moved = 0;
  for (const p of legacy) {
    if (p.pk && !(session && Vault.hasCloudKey(session.uid))) continue;
    let f = folders.find(x => !x.deleted && x.name === p.folder);
    if (!f) { try { f = await newFolder(p.folder); } catch (e) { continue; } }
    const name = p.folder; p.folder = '';
    try { if (p.pk) { const raw = await Vault.unwrapItemKey(p.pk, 'lb|pk|' + p.id); p.folder = f.id; p.pk = await Vault.fwrapItemKey(f.id, raw, 'lb|pk|' + p.id); } else p.folder = f.id; moved++; }
    catch (e) { p.folder = name; }
  }
  if (moved) save();
}
// ---------- folders: the compartments, in the cloud ----------
// One row per folder: the name sealed with the folder's key, the key wrapped by the cloud key
// (a protected folder carries a passphrase-wrapped copy instead, see the concept). Written and
// read like photo entries: conditionally on the server stamp, the later change wins.
const folderInfoAad = id => 'lb|folderinfo|' + id;
const folderDue = f => f.srv !== f.updated_at;
async function folderRow(f, u) {
  return { id: f.id, user_id: u, info: await Vault.fsealJson(f.id, { name: f.name, u: f.updated_at, del: !!f.deleted }, folderInfoAad(f.id)), wrap: await Vault.wrapFolderKey(f.id, u), pwrap: '', psalt: '', piter: 0, updated_at: f.updated_at, deleted: !!f.deleted };
}
async function writeFolder(f, u) {
  const row = await folderRow(f, u), headers = { 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const r = f.seen ? await api('PATCH', '/rest/v1/lb_folders?select=synced_at&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(f.id) + '&synced_at=eq.' + f.seen, { headers, body: JSON.stringify(row) })
    : await api('POST', '/rest/v1/lb_folders?select=synced_at', { headers, body: JSON.stringify(row) });
  if (r.status === 409) return false;
  if (!r.ok) throw await httpError('Saving the folders', r);
  const out = await r.json(); if (!Array.isArray(out) || !out.length) return false;
  f.seen = +out[0].synced_at || f.seen;
  if (f.updated_at === row.updated_at) f.srv = f.updated_at;
  return true;
}
async function applyFolderRow(row, u) {
  const id = String(row.id), upd = +row.updated_at || 0, del = !!row.deleted, stamp = +row.synced_at || 0;
  if (!Vault.hasFolderKey(id)) {
    if (!row.wrap) return 'locked';                              // a protected folder: its key waits for the passphrase
    await Vault.keepFolderKey(id, await Vault.unwrapFolderKey(row.wrap, u, id), u);
  }
  const m = await Vault.fopenJson(id, row.info, folderInfoAad(id));
  if (+m.u !== upd || !!m.del !== del) throw new Error('folder entry does not match its seal');
  let f = folders.find(x => x.id === id);
  if (!f) { f = migrateFolder({ id, name: String(m.name || ''), created_at: upd, updated_at: upd, deleted: del, srv: upd, seen: stamp }); folders.push(f); fsnap[id] = fsigOf(f); return 'new'; }
  const before = fsigOf(f), wasDeleted = f.deleted;
  f.seen = stamp;
  if (upd > f.updated_at) { f.name = String(m.name || ''); f.deleted = del; f.updated_at = upd; f.srv = upd; if (del && !wasDeleted) { for (const p of photos) if (p.folder === id && !p.deleted) { /* the other device moved them out; their entries follow */ } if (folderFilter === id) folderFilter = ''; } }
  else if (upd === f.updated_at) { if (!!m.del !== !!f.deleted) { if (del) { f.deleted = true; f.srv = upd; } else f.srv = -1; } else if (String(m.name || '') !== f.name) { if (String(m.name || '') > f.name) { f.name = String(m.name || ''); f.srv = upd; } else f.srv = -1; } else f.srv = upd; }
  else f.srv = -1;
  if (fsnap[id] === before) fsnap[id] = fsigOf(f);
  return 'ok';
}
// pull the folders changed since the last visit, push the ones changed here; true when the bookmark moved
async function syncFolders(u) {
  const ck = FOLDERS_KEY(u), cursor = cursors[ck] || 0;
  let maxSeen = cursor, after = null;
  for (;;) {
    const where = after ? '&or=(synced_at.gt.' + after.s + ',and(synced_at.eq.' + after.s + ',id.gt.' + encodeURIComponent(after.id) + '))' : '&synced_at=gt.' + Math.max(0, cursor - 3000);
    const r = await api('GET', '/rest/v1/lb_folders?select=id,info,wrap,pwrap,psalt,piter,updated_at,deleted,synced_at' + where + '&order=synced_at.asc,id.asc&limit=500');
    if (!r.ok) throw await httpError('Loading the folders', r);
    const rows = await r.json();
    for (const row of rows) { maxSeen = Math.max(maxSeen, +row.synced_at || 0); try { await applyFolderRow(row, u); } catch (e) {} }
    if (rows.length < 500) break;
    const last = rows[rows.length - 1]; after = { s: +last.synced_at || 0, id: String(last.id) };
  }
  let moved = false;
  if (maxSeen > cursor) { cursors[ck] = maxSeen; moved = true; }
  for (const f of folders.slice()) {
    if (!folderDue(f) || !Vault.hasFolderKey(f.id)) continue;
    let done = await writeFolder(f, u);
    if (!done) {                                                   // another device wrote first: take its row, then once more
      const r = await api('GET', '/rest/v1/lb_folders?select=id,info,wrap,pwrap,psalt,piter,updated_at,deleted,synced_at&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(f.id));
      if (r.ok) { const rows = await r.json(); if (rows.length) { f.seen = +rows[0].synced_at || 0; try { await applyFolderRow(rows[0], u); } catch (e) {} } else f.seen = 0; }
      if (folderDue(f)) done = await writeFolder(f, u);
    }
  }
  return moved;
}
