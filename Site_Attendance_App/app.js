'use strict';
/* Site Attendance – offline face-recognition time clock (single shared kiosk device).
   All data stays on this device (IndexedDB). Face data is stored as 128-number descriptors plus a small thumbnail. */

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; e.append(k.nodeType ? k : document.createTextNode(String(k))); }
  return e;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const minsOf = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const tsMins = ts => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const r2 = x => Math.round(x * 100) / 100;

const PUNCHES = [
  { k: 'AM_IN', label: 'Morning Time In', short: 'AM In' },
  { k: 'AM_OUT', label: 'Morning Time Out', short: 'AM Out' },
  { k: 'PM_IN', label: 'Afternoon Time In', short: 'PM In' },
  { k: 'PM_OUT', label: 'Afternoon Time Out', short: 'PM Out' },
  { k: 'OT_OUT', label: 'OT Time Out', short: 'OT Out' },
];
const PL = Object.fromEntries(PUNCHES.map(p => [p.k, p]));
const DEFAULTS = {
  project: 'Tonivic Warehouse – CCTV & AP', pin: '1234', pinChanged: false,
  amStart: '08:00', amEnd: '12:00', pmStart: '13:00', pmEnd: '17:00',
  graceMin: 5, otRound: 30, threshold: 0.5, liveness: true, keepSnaps: true, cooldownSec: 60,
  camera: 'user', lastBackup: 0, teams: ['CCTV Sub-Con', '2nd Sub-Con', 'Our Team'],
};

/* ---------------- storage ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('site-attendance', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('workers', { keyPath: 'id' });
        const p = d.createObjectStore('punches', { keyPath: 'id', autoIncrement: true });
        p.createIndex('date', 'date'); p.createIndex('wd', ['workerId', 'date']);
        d.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('kv');
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); let out;
      const r = fn(t.objectStore(store)); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  all: s => DB.tx(s, 'readonly', o => o.getAll()),
  get: (s, k) => DB.tx(s, 'readonly', o => o.get(k)),
  put: (s, v, k) => DB.tx(s, 'readwrite', o => (k === undefined ? o.put(v) : o.put(v, k))),
  del: (s, k) => DB.tx(s, 'readwrite', o => o.delete(k)),
  idx: (s, i, v) => DB.tx(s, 'readonly', o => o.index(i).getAll(v)),
  clear: s => DB.tx(s, 'readwrite', o => o.clear()),
};

let S = { ...DEFAULTS };
const saveSettings = () => DB.put('kv', S, 'settings');

/* ---------------- state ---------------- */
let video, overlay, stream = null, workers = [], matcher = null, modelsReady = false;
let loopOn = false, state = 'idle', cand = null, unknownFrames = 0, chooseTimer = null, doneTimer = null;
const cooldown = {};
const wById = id => workers.find(w => w.id === id);

/* ---------------- boot ---------------- */
async function init() {
  video = $('#video'); overlay = $('#overlay');
  await DB.open();
  S = { ...DEFAULTS, ...((await DB.get('kv', 'settings')) || {}) };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  $('#projName').textContent = S.project;
  startClock(); bindUI();
  await loadWorkers(); await renderRecent();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  setStatus('Loading face recognition…');
  try { await loadModels(); } catch (e) { setStatus('Could not load the face models: ' + e.message, 'err'); return; }
  await startCamera();
  loopOn = true; tick();
}

async function loadModels() {
  try { await faceapi.tf.setBackend('webgl'); } catch (e) { await faceapi.tf.setBackend('cpu'); }
  await faceapi.tf.ready();
  await faceapi.nets.tinyFaceDetector.loadFromUri('model');
  await faceapi.nets.faceLandmark68Net.loadFromUri('model');
  await faceapi.nets.faceRecognitionNet.loadFromUri('model');
  modelsReady = true;
}

async function startCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: S.camera, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    video.srcObject = stream; await video.play();
    const m = S.camera === 'user'; video.classList.toggle('mirror', m); overlay.classList.toggle('mirror', m);
    setStatus(workers.some(w => w.active !== false) ? 'Look at the camera' : 'No workers enrolled yet – tap Admin to enrol');
  } catch (e) {
    stream = null;
    const insecure = !window.isSecureContext;
    setStatus(insecure ? 'The camera needs the https:// link of this app' : 'Camera blocked – allow camera access for this app (' + e.name + ')', 'err');
  }
}

function startClock() {
  const f = () => {
    const d = new Date();
    $('#clockTime').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    $('#clockDate').textContent = d.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
  };
  f(); setInterval(f, 1000);
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) {}
}

function bindUI() {
  $('#adminBtn').onclick = openAdmin;
  $('#backBtn').onclick = closeAdmin;
  $('#fsBtn').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); };
  $('#cancelPunch').onclick = resetKiosk;
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  document.addEventListener('click', keepAwake, { once: false });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && !$('#modalBox').dataset.locked) closeModal(); });
}

async function loadWorkers() {
  workers = (await DB.all('workers')).sort((a, b) => a.name.localeCompare(b.name));
  buildMatcher();
}
function buildMatcher() {
  const lab = workers.filter(w => w.active !== false && w.descriptors && w.descriptors.length)
    .map(w => new faceapi.LabeledFaceDescriptors(w.id, w.descriptors.map(d => new Float32Array(d))));
  matcher = lab.length ? new faceapi.FaceMatcher(lab, S.threshold) : null;
}

/* ---------------- kiosk loop ---------------- */
function setStatus(t, kind = '') { const s = $('#status'); s.textContent = t; s.className = 'status ' + kind; }
function resetCand() { cand = null; }
const detOpts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

function eyeRatio(lm) {
  const p = lm.positions, d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
  const l = (d(37, 41) + d(38, 40)) / (2 * d(36, 39)), r = (d(43, 47) + d(44, 46)) / (2 * d(42, 45));
  return (l + r) / 2;
}

function drawBox(det, color = '#f5a524') {
  const c = overlay, x = c.getContext('2d');
  if (c.width !== video.videoWidth) { c.width = video.videoWidth; c.height = video.videoHeight; }
  x.clearRect(0, 0, c.width, c.height);
  if (!det) return;
  const b = det.box || det.detection.box; x.lineWidth = 4; x.strokeStyle = color;
  x.beginPath(); x.roundRect ? x.roundRect(b.x, b.y, b.width, b.height, 14) : x.rect(b.x, b.y, b.width, b.height); x.stroke();
}

function snapFrom(v, box, size = 200) {
  const c = document.createElement('canvas'), p = box.width * 0.35;
  const sx = Math.max(0, box.x - p), sy = Math.max(0, box.y - p * 1.2);
  const sw = Math.min(v.videoWidth - sx, box.width + 2 * p), sh = Math.min(v.videoHeight - sy, box.height + 2.2 * p);
  c.width = size; c.height = Math.round(size * sh / sw);
  c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

async function tick() {
  if (!loopOn) return;
  try {
    if (stream && modelsReady && video.readyState >= 2 && (state === 'idle' || state === 'blink')) await step();
  } catch (e) { console.warn(e); }
  setTimeout(tick, state === 'blink' ? 30 : 120);
}

async function step() {
  if (state === 'idle') {
    const r = await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks().withFaceDescriptor();
    if (state !== 'idle') return;
    drawBox(r && r.detection);
    if (!r) { resetCand(); unknownFrames = 0; setStatus(matcher ? 'Look at the camera' : 'No workers enrolled yet – tap Admin to enrol'); return; }
    if (!matcher) return;
    const best = matcher.findBestMatch(r.descriptor);
    if (best.label === 'unknown') {
      resetCand(); unknownFrames++;
      setStatus(unknownFrames > 6 ? 'Face not recognised – please see the supervisor' : 'Hold still…', unknownFrames > 6 ? 'warn' : '');
      return;
    }
    unknownFrames = 0;
    const w = wById(best.label);
    if (cand && cand.id === best.label) { cand.hits++; cand.dists.push(best.distance); }
    else cand = { id: best.label, hits: 1, dists: [best.distance] };
    cand.box = r.detection.box;
    if (cooldown[w.id] && Date.now() - cooldown[w.id] < S.cooldownSec * 1000) { setStatus(`${w.name} – already recorded just now`, 'ok'); return; }
    if (cand.hits < 3) { setStatus('Hold still…'); return; }
    cand.snap = snapFrom(video, r.detection.box);
    if (S.liveness) { state = 'blink'; Object.assign(cand, { t0: Date.now(), ears: [], closed: false, lost: 0 }); setStatus(`Hi ${w.name.split(' ')[0]}! Blink slowly to confirm`, 'info'); }
    else showChoose(w);
  } else if (state === 'blink') {
    const r = await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks();
    if (state !== 'blink' || !cand) return;
    drawBox(r && r.detection, '#38bdf8');
    if (Date.now() - cand.t0 > 8000) { setStatus('Blink not detected – try again', 'warn'); state = 'idle'; resetCand(); return; }
    if (!r) { if (++cand.lost > 15) { state = 'idle'; resetCand(); } return; }
    const e = eyeRatio(r.landmarks); cand.ears.push(e); if (cand.ears.length > 20) cand.ears.shift();
    const sorted = [...cand.ears].sort((a, b) => a - b), base = sorted[Math.floor(sorted.length * 0.8)];
    if (cand.ears.length < 4) return;
    if (!cand.closed && e < base * 0.75) cand.closed = true;
    else if (cand.closed && e > base * 0.9) {
      // blink seen – re-check identity once more so nobody can swap in during the blink
      const v = await faceapi.detectSingleFace(video, detOpts()).withFaceLandmarks().withFaceDescriptor();
      if (state !== 'blink' || !cand) return;
      const b = v && matcher.findBestMatch(v.descriptor);
      if (b && b.label === cand.id) { cand.dists.push(b.distance); cand.snap = snapFrom(video, v.detection.box); showChoose(wById(cand.id)); }
      else { setStatus('Please face the camera and try again', 'warn'); state = 'idle'; resetCand(); }
    }
  }
}

function suggest(done, now = new Date()) {
  const order = PUNCHES.map(p => p.k), m = now.getHours() * 60 + now.getMinutes();
  let last = -1; order.forEach((k, i) => { if (done[k]) last = i; });
  if (last === -1) return m >= minsOf(S.amEnd) - 30 ? 'PM_IN' : 'AM_IN';
  for (let i = last + 1; i < order.length; i++) {
    if (!done[order[i]]) return (order[i] === 'PM_OUT' && m > minsOf(S.pmEnd) + 30) ? 'OT_OUT' : order[i];
  }
  return null;
}

async function showChoose(w) {
  state = 'choose'; drawBox(null);
  const today = dateKey(), ps = await DB.idx('punches', 'wd', [w.id, today]);
  const done = {}; ps.forEach(p => { done[p.type] = p; });
  const sug = suggest(done);
  $('#whoThumb').src = w.thumb || ''; $('#whoThumb').classList.toggle('hidden', !w.thumb); $('#whoName').textContent = w.name; $('#whoTeam').textContent = `${w.id} · ${w.team}${w.role ? ' · ' + w.role : ''}`;
  const g = $('#punchBtns'); g.innerHTML = '';
  for (const p of PUNCHES) {
    const d = done[p.k];
    g.append(el('button', { class: d ? 'donep' : (p.k === sug ? 'primary' : ''), disabled: !!d, onclick: () => recordPunch(w, p.k) },
      p.label, el('small', {}, d ? `Recorded ${hhmm(d.ts)}` : (p.k === sug ? 'Suggested now' : ' '))));
  }
  setStatus(sug ? `${w.name} – choose your punch` : `${w.name} – all punches already recorded today`, 'ok');
  $('#punchPanel').classList.remove('hidden');
  clearTimeout(chooseTimer); chooseTimer = setTimeout(resetKiosk, 15000);
}

async function recordPunch(w, type) {
  clearTimeout(chooseTimer);
  const mean = cand ? cand.dists.reduce((a, b) => a + b, 0) / cand.dists.length : null;
  const p = { workerId: w.id, date: dateKey(), type, ts: Date.now(), snap: S.keepSnaps && cand ? cand.snap : null, source: 'face', dist: mean == null ? null : r2(mean * 1000) / 1000 };
  await DB.put('punches', p);
  cooldown[w.id] = Date.now();
  $('#punchPanel').classList.add('hidden');
  $('#doneName').textContent = w.name; $('#doneType').textContent = PL[type].label; $('#doneTime').textContent = hhmm(p.ts);
  $('#doneCard').classList.remove('hidden'); state = 'done';
  renderRecent();
  clearTimeout(doneTimer); doneTimer = setTimeout(resetKiosk, 3000);
}

function resetKiosk() {
  clearTimeout(chooseTimer); clearTimeout(doneTimer);
  $('#punchPanel').classList.add('hidden'); $('#doneCard').classList.add('hidden');
  resetCand(); state = 'idle'; setStatus(matcher ? 'Look at the camera' : 'No workers enrolled yet – tap Admin to enrol');
}

async function renderRecent() {
  const ps = (await DB.idx('punches', 'date', dateKey())).sort((a, b) => b.ts - a.ts);
  const inToday = new Set(ps.filter(p => p.type === 'AM_IN' || p.type === 'PM_IN').map(p => p.workerId));
  $('#todayCount').textContent = `${inToday.size} timed in`;
  const ol = $('#recentList'); ol.innerHTML = '';
  if (!ps.length) ol.append(el('li', { class: 'muted' }, 'No punches yet today'));
  for (const p of ps.slice(0, 30)) {
    const w = wById(p.workerId);
    ol.append(el('li', {}, el('span', { class: 't' }, hhmm(p.ts)), (p.snap || (w && w.thumb)) ? el('img', { src: p.snap || w.thumb, alt: '' }) : el('span', { class: 'noimg' }, (w ? w.name : '?').charAt(0)),
      el('div', {}, el('div', {}, w ? w.name : p.workerId), el('div', { class: 'muted' }, PL[p.type].short + (p.source === 'manual' ? ' (manual)' : '')))));
  }
}

/* ---------------- modal helpers ---------------- */
function openModal(content, { wide = false, locked = false } = {}) {
  const b = $('#modalBox'); b.innerHTML = ''; b.className = 'modal-box' + (wide ? ' wide' : '');
  if (locked) b.dataset.locked = '1'; else delete b.dataset.locked;
  b.append(content); $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBox').innerHTML = ''; }

function askPin(title = 'Supervisor PIN') {
  return new Promise(res => {
    let v = '';
    const show = el('div', { class: 'pinshow' }), msg = el('div', { class: 'msg err' });
    const upd = () => { show.textContent = '•'.repeat(v.length) || ' '; };
    const press = k => { if (k === '⌫') v = v.slice(0, -1); else if (k === 'OK') { if (v === S.pin) { closeModal(); res(true); } else { msg.textContent = 'Wrong PIN'; v = ''; } } else if (v.length < 8) v += k; upd(); };
    const pad_ = el('div', { class: 'pinpad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].map(k => el('button', { class: k === 'OK' ? 'primary' : '', onclick: () => press(k) }, k)));
    upd();
    openModal(el('div', {}, el('h3', {}, title), show, msg, pad_, el('div', { class: 'btns' }, el('button', { class: 'ghost', onclick: () => { closeModal(); res(false); } }, 'Cancel'))));
  });
}

/* ---------------- admin ---------------- */
let curTab = 'workers', recDate = dateKey();
async function openAdmin() {
  if (!(await askPin())) return;
  loopOn = false; resetKiosk(); drawBox(null);
  $('#kiosk').classList.add('hidden'); $('#admin').classList.remove('hidden');
  $('#adminBtn').classList.add('hidden'); $('#backBtn').classList.remove('hidden');
  await backupBanner();
  showTab(S.pinChanged ? curTab : 'settings');
  if (!S.pinChanged) alertBox('Please change the default PIN (1234) first.');
}
function closeAdmin() {
  closeModal();
  $('#admin').classList.add('hidden'); $('#kiosk').classList.remove('hidden');
  $('#backBtn').classList.add('hidden'); $('#adminBtn').classList.remove('hidden');
  renderRecent(); resetKiosk(); loopOn = true; tick();
}
function alertBox(text) {
  openModal(el('div', {}, el('p', {}, text), el('div', { class: 'btns' }, el('button', { class: 'primary', onclick: closeModal }, 'OK'))));
}
async function backupBanner() {
  const n = (await DB.all('punches')).length, b = $('#backupWarn');
  const old = Date.now() - (S.lastBackup || 0) > 24 * 3600 * 1000;
  if (n && old) { b.textContent = S.lastBackup ? `Last backup: ${new Date(S.lastBackup).toLocaleString('en-PH')}. Make a backup today (Export & backup tab) – if this phone is lost or reset, all records are lost.` : 'No backup made yet. Make one in the Export & backup tab – if this phone is lost or reset, all records are lost.'; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}
function showTab(t) {
  curTab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + t));
  ({ workers: renderWorkers, records: renderRecords, export: renderExport, settings: renderSettings })[t]();
}

/* ---- workers ---- */
function nextId() {
  let n = 1; const ids = new Set(workers.map(w => w.id));
  while (ids.has('W' + String(n).padStart(3, '0'))) n++;
  return 'W' + String(n).padStart(3, '0');
}
function renderWorkers() {
  const box = $('#tab-workers'); box.innerHTML = '';
  const act = workers.filter(w => w.active !== false), ina = workers.filter(w => w.active === false);
  box.append(el('div', { class: 'row' }, el('h3', {}, `Workers (${act.length} active)`), el('button', { class: 'primary shrink', onclick: () => enrolDialog() }, '+ Enrol worker')));
  const card = w => el('div', { class: 'card' + (w.active === false ? ' inactive' : '') },
    w.thumb ? el('img', { src: w.thumb, alt: '' }) : el('div', { class: 'noimg' }),
    el('div', { class: 'meta' }, el('div', { class: 'nm' }, w.name), el('div', { class: 'muted' }, `${w.id} · ${w.team}`), el('div', { class: 'muted' }, (w.role || '') + (w.descriptors && w.descriptors.length ? '' : ' · NO FACE'))),
    el('div', { class: 'acts' },
      el('button', { onclick: () => enrolDialog(w) }, 'Edit'),
      w.active === false ? el('button', { onclick: () => setActive(w, true) }, 'Restore') : el('button', { class: 'danger', onclick: () => setActive(w, false) }, 'Remove')));
  box.append(el('div', { class: 'cards' }, act.map(card)));
  if (ina.length) box.append(el('h3', { style: 'margin-top:18px' }, 'Removed (kept for reports)'), el('div', { class: 'cards' }, ina.map(card)));
  box.append(el('p', { class: 'note' }, 'Removing a worker stops face recognition for them but keeps their attendance records. Tip: enrol everyone in the same light as the kiosk spot, without cap or sunglasses.'));
}
async function setActive(w, on) {
  if (!on && !confirm(`Remove ${w.name}? Their records are kept, but they can no longer clock in.`)) return;
  w.active = on; await DB.put('workers', w); await loadWorkers(); renderWorkers();
}

let enrolTimer = null;
function enrolDialog(existing) {
  const isNew = !existing;
  const w = existing ? JSON.parse(JSON.stringify(existing)) : { id: nextId(), name: '', team: S.teams[0] || '', role: '', descriptors: [], thumb: null, active: true, consent: false };
  const v = el('video', { autoplay: true, playsinline: true, muted: true, class: S.camera === 'user' ? 'mirror' : '' });
  if (stream) { v.srcObject = stream; v.play().catch(() => {}); }
  const fId = el('input', { value: w.id, disabled: !isNew }), fName = el('input', { value: w.name, placeholder: 'e.g. Juan Dela Cruz' });
  const teams = S.teams.includes(w.team) || !w.team ? S.teams : [...S.teams, w.team];
  const fTeam = el('select', {}, teams.map(t => el('option', { value: t, selected: t === w.team }, t)));
  const fRole = el('input', { value: w.role, placeholder: 'e.g. Skilled worker, Sub-lead, Lift operator' });
  const fConsent = el('input', { type: 'checkbox', checked: w.consent });
  const msg = el('div', { class: 'msg' }, w.descriptors.length ? `Face on file (${w.descriptors.length} samples). Re-capture only if recognition is poor.` : 'No face captured yet.');
  const thumb = el('img', { src: w.thumb || '', class: 'snapbig' + (w.thumb ? '' : ' hidden'), style: 'max-width:110px;margin:8px 0 0' });
  const cap = el('button', { class: 'primary wide', onclick: capture }, w.descriptors.length ? 'Re-capture face' : 'Capture face');
  async function capture() {
    if (!stream || !modelsReady) { msg.textContent = 'Camera or face models not ready.'; msg.className = 'msg err'; return; }
    cap.disabled = true;
    const prompts = ['Look straight at the camera', 'Turn your head slightly LEFT', 'Turn your head slightly RIGHT', 'Look straight again', 'Lift your chin a little'];
    const got = []; let th = null;
    for (let i = 0; i < prompts.length; i++) {
      msg.className = 'msg'; msg.textContent = `${prompts[i]}… (${i + 1}/${prompts.length})`;
      await sleep(1100);
      let r = null;
      for (let t = 0; t < 8 && !r; t++) {
        r = await faceapi.detectSingleFace(v, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.6 })).withFaceLandmarks().withFaceDescriptor();
        if (!r) await sleep(150);
      }
      if (r) { got.push(Array.from(r.descriptor, x => Math.round(x * 1e5) / 1e5)); if (!th) th = snapFrom(v, r.detection.box, 160); }
    }
    cap.disabled = false;
    if (got.length < 3) { msg.className = 'msg err'; msg.textContent = 'Could not see the face clearly. Use good front lighting, remove cap/sunglasses, and try again.'; return; }
    if (matcher) {
      const mean = new Float32Array(128); got.forEach(d => d.forEach((x, i) => { mean[i] += x / got.length; }));
      const b = matcher.findBestMatch(mean);
      if (b.label !== 'unknown' && b.label !== w.id) {
        const o = wById(b.label);
        if (!confirm(`This face looks like ${o ? o.name : b.label} (${b.label}), who is already enrolled. Each person should be enrolled only once. Keep this capture anyway?`)) { msg.textContent = 'Capture discarded.'; return; }
      }
    }
    w.descriptors = got; w.thumb = th; thumb.src = th; thumb.classList.remove('hidden');
    msg.className = 'msg ok'; msg.textContent = `Face captured (${got.length} samples). Now tap Save.`;
  }
  async function save() {
    w.name = fName.value.trim(); w.team = fTeam.value; w.role = fRole.value.trim(); w.consent = fConsent.checked;
    if (isNew) w.id = fId.value.trim().toUpperCase();
    const err = !w.id ? 'Enter a worker ID.' : (isNew && wById(w.id)) ? 'That worker ID is already used.' : !w.name ? 'Enter the full name.'
      : !w.consent ? 'The worker must agree to the privacy notice (tick the box).' : w.descriptors.length < 3 ? 'Capture the face first.' : '';
    if (err) { msg.className = 'msg err'; msg.textContent = err; return; }
    w.updated = Date.now(); if (isNew) w.created = Date.now();
    await DB.put('workers', w); await loadWorkers(); closeModal(); renderWorkers();
  }
  openModal(el('div', {},
    el('h3', {}, isNew ? 'Enrol worker' : `Edit ${w.name}`),
    el('div', { class: 'enrol-grid' },
      el('div', {}, el('div', { class: 'enrol-cam' }, v, el('div', { class: 'guide' })), cap, msg, thumb),
      el('div', {},
        el('label', {}, 'Worker ID'), fId, el('label', {}, 'Full name'), fName, el('label', {}, 'Team / company'), fTeam, el('label', {}, 'Role'), fRole,
        el('div', { class: 'consent' },
          el('label', { style: 'display:flex;align-items:flex-start;color:var(--text);margin:0' }, fConsent,
            el('span', {}, 'The worker agrees that their face is used only to record site attendance for this project. Face data and attendance photos stay on this device, are not shared, and are deleted when the project ends. (Data Privacy Act, RA 10173)'))))),
    el('div', { class: 'btns' }, el('button', { class: 'ghost', onclick: closeModal }, 'Cancel'), el('button', { class: 'primary', onclick: save }, 'Save'))), { wide: true, locked: true });
}

/* ---- daily records ---- */
function summarize(ps) {
  const m = {}; ps.forEach(p => { if (!m[p.type] || p.ts < m[p.type].ts) m[p.type] = p; });
  const t = k => (m[k] ? tsMins(m[k].ts) : null);
  const amS = minsOf(S.amStart), amE = minsOf(S.amEnd), pmS = minsOf(S.pmStart), pmE = minsOf(S.pmEnd);
  const seg = (a, b, lo, hi) => (a != null && b != null ? Math.max(0, Math.min(b, hi) - Math.max(a, lo)) : 0);
  const amIn = t('AM_IN'), amOut = t('AM_OUT'), pmIn = t('PM_IN'), pmOut = t('PM_OUT'), otOut = t('OT_OUT');
  const rem = []; let reg = 0;
  const pmEnd = pmOut != null ? pmOut : otOut;
  if (amIn != null && amOut == null && pmIn == null && pmEnd != null) {
    reg = seg(amIn, pmEnd, amS, amE) + seg(amIn, pmEnd, pmS, pmE); rem.push('No lunch punches');
  } else {
    reg = seg(amIn, amOut, amS, amE) + seg(pmIn, pmEnd, pmS, pmE);
    if (amIn != null && amOut == null) rem.push('No AM Out');
    if (amIn == null && amOut != null) rem.push('No AM In');
    if (pmIn != null && pmEnd == null) rem.push('No PM Out');
    if (pmIn == null && pmOut != null) rem.push('No PM In');
  }
  let ot = otOut != null ? Math.max(0, otOut - pmE) : 0;
  if (S.otRound > 0) ot = Math.floor(ot / S.otRound) * S.otRound;
  let late = 0;
  if (amIn != null && amIn > amS + S.graceMin) late += amIn - amS;
  if (pmIn != null && pmIn > pmS + S.graceMin) late += pmIn - pmS;
  if (ps.some(p => p.source === 'manual')) rem.push('Has manual entry');
  return { m, reg: r2(reg / 60), ot: r2(ot / 60), late: Math.round(late), remarks: rem.join('; ') };
}

async function renderRecords() {
  const box = $('#tab-records'); box.innerHTML = '';
  const d = el('input', { type: 'date', value: recDate, onchange: e => { recDate = e.target.value || dateKey(); renderRecords(); } });
  box.append(el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Date'), d), el('div', { class: 'note' }, 'Tap a time to see the photo or correct it. Tap a blank cell to add a missed punch. Every change is logged with a reason.')));
  const ps = await DB.idx('punches', 'date', recDate);
  const by = {}; ps.forEach(p => { (by[p.workerId] = by[p.workerId] || []).push(p); });
  const list = workers.filter(w => w.active !== false || by[w.id]);
  const tb = el('tbody');
  for (const w of list) {
    const s = summarize(by[w.id] || []);
    tb.append(el('tr', {}, el('td', { class: 'name' }, w.name, el('div', { class: 'muted' }, w.team)),
      PUNCHES.map(p => { const x = s.m[p.k]; return el('td', { class: 'cell' + (x ? (x.source === 'manual' ? ' man' : '') : ' empty'), onclick: () => editPunch(w, p.k, x) }, x ? hhmm(x.ts) : '—'); }),
      el('td', {}, s.reg || ''), el('td', {}, s.ot || ''), el('td', { class: s.late ? 'flag' : '' }, s.late ? s.late + 'm' : ''), el('td', { class: 'flag', style: 'text-align:left' }, s.remarks)));
  }
  box.append(el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', { style: 'text-align:left' }, 'Worker'), PUNCHES.map(p => el('th', {}, p.short)), el('th', {}, 'Reg h'), el('th', {}, 'OT h'), el('th', {}, 'Late'), el('th', { style: 'text-align:left' }, 'Remarks'))), tb)));
  box.append(el('div', { class: 'legend' }, 'Blue time = manual entry. Reg h counts only time inside the schedule; OT counts from the end of the afternoon schedule to OT Time Out.'));
  const au = (await DB.all('audit')).filter(a => a.date === recDate).sort((a, b) => b.ts - a.ts);
  if (au.length) {
    box.append(el('h3', { style: 'margin-top:18px' }, 'Corrections on this date'));
    box.append(el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Changed at', 'Worker', 'Punch', 'Action', 'Old', 'New', 'Reason'].map(h => el('th', {}, h)))),
      el('tbody', {}, au.map(a => el('tr', {}, el('td', {}, new Date(a.ts).toLocaleString('en-PH')), el('td', {}, a.name), el('td', {}, PL[a.type].short), el('td', {}, a.action), el('td', {}, a.oldTime || '—'), el('td', {}, a.newTime || '—'), el('td', { style: 'text-align:left' }, a.reason)))))));
  }
}

function editPunch(w, type, p) {
  const tIn = el('input', { type: 'time', value: p ? hhmm(p.ts) : '' }), reason = el('input', { placeholder: 'e.g. forgot to clock in, phone battery dead' });
  const msg = el('div', { class: 'msg err' });
  const audit = (action, oldTime, newTime) => DB.put('audit', { ts: Date.now(), action, workerId: w.id, name: w.name, date: recDate, type, oldTime, newTime, reason: reason.value.trim() });
  async function save() {
    if (!tIn.value) { msg.textContent = 'Enter the time.'; return; }
    if (!reason.value.trim()) { msg.textContent = 'Enter the reason for the change.'; return; }
    const ts = new Date(`${recDate}T${tIn.value}:00`).getTime();
    if (p) { await audit('edited', hhmm(p.ts), tIn.value); p.ts = ts; p.source = 'manual'; await DB.put('punches', p); }
    else { await audit('added', '', tIn.value); await DB.put('punches', { workerId: w.id, date: recDate, type, ts, snap: null, source: 'manual', dist: null }); }
    closeModal(); renderRecords();
  }
  async function del() {
    if (!reason.value.trim()) { msg.textContent = 'Enter the reason for deleting.'; return; }
    await audit('deleted', hhmm(p.ts), ''); await DB.del('punches', p.id); closeModal(); renderRecords();
  }
  openModal(el('div', {},
    el('h3', {}, `${w.name} – ${PL[type].label}`), el('div', { class: 'muted' }, recDate),
    p && p.snap ? el('img', { src: p.snap, class: 'snapbig', style: 'margin-top:10px' }) : null,
    p ? el('div', { class: 'note' }, p.source === 'manual' ? 'Manual entry.' : `Recorded by face at ${new Date(p.ts).toLocaleTimeString('en-PH')}${p.dist != null ? ` (match distance ${p.dist}; lower is closer)` : ''}.`) : el('div', { class: 'note' }, 'No punch recorded. Add it manually below.'),
    el('label', {}, 'Time'), tIn, el('label', {}, 'Reason (required)'), reason, msg,
    el('div', { class: 'btns' }, p ? el('button', { class: 'danger', onclick: del }, 'Delete') : null, el('button', { class: 'ghost', onclick: closeModal }, 'Cancel'), el('button', { class: 'primary', onclick: save }, p ? 'Save change' : 'Add punch'))));
}

/* ---- export & backup ---- */
function monday(d = new Date()) { const x = new Date(d); const k = (x.getDay() + 6) % 7; x.setDate(x.getDate() - k); return dateKey(x); }
function datesBetween(a, b) { const out = []; const d = new Date(a + 'T00:00:00'), e = new Date(b + 'T00:00:00'); while (d <= e) { out.push(dateKey(d)); d.setDate(d.getDate() + 1); } return out; }

async function buildWorkbook(from, to) {
  const all = (await DB.all('punches')).filter(p => p.date >= from && p.date <= to);
  const by = {}; all.forEach(p => { const k = p.workerId + '|' + p.date; (by[k] = by[k] || []).push(p); });
  const daily = [['Date', 'Day', 'Worker ID', 'Name', 'Team', 'Role', 'AM In', 'AM Out', 'PM In', 'PM Out', 'OT Out', 'Regular hrs', 'OT hrs', 'Late (min)', 'Remarks']];
  const tot = {};
  for (const d of datesBetween(from, to)) {
    for (const w of workers) {
      const ps = by[w.id + '|' + d]; if (!ps) continue;
      const s = summarize(ps), g = k => (s.m[k] ? hhmm(s.m[k].ts) : '');
      daily.push([d, new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short' }), w.id, w.name, w.team, w.role || '', g('AM_IN'), g('AM_OUT'), g('PM_IN'), g('PM_OUT'), g('OT_OUT'), s.reg, s.ot, s.late, s.remarks]);
      const t = tot[w.id] = tot[w.id] || { days: 0, reg: 0, ot: 0, late: 0, lates: 0 };
      t.days++; t.reg += s.reg; t.ot += s.ot; t.late += s.late; if (s.late) t.lates++;
    }
  }
  const totals = [['Worker ID', 'Name', 'Team', 'Role', 'Days present', 'Regular hrs', 'OT hrs', 'Total hrs', 'Times late', 'Late (min)']];
  for (const w of workers) { const t = tot[w.id]; if (t) totals.push([w.id, w.name, w.team, w.role || '', t.days, r2(t.reg), r2(t.ot), r2(t.reg + t.ot), t.lates, t.late]); }
  const log = [['Date', 'Time', 'Worker ID', 'Name', 'Punch', 'Source', 'Match distance']];
  all.sort((a, b) => a.ts - b.ts).forEach(p => { const w = wById(p.workerId); log.push([p.date, new Date(p.ts).toLocaleTimeString('en-GB'), p.workerId, w ? w.name : '', PL[p.type].label, p.source === 'manual' ? 'Manual' : 'Face', p.dist == null ? '' : p.dist]); });
  const au = (await DB.all('audit')).filter(a => a.date >= from && a.date <= to).sort((a, b) => a.ts - b.ts);
  const corr = [['Changed at', 'For date', 'Worker ID', 'Name', 'Punch', 'Action', 'Old time', 'New time', 'Reason']];
  au.forEach(a => corr.push([new Date(a.ts).toLocaleString('en-GB'), a.date, a.workerId, a.name, PL[a.type].label, a.action, a.oldTime || '', a.newTime || '', a.reason]));
  const info = [[S.project], ['Attendance report', `${from} to ${to}`], ['Generated', new Date().toLocaleString('en-GB')],
    ['Schedule', `AM ${S.amStart}–${S.amEnd}, PM ${S.pmStart}–${S.pmEnd}; OT counted from ${S.pmEnd} to OT Time Out`],
    ['Rules', `Late after ${S.graceMin} min grace; OT rounded down to ${S.otRound || 1} min blocks; Regular hrs count only time inside the schedule`]];
  const wb = XLSX.utils.book_new();
  const add = (rows, name, widths) => { const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = widths.map(w => ({ wch: w })); if (rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) }; XLSX.utils.book_append_sheet(wb, ws, name); };
  add(daily, 'Daily', [11, 5, 9, 24, 14, 18, 7, 7, 7, 7, 7, 10, 7, 9, 28]);
  add(totals, 'Totals', [9, 24, 14, 18, 11, 11, 8, 9, 10, 10]);
  add(log, 'Punch log', [11, 9, 9, 24, 20, 8, 13]);
  add(corr, 'Corrections', [20, 11, 9, 24, 20, 9, 9, 9, 36]);
  add(info, 'Info', [22, 80]);
  return { wb, n: all.length };
}

function download(blob, name) { const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }

function renderExport() {
  const box = $('#tab-export'); box.innerHTML = '';
  const f = el('input', { type: 'date', value: monday() }), t = el('input', { type: 'date', value: dateKey() }), msg = el('div', { class: 'msg' });
  box.append(el('h3', {}, 'Attendance report (Excel)'),
    el('div', { class: 'row' }, el('div', {}, el('label', {}, 'From'), f), el('div', {}, el('label', {}, 'To'), t),
      el('button', { class: 'primary shrink', onclick: async () => {
        if (!f.value || !t.value || f.value > t.value) { msg.className = 'msg err'; msg.textContent = 'Pick a valid date range.'; return; }
        const { wb, n } = await buildWorkbook(f.value, t.value);
        XLSX.writeFile(wb, `Attendance_${f.value}_to_${t.value}.xlsx`); msg.className = 'msg ok'; msg.textContent = `Report downloaded (${n} punches).`;
      } }, 'Download Excel')), msg,
    el('p', { class: 'note' }, 'Sheets: Daily (one row per worker per day), Totals, Punch log (every punch), Corrections (every manual change with reason).'));
  const snaps = el('input', { type: 'checkbox', checked: true }), bmsg = el('div', { class: 'msg' });
  const file = el('input', { type: 'file', accept: '.json,application/json' });
  box.append(el('h3', { style: 'margin-top:22px' }, 'Backup'),
    el('p', { class: 'note' }, 'Everything lives only on this device. Make a backup at the end of every day and send it to your laptop or Drive. The backup includes enrolled faces, so keep it private.'),
    el('label', { style: 'display:flex;align-items:center;color:var(--text)' }, snaps, 'Include attendance photos (bigger file)'),
    el('div', { class: 'row' }, el('button', { class: 'primary shrink', onclick: async () => {
      const data = { app: 'site-attendance', version: 1, exported: new Date().toISOString(), settings: S, workers: await DB.all('workers'), punches: await DB.all('punches'), audit: await DB.all('audit') };
      if (!snaps.checked) data.punches = data.punches.map(p => ({ ...p, snap: null }));
      download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `Attendance_backup_${dateKey()}.json`);
      S.lastBackup = Date.now(); await saveSettings(); await backupBanner(); bmsg.className = 'msg ok'; bmsg.textContent = 'Backup downloaded.';
    } }, 'Download backup')), bmsg,
    el('h3', { style: 'margin-top:22px' }, 'Restore'),
    el('p', { class: 'note' }, 'Use this on a new or reset phone. It REPLACES all data on this device with the backup.'),
    el('div', { class: 'row' }, file, el('button', { class: 'danger shrink', onclick: async () => {
      const fl = file.files[0]; if (!fl) { bmsg.className = 'msg err'; bmsg.textContent = 'Choose a backup file first.'; return; }
      let data; try { data = JSON.parse(await fl.text()); } catch (e) { data = null; }
      if (!data || data.app !== 'site-attendance') { bmsg.className = 'msg err'; bmsg.textContent = 'That is not a backup from this app.'; return; }
      if (!confirm(`Replace ALL data on this device with the backup from ${data.exported}?`)) return;
      for (const s of ['workers', 'punches', 'audit']) { await DB.clear(s); for (const x of data[s] || []) await DB.put(s, x); }
      S = { ...DEFAULTS, ...data.settings }; await saveSettings(); await loadWorkers();
      $('#projName').textContent = S.project; bmsg.className = 'msg ok'; bmsg.textContent = `Restored ${data.workers.length} workers and ${data.punches.length} punches.`;
    } }, 'Restore')));
}

/* ---- settings ---- */
function renderSettings() {
  const box = $('#tab-settings'); box.innerHTML = '';
  const inp = (k, type = 'text', extra = {}) => el('input', { type, value: S[k], ...extra });
  const f = {
    project: inp('project'), amStart: inp('amStart', 'time'), amEnd: inp('amEnd', 'time'), pmStart: inp('pmStart', 'time'), pmEnd: inp('pmEnd', 'time'),
    graceMin: inp('graceMin', 'number', { min: 0, max: 60 }), cooldownSec: inp('cooldownSec', 'number', { min: 10, max: 600 }),
    otRound: el('select', {}, [[0, 'No rounding'], [15, '15-minute blocks'], [30, '30-minute blocks'], [60, '1-hour blocks']].map(([v, l]) => el('option', { value: v, selected: +S.otRound === v }, l))),
    threshold: el('select', {}, [[0.42, 'Strict (fewer wrong matches, may need 2 tries)'], [0.5, 'Normal (recommended)'], [0.56, 'Relaxed (poor light / masks)']].map(([v, l]) => el('option', { value: v, selected: Math.abs(S.threshold - v) < 0.01 }, l))),
    camera: el('select', {}, [['user', 'Front camera (kiosk)'], ['environment', 'Back camera']].map(([v, l]) => el('option', { value: v, selected: S.camera === v }, l))),
    teams: inp('teams', 'text', { value: S.teams.join(', ') }),
    liveness: el('input', { type: 'checkbox', checked: S.liveness }), keepSnaps: el('input', { type: 'checkbox', checked: S.keepSnaps }),
  };
  const msg = el('div', { class: 'msg' });
  const pin1 = el('input', { type: 'password', inputmode: 'numeric', placeholder: 'New PIN (4–8 digits)' }), pin2 = el('input', { type: 'password', inputmode: 'numeric', placeholder: 'Repeat new PIN' }), pmsg = el('div', { class: 'msg' });
  box.append(
    el('h3', {}, 'Change supervisor PIN'), !S.pinChanged ? el('div', { class: 'banner' }, 'You are still using the default PIN 1234. Change it now.') : null,
    el('div', { class: 'row' }, pin1, pin2, el('button', { class: 'primary shrink', onclick: async () => {
      if (!/^\d{4,8}$/.test(pin1.value)) { pmsg.className = 'msg err'; pmsg.textContent = 'Use 4 to 8 digits.'; return; }
      if (pin1.value !== pin2.value) { pmsg.className = 'msg err'; pmsg.textContent = 'The two PINs do not match.'; return; }
      S.pin = pin1.value; S.pinChanged = true; await saveSettings(); pin1.value = pin2.value = ''; pmsg.className = 'msg ok'; pmsg.textContent = 'PIN changed.';
    } }, 'Change PIN')), pmsg,
    el('h3', { style: 'margin-top:20px' }, 'Project & schedule'),
    el('label', {}, 'Project name (shown on screen and in reports)'), f.project,
    el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Morning start'), f.amStart), el('div', {}, el('label', {}, 'Morning end'), f.amEnd), el('div', {}, el('label', {}, 'Afternoon start'), f.pmStart), el('div', {}, el('label', {}, 'Afternoon end (OT starts)'), f.pmEnd)),
    el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Late grace (minutes)'), f.graceMin), el('div', {}, el('label', {}, 'OT rounding'), f.otRound), el('div', {}, el('label', {}, 'Ignore repeat scans of the same person for (seconds)'), f.cooldownSec)),
    el('label', {}, 'Teams (comma separated)'), f.teams,
    el('h3', { style: 'margin-top:20px' }, 'Recognition'),
    el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Match strictness'), f.threshold), el('div', {}, el('label', {}, 'Camera'), f.camera)),
    el('label', { style: 'display:flex;align-items:center;color:var(--text);margin-top:12px' }, f.liveness, 'Blink check (stops clocking in with a photo of someone)'),
    el('label', { style: 'display:flex;align-items:center;color:var(--text)' }, f.keepSnaps, 'Keep a photo with every punch (for checking disputes)'),
    el('div', { class: 'btns' }, el('button', { class: 'primary', onclick: async () => {
      const t = ['amStart', 'amEnd', 'pmStart', 'pmEnd'].map(k => f[k].value);
      if (t.some(x => !x) || !(minsOf(t[0]) < minsOf(t[1]) && minsOf(t[1]) <= minsOf(t[2]) && minsOf(t[2]) < minsOf(t[3]))) { msg.className = 'msg err'; msg.textContent = 'Check the schedule times (they must be in order).'; return; }
      const camChanged = S.camera !== f.camera.value;
      Object.assign(S, { project: f.project.value.trim() || DEFAULTS.project, amStart: t[0], amEnd: t[1], pmStart: t[2], pmEnd: t[3],
        graceMin: Math.max(0, +f.graceMin.value || 0), otRound: +f.otRound.value, cooldownSec: Math.max(10, +f.cooldownSec.value || 60),
        threshold: +f.threshold.value, camera: f.camera.value, liveness: f.liveness.checked, keepSnaps: f.keepSnaps.checked,
        teams: f.teams.value.split(',').map(s => s.trim()).filter(Boolean) });
      if (!S.teams.length) S.teams = [...DEFAULTS.teams];
      await saveSettings(); buildMatcher(); $('#projName').textContent = S.project;
      if (camChanged) await startCamera();
      msg.className = 'msg ok'; msg.textContent = 'Settings saved.';
    } }, 'Save settings')), msg,
    el('h3', { style: 'margin-top:24px' }, 'End of project'),
    el('p', { class: 'note' }, 'When the project is finished and the final report is exported, erase all faces, photos and records from this device.'),
    el('button', { class: 'danger', onclick: async () => {
      const a = prompt('This erases ALL workers, faces, photos and attendance records on this device. Type DELETE to confirm.');
      if (a !== 'DELETE') return;
      for (const s of ['workers', 'punches', 'audit']) await DB.clear(s);
      await loadWorkers(); msg.className = 'msg ok'; msg.textContent = 'All data erased.';
    } }, 'Erase all data'),
    el('p', { class: 'note', style: 'margin-top:20px' }, 'Face recognition runs entirely on this device; no internet is needed after the first load.'));
}

window.__att = { DB, summarize, suggest, buildWorkbook, get S() { return S; }, loadWorkers, renderRecent, PUNCHES };
init().catch(e => setStatus('Startup error: ' + e.message, 'err'));
