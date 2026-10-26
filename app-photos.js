'use strict';
/* Lieblingsbilder photos: adding pictures (the gallery picker and the share sheet), the date from
   the picture itself, thumbnails, the home grid by month, the viewer, sharing, folders, the
   monthly collage. */
const THUMB = 640, MAX_FILE = 52428800;
let pickerOpen = false, holdReloadUntil = 0, folderFilter = '', selectMode = false; const selected = new Set();
let curPhoto = null, viewList = [], viewUrl = '', viewThumbUrl = '', viewSeq = 0;

// ---------- the date taken, read from the picture (JPEG, WebP and PNG carry it as EXIF) ----------
// Returns { taken: ms or 0, orientation: 1..8 or 0 }. Only the first 512 KB are looked at; a
// picture without a usable date gets the file's own date later. Nothing here throws.
async function exifInfo(file) {
  const out = { taken: 0, orientation: 0 };
  try {
    const buf = await file.slice(0, 524288).arrayBuffer(), u8 = new Uint8Array(buf), dv = new DataView(buf);
    let tiff = -1;
    if (u8[0] === 0xff && u8[1] === 0xd8) {                                      // JPEG: walk the segments to APP1 "Exif"
      let i = 2;
      while (i + 4 < u8.length && u8[i] === 0xff) {
        const m = u8[i + 1], len = dv.getUint16(i + 2);
        if (m === 0xe1 && u8[i + 4] === 0x45 && u8[i + 5] === 0x78 && u8[i + 6] === 0x69 && u8[i + 7] === 0x66) { tiff = i + 10; break; }
        if (m === 0xda || m === 0xd9) break;
        i += 2 + len;
      }
    } else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45) {      // WebP: RIFF chunks, "EXIF"
      let i = 12;
      while (i + 8 <= u8.length) {
        const tag = String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]), len = dv.getUint32(i + 4, true);
        if (tag === 'EXIF') { tiff = i + 8; if (u8[tiff] === 0x45 && u8[tiff + 1] === 0x78) tiff += 6; break; }
        i += 8 + len + (len & 1);
      }
    } else if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {      // PNG: an eXIf chunk
      let i = 8;
      while (i + 8 <= u8.length) {
        const len = dv.getUint32(i), tag = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
        if (tag === 'eXIf') { tiff = i + 8; break; }
        if (tag === 'IDAT' || tag === 'IEND') break;
        i += 12 + len;
      }
    }
    if (tiff < 0 || tiff + 8 > u8.length) return out;
    const le = u8[tiff] === 0x49 && u8[tiff + 1] === 0x49; if (!le && !(u8[tiff] === 0x4d && u8[tiff + 1] === 0x4d)) return out;
    const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
    const ascii = (o, n) => { let s = ''; for (let k = 0; k < n && o + k < u8.length; k++) { const c = u8[o + k]; if (!c) break; s += String.fromCharCode(c); } return s; };
    const dateOf = s => { const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s); if (!m) return 0; const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); return t > 0 && +m[1] > 1900 ? t : 0; };
    const found = {};
    const readIfd = (off, depth) => {
      if (depth > 2 || off + 2 > u8.length || off < 0) return;
      const n = Math.min(u16(off), 200);
      for (let k = 0; k < n; k++) {
        const e = off + 2 + k * 12; if (e + 12 > u8.length) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 })[type] || 0, inline = size * count <= 4, vo = inline ? e + 8 : tiff + u32(e + 8);
        if (tag === 0x8769 && type === 4) readIfd(tiff + u32(e + 8), depth + 1);
        else if (tag === 0x0112 && type === 3) found.orientation = u16(vo);
        else if ((tag === 0x9003 || tag === 0x9004 || tag === 0x0132) && type === 2 && count >= 19 && vo + count <= u8.length) found[tag] = ascii(vo, count);
      }
    };
    readIfd(tiff + u32(tiff + 4), 0);
    out.taken = dateOf(found[0x9003] || '') || dateOf(found[0x9004] || '') || dateOf(found[0x0132] || '');
    out.orientation = found.orientation >= 1 && found.orientation <= 8 ? found.orientation : 0;
  } catch (e) {}
  return out;
}

// ---------- thumbnails: a small JPEG, the long side THUMB, the picture turned the way it was taken ----------
async function decodeImage(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) {}
  try { return await createImageBitmap(blob); } catch (e) {}
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.decoding = 'async'; img.src = url;
    await (img.decode ? img.decode() : new Promise((res, rej) => { img.onload = res; img.onerror = rej; }));
    return img;                                                                 // browsers draw <img> the way it was taken
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
const dims = im => ({ w: im.naturalWidth || im.width, h: im.naturalHeight || im.height });
function toJpeg(canvas, qlt) { return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('encoding failed')), 'image/jpeg', qlt)); }
// returns { blob, w, h } (w, h: the full picture) or null when this browser cannot decode the picture
async function makeThumb(blob) {
  let im; try { im = await decodeImage(blob); } catch (e) { return null; }
  try {
    const { w, h } = dims(im); if (!w || !h) return null;
    const s = Math.min(1, THUMB / Math.max(w, h)), tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
    const cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
    const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0, tw, th);
    return { blob: await toJpeg(cv, 0.82), w, h };
  } catch (e) { return null; } finally { if (im && im.close) im.close(); }
}

// ---------- adding pictures ----------
function pickPhotos() { if (locked || passive) return; pickerOpen = true; $('importInput').click(); }      // the picker hides the app; it is not restarted while the picker is in front
$('addBtn').addEventListener('click', pickPhotos);
$('importInput').addEventListener('cancel', () => { pickerOpen = false; });
window.addEventListener('focus', () => { if (pickerOpen) setTimeout(() => { pickerOpen = false; }, 1500); });
$('importInput').addEventListener('change', e => {
  const all = Array.from(e.target.files || []);
  e.target.value = ''; pickerOpen = false;
  addFiles(all, 'picked');
});
const isImage = f => /^image\//i.test(f.type) || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(f.name || '');
// Every picture is stored as it is (the original bytes, nothing re-encoded), with a thumbnail and
// the date it was taken. One picture that fails does not hold up the others.
function addFiles(all, source) {
  const files = all.filter(isImage);
  if (all.length && !files.length) { toast(all.length === 1 ? 'That file is not a picture.' : 'None of those files is a picture.'); return; }
  if (!files.length || passive || locked) return;
  const res = { n: 0, dated: 0, undated: 0, big: 0, undecoded: 0, failed: 0 };
  for (const f of files) queue(async () => {
    if (passive || locked) return;
    if (f.size + 4096 > MAX_FILE) { res.big++; return; }
    try {
      const id = uid(), ex = await exifInfo(f), t = await makeThumb(f);
      const taken = ex.taken || (f.lastModified > 0 && f.lastModified < Date.now() + 86400000 ? f.lastModified : Date.now());
      await imgPut(id, f);
      if (t) await thumbPut(id, t.blob);
      const now = Date.now();
      const p = migrate({ id, name: f.name || '', type: safeType(f.type) === 'application/octet-stream' ? guessType(f.name) : safeType(f.type), w: t ? t.w : 0, h: t ? t.h : 0, size: f.size,
        taken_at: taken, created_at: now, updated_at: now, folder: folderFilter || '', caption: '', deleted: false, have: true, th: !!t, up: false, tag: '', srv: 0, seen: 0 });
      photos.unshift(p); snap[p.id] = sigOf(p);
      res.n++; if (ex.taken) res.dated++; else res.undated++; if (!t) res.undecoded++;
      save(); renderHome();
    } catch (e) { res.failed++; }
  });
  queue(async () => {
    const parts = [];
    if (res.n) parts.push(res.n === 1 ? '1 photo added' : res.n + ' photos added');
    if (res.undated) parts.push(res.undated === 1 ? '1 without a date in the picture: the file date was used (tap it to change the date)' : res.undated + ' without a date in the picture: the file date was used');
    if (res.undecoded) parts.push(res.undecoded === 1 ? '1 cannot be displayed by this browser; it is stored as it is' : res.undecoded + ' cannot be displayed by this browser; they are stored as they are');
    if (res.big) parts.push(res.big === 1 ? '1 file is larger than 50 MB and was skipped' : res.big + ' files are larger than 50 MB and were skipped');
    if (res.failed) parts.push(res.failed === 1 ? '1 could not be stored' : res.failed + ' could not be stored');
    if (parts.length) toast(parts.join(' · ') + '.');
    if (source === 'shared' && res.n && current() === 'home') { const first = photos.find(p => !p.deleted); if (first) scrollToMonth(monthKey(first.taken_at)); }
  });
}
const guessType = name => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' })[(String(name || '').split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
// Pictures handed over by the share sheet wait in the parking slot (see sw.js) until the app is
// open and the vault is unlocked. They are taken over here, stored encrypted, and the slot is cleared.
async function takeShared() {
  if (passive || locked || !Vault.isOpen()) return;
  let recs = []; try { recs = await idb.all('shared'); } catch (e) { return; }
  if (!recs.length) return;
  const files = [];
  for (const r of recs) { try { if (r && r.blob && r.blob.size) files.push(new File([r.blob], r.name || ('shared-' + dateStamp(r.lastModified) + '.' + extOf(guessType(r.name) !== 'application/octet-stream' ? guessType(r.name) : r.blob.type)), { type: r.blob.type || guessType(r.name), lastModified: r.lastModified || Date.now() })); } catch (e) {} }
  addFiles(files, 'shared');
  queue(async () => { for (const r of recs) await idb.del('shared', r.id).catch(() => {}); });
}

// ---------- home: folders, months, tiles ----------
const thumbUrls = new Map();                                     // id -> object URL of the decrypted thumbnail (memory only)
function dropThumbUrl(id) { const u = thumbUrls.get(id); if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); } }
const thumbJobs = new Map();
async function thumbUrl(p) {
  if (thumbUrls.has(p.id)) return thumbUrls.get(p.id);
  if (thumbJobs.has(p.id)) return thumbJobs.get(p.id);
  const job = (async () => {
    let b = null;
    try { b = p.th ? await thumbGet(p.id) : null; } catch (e) {}
    if (!b && !p.th && typeof fetchThumb === 'function') { try { b = await fetchThumb(p); } catch (e) {} }
    if (!b) return '';
    if (thumbUrls.has(p.id)) return thumbUrls.get(p.id);
    const u = URL.createObjectURL(b); thumbUrls.set(p.id, u); return u;
  })();
  thumbJobs.set(p.id, job);
  try { return await job; } finally { thumbJobs.delete(p.id); }
}
const io = 'IntersectionObserver' in self ? new IntersectionObserver(entries => {
  for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); fillTile(en.target); }
}, { rootMargin: '300px' }) : null;
async function fillTile(el) {
  const p = byId(el.dataset.id); if (!p) return;
  const u = await thumbUrl(p);
  if (!el.isConnected) return;
  const w = el.querySelector('.wait');
  if (u) { const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = u; if (w) el.replaceChild(img, w); else el.prepend(img); }
  else if (w) w.textContent = p.th || p.have ? extOf(p.type).toUpperCase() : (session ? 'cloud' : 'not here');
}
const visible = () => alive().filter(p => !folderFilter || (folderFilter === '\u0000' ? !p.folder : p.folder === folderFilter));
function renderFolders() {
  const names = folderNames(), box = $('folders');
  if (!names.length) { box.hidden = true; if (folderFilter) folderFilter = ''; return; }
  if (folderFilter && folderFilter !== '\u0000' && !names.includes(folderFilter)) folderFilter = '';
  box.hidden = false; box.innerHTML = '';
  const chip = (label, val) => { const b = document.createElement('button'); b.className = 'pill' + (folderFilter === val ? ' on' : ''); b.textContent = label; b.addEventListener('click', () => { folderFilter = val; renderHome(); }); box.appendChild(b); };
  chip('All', '');
  for (const n of names) chip(n, n);
  if (alive().some(p => !p.folder)) chip('No folder', '\u0000');
}
function renderHome() {
  if (!photosLoaded) return;
  renderFolders();
  const list = $('list'), items = visible();
  $('selectBtn').hidden = !items.length; $('selectBtn').textContent = selectMode ? 'Done' : 'Select'; $('selectBtn').classList.toggle('on', selectMode);
  $('selDock').hidden = !selectMode; $('addDock').hidden = selectMode;
  $('selShare').disabled = !selected.size; $('selFolder').disabled = !selected.size; $('selDelete').disabled = !selected.size;
  $('selShare').textContent = selected.size ? 'Share ' + selected.size : 'Share';
  list.classList.toggle('selmode', selectMode);
  if (!items.length) {
    list.innerHTML = '<div class="empty"><b>' + (folderFilter ? 'Nothing in this folder yet' : 'No photos yet') + '</b>' +
      (folderFilter ? 'Open a photo and give it this folder, or add new ones with the plus.' : 'Tap the plus and pick your favourite pictures from the gallery. Or share a picture from any app to Lieblingsbilder.') +
      (SYNC && !session ? '<br><br>Everything is encrypted on this device. Sign in through the menu to keep an encrypted copy in your own cloud and see the same photos on another device.' : '') + '</div>';
    return;
  }
  const frag = document.createDocumentFragment(); let cur = null, grid = null;
  for (const p of items) {
    const k = monthKey(p.taken_at);
    if (k !== cur) {
      cur = k;
      const sec = document.createElement('section'); sec.className = 'month'; sec.dataset.month = k;
      const n = items.filter(x => monthKey(x.taken_at) === k).length;
      sec.innerHTML = '<div class="mhead"><h2>' + esc(fmtMonth(p.taken_at)) + '</h2><span class="n">' + n + (n === 1 ? ' photo' : ' photos') + '</span>' + (n >= 2 ? '<button class="collage">Collage</button>' : '') + '</div><div class="grid"></div>';
      const cb = sec.querySelector('.collage'); if (cb) cb.addEventListener('click', () => makeCollage(k));
      grid = sec.querySelector('.grid'); frag.appendChild(sec);
    }
    const el = document.createElement('div'); el.className = 'tile' + (selected.has(p.id) ? ' sel' : ''); el.dataset.id = p.id;
    el.innerHTML = '<div class="wait">' + (thumbUrls.has(p.id) ? '' : '…') + '</div><div class="tick"></div>' + (!p.have && !selectMode ? '<span class="cl" title="Only in the cloud so far">☁</span>' : '');
    if (thumbUrls.has(p.id)) { const img = new Image(); img.alt = ''; img.src = thumbUrls.get(p.id); el.replaceChild(img, el.firstChild); }
    else if (io) io.observe(el); else fillTile(el);
    tileEvents(el, p);
    grid.appendChild(el);
  }
  list.innerHTML = ''; list.appendChild(frag);
}
// tap opens (or picks, in select mode); a long press starts picking
let pressTimer = null, pressed = false;
function tileEvents(el, p) {
  el.addEventListener('pointerdown', e => { pressed = false; clearTimeout(pressTimer); if (e.button) return; pressTimer = setTimeout(() => { pressed = true; if (!selectMode) setSelectMode(true); toggleSel(p.id); }, 450); });
  const cancel = () => clearTimeout(pressTimer);
  el.addEventListener('pointermove', cancel); el.addEventListener('pointercancel', cancel); el.addEventListener('pointerleave', cancel); el.addEventListener('pointerup', cancel);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', () => { if (pressed) { pressed = false; return; } if (selectMode) toggleSel(p.id); else openView(p); });
}
function toggleSel(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); const el = $('list').querySelector('.tile[data-id="' + id + '"]'); if (el) el.classList.toggle('sel', selected.has(id)); renderHome(); }
function setSelectMode(on) { selectMode = on; if (!on) selected.clear(); renderHome(); }
$('selectBtn').addEventListener('click', () => setSelectMode(!selectMode));
$('selCancel').addEventListener('click', () => setSelectMode(false));
$('menuBtn').addEventListener('click', () => openSheet());
function scrollToMonth(k) { const el = $('list').querySelector('.month[data-month="' + k + '"]'); if (el) el.scrollIntoView({ block: 'start' }); }

// ---------- the full picture: from this device, or fetched from the cloud and kept ----------
let selBusy = false;
async function fullBlob(p, msg) {
  if (p.have) { const b = await imgGet(p.id, p.type); if (b) return b; p.have = false; persist(); }
  if (!session || !Vault.hasCloudKey(session.uid)) throw new Error(session ? 'The encryption password is needed first (menu).' : 'This photo is only in the cloud. Sign in through the menu to fetch it.');
  if (typeof fetchFull !== 'function') throw new Error('not available');
  return fetchFull(p, msg);
}
const fileOf = (p, blob) => new File([blob], (p.name || (dateStamp(p.taken_at) + '.' + extOf(p.type))).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-'), { type: p.type, lastModified: p.taken_at });
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function shareFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { holdReloadUntil = Date.now() + 600000; await navigator.share({ files, title }); return true; }
    catch (e) {
      const n = e && e.name;
      if (n === 'NotAllowedError') popup('Ready to share', files.length === 1 ? files[0].name : files.length + ' photos', [{ label: 'Share', cls: 'primary', fn: () => shareFiles(files, title) }, { label: 'Save to this device', fn: () => { for (const f of files) downloadBlob(f, f.name); } }, { label: 'Cancel', cls: 'quiet' }]);
      else if (n !== 'AbortError' && n !== 'InvalidStateError') toast('Sharing failed: ' + errText(e));
      return false;
    } finally { holdReloadUntil = 0; }
  }
  for (const f of files) { downloadBlob(f, f.name); await new Promise(r => setTimeout(r, 250)); }      // browsers without a share sheet (desktop)
  toast(files.length === 1 ? 'Saved: ' + files[0].name : files.length + ' photos handed to the browser.');
  return true;
}
async function selAction() {
  if (selBusy || !selected.size) return;
  const list = [...selected].map(byId).filter(p => p && !p.deleted); if (!list.length) return;
  selBusy = true; busy(true); $('selShare').disabled = true;
  try {
    const files = []; let i = 0;
    for (const p of list) { i++; files.push(fileOf(p, await fullBlob(p, list.length > 1 ? 'Fetching ' + i + ' of ' + list.length : ''))); }
    if (await shareFiles(files, files.length === 1 ? files[0].name : files.length + ' photos')) setSelectMode(false);
  } catch (e) { toast('Could not prepare the photos: ' + errText(e)); }
  finally { selBusy = false; busy(false); renderHome(); }
}
$('selShare').addEventListener('click', selAction);
$('selFolder').addEventListener('click', () => { const list = [...selected].map(byId).filter(p => p && !p.deleted); if (list.length) folderSheet(list, () => setSelectMode(false)); });
$('selDelete').addEventListener('click', () => { const list = [...selected].map(byId).filter(p => p && !p.deleted); if (list.length) confirmDelete(list, () => setSelectMode(false)); });
function confirmDelete(list, after) {
  popup(list.length === 1 ? 'Delete this photo?' : 'Delete ' + list.length + ' photos?', 'It is removed from Lieblingsbilder' + (SYNC && session ? ' on every device and in the cloud' : '') + '. Your phone\'s own gallery is not touched.', [
    { label: 'Delete', cls: 'danger', fn: async () => { for (const p of list) p.deleted = true; const stored = save(); if (after) after(); if (list.includes(curPhoto)) closeView(); renderAll(); if (await stored) { for (const p of list) await purgePhotoData(p); persist(); } toast(list.length === 1 ? 'Photo deleted' : list.length + ' photos deleted'); } },
    { label: 'Keep', cls: 'quiet' }]);
}

// ---------- folders and dates ----------
function folderSheet(list, after) {
  const names = folderNames(), cur = list.length === 1 ? list[0].folder : '';
  openSheet(() => '<div class="grab"></div><h2>Folder</h2><p>' + (list.length === 1 ? 'Put this photo into a folder, for example Family or Holidays.' : 'Put these ' + list.length + ' photos into a folder.') + '</p>' +
    '<div class="chips" id="fChips">' + names.map(n => '<button class="pill' + (n === cur ? ' on' : '') + '" data-f="' + esc(n) + '">' + esc(n) + '</button>').join('') + '</div>' +
    '<input id="fNew" type="text" placeholder="New folder" autocomplete="off" autocapitalize="sentences" maxlength="40"><button id="fSave" class="btn primary">Save</button>' +
    (cur || list.some(p => p.folder) ? '<button id="fNone" class="btn quiet">No folder</button>' : ''), () => {
      const apply = f => { for (const p of list) p.folder = f; save(); if (after) after(); renderAll(); back(); toast(f ? 'Moved to ' + f : 'Folder removed'); };
      for (const b of $('fChips').querySelectorAll('button')) b.addEventListener('click', () => apply(b.dataset.f));
      $('fSave').addEventListener('click', () => { const f = $('fNew').value.trim().slice(0, 40); if (f) apply(f); else $('fNew').focus(); });
      $('fNew').addEventListener('keydown', e => { if (e.key === 'Enter') $('fSave').click(); });
      if ($('fNone')) $('fNone').addEventListener('click', () => apply(''));
    });
}
const localInput = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
function dateSheet(p) {
  openSheet(() => '<div class="grab"></div><h2>Date taken</h2><p>The month decides where the photo appears and which collage it joins. The date comes from the picture itself when it carries one.</p>' +
    '<input id="dIn" type="datetime-local" value="' + localInput(p.taken_at) + '"><button id="dSave" class="btn primary">Save</button>', () => {
      $('dSave').addEventListener('click', () => { const v = $('dIn').value, t = v ? new Date(v).getTime() : NaN; if (!(t > 0)) { toast('Enter a date.'); return; } p.taken_at = t; save(); renderAll(); back(); toast('Date saved'); });
    });
}

// ---------- viewer ----------
function openView(p) { if (locked || passive) return; curPhoto = p; viewList = visible(); push('view'); renderView(); }
function leaveView() { curPhoto = null; viewList = []; if (viewUrl) URL.revokeObjectURL(viewUrl); viewUrl = ''; viewThumbUrl = ''; $('viewImg').removeAttribute('src'); viewSeq++; }
async function renderView() {
  const p = curPhoto; if (!p || p.deleted) { if (current() === 'view') closeView(); return; }
  const my = ++viewSeq, img = $('viewImg'), msg = $('viewMsg');
  $('viewTitle').innerHTML = esc(fmtDateTime(p.taken_at)) + '<small>' + esc([p.folder, p.name, p.w && p.h ? p.w + '×' + p.h : '', p.size ? fmtSize(p.size) : ''].filter(Boolean).join(' · ')) + '</small>';
  if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = ''; }
  const tu = await thumbUrl(p); if (my !== viewSeq) return;
  if (tu) { img.src = tu; viewThumbUrl = tu; } else img.removeAttribute('src');
  msg.hidden = false; msg.textContent = p.have ? '' : session ? 'Fetching the full picture…' : 'Only the small picture is on this device. Sign in through the menu to fetch the full one.';
  if (!p.have && !session) return;
  try {
    const b = await fullBlob(p); if (my !== viewSeq) return;
    const u = URL.createObjectURL(b);
    const test = new Image(); test.src = u;
    try { await test.decode(); } catch (e) { URL.revokeObjectURL(u); msg.textContent = 'This browser cannot display this kind of picture (' + extOf(p.type).toUpperCase() + '). Share or save it to open it elsewhere.'; return; }
    if (my !== viewSeq) { URL.revokeObjectURL(u); return; }
    viewUrl = u; img.src = u; msg.hidden = true;
    renderHome();                                                   // the cloud mark on its tile
  } catch (e) { if (my === viewSeq) { msg.hidden = false; msg.textContent = errText(e); } }
}
function stepView(dir) {
  if (!curPhoto) return;
  const i = viewList.indexOf(curPhoto), n = viewList[i + dir];
  if (!n) return;
  curPhoto = n; if (viewUrl) URL.revokeObjectURL(viewUrl); viewUrl = ''; renderView();
}
let swipeX = null, swipeY = null;
$('viewStage').addEventListener('pointerdown', e => { if (e.isPrimary) { swipeX = e.clientX; swipeY = e.clientY; } });
$('viewStage').addEventListener('pointerup', e => { if (swipeX == null) return; const dx = e.clientX - swipeX, dy = e.clientY - swipeY; swipeX = swipeY = null; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepView(dx < 0 ? 1 : -1); });
$('viewStage').addEventListener('pointercancel', () => { swipeX = swipeY = null; });
document.addEventListener('keydown', e => { if (current() !== 'view' || locked || stack[stack.length - 1] !== 'view') return; if (e.key === 'ArrowRight') stepView(1); else if (e.key === 'ArrowLeft') stepView(-1); else if (e.key === 'Escape') back(); });
$('viewBack').addEventListener('click', back);
let viewSharing = false;
$('viewShare').addEventListener('click', async () => {
  const p = curPhoto; if (!p || viewSharing) return;
  viewSharing = true; busy(true);
  try { await shareFiles([fileOf(p, await fullBlob(p))], p.name || fmtDate(p.taken_at)); } catch (e) { toast('Could not share: ' + errText(e)); }
  finally { viewSharing = false; busy(false); }
});
$('viewDate').addEventListener('click', () => { if (curPhoto) dateSheet(curPhoto); });
$('viewFolder').addEventListener('click', () => { if (curPhoto) folderSheet([curPhoto]); });
$('viewDelete').addEventListener('click', () => { if (curPhoto) confirmDelete([curPhoto]); });
$('viewMore').addEventListener('click', () => {
  const p = curPhoto; if (!p) return;
  openSheet(() => '<div class="grab"></div><h2>This photo</h2>' +
    '<div class="statecard"><div class="t">' + esc(p.name || 'Photo') + '</div><div class="s">Taken ' + esc(fmtDateTime(p.taken_at)) + '<br>Added ' + esc(fmtDateTime(p.created_at)) + (p.w ? '<br>' + p.w + ' × ' + p.h + ' px' : '') + (p.size ? ' · ' + esc(fmtSize(p.size)) : '') +
    '<br>' + (p.have ? 'Stored on this device, encrypted' : 'Only the thumbnail is on this device') + (SYNC && session ? (p.up ? ' · encrypted copy in the cloud' : ' · waiting for the cloud') : '') + '</div></div>' +
    '<input id="capIn" type="text" placeholder="Caption (optional)" value="' + esc(p.caption) + '" maxlength="200" autocomplete="off"><button id="capSave" class="btn">Save caption</button>' +
    '<button id="saveLocal" class="btn">Save to this device</button>' +
    (!p.have && session ? '<button id="fetchFullBtn" class="btn">Keep the full picture on this device</button>' : ''), () => {
      $('capSave').addEventListener('click', () => { p.caption = $('capIn').value.trim().slice(0, 200); save(); back(); toast('Caption saved'); });
      $('saveLocal').addEventListener('click', async () => { try { const f = fileOf(p, await fullBlob(p)); downloadBlob(f, f.name); toast('Saved: ' + f.name); } catch (e) { toast(errText(e)); } back(); });
      if ($('fetchFullBtn')) $('fetchFullBtn').addEventListener('click', async () => { back(); try { await fullBlob(p); toast('The full picture is on this device now.'); renderAll(); } catch (e) { toast(errText(e)); } });
    });
});

// ---------- the monthly collage: the month's photos on one picture, to share or save ----------
async function makeCollage(k) {
  if (locked || passive) return;
  const list = visible().filter(p => monthKey(p.taken_at) === k).sort((a, b) => a.taken_at - b.taken_at);
  if (!list.length) return;
  const MAXN = 16, pick = list.length <= MAXN ? list : list.filter((_, i) => i % Math.ceil(list.length / MAXN) === 0).slice(0, MAXN);
  busy(true);
  try {
    const cols = pick.length <= 2 ? pick.length : pick.length <= 4 ? 2 : pick.length <= 9 ? 3 : 4, rows = Math.ceil(pick.length / cols);
    const cell = 640, gap = 14, pad0 = 28, head = 96;
    const W = pad0 * 2 + cols * cell + (cols - 1) * gap, H = pad0 * 2 + head + rows * cell + (rows - 1) * gap;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fbf9f5'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1e1c19'; ctx.font = '600 ' + Math.round(head * 0.46) + 'px -apple-system, "Segoe UI", Roboto, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtMonth(pick[0].taken_at), pad0, pad0 + head / 2);
    ctx.font = Math.round(head * 0.24) + 'px -apple-system, "Segoe UI", Roboto, sans-serif'; ctx.fillStyle = '#8a847b'; ctx.textAlign = 'right';
    ctx.fillText(list.length + (list.length === 1 ? ' photo' : ' photos') + (pick.length < list.length ? ' · ' + pick.length + ' shown' : ''), W - pad0, pad0 + head / 2);
    ctx.textAlign = 'left';
    for (let i = 0; i < pick.length; i++) {
      const p = pick[i], x = pad0 + (i % cols) * (cell + gap), y = pad0 + head + Math.floor(i / cols) * (cell + gap);
      ctx.fillStyle = '#e9e5de'; ctx.fillRect(x, y, cell, cell);
      let b = null; try { b = p.th ? await thumbGet(p.id) : (typeof fetchThumb === 'function' ? await fetchThumb(p) : null); } catch (e) {}
      if (!b) continue;
      let im; try { im = await decodeImage(b); } catch (e) { continue; }
      try {
        const { w, h } = dims(im), s = Math.max(cell / w, cell / h), sw = cell / s, sh = cell / s;
        ctx.drawImage(im, (w - sw) / 2, (h - sh) / 2, sw, sh, x, y, cell, cell);
      } finally { if (im.close) im.close(); }
    }
    const blob = await toJpeg(cv, 0.9), name = 'Collage ' + k + '.jpg', url = URL.createObjectURL(blob);
    openSheet(() => '<div class="grab"></div><h2>' + esc(fmtMonth(pick[0].taken_at)) + '</h2><img class="collage" alt="Collage" src="' + url + '"><button id="colShare" class="btn primary">Share</button><button id="colSave" class="btn">Save to this device</button>' +
      '<div class="hint">Made from the small pictures on this device. The collage itself is not stored; make it again any time.</div>', () => {
        const f = new File([blob], name, { type: 'image/jpeg' });
        $('colShare').addEventListener('click', () => shareFiles([f], name));
        $('colSave').addEventListener('click', () => { downloadBlob(f, name); toast('Saved: ' + name); });
      }, () => URL.revokeObjectURL(url));
  } catch (e) { toast('The collage could not be made: ' + errText(e)); }
  finally { busy(false); }
}
