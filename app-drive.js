'use strict';
/* Lieblingsbilder on Google Drive: optional, taken over from Snapdoc. Once the user has connected
   a Google account, the files of their own photos (the full picture and the thumbnail, both
   sealed with the photo's key, unreadable to Google) go into a folder "Lieblingsbilder" of that
   account instead of the Supabase bucket. Rooms stay in the Supabase bucket, because a room's
   files must be readable by every member and a Drive belongs to one person.

   The app asks Google only for the right to see and change files it created itself (scope
   drive.file). No Google script is loaded: the sign-in is a plain redirect to Google and back,
   and the uploads are requests to the Drive interface. The access token lives one hour and is
   stored encrypted like everything else; when it has run out, the app reconnects by itself (a
   redirect without any screen) only without a lock and while nothing would be lost; otherwise
   the menu and the status line ask for a tap. Every device that wants to show these photos
   connects its own Google account (the same one). */
const DRIVE = CFG.googleClientId ? { clientId: String(CFG.googleClientId), api: 'https://www.googleapis.com', auth: 'https://accounts.google.com/o/oauth2/v2/auth', revoke: 'https://oauth2.googleapis.com/revoke', scope: 'https://www.googleapis.com/auth/drive.file', folder: 'Lieblingsbilder' } : null;
const DRIVE_STATE = 'lieblingsbilder-drive', DRIVE_NONCE_KEY = 'lb.driveNonce', DRIVE_SILENT_KEY = 'lb.driveSilent', DRIVE_SILENT_N = 'lb.driveSilentN', DRIVE_MULTIPART_MAX = 5 * 1024 * 1024;
let drive = null;                 // { email, token, exp, folderId } once connected; stored encrypted in meta 'drive'
let driveState = '', driveMsg = '', driveTried = false;
let driveGo = url => location.assign(url);           // the redirect to Google (replaced in tests)

async function loadDrive() {
  drive = null;
  if (!DRIVE) return;
  try { const r = await idb.get('meta', 'drive'); if (r) drive = await Vault.openJson(r.data, 'lb|drive'); } catch (e) { drive = null; }
}
async function storeDrive() {
  if (drive) await idb.put('meta', { id: 'drive', data: await Vault.sealJson(drive, 'lb|drive') }); else await idb.del('meta', 'drive');
}
const driveRedirect = () => location.origin + location.pathname.replace(/index\.html$/, '');
const driveTokenOk = () => !!(drive && drive.token && drive.exp > Date.now() + 60000);
// new own photos go to Drive once it is connected; while its hour has run out they wait for the tap
const driveWanted = p => !!(DRIVE && drive && !p.room);
const drivePhotos = () => photos.filter(p => !p.deleted && p.st === 'gd');
// Off to Google. silent: no screen, only works when the user is still signed in to Google in this browser.
function driveConnect(silent) {
  if (!DRIVE || passive) return;
  if (persistQueued || persistFailed) { persistChain.then(ok => { if (ok) driveConnect(silent); else if (!silent) toast('The photo list could not be saved; try again.'); }); return; }
  const nonce = uid();
  try { sessionStorage.setItem(DRIVE_NONCE_KEY, nonce); } catch (e) { toast('This browser blocks session storage; Google Drive cannot be connected here.'); return; }
  const p = new URLSearchParams({ client_id: DRIVE.clientId, redirect_uri: driveRedirect(), response_type: 'token', scope: DRIVE.scope, state: DRIVE_STATE + '.' + nonce, include_granted_scopes: 'true' });
  if (silent) p.set('prompt', 'none'); if (drive && drive.email) p.set('login_hint', drive.email);
  try { sessionStorage.setItem(RESUME_KEY, curPhoto ? curPhoto.id : ''); } catch (e) {}
  driveGo(DRIVE.auth + '?' + p.toString());
}
// Back from Google with the token (or an error) in the URL fragment. Returns a message for the user, or ''.
async function driveAdopt(qp) {
  let nonce = ''; try { nonce = sessionStorage.getItem(DRIVE_NONCE_KEY) || ''; sessionStorage.removeItem(DRIVE_NONCE_KEY); } catch (e) {}
  if (!DRIVE) return 'Google Drive is not set up in this version.';
  if (!nonce || qp.get('state') !== DRIVE_STATE + '.' + nonce) return '';          // a reply this browser did not ask for is ignored, whatever it says
  if (qp.get('error')) {                                                              // a few fixed sentences, never the sender's text
    const err = qp.get('error'), silent = err === 'interaction_required' || err === 'login_required' || err === 'consent_required';
    if (silent) { driveState = 'reconnect'; return ''; }
    return err === 'access_denied' ? 'Google Drive was not connected: the request was cancelled.' : 'Google Drive was not connected. Try again from the menu.';
  }
  const token = qp.get('access_token'), ttl = +qp.get('expires_in') || 3600;
  if (!token || !/^[\w.\-]+$/.test(token)) return 'Google sent no usable token.';
  if (ttl <= 120) { driveState = 'reconnect'; return ''; }
  const nd = { email: drive ? drive.email : '', token, exp: Date.now() + ttl * 1000, folderId: drive ? drive.folderId : '' };
  try {
    const r = await driveApi('GET', '/drive/v3/about?fields=user(emailAddress)', null, nd);
    nd.email = r.user && r.user.emailAddress || nd.email;
  } catch (e) { return 'Google Drive did not accept the connection: ' + errText(e); }
  drive = nd; driveState = ''; driveMsg = ''; await storeDrive();
  return '';
}
async function driveDisconnect() {
  const t = drive && drive.token; drive = null; driveState = ''; driveMsg = ''; await storeDrive();
  if (t) fetch(DRIVE.revoke + '?token=' + encodeURIComponent(t), { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => {});
  renderDriveBox(); renderSyncLine();
}
// one request to the Drive interface; body: object (JSON) or Blob (multipart upload); d: token holder
async function driveApi(method, path, body, d) {
  const h = { Authorization: 'Bearer ' + (d || drive).token };
  let b = null;
  if (body instanceof Blob) { b = body; h['Content-Type'] = body.type; } else if (body) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(DRIVE.api + path, { method, headers: h, body: b, credentials: 'omit', cache: 'no-store' });
  if (r.status === 401) { const e = new Error('reconnect'); e.reconnect = true; throw e; }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (e) {} const err = new Error('Google Drive answered ' + r.status + (m ? ': ' + m : '')); err.status = r.status; throw err; }
  return r.status === 204 ? null : r.json();
}
// the token has run out: once, quietly, back to Google and on, but only without a lock, while
// nothing would be lost and at most twice in ten minutes; otherwise the user taps
function driveNeedsToken() {
  if (!DRIVE || !drive || driveTokenOk()) return false;
  let tried = '', n = 0; try { tried = sessionStorage.getItem(DRIVE_SILENT_KEY) || ''; n = +sessionStorage.getItem(DRIVE_SILENT_N) || 0; } catch (e) {}
  if (Date.now() - (+tried || 0) > 600000) n = 0;
  const quiet = !workInFlight() && current() === 'home' && !selectMode && !toastAction && !persistQueued && !persistFailed && document.visibilityState === 'visible' && (!document.activeElement || document.activeElement === document.body);
  if (!Vault.lockType() && !driveTried && quiet && n < 2 && navigator.onLine !== false) {
    driveTried = true; try { sessionStorage.setItem(DRIVE_SILENT_KEY, String(Date.now())); sessionStorage.setItem(DRIVE_SILENT_N, String(n + 1)); } catch (e) {}
    driveConnect(true); return true;
  }
  setDriveState('reconnect', ''); return true;
}
async function driveLost() { if (drive) { drive.exp = 0; await storeDrive(); } setDriveState('reconnect', ''); }
const driveQ = s => encodeURIComponent(s);
// two devices on one account may create the same thing at the same moment: after creating, the
// search is repeated and everyone keeps the oldest, so both converge on one folder
const oldest = files => files.slice().sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id))[0];
async function driveFolder() {
  if (drive.folderId) { try { const f = await driveApi('GET', '/drive/v3/files/' + drive.folderId + '?fields=id,trashed'); if (f && !f.trashed) return drive.folderId; } catch (e) { if (e.reconnect) throw e; } }
  const q = '/drive/v3/files?spaces=drive&fields=files(id,createdTime)&q=' + driveQ("name='" + DRIVE.folder + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const found = await driveApi('GET', q);
  let id = found.files && found.files.length ? oldest(found.files).id : '';
  if (!id) {
    id = (await driveApi('POST', '/drive/v3/files?fields=id', { name: DRIVE.folder, mimeType: 'application/vnd.google-apps.folder' })).id;
    const again = await driveApi('GET', q); if (again.files && again.files.length > 1) { const keep = oldest(again.files).id; if (keep !== id) { try { await driveApi('PATCH', '/drive/v3/files/' + id + '?fields=id', { trashed: true }); } catch (e) {} id = keep; } }
  }
  drive.folderId = id; await storeDrive(); return id;
}
// a file larger than the one-request limit goes up in the resumable form: the metadata first, then the body to the address Google names
async function driveUploadBody(meta, blob) {
  if (blob.size <= DRIVE_MULTIPART_MAX) return driveApi('POST', '/upload/drive/v3/files?uploadType=multipart&fields=id', multipart(meta, blob));
  const r = await fetch(DRIVE.api + '/upload/drive/v3/files?uploadType=resumable&fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + drive.token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) }, body: JSON.stringify(meta), credentials: 'omit', cache: 'no-store' });
  if (r.status === 401) { const e = new Error('reconnect'); e.reconnect = true; throw e; }
  const loc = r.headers.get('Location'); if (!r.ok || !loc) throw new Error('Google Drive answered ' + r.status + ' to the upload request');
  const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob, credentials: 'omit', cache: 'no-store' });
  if (!up.ok) throw new Error('Google Drive answered ' + up.status + ' to the upload');
  return up.json();
}
function multipart(meta, blob) {
  const b = 'lb' + uid().replace(/-/g, '');
  return new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: application/octet-stream\r\n\r\n', blob, '\r\n--' + b + '--'], { type: 'multipart/related; boundary=' + b });
}
// one sealed file (the full picture or the thumbnail) into the folder; returns the Drive file id
async function driveUpload(p, name, kind, blob) {
  return (await driveUploadBody({ name, parents: [await driveFolder()], appProperties: { lb: p.id, k: kind } }, blob)).id;
}
async function driveDownload(id) {
  const r = await fetch(DRIVE.api + '/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', { headers: { Authorization: 'Bearer ' + drive.token }, credentials: 'omit', cache: 'no-store' });
  if (r.status === 401) { const e = new Error('reconnect'); e.reconnect = true; throw e; }
  if (!r.ok) { const e = new Error('Google Drive answered ' + r.status); e.status = r.status; throw e; }
  return r.arrayBuffer();
}
// to the Drive bin; a file that is gone already counts as done
async function driveTrash(id) {
  try { await driveApi('PATCH', '/drive/v3/files/' + encodeURIComponent(id) + '?fields=id', { trashed: true }); return true; }
  catch (e) { if (e.reconnect) throw e; return e.status === 404; }
}
function setDriveState(s, msg) { driveState = s; driveMsg = msg; renderSyncLine(); renderDriveBox(); }
function renderDriveBox() {
  const box = $('driveBox'); if (!box) return;
  if (!DRIVE) { box.innerHTML = '<p>Google Drive is not set up in this version: your photos go to the Supabase cloud.</p>'; return; }
  if (!drive) {
    box.innerHTML = '<p>Keep the files of your own photos in a folder "Lieblingsbilder" of your Google Drive (15 GB free) instead of the small Supabase cloud. They are encrypted before they leave the phone: Google holds only ciphertext. Rooms stay in the Supabase cloud. Every device that should show these photos connects the same Google account.</p>' +
      '<button id="driveOn" class="btn primary">Connect Google Drive</button>';
    $('driveOn').addEventListener('click', () => driveConnect(false));
    return;
  }
  const n = drivePhotos().length, waiting = photos.filter(p => !p.deleted && p.have && !p.up && !p.room).length, err = driveState === 'error' || driveState === 'reconnect';
  const line = driveState === 'reconnect' ? 'The connection has run out. Tap Reconnect to continue.' : driveState === 'error' ? driveMsg : n + (n === 1 ? ' photo' : ' photos') + ' in Drive' + (waiting ? ' · ' + waiting + ' waiting' : '');
  box.innerHTML = '<div class="statecard' + (err ? ' err' : '') + '"><div class="t">Google Drive · ' + esc(drive.email || '') + '</div><div class="s">Folder "' + esc(DRIVE.folder) + '" · ' + esc(line) + '</div></div>' +
    (driveState === 'reconnect' ? '<button id="driveRe" class="btn primary">Reconnect</button>' : '<button id="driveNowBtn" class="btn">Sync now</button>') +
    '<button id="driveOff" class="btn quiet">Disconnect Google Drive</button>';
  if ($('driveRe')) $('driveRe').addEventListener('click', () => driveConnect(false));
  if ($('driveNowBtn')) $('driveNowBtn').addEventListener('click', () => { driveTried = false; syncRetry(); });
  $('driveOff').addEventListener('click', () => popup('Disconnect Google Drive?', 'The photos already in Drive stay there and can be shown again once it is connected. New photos go to the Supabase cloud meanwhile.', [{ label: 'Disconnect', cls: 'danger', fn: driveDisconnect }, { label: 'Keep it', cls: 'quiet' }]));
}
