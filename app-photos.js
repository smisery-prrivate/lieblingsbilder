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
  if (!files.length || passive || !Vault.isOpen()) return;      // under a soft lock the vault is still open: pictures from the picker are stored, then the page restarts
  const intoFolder = folderFilter && folderById(folderFilter) ? folderFilter : '';      // added while a folder is open: it goes in there
  const res = { n: 0, dated: 0, undated: 0, big: 0, undecoded: 0, failed: 0, why: '' };
  // The bytes are read right now, all at once: a file handed over by the picker can stop being
  // readable while it waits behind others (Android, pictures a cloud gallery fetches on demand).
  const reads = files.map(f => f.size + 4096 > MAX_FILE ? null : f.arrayBuffer().catch(e => (e instanceof Error ? e : new Error(String(e)))));
  files.forEach((f0, i) => queue(async () => {
    if (passive || !Vault.isOpen()) return;
    if (f0.size + 4096 > MAX_FILE) { res.big++; return; }
    try {
      const buf = await reads[i]; if (buf instanceof Error) throw new Error('the picture could not be read from the gallery (' + errText(buf) + ')');
      const f = new File([buf], f0.name || '', { type: f0.type, lastModified: f0.lastModified });
      const id = uid(), ex = await exifInfo(f), t = await makeThumb(f);
      const taken = ex.taken || (f.lastModified > 0 && f.lastModified < Date.now() + 86400000 ? f.lastModified : Date.now());
      await imgPut(id, f);
      if (t) await thumbPut(id, t.blob);
      const now = Date.now();
      const p = migrate({ id, name: f.name || '', type: safeType(f.type) === 'application/octet-stream' ? guessType(f.name) : safeType(f.type), w: t ? t.w : 0, h: t ? t.h : 0, size: f.size,
        taken_at: taken, created_at: now, updated_at: now, folder: intoFolder, caption: '', deleted: false, have: true, th: !!t, up: false, tag: '', srv: 0, seen: 0 });
      photos.unshift(p); snap[p.id] = sigOf(p);
      res.n++; if (ex.taken) res.dated++; else res.undated++; if (!t) res.undecoded++;
      save(); renderHome();
    } catch (e) { res.failed++; if (!res.why) res.why = errText(e); }
  }));
  queue(async () => {
    const parts = [];
    if (res.n) parts.push(res.n === 1 ? '1 photo added' : res.n + ' photos added');
    if (res.undated) parts.push(res.undated === 1 ? '1 without a date in the picture: the file date was used (tap it to change the date)' : res.undated + ' without a date in the picture: the file date was used');
    if (res.undecoded) parts.push(res.undecoded === 1 ? '1 cannot be displayed by this browser; it is stored as it is' : res.undecoded + ' cannot be displayed by this browser; they are stored as they are');
    if (res.big) parts.push(res.big === 1 ? '1 file is larger than 50 MB and was skipped' : res.big + ' files are larger than 50 MB and were skipped');
    if (res.failed) parts.push((res.failed === 1 ? '1 could not be stored' : res.failed + ' could not be stored') + (res.why ? ': ' + res.why : ''));
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
const TOP = '\u0001';      // the "Top" view: only starred photos, still by month
const visible = () => alive().filter(p => !folderFilter || (folderFilter === TOP ? p.star : folderFilter === '\u0000' ? !p.folder : p.folder === folderFilter));
function renderFolders() {
  const fl = liveFolders(), box = $('folders'), stars = alive().filter(p => p.star).length;
  if (!fl.length && !alive().length) { box.hidden = true; if (folderFilter) folderFilter = ''; return; }
  if (folderFilter === TOP && !stars) folderFilter = '';
  if (folderFilter && folderFilter !== '\u0000' && folderFilter !== TOP && !folderById(folderFilter)) folderFilter = '';
  box.hidden = false; box.innerHTML = '';
  const chip = (label, val) => { const b = document.createElement('button'); b.className = 'pill' + (folderFilter === val ? ' on' : '') + (val === TOP ? ' top' : ''); b.textContent = label; b.addEventListener('click', () => { folderFilter = val; renderHome(); }); box.appendChild(b); };
  chip('All', '');
  if (stars) chip('★ Top ' + stars, TOP);
  for (const f of fl) chip(f.name || 'Folder', f.id);
  if (fl.length && alive().some(p => !p.folder)) chip('No folder', '\u0000');
  const nb = document.createElement('button'); nb.className = 'pill new'; nb.textContent = '+ New folder'; nb.addEventListener('click', newFolderSheet); box.appendChild(nb);
}
// a new, empty folder; it opens at once, so the plus adds straight into it
function newFolderSheet() {
  openSheet(() => '<div class="grab"></div><h2>New folder</h2><p>A folder is a compartment with its own key. Make it, then tap the plus to add photos into it, or hold a photo to move it here.</p>' +
    '<input id="nfIn" type="text" placeholder="Folder name, e.g. Familie" maxlength="40" autocomplete="off" autocapitalize="sentences"><button id="nfSave" class="btn primary">Make the folder</button>', () => {
      setTimeout(() => { const i = $('nfIn'); if (i) i.focus(); }, 80);
      $('nfSave').addEventListener('click', async () => {
        const name = $('nfIn').value.trim().slice(0, 40); if (!name) { $('nfIn').focus(); return; }
        try { const f = await newFolder(name); save(); back(); folderFilter = f.id; renderAll(); toast('"' + f.name + '" is open: tap the plus to add photos into it.'); } catch (e) { toast('Could not make the folder: ' + errText(e)); }
      });
      $('nfIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('nfSave').click(); });
    });
}
function renderHome() {
  if (!photosLoaded) return;
  renderFolders();
  const list = $('list'), items = visible();
  $('selectBtn').hidden = !items.length; $('selectBtn').textContent = selectMode ? 'Done' : 'Select'; $('selectBtn').classList.toggle('on', selectMode);
  $('selDock').hidden = !selectMode; $('addDock').hidden = selectMode;
  const own = true, allStar = selected.size > 0 && [...selected].every(id => { const p = byId(id); return p && p.star; });
  $('selShare').disabled = !selected.size; $('selFolder').disabled = !selected.size || !own; $('selDelete').disabled = !selected.size || !own; $('selStar').disabled = !selected.size || !own;
  $('selStar').textContent = allStar ? '☆' : '★'; $('selStar').title = allStar ? 'Remove the star' : 'Mark as top';
  $('selShare').textContent = selected.size ? 'Share ' + selected.size : 'Share';
  list.classList.toggle('selmode', selectMode);
  if (!items.length) {
    list.innerHTML = '<div class="empty"><b>' + (folderFilter === TOP ? 'No top photos yet' : folderFilter ? 'Nothing in this folder yet' : 'No photos yet') + '</b>' +
      (folderFilter === TOP ? 'Open a photo and tap the star: the best of the best collect here, by month.' : folderFilter ? 'Open a photo and give it this folder, or add new ones with the plus.' : 'Tap the plus and pick your favourite pictures from the gallery. Or share a picture from any app to Lieblingsbilder.') +
      (SYNC && !session ? '<br><br>Everything is encrypted on this device. Sign in through the menu to keep an encrypted copy in your own cloud and see the same photos on another device.' : '') + '</div>';
    return;
  }
  const frag = document.createDocumentFragment(); let cur = null, grid = null;
  for (const p of items) {
    const k = monthKey(p.taken_at);
    if (k !== cur) {
      cur = k;
      const sec = document.createElement('section'); sec.className = 'month'; sec.dataset.month = k;
      const n = items.filter(x => monthKey(x.taken_at) === k).length, st = items.filter(x => monthKey(x.taken_at) === k && x.star).length;
      sec.innerHTML = '<div class="mhead"><h2>' + esc(fmtMonth(p.taken_at)) + '</h2><span class="n">' + n + (n === 1 ? ' photo' : ' photos') + (st && folderFilter !== TOP ? ' · ' + st + ' ★' : '') + '</span>' + (n >= 2 ? '<button class="collage">' + (folderFilter === TOP ? 'Top collage' : 'Collage') + '</button>' : '') + '</div><div class="grid"></div>';
      const cb = sec.querySelector('.collage'); if (cb) cb.addEventListener('click', () => makeCollage(k));
      grid = sec.querySelector('.grid'); frag.appendChild(sec);
    }
    const el = document.createElement('div'); el.className = 'tile' + (selected.has(p.id) ? ' sel' : ''); el.dataset.id = p.id;
    el.innerHTML = '<div class="wait">' + (thumbUrls.has(p.id) ? '' : '…') + '</div><div class="tick"></div>' + (!p.have && !selectMode ? '<span class="cl" title="Only in the cloud so far">☁</span>' : '') + '<button class="starbtn' + (p.star ? ' on' : '') + '" title="' + (p.star ? 'Remove the star' : 'Mark as top') + '" aria-label="Star">' + (p.star ? '★' : '☆') + '</button>';
    if (thumbUrls.has(p.id)) { const img = new Image(); img.alt = ''; img.src = thumbUrls.get(p.id); el.replaceChild(img, el.firstChild); }
    else if (io) io.observe(el); else fillTile(el);
    tileEvents(el, p);
    grid.appendChild(el);
  }
  list.innerHTML = ''; list.appendChild(frag);
}
// tap opens (or picks, in select mode); a long press starts picking
let pressTimer = null, pressed = false;
// a tap on the star corner marks the photo as top (or takes the star away) without opening it
function setStar(p, on) { if (p.star === on) return; p.star = on; save(); renderHome(); if (curPhoto === p) renderView(); }
function tileEvents(el, p) {
  const sb = el.querySelector('.starbtn');
  if (sb) sb.addEventListener('click', e => { e.stopPropagation(); clearTimeout(pressTimer); pressed = false; setStar(p, !p.star); });
  // A long press opens the folders for this picture (and offers to pick several); in the pick list
  // it picks. A finger never holds perfectly still, so the press survives small moves (Snapdoc's
  // 10 px); a real move (a scroll) cancels it, and so does the browser taking the gesture.
  let x0 = 0, y0 = 0;
  el.addEventListener('pointerdown', e => {
    pressed = false; clearTimeout(pressTimer); if (e.button || e.target.closest('.starbtn')) return;
    x0 = e.clientX; y0 = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null; pressed = true; setTimeout(() => { pressed = false; }, 600);      // the click that follows the press is swallowed
      if (navigator.vibrate) navigator.vibrate(20);
      if (selectMode) toggleSel(p.id); else openFan(el, p);
    }, 450);
  });
  // pointercancel is NOT the end of a press: browsers fire it when they take the gesture (the image
  // drag with a mouse, the context menu on a phone). A real scroll ends it, see the list's scroll listener.
  const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
  el.addEventListener('pointermove', e => { if (pressTimer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) cancel(); });
  el.addEventListener('pointerleave', cancel); el.addEventListener('pointerup', cancel);
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', () => { if (pressed) { pressed = false; return; } if (selectMode) toggleSel(p.id); else openView(p); });
}
$('list').addEventListener('scroll', () => { clearTimeout(pressTimer); pressTimer = null; if (fanFor) back(); }, { passive: true });      // scrolling is not pressing, and closes the fan
// ---------- the fan: the folders, opened right under the pressed tile ----------
// A small panel centred on the tile (above it when there is no room below): the existing folders
// as chips, a field for a new one, "No folder", and "Select several". One tap moves the photo.
let fanFor = null;
function openFan(el, p) {
  if (fanFor || locked || passive) return;
  const fan = $('fan'), box = $('fanBox'), fl = liveFolders();
  box.innerHTML = '<div class="fanchips">' + fl.map(f => '<button class="pill' + (f.id === p.folder ? ' on' : '') + '" data-f="' + esc(f.id) + '">' + esc(f.name || 'Folder') + '</button>').join('') +
    '<button class="pill new" id="fanNew">+ New folder</button></div>' +
    '<div class="fannew" id="fanNewRow" hidden><input id="fanIn" type="text" placeholder="Folder name" maxlength="40" autocomplete="off" autocapitalize="sentences"><button id="fanSave" class="pill on">Save</button></div>' +
    '<div class="fanrow">' + (p.folder ? '<button id="fanNone" class="link">No folder</button>' : '') + '<button id="fanMore" class="link">Select several…</button></div>';
  fanFor = p; fan.hidden = false;
  const r = el.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const w = Math.min(300, vw - 24); box.style.width = w + 'px';
  const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw - w - 12));
  const h = box.offsetHeight, below = r.bottom + 8 + h <= vh - 8;
  box.style.left = left + 'px'; box.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - 8 - h)) + 'px';
  box.classList.toggle('up', !below);
  box.style.setProperty('--arrow', Math.max(14, Math.min(w - 14, r.left + r.width / 2 - left)) + 'px');
  const apply = fid => movePhotos([p], fid).then(() => { back(); }).catch(e => toast('Could not move: ' + errText(e)));
  for (const b of box.querySelectorAll('button[data-f]')) b.addEventListener('click', () => apply(b.dataset.f));
  $('fanNew').addEventListener('click', () => { $('fanNewRow').hidden = false; $('fanNew').hidden = true; setTimeout(() => { const i = $('fanIn'); if (i) i.focus(); }, 50); });      // the fan may be gone again by then
  $('fanSave').addEventListener('click', async () => { const name = $('fanIn').value.trim().slice(0, 40); if (!name) { $('fanIn').focus(); return; } try { apply((await newFolder(name)).id); } catch (e) { toast('Could not make the folder: ' + errText(e)); } });
  $('fanIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('fanSave').click(); });
  if ($('fanNone')) $('fanNone').addEventListener('click', () => apply(''));
  $('fanMore').addEventListener('click', () => { back(); setTimeout(() => { setSelectMode(true); if (!selected.has(p.id)) toggleSel(p.id); }, 50); });
  push('fan');
}
function fanClosed() { fanFor = null; $('fan').hidden = true; $('fanBox').innerHTML = ''; }
$('fan').addEventListener('pointerdown', e => { if (e.target === $('fan')) back(); });      // a tap beside the fan closes it
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
  if (!haveKeyFor(p)) throw new Error(session ? (p.folder ? 'The key of this folder is not on this device yet.' : 'The encryption password is needed first (menu).') : 'This photo is only in the cloud. Sign in through the menu to fetch it.');
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
$('selStar').addEventListener('click', () => { const list = [...selected].map(byId).filter(p => p && !p.deleted); if (!list.length) return; const on = !list.every(p => p.star); for (const p of list) p.star = on; save(); renderAll(); toast(on ? (list.length === 1 ? 'Marked as top' : list.length + ' marked as top') : 'Star removed'); });
$('selFolder').addEventListener('click', () => { const list = [...selected].map(byId).filter(p => p && !p.deleted); if (list.length) folderSheet(list, () => setSelectMode(false)); });
$('selDelete').addEventListener('click', () => { const list = [...selected].map(byId).filter(p => p && !p.deleted); if (list.length) confirmDelete(list, () => setSelectMode(false)); });
function confirmDelete(list, after) {
  popup(list.length === 1 ? 'Delete this photo?' : 'Delete ' + list.length + ' photos?', 'It is removed from Lieblingsbilder' + (SYNC && session ? ' on every device and in the cloud' : '') + '. Your phone\'s own gallery is not touched.', [
    { label: 'Delete', cls: 'danger', fn: async () => { for (const p of list) p.deleted = true; const stored = save(); if (after) after(); if (list.includes(curPhoto)) closeView(); renderAll(); if (await stored) { for (const p of list) await purgePhotoData(p); persist(); } toast(list.length === 1 ? 'Photo deleted' : list.length + ' photos deleted'); } },
    { label: 'Keep', cls: 'quiet' }]);
}

// ---------- folders and dates ----------
function folderSheet(list, after, opts) {
  const fl = liveFolders(), cur = list.length === 1 ? list[0].folder : '', more = !!(opts && opts.more);
  openSheet(() => '<div class="grab"></div><h2>Folder</h2><p>' + (list.length === 1 ? 'Put this photo into a folder, for example Family or Holidays.' : 'Put these ' + list.length + ' photos into a folder.') + '</p>' +
    '<div class="chips" id="fChips">' + fl.map(f => '<button class="pill' + (f.id === cur ? ' on' : '') + '" data-f="' + esc(f.id) + '">' + esc(f.name || 'Folder') + '</button>').join('') + '</div>' +
    '<input id="fNew" type="text" placeholder="New folder" autocomplete="off" autocapitalize="sentences" maxlength="40"><button id="fSave" class="btn primary">Save</button>' +
    (cur || list.some(p => p.folder) ? '<button id="fNone" class="btn quiet">No folder</button>' : '') +
    (more ? '<button id="fMore" class="btn">Select several…</button>' : ''), () => {
      const apply = fid => movePhotos(list, fid).then(() => { if (after) after(); back(); }).catch(e => toast('Could not move: ' + errText(e)));
      for (const b of $('fChips').querySelectorAll('button')) b.addEventListener('click', () => apply(b.dataset.f));
      $('fSave').addEventListener('click', async () => { const name = $('fNew').value.trim().slice(0, 40); if (!name) { $('fNew').focus(); return; } try { apply((await newFolder(name)).id); } catch (e) { toast('Could not make the folder: ' + errText(e)); } });
      $('fNew').addEventListener('keydown', e => { if (e.key === 'Enter') $('fSave').click(); });
      if ($('fNone')) $('fNone').addEventListener('click', () => apply(''));
      if ($('fMore')) $('fMore').addEventListener('click', () => { back(); setTimeout(() => { setSelectMode(true); for (const p of list) if (!selected.has(p.id)) toggleSel(p.id); }, 50); });
    });
}
// Moving a photo into a folder puts its entry and its small key under that folder's key; the
// files stay where they are. '' takes it out of every folder.
async function movePhotos(list, fid) {
  fid = fid && folderById(fid) ? fid : '';
  for (const p of list) await moveToFolder(p, fid);
  save(); renderAll();
  toast(fid ? 'Moved to ' + (folderName(fid) || 'the folder') : 'Taken out of the folder');
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
  $('viewTitle').innerHTML = esc(fmtDateTime(p.taken_at)) + '<small>' + esc([folderName(p.folder), p.name, p.w && p.h ? p.w + '×' + p.h : '', p.size ? fmtSize(p.size) : ''].filter(Boolean).join(' · ')) + '</small>';
  $('viewStar').innerHTML = '<span>' + (p.star ? '★' : '☆') + '</span>' + (p.star ? 'Top' : 'Star'); $('viewStar').classList.toggle('on', !!p.star);
  if (viewUrl) { URL.revokeObjectURL(viewUrl); viewUrl = ''; }
  const tu = await thumbUrl(p); if (my !== viewSeq) return;
  if (tu) { img.src = tu; viewThumbUrl = tu; } else img.removeAttribute('src');
  msg.hidden = false; msg.textContent = p.have ? '' : haveKeyFor(p) ? 'Fetching the full picture…' : session ? 'The key of this folder is not on this device yet.' : 'Only the small picture is on this device. Sign in through the menu to fetch the full one.';
  if (!p.have && !haveKeyFor(p)) return;
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
let swipeX = null, swipeY = null, lastTap = 0;
$('viewStage').addEventListener('pointerdown', e => { if (e.isPrimary) { swipeX = e.clientX; swipeY = e.clientY; } });
$('viewStage').addEventListener('pointerup', e => {
  if (swipeX == null) return;
  const dx = e.clientX - swipeX, dy = e.clientY - swipeY; swipeX = swipeY = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { stepView(dx < 0 ? 1 : -1); lastTap = 0; return; }
  if (Math.abs(dx) > 12 || Math.abs(dy) > 12) { lastTap = 0; return; }
  const now = Date.now();
  if (now - lastTap < 350) { lastTap = 0; if (curPhoto) folderSheet([curPhoto]); } else lastTap = now;      // two taps on the picture: the folder menu
});
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
$('viewStar').addEventListener('click', () => { const p = curPhoto; if (!p) return; p.star = !p.star; save(); renderView(); renderHome(); toast(p.star ? 'Marked as top ★' : 'Star removed'); });
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
      if ($('capSave')) $('capSave').addEventListener('click', () => { p.caption = $('capIn').value.trim().slice(0, 200); save(); back(); toast('Caption saved'); });
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
    ctx.fillText((folderFilter === TOP ? '★ ' : '') + fmtMonth(pick[0].taken_at), pad0, pad0 + head / 2);
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
    const blob = await toJpeg(cv, 0.9), name = (folderFilter === TOP ? 'Top collage ' : 'Collage ') + k + '.jpg', url = URL.createObjectURL(blob);
    openSheet(() => '<div class="grab"></div><h2>' + (folderFilter === TOP ? '★ ' : '') + esc(fmtMonth(pick[0].taken_at)) + '</h2><img class="collage" alt="Collage" src="' + url + '"><button id="colShare" class="btn primary">Share</button><button id="colSave" class="btn">Save to this device</button>' +
      '<div class="hint">Made from the small pictures on this device. The collage itself is not stored; make it again any time.</div>', () => {
        const f = new File([blob], name, { type: 'image/jpeg' });
        $('colShare').addEventListener('click', () => shareFiles([f], name));
        $('colSave').addEventListener('click', () => { downloadBlob(f, name); toast('Saved: ' + name); });
      }, () => URL.revokeObjectURL(url));
  } catch (e) { toast('The collage could not be made: ' + errText(e)); }
  finally { busy(false); }
}

// ---------- folders in the menu: rename, delete ----------
function folderManageSheet(f) {
  const n = alive().filter(p => p.folder === f.id).length;
  openSheet(() => '<div class="grab"></div><h2>' + esc(f.name || 'Folder') + '</h2><p>' + n + (n === 1 ? ' photo' : ' photos') + '. A folder has its own key: its photos are readable only with it.</p>' +
    '<input id="fnIn" type="text" maxlength="40" value="' + esc(f.name || '') + '" autocomplete="off"><button id="fnSave" class="btn primary">Rename</button>' +
    '<button id="fnDel" class="btn quiet">Delete the folder (the photos stay, without a folder)</button>', () => {
      $('fnSave').addEventListener('click', () => { const name = $('fnIn').value.trim().slice(0, 40); if (!name) { $('fnIn').focus(); return; } f.name = name; save(); back(); renderAll(); toast('Renamed'); });
      $('fnIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('fnSave').click(); });
      $('fnDel').addEventListener('click', () => { back(); setTimeout(() => popup('Delete "' + (f.name || 'Folder') + '"?', 'Its ' + n + (n === 1 ? ' photo stays' : ' photos stay') + ', without a folder. Nothing is deleted from the cloud.', [
        { label: 'Delete the folder', cls: 'danger', fn: async () => { try { await movePhotos(alive().filter(p => p.folder === f.id), ''); f.deleted = true; if (folderFilter === f.id) folderFilter = ''; save(); renderAll(); toast('Folder deleted'); } catch (e) { toast('Could not delete: ' + errText(e)); } } },
        { label: 'Keep', cls: 'quiet' }]), 50); });
    });
}
