#!/usr/bin/env node
/*
 * Reusable UX screenshot harness for the JagaKebond field app (release 0.2.2.0).
 *
 * Serves app/frontend from this checkout, mocks every /api/** call with synthetic fixtures
 * (a signed-in farmer, trees with records of different severities, a plot polygon, a daily
 * log, pending drafts) and captures every main screen and state at phone and desktop size.
 * Nothing here touches production or real data.
 *
 *   node ux-screens-0220.cjs --out ../screenshots/ux-after
 *        [--sizes 390x844,1440x900]   viewport list (default both)
 *        [--only login,home,scan]      comma list of state name prefixes to capture
 *        [--frontend <dir>]            frontend directory to serve (default ../../app/frontend)
 *        [--chrome /usr/bin/google-chrome]  (or env JK_CHROME)
 *        [--landing-assets]            capture landing PNGs from the real app with sample data
 *        [--edge]                      add edge-case fixtures (missing fields, unknown severity)
 *
 * Output: <out>/<NN>-<state>-<w>x<h>.png plus <out>/index.json (file list + console errors).
 * Exit code is 0 unless the harness itself failed; a state that cannot be reached is
 * recorded in index.json under "skipped" and does not abort the run.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { chromium } = require('playwright');

/* ------------------------------------------------------------------ arguments */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = name => args.includes('--' + name);
const OUT = path.resolve(process.cwd(), arg('out', path.join(__dirname, '../screenshots/ux-0220')));
const SIZES = arg('sizes', '390x844,1440x900').split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { const [w, h] = s.split('x').map(Number); return { w, h }; });
const ONLY = arg('only', '').split(',').map(s => s.trim()).filter(Boolean);
const FRONTEND = path.resolve(process.cwd(), arg('frontend', path.join(__dirname, '../../app/frontend')));
const CHROME = arg('chrome', process.env.JK_CHROME || '/usr/bin/google-chrome');
const EDGE = flag('edge');
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ fixtures */
const DAY = 86400000;
const NOW = Date.now();
const ACCOUNT = { id: 'ux-account-1', name: 'Pak Slamet', email: 'slamet@example.test', role: 'user',
  fastQuota: 3, fastUsed: 1, fastRemaining: 2, dailyQuota: 3 };
const GPS = { latitude: -6.2012, longitude: 106.8012, accuracy: 18 };
const PLOT_A = [[-6.2000, 106.8000], [-6.2000, 106.8030], [-6.2025, 106.8030], [-6.2025, 106.8000], [-6.2000, 106.8000]];
const PLOT_B = [[-6.2040, 106.8005], [-6.2040, 106.8040], [-6.2062, 106.8040], [-6.2062, 106.8005], [-6.2040, 106.8005]];
const FARMS = [
  { id: 'farm_a', name: 'Kebun Kopi Atas', crop: 'Kopi', note: 'Dekat sumber air', ring: PLOT_A, areaM2: 7600, source: 'peta', createdMs: NOW - 40 * DAY, updatedMs: NOW - 40 * DAY },
  { id: 'farm_b', name: 'Bedeng Cabai', crop: 'Cabai', note: '', ring: PLOT_B, areaM2: 8100, source: 'gps', createdMs: NOW - 20 * DAY, updatedMs: NOW - 20 * DAY },
];
function record(over) {
  const ts = over.timestampMs ?? NOW - 3600000;
  return Object.assign({
    id: 'rec_x', cropId: null, cropName: null, timestampMs: ts, createdMs: ts, updatedMs: ts,
    crop: 'Cabai', condition: 'Bercak daun', severity: 'Moderate', observedSeverity: null,
    lat: -6.2010, lng: 106.8010, elevation: 724, locationName: 'Ciomas, Kab. Bogor, Jawa Barat', accuracy: 12,
    date: new Date(ts).toISOString().slice(0, 10), symptoms: 'Bercak cokelat bulat pada daun bagian bawah.',
    geocorrelation: 'Kelembapan tinggi sebulan terakhir mendukung jamur daun.',
    immediate_action: 'Buang daun yang bergejala, perbaiki jarak tanam supaya daun cepat kering, dan pantau 3 hari.',
    suitability: 'Sesuai', needs_review: false, confidence: 0.82, farmId: null, deviceId: 'app',
    imageUrl: '/api/photos/leaf1', source: 'ai', cropHint: null, locationSource: 'gps',
  }, over);
}
const RECORDS = [
  record({ id: 'record_job1', cropId: 'tree_cabai1', cropName: 'Cabai bedeng 1', crop: 'Cabai', condition: 'Bercak daun cercospora', severity: 'Severe', lat: -6.2050, lng: 106.8020, farmId: 'farm_b', imageUrl: '/api/photos/leaf1', timestampMs: NOW - 2 * 3600000, confidence: 0.91, needs_review: false }),
  record({ id: 'record_job2', cropId: 'tree_cabai1', cropName: 'Cabai bedeng 1', crop: 'Cabai', condition: 'Daun mulai menguning', severity: 'Moderate', lat: -6.2050, lng: 106.8020, farmId: 'farm_b', imageUrl: '/api/photos/leaf2', timestampMs: NOW - 9 * DAY, confidence: 0.77 }),
  record({ id: 'record_job3', cropId: 'tree_cabai1', cropName: 'Cabai bedeng 1', crop: 'Cabai', condition: 'Tanaman sehat', severity: 'Healthy', lat: -6.2050, lng: 106.8020, farmId: 'farm_b', imageUrl: '/api/photos/leaf3', timestampMs: NOW - 21 * DAY, confidence: 0.9 }),
  record({ id: 'record_job4', cropId: 'tree_kopi1', cropName: 'Kopi pohon depan', crop: 'Kopi', condition: 'Karat daun kopi', severity: 'Moderate', lat: -6.2012, lng: 106.8012, farmId: 'farm_a', imageUrl: '/api/photos/leaf2', timestampMs: NOW - 1 * DAY - 3600000, confidence: 0.64, needs_review: true }),
  record({ id: 'record_job5', cropId: 'tree_jagung1', cropName: 'Jagung pinggir jalan', crop: 'Jagung', condition: 'Tanaman sehat', severity: 'Healthy', lat: -6.2085, lng: 106.8090, farmId: null, imageUrl: '/api/photos/leaf3', timestampMs: NOW - 3 * DAY, confidence: 0.88 }),
  record({ id: 'rec_manual1', cropId: null, cropName: null, crop: 'Teh', condition: 'Pengamatan manual', severity: 'Healthy', lat: null, lng: null, elevation: null, accuracy: null, locationName: null, farmId: null, imageUrl: null, source: 'manual', timestampMs: NOW - 12 * DAY, confidence: null, immediate_action: '', symptoms: null, geocorrelation: null }),
];
if (EDGE) {
  RECORDS.push(
    record({ id: 'rec_edge_nocrop', cropId: null, crop: '', condition: '', severity: 'Belum', lat: -6.2090, lng: 106.8095, imageUrl: null, source: 'manual', timestampMs: NOW - 15 * DAY, confidence: null, immediate_action: null }),
    record({ id: 'rec_edge_unknown_sev', cropId: null, crop: 'Padi', condition: 'Perlu dicek', severity: null, lat: -6.2095, lng: 106.8099, imageUrl: null, source: 'manual', timestampMs: NOW - 16 * DAY, confidence: null }),
  );
}
const DAILY = [
  { id: 'daily_1', date: new Date(NOW - DAY).toISOString().slice(0, 10) + ' (Asia/Jakarta)', timestampMs: NOW - DAY + 3600000,
    title: 'Catatan harian kemarin', summary: 'Pada kemarin Anda menyimpan pembaruan untuk 2 tanaman. Cabai bedeng 1 dicatat waspada dan kopi dicatat sehat.',
    actions: ['Periksa daun bagian bawah cabai', 'Siram pagi hari saja'], sourceRecordIds: ['record_job1', 'record_job4'], zones: ['Kebun Kopi Atas'] },
];
const TELEMETRY = { lat: GPS.latitude, lng: GPS.longitude, elevation: [724], locationName: 'Ciomas, Kab. Bogor, Jawa Barat',
  tempC: 24, rh: 82, weather: '24°C • 82% RH', locationProvider: 'nominatim', locationApproximate: false };

/* ------------------------------------------------------------------ images */
function crc32(buf) {
  let c, crc = -1;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/* A soft, map-like 256x256 tile so Leaflet screenshots are not a black void. */
function tilePng(x, y) {
  const size = 256, raw = Buffer.alloc((size * 3 + 1) * size);
  for (let r = 0; r < size; r++) {
    raw[r * (size * 3 + 1)] = 0;
    for (let c = 0; c < size; c++) {
      const o = r * (size * 3 + 1) + 1 + c * 3;
      const road = (r === 128 || c === 100 || (r + c + x * 7) % 231 === 0);
      const base = ((x + y) % 2) ? [232, 238, 226] : [226, 234, 220];
      const px = road ? [250, 249, 244] : (r === 0 || c === 0) ? [214, 224, 208] : base;
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
const TILE = tilePng(0, 0);

/* ------------------------------------------------------------------ static server */
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const file = path.resolve(FRONTEND, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

/* ------------------------------------------------------------------ mock API */
function makeState() {
  return {
    signedIn: true, account: { ...ACCOUNT }, records: RECORDS.map(r => ({ ...r })), farms: FARMS.map(f => ({ ...f })),
    daily: DAILY.map(d => ({ ...d })), telemetry: TELEMETRY, jobs: {}, pending: [],
    analyzeMode: 'done', loginError: false, jpegs: [],
  };
}
async function installApi(context, S) {
  await context.route(/^https:\/\//, route => {
    const url = route.request().url();
    if (/tile\.openstreetmap\.org/.test(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: TILE });
    return route.abort();
  });
  await context.route('**/api/**', route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
    const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (p === '/api/auth/me') return S.signedIn ? json({ ok: true, account: S.account, csrf: 'ux-csrf' }) : json({ detail: 'Belum masuk' }, 401);
    if (p === '/api/auth/login') {
      if (S.loginError) return json({ detail: 'Email atau kata sandi salah' }, 401);
      S.signedIn = true; return json({ ok: true, account: S.account, csrf: 'ux-csrf' });
    }
    if (p === '/api/auth/logout') { S.signedIn = false; return json({ ok: true }); }
    if (p === '/api/health') return json({ ok: true, version: '2.1.0', capabilities: { treeContinuity: true, recordsPaging: true, accountBinding: true, photoLifecycle: true }, release: '0.2.2.0' });
    if (p === '/api/telemetry') return json(S.telemetry);
    if (p === '/api/records') {
      if (m === 'POST') { const body = req.postDataJSON() || {}; const saved = record({ ...body, id: body.id || 'rec_new', cropName: body.cropName || null, timestampMs: body.timestampMs || NOW, imageUrl: '/api/photos/leaf1' }); S.records.unshift(saved); return json(saved); }
      const limit = Number(url.searchParams.get('limit') || 0);
      return json(limit ? { items: S.records, next: null } : S.records);
    }
    if (/^\/api\/records\/[^/]+$/.test(p)) {
      const id = decodeURIComponent(p.split('/').pop()), rec = S.records.find(r => r.id === id);
      if (m === 'DELETE') { S.records = S.records.filter(r => r.id !== id); return json({ ok: true }); }
      if (m === 'PUT') { Object.assign(rec || {}, req.postDataJSON() || {}); return json(rec || {}); }
      return json(rec || {});
    }
    if (p === '/api/farms') return m === 'GET' ? json(S.farms) : json({ ...(req.postDataJSON() || {}), id: 'farm_new', createdMs: NOW, updatedMs: NOW });
    if (p === '/api/daily') return m === 'GET' ? json(S.daily) : json({ ...(req.postDataJSON() || {}), id: 'daily_new' });
    if (p === '/api/queue/pending') return json(S.pending);
    if (p === '/api/analyze' && m === 'POST') {
      const id = 'job_ux_' + (Object.keys(S.jobs).length + 1);
      S.jobs[id] = { polls: 0 };
      return json({ job_id: id, status: 'queued', position: 0 });
    }
    const job = p.match(/^\/api\/analyze\/([^/]+)(?:\/(ack|cancel))?$/);
    if (job) {
      const id = job[1], state = S.jobs[id] || (S.jobs[id] = { polls: 0 });
      if (job[2]) return json({ ok: true, status: job[2] === 'cancel' ? 'cancelled' : 'done' });
      state.polls++;
      const base = { id, accountId: S.account.id, attempts: 1, createdMs: NOW, updatedMs: NOW, context: { lat: GPS.latitude, lng: GPS.longitude, elevation: 724, accuracy: 18, locationName: TELEMETRY.locationName, weather: TELEMETRY.weather, photoDate: 'Sekarang', photoTimestampMs: NOW, cropId: null }, acked: false };
      if (S.analyzeMode === 'claimed') return json({ ...base, status: 'claimed', stage: 'diagnose:http', position: 0 });
      if (S.analyzeMode === 'queued') return json({ ...base, status: 'queued', position: 2 });
      if (S.analyzeMode === 'failed') return json({ ...base, status: 'failed', error: 'Server analisis sedang bermasalah. Foto Anda aman — kirim ulang nanti dari Riwayat.' });
      return json({ ...base, status: 'done', diagnosis: { crop: 'Cabai', condition: 'Bercak daun cercospora', severity: 'Moderate', confidence: 0.84, needs_review: false, symptoms_id: 'Bercak bulat cokelat dengan tepi gelap pada daun.', immediate_action_id: 'Petik dan buang daun yang berbercak, jaga kebun tidak terlalu lembap, dan foto ulang dalam 3 hari.', geocorrelation: 'Kelembapan tinggi.', suitability: 'Sesuai' } });
    }
    const photo = p.match(/^\/api\/photos\/(.+)$/);
    if (photo) {
      const idx = { leaf1: 0, leaf2: 1, leaf3: 2 }[photo[1]] ?? 0;
      const body = S.jpegs[idx % Math.max(1, S.jpegs.length)];
      return body ? route.fulfill({ status: 200, contentType: 'image/jpeg', body }) : route.fulfill({ status: 404, body: '' });
    }
    return json([]);
  });
}

/* leaf-like JPEGs drawn on a canvas inside the page (no binary files in the repo) */
async function makeJpegs(page) {
  const urls = await page.evaluate(() => {
    const out = [];
    const palettes = [['#2f6b2f', '#7fb069', '#c9a227'], ['#3d7a35', '#a3c76b', '#8b5a2b'], ['#1f5a2a', '#5fa36a', '#d9d9a0']];
    palettes.forEach((pal, i) => {
      const c = document.createElement('canvas'); c.width = 600; c.height = 800;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, 0, 800); bg.addColorStop(0, '#8fbf86'); bg.addColorStop(1, '#4c7a43');
      g.fillStyle = bg; g.fillRect(0, 0, 600, 800);
      for (let k = 0; k < 7; k++) {
        g.save(); g.translate(300 + (k - 3) * 55, 430 + Math.sin(k * 1.7 + i) * 70); g.rotate((k - 3) * 0.28 + i * 0.1);
        g.fillStyle = pal[k % 2]; g.beginPath(); g.ellipse(0, 0, 70, 190, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, -180); g.lineTo(0, 180); g.stroke();
        g.fillStyle = pal[2]; for (let s = 0; s < 6; s++) { g.beginPath(); g.arc((s % 3 - 1) * 28, -90 + s * 32, 11 + (s % 3) * 4, 0, 7); g.fill(); }
        g.restore();
      }
      out.push(c.toDataURL('image/jpeg', 0.82));
    });
    return out;
  });
  return urls.map(u => Buffer.from(u.split(',')[1], 'base64'));
}

/* ------------------------------------------------------------------ run */
const written = [], skipped = [], consoleErrors = [];
let counter = 0;
const wanted = name => !ONLY.length || ONLY.some(prefix => name === prefix || name.startsWith(prefix));
async function shot(page, size, name, opts = {}) {
  if (!wanted(name)) return false;
  await page.waitForTimeout(opts.settle ?? 350);
  const file = `${String(counter).padStart(2, '0')}-${name}-${size.w}x${size.h}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: !!opts.fullPage });
  written.push(file);
  return true;
}
/* Run one state; a failure is recorded, never fatal. */
async function state(size, name, fn) {
  counter += 1;
  if (!wanted(name)) return;
  try { await fn(); }
  catch (error) { skipped.push({ state: name, size: size.w + 'x' + size.h, reason: String(error.message || error).slice(0, 300) }); }
}
async function openPage(browser, size, S, { offline = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: size.w, height: size.h }, serviceWorkers: 'block', locale: 'id-ID', timezoneId: 'Asia/Jakarta',
    permissions: ['camera', 'geolocation'], geolocation: GPS, deviceScaleFactor: size.w < 600 ? 2 : 1,
  });
  await installApi(context, S);
  const page = await context.newPage();
  page.on('pageerror', e => consoleErrors.push({ size: size.w + 'x' + size.h, error: String(e.message).slice(0, 300) }));
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'networkidle' });
  if (offline) await context.setOffline(true);
  return { context, page };
}
const jpegBase64 = page => page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 800;
  const g = c.getContext('2d'); g.fillStyle = '#5b8a4e'; g.fillRect(0, 0, 600, 800); g.fillStyle = '#c9a227'; g.fillRect(180, 260, 240, 280);
  return c.toDataURL('image/jpeg', 0.8).split(',')[1];
});
const waitSignedIn = page => page.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 15000 });

/* The camera must be live before a snapshot; takeSnapshotForReview() silently does nothing otherwise. */
const waitCamera = (page, timeout = 8000) => page.waitForFunction(() => {
  const v = document.getElementById('camera-stream');
  return v && v.videoWidth > 0 && !v.classList.contains('hidden');
}, null, { timeout });
async function takePhoto(page) {
  await page.evaluate(() => { navigateToMenu('scan'); });
  await waitCamera(page);
  await page.evaluate(() => takeSnapshotForReview());
  await page.waitForSelector('#photo-review-controls:not(.hidden)', { timeout: 5000 });
}
/* Analysis flows are fire-and-forget: executeCropPathologyAnalysis() only resolves when the whole
   poll loop ends (up to ~16 minutes for a job that never finishes). */
const startAnalysis = (page, tier = 'normal') => page.evaluate(t => { executeCropPathologyAnalysis(t); }, tier);
/* Screenshot of the bottom of a scroll container, but only when it actually scrolls. */
async function shotScrolled(page, size, name, containerId) {
  if (!wanted(name)) return;
  const scrolls = await page.evaluate(id => { const v = document.getElementById(id); if (!v) return false; v.scrollTop = v.scrollHeight; return v.scrollHeight > v.clientHeight + 8; }, containerId);
  if (scrolls) await shot(page, size, name);
  await page.evaluate(id => { const v = document.getElementById(id); if (v) v.scrollTop = 0; }, containerId);
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    if (flag('landing-assets')) {
      const S=makeState(), size={w:390,h:844};
      const {context,page}=await openPage(browser,size,S);
      S.jpegs=await makeJpegs(page);
      await page.reload({waitUntil:'networkidle'});
      await waitSignedIn(page);
      await page.evaluate(()=>JagaOfflineSync.stop());
      await page.evaluate(()=>navigateToMenu('home'));
      await page.waitForTimeout(500);
      await page.screenshot({path:path.join(OUT,'home-full.png')});
      await page.screenshot({path:path.join(OUT,'landing-app-home.png'),clip:{x:0,y:56,width:390,height:276}});
      await page.evaluate(()=>openTreeTimeline('tree_cabai1'));
      await page.waitForSelector('.tl-hero');
      await page.waitForTimeout(500);
      await page.screenshot({path:path.join(OUT,'history-full.png')});
      await page.locator('.tl-hero').screenshot({path:path.join(OUT,'landing-app-history.png')});
      fs.writeFileSync(path.join(OUT,'provenance.json'),JSON.stringify({
        source:'app/frontend',harness:'ux-screens-0220.cjs --landing-assets',
        viewport:size,deviceScaleFactor:2,fixtures:'synthetic only; API mocked',
        homeClip:{x:0,y:56,width:390,height:276},historySelector:'.tl-hero',consoleErrors
      },null,2));
      written.push('home-full.png','landing-app-home.png','history-full.png','landing-app-history.png');
      await context.close();
      if(consoleErrors.length) throw Error(JSON.stringify(consoleErrors));
      return;
    }
    for (const size of SIZES) {
      counter = 0;

      /* ---- A. login (signed out) ---- */
      {
        const S = makeState(); S.signedIn = false;
        const { context, page } = await openPage(browser, size, S);
        await state(size, 'login', async () => { await page.waitForSelector('#auth-gate:not(.hidden)'); await shot(page, size, 'login'); });
        await state(size, 'login-register', async () => { await page.evaluate(() => showAuthTab('register')); await shot(page, size, 'login-register'); await page.evaluate(() => showAuthTab('login')); });
        await state(size, 'login-error', async () => {
          S.loginError = true;
          await page.fill('#auth-email', 'slamet@example.test'); await page.fill('#auth-password', 'salah-sekali');
          await page.click('#auth-submit'); await page.waitForSelector('#auth-error:not(.hidden)', { timeout: 5000 });
          await shot(page, size, 'login-error');
        });
        await context.close();
      }

      /* ---- B. signed in: read-only screens first, so later states never contaminate them ---- */
      {
        const S = makeState();
        const { context, page } = await openPage(browser, size, S);
        S.jpegs = await makeJpegs(page);
        await page.reload({ waitUntil: 'networkidle' });
        await waitSignedIn(page);
        await page.evaluate(() => JagaOfflineSync.stop()).catch(() => {});
        await page.waitForTimeout(900);

        await state(size, 'home', async () => { await page.evaluate(() => navigateToMenu('home')); await shot(page, size, 'home'); });
        await state(size, 'home-bottom', async () => { await shotScrolled(page, size, 'home-bottom', 'view-home'); });

        await state(size, 'map', async () => { await page.evaluate(() => navigateToMenu('map')); await page.waitForTimeout(900); await shot(page, size, 'map', { settle: 900 }); });
        await state(size, 'map-detail', async () => { await page.evaluate(() => openBottomSheet('record_job4')); await shot(page, size, 'map-detail', { settle: 700 }); await page.evaluate(() => closeBottomSheet()); });
        await state(size, 'map-petak-list', async () => { await page.evaluate(() => openFarmPanel()); await shot(page, size, 'map-petak-list', { settle: 600 }); await page.evaluate(() => closeFarmPanel()); });
        await state(size, 'map-draw', async () => { await page.evaluate(() => startFarmDraw()); await shot(page, size, 'map-draw'); await page.evaluate(() => cancelFarmDraw()); });
        await state(size, 'modal-farm', async () => {
          await page.evaluate(() => openFarmModal([[-6.2, 106.8], [-6.2, 106.801], [-6.201, 106.801], [-6.2, 106.8]], 'Simpan Petak'));
          await shot(page, size, 'modal-farm'); await page.evaluate(() => cancelFarmDraw());
        });

        await state(size, 'log', async () => { await page.evaluate(() => { expandedCropId = null; navigateToMenu('log'); switchLogTab('crops'); }); await shot(page, size, 'log'); });
        await state(size, 'log-bottom', async () => { await shotScrolled(page, size, 'log-bottom', 'view-log'); });
        await state(size, 'log-timeline', async () => {
          await page.evaluate(() => {
            expandedCropId = 'tree_cabai1'; renderLogRecords();
            const card = [...document.querySelectorAll('#logs-container button')].find(b => (b.getAttribute('data-args') || '').includes('tree_cabai1'));
            if (card) card.scrollIntoView({ block: 'start' });
          });
          await shot(page, size, 'log-timeline');
          await page.evaluate(() => { const v = document.getElementById('view-log'); v.scrollTop = v.scrollTop + Math.round(v.clientHeight * 0.75); });
          await shot(page, size, 'log-timeline-more');
          await page.evaluate(() => { document.getElementById('view-log').scrollTop = 0; expandedCropId = null; renderLogRecords(); });
        });
        await state(size, 'log-petak', async () => { await page.evaluate(() => switchLogTab('petak')); await shot(page, size, 'log-petak'); });
        await state(size, 'log-daily', async () => { await page.evaluate(() => switchLogTab('daily')); await shot(page, size, 'log-daily'); await page.evaluate(() => switchLogTab('crops')); });
        await state(size, 'modal-status', async () => { await page.evaluate(() => openStatusModal('record_job1')); await shot(page, size, 'modal-status'); await page.evaluate(() => closeStatusModal()); });
        await state(size, 'modal-confirm', async () => {
          await page.evaluate(() => { confirmAction({ title: 'Hapus catatan ini?', message: 'Cabai • 2026-10-20 akan dihapus dari riwayat secara permanen.', okLabel: 'Hapus' }); });
          await shot(page, size, 'modal-confirm'); await page.evaluate(() => resolveConfirm(false));
        });
        await state(size, 'modal-daily', async () => { await page.evaluate(() => openDailyModal()); await shot(page, size, 'modal-daily'); await page.evaluate(() => closeDailyModal()); });
        await state(size, 'modal-location', async () => { await page.evaluate(() => openLocationEditor('record', 'record_job4')); await shot(page, size, 'modal-location', { settle: 900 }); await page.evaluate(() => closeDialog('modal-location')); });
        await state(size, 'photo-viewer', async () => {
          await page.evaluate(() => openViewerForRecord('record_job1')); await page.waitForSelector('#photo-viewer:not(.hidden)', { timeout: 5000 });
          await shot(page, size, 'photo-viewer'); await page.evaluate(() => closePhotoViewer());
        });
        await state(size, 'modal-account', async () => { await page.evaluate(() => openAccountModal()); await shot(page, size, 'modal-account'); await page.evaluate(() => closeAccountModal()); });

        /* scan: camera, review, gallery, then the analysis flows (these add records/drafts, so they come last) */
        await state(size, 'scan-camera', async () => {
          await page.evaluate(() => navigateToMenu('scan')); await waitCamera(page).catch(() => {}); await shot(page, size, 'scan-camera');
        });
        await state(size, 'scan-review', async () => {
          await page.evaluate(() => takeSnapshotForReview());
          await page.waitForSelector('#photo-review-controls:not(.hidden)', { timeout: 5000 });
          await shot(page, size, 'scan-review');
          await page.evaluate(() => { const v = document.getElementById('view-scan'); v.scrollTop = v.scrollHeight; });
          await shot(page, size, 'scan-review-bottom');
        });
        await state(size, 'modal-date-picker', async () => { await page.evaluate(() => openDatePickerModal()); await shot(page, size, 'modal-date-picker'); await page.evaluate(() => closeDatePickerModal()); });
        await state(size, 'scan-gallery', async () => {
          await page.evaluate(() => { resetToLiveCamera(); });
          const b64 = await jpegBase64(page);
          await page.evaluate(async () => { await JagaFeatures.load('photoMetadata'); exifr.parse = async () => null; });
          await page.locator('input[type=file]').first().setInputFiles({ name: 'galeri.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
          await page.waitForSelector('#photo-review-controls:not(.hidden)', { timeout: 8000 });
          await shot(page, size, 'scan-gallery-review');
          await page.evaluate(() => resetToLiveCamera());
        });
        await state(size, 'scan-progress', async () => {
          S.analyzeMode = 'claimed';
          await page.evaluate(() => { resetToLiveCamera(); });
          await takePhoto(page);
          await startAnalysis(page);
          // 0.2.2.0: the farmer is not kept waiting; after the upload the screen says "Foto terkirim" and the
          // analysis status ("Sedang dianalisis") runs underneath it.
          await page.waitForFunction(() => !document.getElementById('analysis-sent')?.classList.contains('hidden') &&
            /dianalisis|giliran|gejala/i.test(document.getElementById('sent-status')?.textContent || ''), null, { timeout: 15000 });
          await shot(page, size, 'scan-progress');
          await page.evaluate(() => resetToLiveCamera());
        });
        await state(size, 'scan-failed', async () => {
          S.analyzeMode = 'failed';
          await page.evaluate(() => { resetToLiveCamera(); });
          await takePhoto(page);
          await startAnalysis(page);
          await page.waitForSelector('#analysis-failed:not(.hidden)', { timeout: 20000 });
          await shot(page, size, 'scan-failed');
        });
        await state(size, 'scan-result', async () => {
          S.analyzeMode = 'done';
          await page.evaluate(() => { resetToLiveCamera(); });
          await takePhoto(page);
          await startAnalysis(page);
          await page.waitForSelector('#stamped-result-actions:not(.hidden)', { timeout: 25000 });
          // The nearby-tree question can cover the card; capture the card first.
          await page.evaluate(() => { closeCropAssignModal(); });
          await shot(page, size, 'scan-result');
          await shotScrolled(page, size, 'scan-result-bottom', 'view-scan');
        });
        await state(size, 'modal-crop-assign', async () => {
          await page.evaluate(() => {
            pendingCropAssignment = { record: { id: 'record_demo', cropId: null, crop: 'Kopi', locationName: 'Ciomas, Kab. Bogor', lat: -6.2012, lng: 106.8012 } };
            promptCropAssignment();
          });
          await shot(page, size, 'modal-crop-assign');
          await page.evaluate(() => { closeCropAssignModal(); pendingCropAssignment = null; });
        });
        await context.close();
      }

      /* ---- C. drafts and offline, in a clean context with only the intended drafts ---- */
      {
        const S = makeState();
        const { context, page } = await openPage(browser, size, S);
        S.jpegs = await makeJpegs(page);
        await page.reload({ waitUntil: 'networkidle' });
        await waitSignedIn(page);
        await page.evaluate(() => JagaOfflineSync.stop()).catch(() => {});
        await page.waitForTimeout(700);
        await state(size, 'drafts', async () => {
          const jpeg = await jpegBase64(page);
          await page.evaluate(async jpeg => {
            const accountId = String(currentAccount.id);
            const base = { cropHint: 'Cabai', locationSource: 'gps', accuracy: '14', lat: '-6.2051', lng: '106.8021', photoTimestampMs: String(Date.now() - 1800000) };
            await JagaOfflineStore.enqueue({ accountId, clientRequestId: 'ux_draft_pending_1', imageBase64: jpeg, fields: { ...base, cropId: 'tree_cabai1', cropName: 'Cabai bedeng 1' } });
            await JagaOfflineStore.enqueue({ accountId, clientRequestId: 'ux_draft_pending_2', imageBase64: jpeg, fields: { ...base, cropHint: 'Kopi' } });
            await JagaOfflineStore.enqueue({ accountId, clientRequestId: 'ux_draft_failed_3', imageBase64: jpeg, fields: { ...base, cropHint: 'Jagung' } });
            await JagaOfflineStore.markFailure(accountId, 'ux_draft_failed_3', 'Foto ditolak server (422).');
            await updateOfflineDraftCount();
          }, jpeg);
          await page.evaluate(() => { navigateToMenu('home'); });
          await page.waitForTimeout(500);
          await shot(page, size, 'drafts-home-banner');
          await page.evaluate(() => { navigateToMenu('log'); });
          await page.waitForTimeout(600);
          await shot(page, size, 'drafts-log');
          // 0.2.2.0: the drafts are one compact strip (UX brief D1) that expands to the list.
          await page.evaluate(() => { if (window.JagaDraftsStrip) JagaDraftsStrip.expand(); document.querySelectorAll('.workflow-tree-group').forEach(d => d.open = true); });
          await shot(page, size, 'drafts-log-expanded');
        });
        await state(size, 'offline', async () => {
          await context.setOffline(true);
          await page.evaluate(() => { window.dispatchEvent(new Event('offline')); navigateToMenu('home'); });
          await shot(page, size, 'offline-home');
          await page.evaluate(() => navigateToMenu('scan'));
          await waitCamera(page).catch(() => {});
          await shot(page, size, 'offline-scan');
          await page.evaluate(() => { navigateToMenu('log'); });
          await shot(page, size, 'offline-log');
          await context.setOffline(false);
          await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
        });
        await context.close();
      }

      /* ---- D. first run: signed in with no data ---- */
      {
        const E = makeState(); E.records = []; E.farms = []; E.daily = []; E.telemetry = { ...TELEMETRY };
        const { context, page } = await openPage(browser, size, E);
        await state(size, 'empty-home', async () => { await waitSignedIn(page); await page.waitForTimeout(700); await shot(page, size, 'empty-home'); });
        await state(size, 'empty-log', async () => { await page.evaluate(() => navigateToMenu('log')); await shot(page, size, 'empty-log'); });
        await state(size, 'empty-map', async () => { await page.evaluate(() => navigateToMenu('map')); await shot(page, size, 'empty-map', { settle: 900 }); });
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sizes: SIZES, files: written, skipped, pageErrors: consoleErrors }, null, 2));
    console.log(JSON.stringify({ out: OUT, count: written.length, skipped, pageErrors: consoleErrors.slice(0, 10) }, null, 2));
  }
})().catch(error => { console.error(error); try { server.close(); } catch (_) { /* already closed */ } process.exitCode = 1; });
