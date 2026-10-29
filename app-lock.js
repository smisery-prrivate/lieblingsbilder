'use strict';
/* Lieblingsbilder lock screen and the sheets (the menu with cloud sync and the app lock, and the
   small sheets of the viewer). Taken over from Snapdoc. */
let locked = false, softLock = false, unlocking = false, hiddenAt = 0, pinStep = false, hideTimer = null, softTimer = null, storageAtRisk = false;
const unlockWaiters = [];
const COVERED = ['home', 'view', 'sheet'];
const lockAfterMs = () => (+settings.lockAfter || 0) * 1000;
// Only work that ends by itself counts as in flight: pictures being stored, a sync, a list write
// waiting, the share sheet or the photo picker in front of the app. A screen that is merely open
// (the viewer) is remembered and reopened after the unlock instead.
const workInFlight = () => qLen > 0 || syncing || persistQueued || Date.now() < holdReloadUntil || pickerOpen || selBusy || viewSharing || busyN > 0;

// ---------- lock screen ----------
// soft = shown over a running app because work is still in flight; the page restarts (and the key
// leaves memory) as soon as that work is done. Either way nothing under the lock can be operated.
function showLock(soft) {
  let n = 0; for (let i = stack.length - 1; i > 0 && (stack[i] === 'popup' || stack[i] === 'sheet' || stack[i] === 'fan'); i--) n++;
  if (n) { if (popupState) popupState.after = null; history.go(-n); }          // popups and the menu close without acting
  locked = true; softLock = !!soft;
  for (const id of COVERED) $(id).inert = true;
  $('toast').classList.remove('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const pin = Vault.lockType() === 'pin', num = Vault.pinIsNumeric(), inp = $('pinInput');
  $('lock').hidden = false; $('lockErr').textContent = '';
  inp.hidden = !pin; inp.value = ''; inp.inputMode = num ? 'numeric' : 'text'; inp.placeholder = num ? 'PIN' : 'Password';
  $('lockText').textContent = pin ? 'Enter your ' + (num ? 'PIN' : 'password') + ' to open your photos.' : 'Unlock with your fingerprint or screen lock.';
  if (pin) setTimeout(() => inp.focus(), 100); else if (!document.hidden) setTimeout(tryUnlock, 300);
  clearInterval(softTimer);
  if (soft) softTimer = setInterval(() => { if (!locked || !softLock) { clearInterval(softTimer); return; } if (!workInFlight() && !unlocking && !$('pinInput').value) restartLocked(true); }, 1500);
}
let unlockCtl = null, unlockRun = null, unlockSeq = 0;
async function tryUnlock() {
  if (!locked) return;
  const pin = Vault.lockType() === 'pin', secret = $('pinInput').value;
  if (pin && (!secret || unlocking)) return;
  const my = ++unlockSeq;
  if (unlockCtl) { unlockCtl.abort(); unlockCtl = null; }
  if (unlockRun) { try { await unlockRun; } catch (e) {} }
  if (my !== unlockSeq || !locked) return;
  const ctl = unlockCtl = pin ? null : new AbortController();
  unlocking = true; $('lockErr').textContent = pin ? 'Checking…' : '';
  const run = unlockRun = Vault.unlock(secret, ctl ? ctl.signal : undefined);
  try {
    await run;
    locked = false; softLock = false; unlockCtl = null; clearInterval(softTimer);
    for (const id of COVERED) $(id).inert = false;
    $('lock').hidden = true; $('pinInput').value = ''; $('lockErr').textContent = '';
    while (unlockWaiters.length) unlockWaiters.shift()();
    if (heldToast) { const m = heldToast; heldToast = ''; toast(m); }
    drainNav();
    takeShared(); syncNow(); resealAll();
  } catch (e) {
    if (my === unlockSeq) $('lockErr').textContent = e && (e.name === 'NotAllowedError' || e.name === 'AbortError') ? 'Not unlocked. Tap Unlock to try again.' : (e && e.message) || 'Not unlocked.';
  } finally { if (unlockRun === run) unlockRun = null; if (my === unlockSeq) unlocking = false; }
}
const whenUnlocked = () => locked ? new Promise(r => unlockWaiters.push(r)) : Promise.resolve();
$('unlockBtn').addEventListener('click', tryUnlock);
$('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
$('lockReset').addEventListener('click', () => popup('Reset Lieblingsbilder on this device?',
  'Everything stored here is erased: photos, lock and sign-in. Photos that were synced come back after you sign in and enter your encryption password again. Photos that were never synced are lost.',
  [{ label: 'Erase and reset', cls: 'danger', fn: () => wipeEverything().then(() => location.reload(), e => popup('Reset', errText(e), [{ label: 'OK', cls: 'primary' }], { lockOk: true })) }, { label: 'Cancel', cls: 'quiet' }], { lockOk: true }));
async function wipeEverything() { try { sessionStorage.setItem(WIPE_KEY, '1'); } catch (e) { throw new Error('This browser blocks session storage. Clear the site data in the browser settings instead.'); } }
async function wipeNow() {
  try { await Vault.wipeBox(); } catch (e) {}
  await idb.wipe();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('lb.')) localStorage.removeItem(k); sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
}
// Lock again. Work in flight is never cut off: the lock screen covers the app at once and the page
// restarts when that work is done. A restart also clears the key and every decrypted image from memory.
function relock() {
  if (!Vault.lockType() || locked || passive) return;
  showLock(true);
  if (!workInFlight()) restartLocked(true);
}
let restarting = false, linkHash = '';
async function restartLocked(soft) {
  if (restarting) return; restarting = true;
  try {
    await waitForQueue();
    const typing = () => soft && (!locked || unlocking || $('pinInput').value);
    if (typing()) { restarting = false; return; }
    const resume = curPhoto ? curPhoto.id : '';
    if (photosLoaded && !(await persist())) {
      if (!locked && Vault.lockType()) showLock(true);
      $('lockErr').textContent = 'Your last changes could not be saved. Trying again…';
      restarting = false; setTimeout(() => restartLocked(soft), 5000); return;
    }
    if (typing()) { restarting = false; return; }
    await swSwitch();
    if (typing()) { restarting = false; return; }
    try { sessionStorage.setItem(RESUME_KEY, resume); } catch (e) {}
    reloadPage();
  } catch (e) { restarting = false; }
}
function reloadPage() {
  let h = linkHash; if (!h) { try { h = sessionStorage.getItem(LINKHASH_KEY) || ''; } catch (e) {} }
  try { sessionStorage.removeItem(LINKHASH_KEY); } catch (e) {}
  if (h) { try { history.replaceState(history.state, '', location.pathname + location.search + h); } catch (e) {} }
  location.reload();
}
// A sign-in link opened in the running app: taken off the address at once and handled by a fresh
// start as soon as nothing is in flight.
function linkOpened() {
  linkHash = location.hash; try { history.replaceState(histState(), '', location.pathname + location.search); } catch (e) {}
  try { sessionStorage.setItem(LINKHASH_KEY, linkHash); } catch (e) {}
  if (passive) return;
  if (locked && !photosLoaded) { reloadPage(); return; }
  const go = () => { if (restarting) return; if (workInFlight()) { setTimeout(go, 1000); return; } restartLocked(false); };
  go();
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.hidden) {
    hiddenAt = Date.now();
    // the photo picker is part of the app's own flow (the plus was tapped a moment ago): it does not count as leaving
    if (Vault.lockType() && !locked && !pickerOpen) hideTimer = setTimeout(() => { if (document.hidden && !pickerOpen) relock(); }, lockAfterMs() + 500);
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (passive || restarting) return;
  const fromPicker = pickerOpen;
  if (pickerOpen) setTimeout(() => { pickerOpen = false; }, 3000);
  if (Vault.lockType() && !locked && !fromPicker && away >= lockAfterMs()) relock();
  if (locked) { if (Vault.lockType() !== 'pin' && !unlocking) tryUnlock(); return; }
  if (!Vault.isOpen()) return;
  takeShared(); syncNow(); checkForUpdate();
});

// ---------- sheets: the menu, and the small sheets of the viewer ----------
// openSheet() opens the menu; openSheet(html, bind, onClose) opens a sheet with that content:
// html() returns the markup, bind() attaches the handlers, onClose() runs when it is gone.
let sheetContent = null;
function openSheet(html, bind, onClose) {
  if (stack.includes('sheet') || locked || passive) return;
  pinStep = false; sheetContent = html ? { html, bind, onClose } : null;
  push('sheet'); renderSheet();
}
function sheetClosed() { $('panel').innerHTML = ''; pinStep = false; const c = sheetContent; sheetContent = null; if (c && c.onClose) { try { c.onClose(); } catch (e) {} } }
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) back(); });
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstallBox(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstallBox(); });
function renderInstallBox() {
  const box = $('installBox'); if (!box) return;
  const unsafe = storageAtRisk && photos.some(p => !p.deleted && p.have && !(session && p.up));
  box.innerHTML = (installEvt ? '<button class="btn primary" id="installBtn">Install on this phone</button>' : '') +
    (unsafe ? '<div class="hint warn">This browser may clear stored photos it has not seen for a while. Install the app or turn on cloud sync so nothing is lost.</div>' : '');
  if (installEvt) $('installBtn').addEventListener('click', async () => { const ev = installEvt; installEvt = null; renderInstallBox(); ev.prompt(); try { await ev.userChoice; } catch (e) {} });
}
function renderSheet() {
  if (!stack.includes('sheet')) return;
  if (sheetContent) { $('panel').innerHTML = sheetContent.html(); if (sheetContent.bind) sheetContent.bind(); return; }
  const n = alive().length, here = alive().filter(p => p.have).length;
  $('panel').innerHTML = '<div class="grab"></div><h2>Folders</h2><div id="folderBox"></div><h2>Cloud sync</h2><div id="syncBox"></div><h2>Google Drive</h2><div id="driveBox"></div><h2>App lock</h2><div id="lockBox"></div>' +
    '<h2>Photos on this device</h2>' +
    '<div class="rowopt"><span>Keep every full-size photo here</span><select id="setKeep"><option value="0">Only the small pictures</option><option value="1">All photos</option></select></div>' +
    '<div class="hint">' + n + (n === 1 ? ' photo' : ' photos') + (SYNC && session ? ', ' + here + ' of them in full size on this device. The others are fetched from the cloud when you open them.' : ', all in full size on this device.') + '</div>' +
    '<h2>App</h2><div id="installBox"></div>' +
    '<div class="hint">Photos are encrypted on this device and encrypted again before they are uploaded. No cookies, no trackers, no third-party scripts.</div>' +
    '<div class="version">Lieblingsbilder · ' + VERSION + '</div>';
  renderFolderBox(); renderSyncBox(); renderDriveBox(); renderLockBox(); renderInstallBox();
  $('setKeep').value = settings.keepAll ? '1' : '0';
  $('setKeep').addEventListener('change', e => { settings.keepAll = e.target.value === '1'; saveSettings(); syncNow(); });
}
const LOCK_TEXT = {
  prf: ['🔒 Locked with fingerprint / screen lock', 'The key to your photos is released only by this phone\'s screen lock.'],
  gate: ['⚠ Fingerprint / screen lock guards the screen only', 'This browser cannot tie the key itself to the screen lock: whoever can read this phone\'s storage can read the photos. Turn the lock off and use a password or long PIN instead, which ties the key.'],
  pin: ['🔒 Locked with a PIN or password', 'The key to your photos is derived from it.']
};
function pinProblem(a) {
  const s = String(a).normalize('NFKC'), n = [...s].length, letters = (s.match(/\p{L}/gu) || []).length, digits = (s.match(/\p{Nd}/gu) || []).length;
  if (letters < 4) return digits < 12 ? 'A PIN needs 12 digits or more. Shorter ones can be guessed by a computer. A password of 8 or more characters with at least 4 letters works too.' : '';
  return n < 8 ? 'Use at least 8 characters with at least 4 letters, or a PIN of 12 digits or more.' : '';
}
function renderLockBox() {
  const box = $('lockBox'); if (!box) return;
  const type = Vault.lockType();
  if (type) {
    box.innerHTML = '<div class="statecard"><div class="t">' + LOCK_TEXT[type][0] + '</div><div class="s">' + LOCK_TEXT[type][1] + (Vault.hasOldKeys() ? '<br>Older photos are being moved under the new key in the background.' : '') + '</div></div>' +
      '<div class="rowopt"><span>Lock again after</span><select id="lockAfter"><option value="0">as soon as the app leaves the screen</option><option value="5">5 seconds away</option><option value="60">1 minute away</option><option value="300">5 minutes away</option><option value="1800">30 minutes away</option></select></div>' +
      '<button class="btn" id="lockNow">Lock now</button><button class="btn quiet" id="lockOff">Turn the lock off</button>';
    $('lockAfter').value = String(+settings.lockAfter || 0);
    $('lockAfter').addEventListener('change', e => { settings.lockAfter = +e.target.value; saveSettings(); });
    $('lockNow').addEventListener('click', () => relock());
    $('lockOff').addEventListener('click', () => popup('Turn the lock off?', 'Anyone who can open this phone can then open your photos.', [
      { label: 'Turn off', cls: 'danger', fn: async () => { try { await Vault.clearLock(); toast('Lock is off'); } catch (e) { toast('Could not turn it off: ' + errText(e)); } renderLockBox(); } },
      { label: 'Keep it on', cls: 'quiet' }]));
    return;
  }
  if (pinStep) {
    box.innerHTML = '<p>Choose a password (8 characters or more, with at least 4 letters) or a long PIN (12 digits or more). It is asked every time the app opens. It cannot be recovered: if you forget it, the app on this device has to be reset.</p>' +
      '<div class="pinform"><input id="pin1" type="password" autocomplete="new-password" placeholder="Password or long PIN"><input id="pin2" type="password" autocomplete="new-password" placeholder="Repeat"></div>' +
      '<button class="btn primary" id="pinSave">Turn the lock on</button><button class="btn quiet" id="pinBack">Back</button><div class="hint" id="lockHint"></div>';
    $('pinBack').addEventListener('click', () => { pinStep = false; renderLockBox(); });
    let saving = false;
    $('pinSave').addEventListener('click', async () => {
      const a = $('pin1').value, b = $('pin2').value, hint = $('lockHint');
      if (saving) return;
      const prob = pinProblem(a); if (prob) { hint.textContent = prob; return; }
      if (a !== b) { hint.textContent = 'The two entries differ.'; return; }
      saving = true; hint.textContent = 'Setting up…';
      try { await Vault.setPin(a); pinStep = false; toast('Lock is on'); renderLockBox(); resealAll(); } catch (e) { hint.textContent = 'Not set up: ' + errText(e); if (Vault.lockType()) { pinStep = false; renderLockBox(); resealAll(); } } finally { saving = false; }
    });
    return;
  }
  box.innerHTML = '<p>Your photos are stored encrypted on this phone. With a lock, the key is released only by your fingerprint or screen lock. Turn it on before you add anything private.</p>' +
    '<button class="btn primary" id="lockOnBio">Use fingerprint / screen lock</button><button class="btn" id="lockOnPin">Use a password or long PIN instead</button><div class="hint" id="lockHint"></div>';
  $('lockOnPin').addEventListener('click', () => { pinStep = true; renderLockBox(); });
  let setting = false;
  $('lockOnBio').addEventListener('click', async () => {
    const hint = $('lockHint'); if (setting) return;
    setting = true;
    try {
      if (!(await Vault.biometricAvailable())) { hint.textContent = 'This device or browser offers no fingerprint or screen lock here. Use a password or long PIN instead.'; return; }
      hint.textContent = 'Confirm with your fingerprint or screen lock. Your phone may ask twice.';
      const t = await Vault.setBiometric();
      if (t === 'gate') gatePopup(); else toast('Lock is on'); renderLockBox(); resealAll();
    } catch (e) { hint.textContent = e && e.name === 'NotAllowedError' ? 'Not set up: it was cancelled. Tap again to retry.' : 'Not set up: ' + errText(e); if (Vault.lockType()) { renderLockBox(); resealAll(); } }
    finally { setting = false; }
  });
}

// ---------- folders in the menu: the list (rename, delete through the sheet) ----------
function renderFolderBox() {
  const box = $('folderBox'); if (!box) return;
  const fl = liveFolders();
  box.innerHTML = (fl.length ? '<div class="list">' + fl.map(f => '<button data-fid="' + esc(f.id) + '">' + esc(f.name || 'Folder') + ' <span class="hint" style="display:inline">· ' + alive().filter(p => p.folder === f.id).length + '</span></button>').join('') + '</div>' : '<p>No folders yet.</p>') + '<button id="fbNew" class="btn">+ New folder</button>' +
    '<div class="hint">Every folder is a compartment with its own key: whoever gets hold of one folder\'s key has that folder, nothing else. Folder names never reach the server in the clear.</div>';
  for (const b of box.querySelectorAll('button[data-fid]')) b.addEventListener('click', () => { const f = folderById(b.dataset.fid); back(); if (f) setTimeout(() => folderManageSheet(f), 50); });
  $('fbNew').addEventListener('click', () => { back(); setTimeout(newFolderSheet, 50); });
}

// this browser could not tie the key to the screen lock: say so at once, and offer the lock that does
function gatePopup() {
  popup('Only the screen is guarded', 'This browser cannot tie the key to your fingerprint or screen lock, so a copy of this phone\'s storage would still open your photos. A password or long PIN ties the key. Use that instead?',
    [{ label: 'Use a password or PIN', cls: 'primary', fn: async () => { try { await Vault.clearLock(); } catch (e) {} pinStep = true; openSheet(); } }, { label: 'Keep the screen lock', cls: 'quiet' }]);
}

// ---------- the lock is set up at the first start, before anything is stored ----------
// Whoever can open this phone must not be able to read the photos: the app asks for the lock
// before the first picture, with the fingerprint as the first choice. "Not now" asks again at the
// next start; nothing is stored without a lock unless the owner decides so every time.
function offerLock() {
  return new Promise(resolve => {
    const box = $('setup'), hint = $('setupHint'); box.hidden = false;
    for (const id of COVERED) $(id).inert = true;
    const done = msg => { box.hidden = true; for (const id of COVERED) $(id).inert = false; if (msg) setTimeout(() => toast(msg), 300); resolve(); };
    let busy = false;
    $('setupBio').addEventListener('click', async () => {
      if (busy) return; busy = true;
      try {
        if (!(await Vault.biometricAvailable())) { hint.textContent = 'This device or browser offers no fingerprint or screen lock here. Use a password or long PIN instead.'; return; }
        hint.textContent = 'Confirm with your fingerprint or screen lock. Your phone may ask twice.';
        const t = await Vault.setBiometric();
        if (t === 'gate') { hint.textContent = 'This browser can only guard the screen, not the key itself. Better: a password or long PIN.'; $('setupBio').hidden = true; $('setupGateOk').hidden = false; return; }
        done('Lock is on');
      } catch (e) { hint.textContent = e && e.name === 'NotAllowedError' ? 'Not set up: it was cancelled. Tap again to retry.' : 'Not set up: ' + errText(e); if (Vault.lockType()) done(); }
      finally { busy = false; }
    });
    $('setupGateOk').addEventListener('click', () => done('Lock is on. On this browser it guards the screen only.'));
    $('setupPinBtn').addEventListener('click', () => { $('setupPinForm').hidden = false; $('setupPinBtn').hidden = true; setTimeout(() => $('setupPin1').focus(), 50); });
    $('setupPinSave').addEventListener('click', async () => {
      const a = $('setupPin1').value, b = $('setupPin2').value; if (busy) return;
      const prob = pinProblem(a); if (prob) { hint.textContent = prob; return; }
      if (a !== b) { hint.textContent = 'The two entries differ.'; return; }
      busy = true; hint.textContent = 'Setting up…';
      try { if (Vault.lockType() === 'gate') await Vault.clearLock(); await Vault.setPin(a); done('Lock is on'); } catch (e) { hint.textContent = 'Not set up: ' + errText(e); if (Vault.lockType()) done(); } finally { busy = false; }
    });
    $('setupSkip').addEventListener('click', () => done(''));
  });
}
