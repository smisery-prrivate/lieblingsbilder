'use strict';
/* Lieblingsbilder start-up: become the one active instance, open the vault (asking for the lock if
   one is set), load the photos, take over pictures from the share sheet, continue a sign-in link,
   start sync, keep the app up to date. Taken over from Snapdoc. */
function fatal(msg) { $('list').innerHTML = '<div class="empty"><b>Lieblingsbilder cannot start</b>' + esc(msg) + '</div>'; }

// ---------- one active instance (see app-core.js for the write guard) ----------
const INSTANCE_LOCK = 'lieblingsbilder-instance', TAKE_KEY = 'lb.take', STAY_KEY = 'lb.stay', WIPE_KEY = 'lb.wipe', LINKHASH_KEY = 'lb.linkHash';
let instanceRelease = null;
const bc = 'BroadcastChannel' in self ? new BroadcastChannel('lieblingsbilder') : null;
function holdInstance(opts) {
  return new Promise(resolve => {
    let held = false;
    navigator.locks.request(INSTANCE_LOCK, opts, lock => {
      if (!lock) { resolve(false); return; }
      held = true; lockHeld = true;
      try { localStorage.setItem(OWNER_KEY, INSTANCE_ID); } catch (e) {}
      startAlive(); resolve(true);
      return new Promise(rel => { instanceRelease = rel; });
    }).catch(() => { lockHeld = false; if (held) instanceLost(); else resolve(false); });
  });
}
function askHolder() {
  return new Promise(res => {
    if (!bc) { res(null); return; }
    const on = e => { if (e.data && e.data.t === 'here') { clearTimeout(t); bc.removeEventListener('message', on); res(!!e.data.visible); } };
    const t = setTimeout(() => { bc.removeEventListener('message', on); res(null); }, 500);
    bc.addEventListener('message', on); bc.postMessage({ t: 'who', from: INSTANCE_ID });
  });
}
const AWAY_TEXT = 'Only one can be active at a time, so that nothing gets overwritten.';
const awayNote = t => { const p = $('away').querySelector('p'); if (p) p.textContent = t; };
let aliveTimer = null;
const ALIVE_KEY = 'lb.alive';
const markAlive = () => { try { localStorage.setItem(ALIVE_KEY, String(Date.now())); } catch (e) {} };
function startAlive() { clearInterval(aliveTimer); markAlive(); aliveTimer = setInterval(markAlive, 1000); }
const aliveAge = () => { try { return Date.now() - (+localStorage.getItem(ALIVE_KEY) || 0); } catch (e) { return Infinity; } };
function waitForRelease() {
  const ctl = new AbortController(); let timer = setTimeout(() => ctl.abort(), 4000), shown = false;
  const onBusy = e => { if (e.data && e.data.t === 'busy') { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 4000); if (!shown) { shown = true; awayNote('The other window is finishing its work. The app opens here as soon as it is stored.'); $('away').hidden = false; } } };
  if (bc) bc.addEventListener('message', onBusy);
  return holdInstance({ signal: ctl.signal }).then(got => { clearTimeout(timer); if (bc) bc.removeEventListener('message', onBusy); if (shown) { $('away').hidden = true; awayNote(AWAY_TEXT); } return got; });
}
let released = false;
const waitBusy = ms => new Promise(r => { if (!bc) { r(); return; } let t = setTimeout(done, ms); const on = e => { if (!e.data) return; if (e.data.t === 'released') { released = true; done(); } else if (e.data.t === 'busy') { clearTimeout(t); t = setTimeout(done, 4000); } }; function done() { bc.removeEventListener('message', on); r(); } bc.addEventListener('message', on); });
async function acquireInstance(force) {
  if (!navigator.locks) {
    if (!force && (await askHolder()) === true) return false;
    released = false;
    if (bc) { bc.postMessage({ t: 'yield', from: INSTANCE_ID }); await waitBusy(1500); }
    const t0 = Date.now(); let shown = false;
    while (!released && aliveAge() < 30000 && Date.now() - t0 < 120000) {
      if (!shown) { shown = true; awayNote('The other window is finishing its work. The app opens here as soon as it is stored.'); $('away').hidden = false; }
      await waitBusy(2000);
    }
    if (shown) { $('away').hidden = true; awayNote(AWAY_TEXT); }
    try { localStorage.setItem(OWNER_KEY, INSTANCE_ID); } catch (e) {}
    instanceRelease = () => {}; lockHeld = true;
    startAlive(); return true;
  }
  if (await holdInstance({ ifAvailable: true })) return true;
  if (!bc && !force) return false;
  if (!force && (await askHolder()) === true) return false;
  if (bc) bc.postMessage({ t: 'yield', from: INSTANCE_ID });
  if (await waitForRelease()) return true;
  const ans = await askHolder();
  if (ans === true) return false;
  if (ans === false) { if (bc) bc.postMessage({ t: 'yield', from: INSTANCE_ID }); if (await waitForRelease()) return true; if ((await askHolder()) != null) return false; }
  const t0 = Date.now();
  while (aliveAge() < 30000 && Date.now() - t0 < 120000) { if (await waitForRelease()) return true; if ((await askHolder()) === true) return false; }
  return holdInstance({ steal: true });
}
function stepAside() { if (!Vault.lockType()) return; try { sessionStorage.setItem(STAY_KEY, '1'); } catch (e) {} location.reload(); }
function showAway() { for (const id of COVERED) $(id).inert = true; $('toast').classList.remove('show'); $('away').hidden = false; }
function stopEverything() { clearTimeout(syncTimer); }
function instanceLost() { if (passive) return; passive = true; lockHeld = false; clearInterval(aliveTimer); try { localStorage.removeItem(ALIVE_KEY); } catch (e) {} showAway(); stopEverything(); abortSync(); stepAside(); }
async function yieldInstance() {
  showAway();
  const t0 = Date.now(); let said = 0;
  const left = () => qLen > 0 || persistQueued || busyN > 0;
  while (left() || (syncing && Date.now() - t0 < 3000)) {
    if (bc && Date.now() - said > 900) { said = Date.now(); bc.postMessage({ t: 'busy', from: INSTANCE_ID }); }
    await new Promise(r => setTimeout(r, 100));
  }
  try { await persistChain; } catch (e) {}
  passive = true; lockHeld = false; stopEverything(); clearInterval(aliveTimer);
  try { localStorage.removeItem(ALIVE_KEY); } catch (e) {}
  if (instanceRelease) { instanceRelease(); instanceRelease = null; }
  if (bc) bc.postMessage({ t: 'released', from: INSTANCE_ID });
  stepAside();
}
if (bc) bc.addEventListener('message', e => {
  const m = e.data || {}; if (m.from === INSTANCE_ID) return;
  if (m.t === 'who' || m.t === 'yield') markNeeded = true;
  if (passive || !instanceRelease) return;
  if (m.t === 'who') bc.postMessage({ t: 'here', visible: !document.hidden, from: INSTANCE_ID });
  if (m.t === 'yield') yieldInstance();
});
$('awayBtn').addEventListener('click', () => { try { sessionStorage.setItem(TAKE_KEY, '1'); } catch (e) {} reloadPage(); });

// ---------- updates ----------
let swReg = null, updateReady = false, swTookOver = false, lastUpdateCheck = 0, swSwitching = false;
const hadController = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (swSwitching) return;
  if (hadController) { swTookOver = true; updateReady = true; afterNav(); }
});
function noteWaiting(r) { if (r && r.waiting && navigator.serviceWorker.controller) { updateReady = true; afterNav(); } }
function registerSW() {
  let allow = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'; try { allow = allow || localStorage.getItem('lb.sw') === '1'; } catch (e) {}
  if (!('serviceWorker' in navigator) || !allow) return;
  navigator.serviceWorker.register('sw.js').then(r => {
    swReg = r; noteWaiting(r);
    r.addEventListener('updatefound', () => { const w = r.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') noteWaiting(r); }); });
  }).catch(() => {});
}
function checkForUpdate() {
  if (!swReg || Date.now() - lastUpdateCheck < 3600000) return;
  lastUpdateCheck = Date.now(); swReg.update().catch(() => {});
}
function swSwitch() {
  if (!swReg || !swReg.waiting) return Promise.resolve();
  swSwitching = true;
  return new Promise(res => { const t = setTimeout(res, 3000); navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); res(); }, { once: true }); try { swReg.waiting.postMessage({ t: 'skip' }); } catch (e) { clearTimeout(t); res(); } });
}
function afterNav() {
  if (!updateReady || locked || passive || !Vault.isOpen()) return;
  if (current() !== 'home' || stack.length > 1 || workInFlight() || (Vault.lockType() && !swTookOver) || persistQueued || persistFailed) return;
  persistChain.then(async () => { if (persistFailed || workInFlight() || current() !== 'home') return; await swSwitch(); location.reload(); });
}

async function boot() {
  const vt = $('vtag'); if (vt) vt.textContent = VERSION;
  let tokens = null, linkMsg = '', search = location.search, sharedN = '', driveQp = null;
  let h = location.hash || ''; if (!h) { try { h = sessionStorage.getItem(LINKHASH_KEY) || ''; sessionStorage.removeItem(LINKHASH_KEY); } catch (e) {} }
  try {
    const qs = new URLSearchParams(location.search), code = qs.get('code');
    const sentence = c => c === 'otp_expired' ? 'This sign-in link has expired or was already used. Request a new one in the menu.' : c === 'access_denied' ? 'The sign-in link was refused. Request a new one in the menu.' : 'The sign-in link could not be used. Request a new one in the menu.';
    if (code) tokens = { code };
    else if (qs.get('error') || qs.get('error_code')) linkMsg = sentence(qs.get('error_code') || qs.get('error'));
    sharedN = qs.get('shared') || '';
    for (const k of ['code', 'error', 'error_code', 'error_description', 'shared']) qs.delete(k);
    const rest = qs.toString(); search = rest ? '?' + rest : '';
    const qp0 = new URLSearchParams(h.slice(1)); if ((qp0.get('state') || '').startsWith(DRIVE_STATE + '.')) driveQp = qp0;      // back from Google
    const qp = new URLSearchParams(h.slice(1));
    if (!tokens && qp.get('access_token') && qp.get('refresh_token')) tokens = { access_token: qp.get('access_token'), refresh_token: qp.get('refresh_token') };
    else if (!linkMsg && (qp.get('error') || qp.get('error_code'))) linkMsg = sentence(qp.get('error_code') || qp.get('error'));
  } catch (e) {}
  history.replaceState(histState(), '', location.pathname + search);
  applyStack();

  let asked = 0; try { asked = +localStorage.getItem(LINK_KEY) || 0; } catch (e) {}
  const linkFresh = asked && Math.abs(Date.now() - asked) <= 3600000;
  if (linkMsg && !linkFresh) linkMsg = '';
  if (tokens && !linkFresh) { tokens = null; linkMsg = 'This sign-in link was not requested from this browser, or it is older than an hour. Request a new one in the menu.'; }
  let force = false, stay = false, wipe = false;
  try { wipe = sessionStorage.getItem(WIPE_KEY) === '1'; force = sessionStorage.getItem(TAKE_KEY) === '1' || wipe; sessionStorage.removeItem(TAKE_KEY); stay = sessionStorage.getItem(STAY_KEY) === '1'; if (force) { sessionStorage.removeItem(STAY_KEY); stay = false; } } catch (e) {}
  if (stay && !tokens && !sharedN && !driveQp) { passive = true; showAway(); return; }
  let mine = true; try { mine = await acquireInstance(force || !!tokens || !!sharedN || !!driveQp); } catch (e) { mine = true; }      // pictures from the share sheet are like a link: this window takes over
  if (!mine) { passive = true; showAway(); return; }
  if (wipe) { try { await wipeNow(); } catch (e) {} try { sessionStorage.removeItem(WIPE_KEY); } catch (e) {} }
  try { if (!(await idb.get('meta', 'keys'))) { const shared = await idb.all('shared').catch(() => []); await idb.wipe(); for (const r of shared) await idb.put('shared', r).catch(() => {}); } } catch (e) {}      // no key record: nothing stored can be read; leftovers go, the parked pictures stay

  let state;
  try { state = await Vault.load(metaStore); } catch (e) {
    fatal('The storage of this browser could not be opened (' + errText(e) + '). Private windows and blocked site data prevent it.');
    popup('Lieblingsbilder cannot start', errText(e) + ' You can erase everything stored here and start again.', [{ label: 'Erase and reset', cls: 'danger', fn: () => wipeEverything().then(() => location.reload(), () => {}) }, { label: 'Not now', cls: 'quiet' }]);
    return;
  }
  if (state === 'locked') { showLock(false); await whenUnlocked(); if (!isOwner()) { instanceLost(); return; } }
  else if (!Vault.lockType() && !driveQp) { await offerLock(); if (!isOwner()) { instanceLost(); return; } }      // no lock yet: asked before anything is stored, and at every start until one is set
  try { await loadPhotos(); } catch (e) { fatal('The stored photos could not be read (' + errText(e) + ').'); return; }
  await loadSession(); await loadDrive();
  await migrateFolderNames().catch(() => {});
  let driveMsgBoot = ''; if (driveQp) { try { driveMsgBoot = await driveAdopt(driveQp); } catch (e) { driveMsgBoot = 'Google Drive was not connected: ' + errText(e); } }
  if (tokens) { try { linkMsg = await adoptLink(tokens); } catch (e) { linkMsg = 'The sign-in link could not be used.'; } }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(ok => { storageAtRisk = !ok; renderInstallBox(); }).catch(() => {});
  else storageAtRisk = true;
  renderAll();
  if (linkMsg) popup('Sign-in link', linkMsg, [{ label: 'OK', cls: 'primary' }]);
  if (driveMsgBoot) popup('Google Drive', driveMsgBoot, [{ label: 'OK', cls: 'primary' }]);
  else if (driveQp && drive) toast('Google Drive connected as ' + (drive.email || 'your account'));
  if (sharedN === 'err') toast('The shared pictures could not be received. Try again from the gallery.');
  takeShared();

  let resume = ''; try { resume = sessionStorage.getItem(RESUME_KEY) || ''; sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
  const rp = resume && byId(resume); if (rp && !rp.deleted && !linkMsg) openView(rp);

  if (session) syncNow().then(() => { if (tokens && !linkMsg && (keyNeed === 'create' || keyNeed === 'enter')) openSheet(); });
  setTimeout(resealAll, 3000); setTimeout(housekeeping, 8000);
  registerSW();
}
// Tidying up, only while nothing else is going on: records that nothing refers to any more.
async function housekeeping() {
  if (!Vault.isOpen() || locked || passive) return;
  if (qLen > 0 || syncing) { setTimeout(housekeeping, 60000); return; }
  const idle = () => qLen === 0 && !syncing && !locked && !passive;
  try {
    const live = new Set(photos.filter(p => !p.deleted).map(p => p.id)), old = Date.now() - 3600000;
    for (const st of ['images', 'thumbs']) for (const id of await idb.keys(st)) {
      if (!idle()) return;
      if (live.has(id)) continue;
      const r = await idb.get(st, id); if (r && (!r.t || r.t < old) && idle() && !live.has(id)) await idb.del(st, id);
    }
    for (const r of await idb.all('shared')) { if (!idle()) return; if (r && r.t && r.t < Date.now() - 864e5) await idb.del('shared', r.id); }      // a parked picture nobody took within a day
  } catch (e) {}
}
window.addEventListener('storage', e => {
  if (e.key === OWNER_KEY && e.newValue && e.newValue !== INSTANCE_ID) { markNeeded = true; if (!passive && !navigator.locks) { instanceLost(); return; } }
  if (e.key !== TICK_KEY || !Vault.isOpen() || locked || passive) return;
  foreignDirty = true;
  mergeStored().then(() => { foreignDirty = false; return syncing ? null : loadSession(); }).then(renderAll).catch(() => {});
});
window.addEventListener('online', () => syncNow());
setInterval(() => { if (passive) return; renderSyncLine(); syncNow(); }, 60000);

window.lbDebug = { get photos() { return photos; }, get session() { return session; }, get keyNeed() { return keyNeed; }, get syncState() { return syncState + (syncMsg ? ': ' + syncMsg : ''); },
  get busy() { return syncing || qLen > 0 || persistQueued; }, get qLen() { return qLen; }, get passive() { return passive; }, get locked() { return locked; }, get updateReady() { return updateReady; },
  get folders() { return folders; }, get drive() { return drive; }, get driveState() { return driveState; }, syncNow, syncRetry, idb, Vault, relock, resealAll, housekeeping, takeShared, fetchFull, fetchThumb, newFolder, movePhotos };
boot().catch(e => fatal('Unexpected error: ' + errText(e)));
