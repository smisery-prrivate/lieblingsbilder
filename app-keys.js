'use strict';
/* The recovery key file in Google Drive (since v20). Drive holds the files of every photo, but
   sealed: without the keys they are noise, and the keys travel in the entries of the Supabase
   cloud. So that Drive alone is a backup, the app also keeps one small file beside the photos,
   "lieblingsbilder-keys.lb", that holds everything restore.html needs to turn the Drive folder
   back into pictures on a PC: the cloud key's password envelope (the same one the cloud holds),
   and, sealed with the cloud key, the list of photos with their wrapped per-photo keys, the
   folders with their wrapped keys, and the names the files carry in Drive. The file gives away
   nothing without the encryption password: the index is ciphertext, the envelope is PBKDF2
   (600,000 rounds) under the password. A protected folder's photos (names, dates) are sealed in
   it with that folder's key, under its passphrase, exactly as in the cloud; the cloud-key part
   knows of them only their ids and wrapped keys, which open nothing.

   Written at the end of a sync pass whenever its content changed (a new photo, a move, a new
   folder, a date change, files moved to Drive), and never read by the app itself except to carry
   over a protected folder's part that this device cannot produce because the folder is closed
   here. One file per Drive folder: every device of the owner writes the same one. */
const KEYFILE_NAME = 'lieblingsbilder-keys.lb';
let keyfileState = '', keyfileMsg = '';            // '' | 'error'; shown in the menu

// the name a file carries in Drive for the date its names were given (dn): -1 or 0 = the neutral name
const driveNameAt = (p, kind, idx, dn) => driveNameFor(p, kind, idx, dn > 0 ? dn : -1);
// what restore.html needs of one photo; thin: of a photo in a closed protected folder (a stub) only what the device holds
function keyEntry(p, thin) {
  const e = { id: p.id, pk: p.pk || '', f: p.folder || '', st: p.st || 'sb' };
  if (!thin) { e.name = p.name || ''; e.type = p.type; e.taken = p.taken_at; if (p.kind === 'video') { e.kind = 'video'; e.chunks = p.chunks; } }
  if (p.st === 'gd') {
    const video = p.kind === 'video' || (thin && (p.dfs || []).length > 0);
    e.files = video ? (p.dfs || []).map((id, i) => ({ id, n: thin ? driveNameAt(p, 'f', i, -1) : driveNameAt(p, 'f', i, p.dn) })) : [{ id: p.df || '', n: thin ? driveNameAt(p, 'f', undefined, -1) : driveNameAt(p, 'f', undefined, p.dn) }];
  }
  return e;
}
// the photos the file lists: in the cloud, with a key
const keyfilePhotos = () => photos.filter(p => !p.deleted && p.up && !!p.pk && !!p.tag);
// the plain parts, before sealing; prev: the file as it is in Drive (for the parts this device cannot make)
async function keyfileParts(u) {
  const live = keyfilePhotos(), fl = [], plain = [], open = {};
  for (const f of folders) {
    if (f.deleted) continue;
    if (f.prot) { fl.push({ id: f.id, prot: true, pwrap: f.pwrap, psalt: f.psalt, piter: f.piter, photos: live.filter(p => p.folder === f.id).map(p => keyEntry(p, true)) }); if (Vault.hasFolderKey(f.id)) open[f.id] = { name: f.name, photos: live.filter(p => p.folder === f.id && !p.stub).map(p => keyEntry(p, false)) }; }
    else fl.push(Vault.hasFolderKey(f.id) ? { id: f.id, name: f.name, wrap: await Vault.wrapFolderKey(f.id, u) } : { id: f.id, name: f.name });
  }
  for (const p of live) if (!p.folder || !protFolder(p.folder)) plain.push(keyEntry(p, false));
  return { index: { v: 1, uid: u, folders: fl, photos: plain }, open };
}
async function sha256hex(s) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s))); let h = ''; for (const b of d) h += b.toString(16).padStart(2, '0'); return h; }
// the key file in the Drive folder: the id kept in the Drive record, else found by name
async function keyfileId() {
  if (drive.keyId) { try { const f = await driveApi('GET', '/drive/v3/files/' + encodeURIComponent(drive.keyId) + '?fields=id,trashed'); if (f && !f.trashed) return drive.keyId; } catch (e) { if (e.reconnect) throw e; } drive.keyId = ''; }
  const found = await driveApi('GET', '/drive/v3/files?spaces=drive&fields=files(id,createdTime)&q=' + driveQ("name='" + KEYFILE_NAME + "' and trashed=false"));      // wherever it lies (the main folder before v21, the archive subfolder since)
  drive.keyId = found.files && found.files.length ? oldest(found.files).id : '';
  return drive.keyId;
}
// after a sync pass: the file anew when its content changed. Never throws; a failure shows in the menu.
async function writeKeyFile(u) {
  if (!DRIVE || !drive || !driveTokenOk() || !session || session.uid !== u || !Vault.hasCloudKey(u)) return;
  try {
    const parts = await keyfileParts(u);
    const sig = await sha256hex(JSON.stringify([parts.index, parts.open]));
    const fine = () => { if (keyfileState) { keyfileState = ''; keyfileMsg = ''; renderDriveBox(); } };
    if (sig === drive.keySig && drive.keyId) {                     // nothing changed; once a day the file is checked to be there still (someone may have removed it by hand)
      if (Date.now() - (drive.keyChk || drive.keyAt || 0) < 86400000) { fine(); return; }
      if (await keyfileId()) { drive.keyChk = Date.now(); await storeDrive(); fine(); return; }
    }
    const r = await api('GET', '/rest/v1/lb_keys?select=salt,iter,wrapped&user_id=eq.' + u);
    if (!r.ok) throw await httpError('Reading the key envelope', r);
    const env = (await r.json())[0]; if (!env || !env.wrapped) throw new Error('the cloud holds no key envelope');
    const id = await keyfileId();
    let prev = null;                                               // the parts of closed protected folders come from the file as it is
    if (id && parts.index.folders.some(f => f.prot && !parts.open[f.id])) { try { prev = JSON.parse(new TextDecoder().decode(await driveDownload(id))); } catch (e) { prev = null; } }
    const file = { v: 1, app: 'lieblingsbilder', uid: u, written: Date.now(), env: { salt: String(env.salt), iter: +env.iter, wrapped: String(env.wrapped) }, index: await Vault.csealJson(parts.index, 'lb|keys|' + u), prot: {} };
    for (const f of parts.index.folders) {
      if (!f.prot) continue;
      if (parts.open[f.id]) file.prot[f.id] = await Vault.fsealJson(f.id, parts.open[f.id], 'lb|keys|' + u + '|' + f.id);
      else if (prev && prev.uid === u && prev.prot && typeof prev.prot[f.id] === 'string') file.prot[f.id] = prev.prot[f.id];
    }
    const blob = new Blob([JSON.stringify(file)], { type: 'application/octet-stream' });
    const archive = await driveArchive(), meta = { name: KEYFILE_NAME, appProperties: { lb: 'keys' } }; if (!id) meta.parents = [archive];
    const out = await driveUploadBody(meta, blob, id || '');
    if (id && !drive.keyMoved) { try { const f = await driveApi('GET', '/drive/v3/files/' + encodeURIComponent(id) + '?fields=parents'); if (f && Array.isArray(f.parents) && !f.parents.includes(archive)) await driveMove(id, f.parents[0], archive); drive.keyMoved = true; } catch (e) { if (e && e.reconnect) throw e; } }      // a key file of v20 moves into the subfolder
    drive.keyId = (out && out.id) || id; drive.keySig = sig; drive.keyAt = drive.keyChk = Date.now(); await storeDrive();
    keyfileState = ''; keyfileMsg = '';
  } catch (e) {
    if (e && e.reconnect) { await driveLost(); return; }
    keyfileState = 'error'; keyfileMsg = errText(e);
  }
  renderDriveBox();
}
// the content must go up again whatever the signature says (the password changed: the envelope is new)
async function keyfileDirty() { if (drive && drive.keySig) { drive.keySig = ''; await storeDrive(); } }
const restoreUrl = () => new URL('restore.html', location.href).href;
function keyfileLine() {
  if (!drive) return '';
  const when = drive.keyAt ? (() => { const m = Math.floor((Date.now() - drive.keyAt) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ago' : Math.floor(m / 1440) + ' d ago'; })() : '';
  const state = keyfileState === 'error' ? 'could not be written: ' + keyfileMsg : drive.keyAt ? 'written ' + when : session && Vault.hasCloudKey(session.uid) ? 'written with the next sync' : 'written once cloud sync is on';
  return '<div class="hint' + (keyfileState === 'error' ? ' warn' : '') + '">Recovery key file "' + esc(KEYFILE_NAME) + '" in the subfolder "' + esc(DRIVE.archive) + '": ' + esc(state) + '. With it and your encryption password alone, every photo in Drive can be restored on a PC, without this app or its cloud: download the folder from Drive and open <a id="restoreOpen" href="' + esc(restoreUrl()) + '" target="_blank" rel="noopener">' + esc(restoreUrl()) + '</a>. A protected folder needs its passphrase there too.</div>';
}
