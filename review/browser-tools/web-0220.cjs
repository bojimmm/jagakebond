#!/usr/bin/env node
/*
 * JagaKebond 0.2.2.0 — WEB (field app) reliability + scan-flow/drafts regression harness.
 *
 * Real Chromium (service worker, IndexedDB, BroadcastChannel, fake camera, CSP enforcement) against an in-process mock
 * backend that follows the 0.2.2.0 contract (records paging, X-JK-Account binding with 409 account_mismatch,
 * 429/503 behaviour, multipart /api/analyze with clientRequestId idempotency). Synthetic accounts and photos only.
 *
 *   node web-0220.cjs [--only name,name] [--frontend ../../app/frontend] [--chrome /usr/bin/google-chrome]
 *
 * Prints a JSON list of checks; exit code 1 when any check fails. Each scenario is isolated in its own browser
 * context, a scenario that throws is recorded as a failed check and the run continues.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const FRONTEND = path.resolve(process.cwd(), arg('frontend', path.join(__dirname, '../../app/frontend')));
const CHROME = arg('chrome', process.env.JK_CHROME || '/usr/bin/google-chrome');
const ONLY = arg('only', '').split(',').filter(Boolean);
const APP_PY = path.resolve(__dirname, '../../app/backend/app.py');

/* The field-app CSP is read from the backend so the harness enforces exactly what production sends. */
function fieldAppCsp() {
  try {
    const source = fs.readFileSync(APP_PY, 'utf8');
    const block = source.match(/APP_CSP\s*=\s*\(([\s\S]*?)\n\)/);
    if (block) return [...block[1].matchAll(/"([^"]*)"/g)].map(m => m[1]).join('');
  } catch (_) { /* fall back below */ }
  return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com; font-src 'self' data:; connect-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
}
const CSP = fieldAppCsp();

/* ------------------------------------------------------------------ mock backend */
const ACCOUNTS = {
  acc_a: { id: 'acc_a', name: 'Petani A', email: 'a@example.test', role: 'user', fastQuota: 3, fastUsed: 1, fastRemaining: 2 },
  acc_b: { id: 'acc_b', name: 'Petani B', email: 'b@example.test', role: 'user', fastQuota: 3, fastUsed: 0, fastRemaining: 3 },
};
const NOW = Date.now();
function makeRecord(i, over = {}) {
  return { id: 'rec_' + String(i).padStart(4, '0'), cropId: 'tree_' + (i % 7), cropName: 'Tanaman ' + (i % 7), crop: 'Cabai',
    condition: 'Bercak daun', severity: ['Severe', 'Moderate', 'Healthy'][i % 3], lat: -6.2 + i * 1e-4, lng: 106.8, timestampMs: NOW - i * 60000,
    createdMs: NOW - i * 60000, imageUrl: null, source: 'ai', confidence: 0.8, needs_review: false, ...over };
}
let S;
function resetState() {
  S = {
    sessions: new Map(), records: { acc_a: [], acc_b: [] }, legacyRecords: false, recordRequests: [],
    jobs: new Map(), uploads: [], analyzeCalls: [], fail503: new Set(), forbid403: new Set(), hangAnalyze: false, aborted: 0,
    jobMode: 'done', pendingCalls: 0, logoutCalls: 0, hang: new Set(), badType: null, swSalt: '', otherHosts: [], down: false,
  };
}
resetState();
function readCookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; })); }
function sessionAccount(req) { const sid = readCookies(req).jk_sess; return sid && S.sessions.get(sid) ? ACCOUNTS[S.sessions.get(sid)] : null; }
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
function readBody(req) { return new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', () => resolve(Buffer.alloc(0))); }); }
function formField(raw, name) { const m = raw.toString('latin1').match(new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)')); return m ? m[1] : null; }
function jobView(job) {
  const base = { id: job.id, accountId: job.accountId, status: job.status, position: 0, context: job.context, createdMs: job.createdMs, updatedMs: NOW, acked: !!job.acked };
  if (job.status === 'done') base.diagnosis = { crop: 'Cabai', condition: 'Bercak daun', severity: 'Moderate', confidence: 0.82, needs_review: false,
    immediate_action_id: 'Buang daun yang bergejala dan foto lagi 3 hari lagi.', symptoms_id: 'Bercak cokelat.' };
  if (job.status === 'rejected' && job.provider) { base.triage = { code: 'provider_unavailable' }; base.error = 'Server analisis sedang bermasalah. Foto Anda aman — kirim ulang nanti dari Riwayat.'; }
  else if (job.status === 'rejected') base.error = 'Foto terlalu buram untuk dianalisis.';
  return base;
}
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const account = sessionAccount(req);
  const header = req.headers['x-jk-account'];
  if (!/^\/api\/(?:auth\/(?:login|register)|health)$/.test(p) && header && account && header !== account.id) {
    return send(res, 409, { detail: 'Akun di perangkat ini sudah berganti. Muat ulang aplikasi.', code: 'account_mismatch' });
  }
  if (S.hang.has(p)) return; // never answers: client timeouts must fire
  if (p === '/api/health') return send(res, 200, { ok: true, version: '2.1.0', release: '0.2.2.0', capabilities: { treeContinuity: true, recordsPaging: true, accountBinding: true, photoLifecycle: true } });
  if (p === '/api/auth/login' && m === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const found = Object.values(ACCOUNTS).find(a => a.email === body.email);
    if (!found) return send(res, 401, { detail: 'Email atau kata sandi salah' });
    const sid = 'sid_' + found.id + '_' + Math.random().toString(36).slice(2, 8);
    S.sessions.set(sid, found.id);
    return send(res, 200, { ok: true, account: found }, { 'Set-Cookie': ['jk_sess=' + sid + '; Path=/; HttpOnly; SameSite=Lax', 'jk_csrf=csrf-fixture; Path=/; SameSite=Lax'] });
  }
  if (p === '/api/auth/me') return account ? send(res, 200, { ok: true, account }) : send(res, 401, { detail: 'Belum masuk' });
  if (p === '/api/auth/logout') { S.logoutCalls += 1; const sid = readCookies(req).jk_sess; if (sid) S.sessions.delete(sid); return send(res, 200, { ok: true }, { 'Set-Cookie': 'jk_sess=; Path=/; Max-Age=0' }); }
  if (!account) return send(res, 401, { detail: 'Sesi berakhir' });
  if (p === '/api/records' && m === 'GET') {
    const all = S.records[account.id];
    const limit = Number(url.searchParams.get('limit') || 0);
    S.recordRequests.push(url.search);
    if (!limit || S.legacyRecords) return send(res, 200, all);
    const start = Number(url.searchParams.get('cursor') || 0);
    const items = all.slice(start, start + limit);
    return send(res, 200, { items, next: start + limit < all.length ? String(start + limit) : null });
  }
  if (p === '/api/records' && m === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const list = S.records[account.id]; const i = list.findIndex(r => r.id === body.id);
    const saved = { ...body, imageUrl: null }; if (i >= 0) list[i] = saved; else list.unshift(saved);
    return send(res, 200, saved);
  }
  const rec = p.match(/^\/api\/records\/([^/]+)$/);
  if (rec) {
    const list = S.records[account.id]; const id = decodeURIComponent(rec[1]); const i = list.findIndex(r => r.id === id);
    if (m === 'DELETE') { if (i >= 0) list.splice(i, 1); return send(res, 200, { ok: true }); }
    const body = JSON.parse((await readBody(req)).toString() || '{}'); if (i >= 0) Object.assign(list[i], body);
    return send(res, 200, i >= 0 ? list[i] : { id, ...body });
  }
  if (p === '/api/farms' || p === '/api/daily') return send(res, 200, []);
  if (p === '/api/telemetry') return send(res, 200, { locationName: 'Ciomas, Bogor', elevation: [700], tempC: 24, rh: 80, weather: '24°C' });
  if (p === '/api/queue/pending') {
    S.pendingCalls += 1;
    for (const j of S.jobs.values()) if (j.accountId === account.id && (j.status === 'queued' || j.status === 'claimed') && S.jobMode === 'done') j.status = 'done';
    return send(res, 200, [...S.jobs.values()].filter(j => j.accountId === account.id && !j.acked).map(jobView));
  }
  if (p === '/api/analyze' && m === 'POST') {
    if (S.hangAnalyze) { req.on('close', () => { S.aborted += 1; }); return; }
    const raw = await readBody(req);
    const clientRequestId = formField(raw, 'clientRequestId');
    const stamp = formField(raw, 'photoTimestampMs');
    S.analyzeCalls.push(clientRequestId);
    if (S.fail503.has(clientRequestId)) return send(res, 503, { detail: 'Server sibuk' });
    if (S.forbid403.has(clientRequestId)) return send(res, 403, { detail: 'Ditolak' });
    let job = [...S.jobs.values()].find(j => j.clientRequestId === clientRequestId && j.accountId === account.id);
    if (!job) {
      job = { id: 'job_' + (S.jobs.size + 1), accountId: account.id, clientRequestId, createdMs: Date.now(), status: 'queued',
        context: { lat: -6.2, lng: 106.8, accuracy: 9, photoTimestampMs: stamp ? Number(stamp) : null, photoDate: 'uji', cropId: formField(raw, 'cropId') } };
      S.jobs.set(job.id, job);
      S.uploads.push({ clientRequestId, account: account.id, photoTimestampMs: stamp ? Number(stamp) : null, header: header || null });
    }
    return send(res, 200, { job_id: job.id, status: 'queued', position: 0 });
  }
  const job = p.match(/^\/api\/analyze\/([^/]+)(?:\/(ack|cancel))?$/);
  if (job) {
    const found = S.jobs.get(decodeURIComponent(job[1]));
    if (!found || found.accountId !== account.id) return send(res, 404, { detail: 'Tidak ditemukan' });
    if (job[2] === 'ack') { found.acked = true; return send(res, 200, { ok: true }); }
    if (job[2] === 'cancel') { found.status = 'cancelled'; return send(res, 200, jobView(found)); }
    if (found.status === 'queued' || found.status === 'claimed') {
      if (S.jobMode === 'done') found.status = 'done';
      else if (S.jobMode === 'provider') { found.status = 'rejected'; found.provider = true; }
      else if (S.jobMode === 'rejected') found.status = 'rejected';
    }
    return send(res, 200, jobView(found));
  }
  return send(res, 404, { detail: 'Tidak ada' });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  // 'No signal': Playwright's setOffline does not reach service-worker fetches, so the server also drops the line.
  if (S.down && url.pathname !== '/__blank') { req.socket.destroy(); return; }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/__blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>blank</title>'); }
    const name = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.resolve(FRONTEND, '.' + name);
    if (!file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    let body = fs.readFileSync(file);
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (name === '/sw.js') { headers['Cache-Control'] = 'no-store'; body = Buffer.concat([body, Buffer.from('\n// ' + S.swSalt + '\n')]); }
    if (headers['Content-Type'].startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
    if (S.badType && name === S.badType) { headers['Content-Type'] = 'text/html'; body = Buffer.from('<html>captive portal</html>'); }
    res.writeHead(200, headers); res.end(body);
  } catch (error) { try { send(res, 500, { detail: String(error.message || error) }); } catch (_) { /* closed */ } }
});

/* ------------------------------------------------------------------ helpers */
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); };
let browser, BASE;
const wanted = name => !ONLY.length || ONLY.includes(name);
async function scenario(name, fn) {
  if (!wanted(name)) return;
  resetState();
  try { await fn(); } catch (error) { check(name + ': scenario completed', false, String(error && (error.stack || error.message) || error).slice(0, 900)); }
}
async function newContext(opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 360, height: 780 }, serviceWorkers: opts.sw ? 'allow' : 'block',
    locale: 'id-ID', timezoneId: 'Asia/Jakarta', permissions: ['camera', 'geolocation'], geolocation: { latitude: -6.2001, longitude: 106.8001, accuracy: 9 } });
  context.on('request', request => { const u = new URL(request.url()); if (u.host !== new URL(BASE).host) S.otherHosts.push(u.host); });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => {
    const u = route.request().url();
    if (/tile\.openstreetmap\.org|server\.arcgisonline\.com/.test(u)) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
    return route.abort();
  });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }));
    window.__geo = { watch: 0, clear: 0 };
    if (navigator.geolocation) {
      const realWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
      const realClear = navigator.geolocation.clearWatch.bind(navigator.geolocation);
      navigator.geolocation.watchPosition = (...a) => { window.__geo.watch += 1; return realWatch(...a); };
      navigator.geolocation.clearWatch = id => { window.__geo.clear += 1; return realClear(id); };
    }
  });
  return context;
}
async function login(context, email = 'a@example.test') {
  const response = await context.request.post(BASE + '/api/auth/login', { data: { email, password: 'fixture' } });
  if (response.status() !== 200) throw new Error('login fixture failed ' + response.status());
  return (await response.json()).account;
}
async function openApp(context, { signedIn = true } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', msg => { if (/Content Security Policy|Refused to/i.test(msg.text())) errors.push('csp: ' + msg.text()); });
  page.errors = errors;
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  if (signedIn) await page.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce && /^ready:/.test(document.documentElement.dataset.session || ''), null, { timeout: 20000 });
  else await page.waitForSelector('#auth-gate:not(.hidden)', { timeout: 20000 });
  return page;
}
const tinyJpeg = page => page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 400; const g = c.getContext('2d'); g.fillStyle = '#4a7f3a'; g.fillRect(0, 0, 300, 400); g.fillStyle = '#d4b44a'; g.fillRect(90, 120, 120, 160); return c.toDataURL('image/jpeg', 0.8); });
/* Puts a photo on the review screen without the camera (gallery-like), like takeSnapshotForReview would. */
async function photoOnReview(page) {
  const dataUrl = await tinyJpeg(page);
  await page.evaluate(url => {
    navigateToMenu('scan');
    selectedImageBase64 = url; capturePhotoSnapshot = url; fullCapturePhoto = url; photoMode = 'gallery';
    selectedPhotoMetadata = Object.freeze({ source: 'gallery-exif', captureTimeMs: Date.now() - 60000, lat: -6.2, lng: 106.8, accuracy: 12, locationSource: 'gallery-exif' });
    showReviewPhoto(); setScanState('review');
  }, dataUrl);
}
const drafts = page => page.evaluate(async () => (await JagaNative.list({ accountId: String(currentAccount.id) })).drafts);
async function until(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return true; await page.waitForTimeout(100); }
  return false;
}

/* ------------------------------------------------------------------ scenarios */
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    /* CSP: the field app loads and runs every tab under the production CSP without a single violation. */
    await scenario('csp', async () => {
      const context = await newContext();
      await login(context);
      S.records.acc_a = [makeRecord(1), makeRecord(2)];
      const page = await openApp(context);
      for (const menu of ['home', 'map', 'scan', 'log', 'home']) { await page.evaluate(m => navigateToMenu(m), menu); await page.waitForTimeout(menu === 'map' ? 900 : 300); }
      await photoOnReview(page);
      await page.evaluate(() => { setMapLayer('satellite'); });
      await page.waitForTimeout(300);
      const violations = await page.evaluate(() => window.__csp);
      check('CSP: zero violations across Beranda, Peta, Kamera, Riwayat', violations.length === 0 && !page.errors.some(e => e.startsWith('csp:')), { violations, errors: page.errors });
      const external = [...new Set(S.otherHosts)].filter(h => !/tile\.openstreetmap\.org$|^server\.arcgisonline\.com$/.test(h));
      check('CSP: nothing external is fetched besides OSM/Esri tiles', external.length === 0, external);
      check('CSP: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Records paging (contract 5.1) and the legacy array fallback; null-safe records (audit M11). */
    await scenario('paging', async () => {
      S.records.acc_a = Array.from({ length: 450 }, (_, i) => makeRecord(i));
      S.records.acc_a.splice(5, 0, makeRecord(9001, { id: 'rec_null', crop: null, condition: null, severity: null, cropId: null, cropName: null }),
        makeRecord(9002, { id: 'rec_weird', crop: '', condition: '', severity: 'Belum', lat: null, lng: null }));
      const context = await newContext();
      await login(context);
      const page = await openApp(context);
      const loaded = await page.evaluate(() => farmRecords.map(r => r.id));
      const expected = S.records.acc_a.map(r => r.id);
      check('Paging: every page is fetched and the server order is kept', JSON.stringify(loaded) === JSON.stringify(expected), { got: loaded.length, want: expected.length });
      check('Paging: pages of 200 with the opaque cursor', S.recordRequests.length === 3 && S.recordRequests.every(q => q.includes('limit=200')) && S.recordRequests[1].includes('cursor=200'), S.recordRequests);
      for (const menu of ['home', 'map', 'log']) { await page.evaluate(m => navigateToMenu(m), menu); await page.waitForTimeout(250); }
      const text = await page.evaluate(() => document.getElementById('view-log').textContent);
      check('Null-safe: records without crop/condition/severity render without errors', page.errors.length === 0, page.errors);
      check('Null-safe: unknown severity is the neutral "Belum dinilai", never "Sehat"', /Belum dinilai/.test(text) && await page.evaluate(() => { const r = farmRecords.find(x => x.id === 'rec_null'); return r.crop === '' && r.condition === ''; }), text.slice(0, 300));
      S.legacyRecords = true; S.recordRequests = [];
      await page.evaluate(() => refreshAllData());
      check('Paging: an older server answering with the full array still works', await page.evaluate(() => farmRecords.length) === expected.length, S.recordRequests);
      await context.close();
    });

    /* Service worker: one cache name, purge via postMessage keeps the shell, index.html re-cached, content-type
       check refuses a captive-portal answer, update prompt (audit H2 / M16). */
    await scenario('sw', async () => {
      const context = await newContext({ sw: true });
      await login(context);
      let page = await openApp(context);
      await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 20000 }).catch(() => null);
      if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 }); }
      const before = await page.evaluate(async () => {
        await caches.open('jk-v17').then(c => c.put('/old', new Response('old')));
        await caches.open('jk-v18').then(c => c.put('/old', new Response('old')));
        const shell = await caches.open('jk-v68');
        await shell.delete('/shell.js?v=4');               // a page of an older release purged it: the worker must repair it
        await purgeCaches();
        const keys = await caches.keys();
        const cache = await caches.open('jk-v68');
        const index = await cache.match('/index.html');
        return { keys, hasIndex: !!index, hasApp: !!(await cache.match('/app.js?v=51')), repaired: !!(await cache.match('/shell.js?v=4')),
          pageNamesCache: /jk-v\d+/.test(String(purgeCaches)) };
      });
      check('SW: purge keeps exactly the live shell cache jk-v68', JSON.stringify(before.keys) === JSON.stringify(['jk-v68']), before.keys);
      check('SW: shell still complete after purge (index.html, app.js, repaired shell.js)', before.hasIndex && before.hasApp && before.repaired, before);
      check('SW: page code does not hard-code a cache name', !before.pageNamesCache);
      const servedIndex = await (await context.request.get(BASE + '/index.html')).text();
      const cachedIndex = await page.evaluate(async () => (await (await caches.open('jk-v68')).match('/index.html')).text());
      check('SW: the cached index.html is the page that was served', cachedIndex === servedIndex);
      // A captive portal answering 200 text/html for a script must never replace a cached script nor install a worker.
      S.badType = '/session.js'; S.swSalt = 'bad-' + Date.now();
      const install = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg.update().catch(() => undefined);
        const worker = reg.installing || reg.waiting;
        if (!worker) return { state: 'none' };
        if (worker.state === 'redundant') return { state: 'redundant' };
        return new Promise(resolve => { worker.addEventListener('statechange', () => { if (worker.state === 'redundant' || worker.state === 'installed') resolve({ state: worker.state }); }); setTimeout(() => resolve({ state: worker.state }), 8000); });
      });
      const cachedType = await page.evaluate(async () => (await (await caches.open('jk-v68')).match('/session.js?v=2')).headers.get('content-type'));
      check('SW: an HTML answer for a script fails the install (old worker stays)', install.state === 'redundant', install);
      check('SW: the cached script keeps its JavaScript content type', /javascript/.test(cachedType || ''), cachedType);
      // network-first refresh of a shell asset with the wrong type must not overwrite the cache either
      await page.evaluate(() => fetch('/session.js?v=2').then(r => r.text()));
      const stillJs = await page.evaluate(async () => (await (await caches.open('jk-v68')).match('/session.js?v=2')).headers.get('content-type'));
      check('SW: network-first never caches a captive-portal answer', /javascript/.test(stillJs || ''), stillJs);
      // a good new version: the page offers "Muat ulang" instead of swapping the worker under the farmer
      S.badType = null; S.swSalt = 'good-' + Date.now();
      await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update().catch(() => undefined); });
      const prompt = await until(page, () => { const b = document.getElementById('update-banner'); return !!b && !b.hidden; }, null, 15000);
      check('SW: a new version shows the "Versi baru tersedia / Muat ulang" prompt', prompt);
      check('SW: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Offline cold start (H1), offline capture, revalidation and upload when the signal returns. */
    await scenario('offline-start', async () => {
      const context = await newContext({ sw: true });
      await login(context);
      let page = await openApp(context);
      await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 }).catch(() => null);
      if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller && loadedOnce, null, { timeout: 20000 }); }
      await page.waitForTimeout(400);
      await context.setOffline(true); S.down = true;
      await page.reload({ waitUntil: 'domcontentloaded' });
      const opened = await until(page, () => typeof JagaAppAccount === 'function' && !!JagaAppAccount(), null, 20000);
      // The chip is drawn just after the account opens (it once read "" for one frame under load).
      await until(page, () => /Offline/.test(document.getElementById('status-chip')?.textContent || ''), null, 5000);
      const state = await page.evaluate(() => ({ id: currentAccount && currentAccount.id, offline: typeof offlineMode !== 'undefined' && offlineMode,
        gate: !document.getElementById('auth-gate').classList.contains('hidden'), chip: document.getElementById('status-chip')?.textContent || '' }));
      check('Offline cold start: opens the last account without signal', opened && state.id === 'acc_a' && !state.gate, state);
      check('Offline cold start: header chip says "Offline"', /Offline/.test(state.chip) && state.offline, state);
      await photoOnReview(page);
      await page.evaluate(() => executeCropPathologyAnalysis());
      await until(page, () => scanState === 'sent', null, 8000);
      const sent = await page.evaluate(() => ({ state: scanState, text: document.getElementById('sent-text').textContent }));
      const queued = await drafts(page);
      check('Offline capture: saved on the phone with the plain "dikirim otomatis" message', queued.length === 1 && queued[0].status === 'pending' && /Tersimpan di HP/.test(sent.text), { sent, queued });
      await context.setOffline(false); S.down = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      const revalidated = await until(page, () => !offlineMode, null, 15000);
      check('Back online: session revalidated, offline mode ends', revalidated);
      const uploaded = await until(page, async () => (await JagaNative.list({ accountId: 'acc_a' })).drafts.every(d => d.status === 'submitted') , null, 25000);
      check('Back online: the offline photo is uploaded with the account header', uploaded && S.uploads.length === 1 && S.uploads[0].header === 'acc_a', S.uploads);
      check('Offline start: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Offline logout (H4): local sign-out is immediate, honoured at the next offline boot, finished when online. */
    await scenario('offline-logout', async () => {
      const context = await newContext({ sw: true });
      await login(context);
      let page = await openApp(context);
      await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 }).catch(() => null);
      if (!await page.evaluate(() => !!navigator.serviceWorker.controller)) { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller && loadedOnce, null, { timeout: 20000 }); }
      await context.setOffline(true); S.down = true;
      await page.evaluate(() => logout());
      const local = await page.evaluate(async () => ({ gate: !document.getElementById('auth-gate').classList.contains('hidden'), account: currentAccount, pending: await JagaOfflineStore.getMeta('pendingLogout'), marker: await JagaOfflineStore.getMeta('lastAccount') }));
      check('Offline logout: signed out locally at once, intent remembered, last-account marker removed', local.gate && local.account === null && local.pending && local.pending.accountId === 'acc_a' && !local.marker, local);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-gate:not(.hidden)', { timeout: 20000 });
      const reboot = await page.evaluate(() => ({ account: typeof currentAccount === 'undefined' ? null : currentAccount, text: document.getElementById('auth-error').textContent }));
      check('Offline logout: an offline restart does not reopen the account', reboot.account === null, reboot);
      const callsBefore = S.logoutCalls;
      await context.setOffline(false); S.down = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      const finished = await until(page, async () => !(await JagaOfflineStore.getMeta('pendingLogout')), null, 15000);
      check('Offline logout: finished on the server as soon as the signal returns', finished && S.logoutCalls > callsBefore && S.sessions.size === 0, { calls: S.logoutCalls, sessions: S.sessions.size });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-gate:not(.hidden)', { timeout: 20000 });
      check('Offline logout: the next person sees the login screen, not the previous account', await page.evaluate(() => currentAccount === null));
      // the account sheet warns about unsent photos and offers "hapus data HP"
      await page.close();   // the old signed-out tab would follow the new sign-in (BroadcastChannel) and upload the draft
      await login(context);
      page = await openApp(context);
      const jpeg = (await tinyJpeg(page)).split(',')[1];
      await page.evaluate(async b64 => { JagaOfflineSync.stop(); await JagaOfflineStore.enqueue({ accountId: 'acc_a', clientRequestId: 'unsent_draft_1', imageBase64: b64, fields: { cropHint: 'Kopi' } }); }, jpeg);
      await page.evaluate(() => { openAccountModal(); });
      const warning = page.evaluate(() => confirmLogout(false));
      await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 5000 });
      const message = await page.textContent('#confirm-message');
      await page.click('#confirm-cancel-btn'); await warning;
      check('Logout warns how many photos are unsent and that they stay on the phone', /1 foto belum terkirim/.test(message) && /tetap tersimpan/.test(message) && await page.evaluate(() => !!currentAccount), message);
      const beforeWipe = await drafts(page);
      const wipe = page.evaluate(() => confirmLogout(true));
      await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 5000 });
      const wipeMessage = await page.textContent('#confirm-message');
      await page.click('#confirm-ok-btn'); await wipe;
      const left = await page.evaluate(() => new Promise(resolve => { const r = indexedDB.open('jagakebond-offline-v1'); r.onsuccess = () => { const tx = r.result.transaction(['drafts', 'draftImages'], 'readonly'); const out = {}; tx.objectStore('drafts').count().onsuccess = e => { out.drafts = e.target.result; }; tx.objectStore('draftImages').count().onsuccess = e => { out.images = e.target.result; }; tx.oncomplete = () => resolve(out); }; }));
      check('"Keluar dan hapus data HP" names the loss and removes this account\'s drafts', /1 foto belum terkirim akan ikut terhapus/.test(wipeMessage) && left.drafts === 0 && left.images === 0, { wipeMessage, left, beforeWipe });
      check('Offline logout: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Account binding (H5 / contract 5.2): BroadcastChannel across tabs and 409 account_mismatch. */
    await scenario('accounts', async () => {
      const context = await newContext();
      await login(context);
      const first = await openApp(context);
      const jpeg = (await tinyJpeg(first)).split(',')[1];
      await first.evaluate(async b64 => { JagaOfflineSync.stop(); await JagaOfflineStore.enqueue({ accountId: 'acc_a', clientRequestId: 'draft_of_a_0001', imageBase64: b64, fields: { cropHint: 'Kopi' } }); }, jpeg);
      check('Binding: requests carry X-JK-Account', await first.evaluate(async () => { const seen = []; const real = window.fetch; window.fetch = (u, o) => { seen.push(o && o.headers && o.headers['X-JK-Account']); return real(u, o); }; await api('/api/farms'); window.fetch = real; return seen[0] === 'acc_a'; }));
      const second = await context.newPage();
      await second.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await second.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 20000 });
      await second.evaluate(async () => { await logout(); });
      const signedOut = await until(first, () => currentAccount === null && !document.getElementById('auth-gate').classList.contains('hidden'), null, 8000);
      check('Cross-tab: logging out in one tab signs the other tab out too', signedOut);
      await second.evaluate(async () => { const r = await api('/api/auth/login', { method: 'POST', body: { email: 'b@example.test', password: 'x' }, anonymous: true }); await afterSignIn(r.account); });
      await first.waitForTimeout(2500); // the stale tab reloads itself
      await first.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount(), null, { timeout: 20000 }).catch(() => null);
      check('Cross-tab: the stale tab follows the newly signed-in account after reload', await first.evaluate(() => currentAccount && currentAccount.id) === 'acc_b');
      // A tab still believing it is account B while the cookie now belongs to account A: the server answers 409.
      const third = await context.newPage();
      await third.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await third.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 20000 });
      await third.evaluate(() => { if (jkAccountChannel) jkAccountChannel.onmessage = null; JagaOfflineSync.stop(); });
      await login(context, 'a@example.test');           // cookie switches behind the tab's back, no broadcast
      const mismatch = await third.evaluate(async () => { try { await api('/api/records?limit=200'); return { thrown: false }; } catch (e) { return { thrown: true, mismatch: !!e.accountMismatch || /Akun di perangkat ini sudah berganti/.test(e.message), message: e.message, account: currentAccount, gate: !document.getElementById('auth-gate').classList.contains('hidden') }; } });
      // Either this call or a parallel background call of the same tab meets the 409 first; both end the same way.
      check('409 account_mismatch: the stale tab stops and signs out locally', mismatch.thrown && (mismatch.mismatch || /respons lama diabaikan/.test(mismatch.message)) && mismatch.account === null && mismatch.gate, mismatch);
      const kept = await third.evaluate(() => new Promise(resolve => { const r = indexedDB.open('jagakebond-offline-v1'); r.onsuccess = () => { const q = r.result.transaction('drafts').objectStore('drafts').get('acc_a:draft_of_a_0001'); q.onsuccess = () => resolve(!!q.result); }; }));
      check('Account switches never delete the other account\'s unsent drafts', kept);
      // the outbox: an upload refused with 409 keeps the draft pending (not failed) and stops syncing
      const fourth = await context.newPage();
      await fourth.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await fourth.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 20000 });
      await fourth.evaluate(() => { if (jkAccountChannel) jkAccountChannel.onmessage = null; JagaOfflineSync.stop(); window.location.reload = () => undefined; });
      await fourth.evaluate(async b64 => { await JagaOfflineStore.enqueue({ accountId: 'acc_a', clientRequestId: 'draft_mismatch_01', imageBase64: b64, fields: {} }); }, jpeg);
      await login(context, 'b@example.test');
      const before = S.uploads.length;
      await fourth.evaluate(() => JagaOfflineSync.run({ manual: true }));
      const row = await fourth.evaluate(() => new Promise(resolve => { const r = indexedDB.open('jagakebond-offline-v1'); r.onsuccess = () => { const q = r.result.transaction('drafts').objectStore('drafts').get('acc_a:draft_mismatch_01'); q.onsuccess = () => resolve(q.result); }; }));
      check('409 on upload: nothing is uploaded under the other account, the draft stays waiting', S.uploads.length === before && row && ['pending', 'uploading'].includes(row.status) && row.status !== 'failed' && await fourth.evaluate(() => currentAccount === null), { row, uploads: S.uploads.length - before });
      check('Accounts: no page errors', [first, second, third, fourth].every(p => (p.errors || []).length === 0), [first.errors, third.errors]);
      await context.close();
    });

    /* Sync engine: per-draft backoff, oldest first, 401-only sign-out, clamped future timestamps, retry button,
       cancel aborts an upload, timeouts (audit M1/M3/M4/M12, contract 5.9). */
    await scenario('sync', async () => {
      const context = await newContext();
      await login(context);
      const page = await openApp(context);
      await page.evaluate(async () => { JagaOfflineSync.stop(); await new Promise(r => setTimeout(r, 1200)); }); // let the sign-in pass finish
      const jpeg = (await tinyJpeg(page)).split(',')[1];
      await page.evaluate(async b64 => {
        const put = (id, fields) => JagaOfflineStore.enqueue({ accountId: 'acc_a', clientRequestId: id, imageBase64: b64, fields });
        await put('draft_new_00002', { cropHint: 'baru' });
        await put('draft_old_00001', { cropHint: 'lama', photoTimestampMs: String(Date.now() + 2 * 86400000) });
        await JagaOfflineStore.update('acc_a', 'draft_old_00001', { createdMs: Date.now() - 3600000 });
        await put('draft_fail_0003', { cropHint: 'gagal' });
        await JagaOfflineStore.update('acc_a', 'draft_fail_0003', { createdMs: Date.now() - 7200000 });
      }, jpeg);
      S.fail503.add('draft_fail_0003');
      await page.evaluate(() => JagaOfflineSync.run());
      check('Sync: drafts go out oldest first', JSON.stringify(S.analyzeCalls) === JSON.stringify(['draft_fail_0003', 'draft_old_00001', 'draft_new_00002']), S.analyzeCalls);
      const rows = Object.fromEntries((await drafts(page)).map(d => [d.clientRequestId, d]));
      const failing = rows.draft_fail_0003;
      check('Sync: a failing draft backs off on its own and does not block the others', failing.status === 'pending' && failing.attempts === 1 && failing.nextAttemptAtMs > Date.now() + 20000 && rows.draft_old_00001.status === 'submitted' && rows.draft_new_00002.status === 'submitted', failing);
      check('Sync: a photo time in the future is clamped before sending', (S.uploads.find(u => u.clientRequestId === 'draft_old_00001') || {}).photoTimestampMs <= Date.now() + 1000, S.uploads);
      check('Sync: failure reasons are plain Bahasa', /^[^a-z]*[A-Z]?[a-zA-Z ,.—-]*$/.test(failing.error || '') && /Server|sibuk|bermasalah/.test(failing.error), failing.error);
      const calls = S.analyzeCalls.length;
      await page.evaluate(() => JagaOfflineSync.run());
      check('Sync: a backed-off draft is not retried before its time', S.analyzeCalls.length === calls);
      S.fail503.delete('draft_fail_0003');
      await page.evaluate(async () => { navigateToMenu('log'); await updateOfflineDraftCount(); JagaDraftsStrip.expand(); });
      const send = await page.$('[data-send-draft="draft_fail_0003"]');
      check('Drafts: each waiting photo has one primary "Kirim" action', !!send);
      if (send) await send.click();
      check('Drafts: "Kirim" sends now, ignoring the backoff', await until(page, async () => (await JagaNative.list({ accountId: 'acc_a' })).drafts.find(d => d.clientRequestId === 'draft_fail_0003')?.status === 'submitted', null, 10000));
      // 403 is an ordinary refusal for that photo, not a sign-out (only 401 is)
      await page.evaluate(async b64 => { await JagaOfflineStore.enqueue({ accountId: 'acc_a', clientRequestId: 'draft_403_00004', imageBase64: b64, fields: {} }); }, jpeg);
      S.forbid403.add('draft_403_00004');
      await page.evaluate(() => JagaOfflineSync.run({ manual: true }));
      const refused = (await drafts(page)).find(d => d.clientRequestId === 'draft_403_00004');
      check('Sync: HTTP 403 does not sign the farmer out', await page.evaluate(() => !!currentAccount) && refused.status === 'failed', refused);
      await page.evaluate(async () => { await updateOfflineDraftCount(); JagaDraftsStrip.expand(); });
      const retryButton = await page.$('[data-retry-draft="draft_403_00004"]');
      check('Drafts: a failed photo offers "Coba lagi"', !!retryButton && /Coba lagi/.test(await retryButton.textContent()));
      S.forbid403.delete('draft_403_00004');
      if (retryButton) await retryButton.click();
      check('Drafts: "Coba lagi" sends the failed photo again', await until(page, async () => (await JagaNative.list({ accountId: 'acc_a' })).drafts.find(d => d.clientRequestId === 'draft_403_00004')?.status === 'submitted', null, 10000));
      // a 401 during upload signs out locally but keeps the draft
      await page.evaluate(async b64 => { await JagaOfflineStore.enqueue({ accountId: 'acc_a', clientRequestId: 'draft_401_00005', imageBase64: b64, fields: {} }); }, jpeg);
      S.sessions.clear();
      await page.evaluate(() => JagaOfflineSync.run({ manual: true }).then(() => new Promise(r => setTimeout(r, 300))));
      check('Sync: HTTP 401 signs out and keeps the photo', await page.evaluate(() => currentAccount === null) && await page.evaluate(() => new Promise(resolve => { const r = indexedDB.open('jagakebond-offline-v1'); r.onsuccess = () => { const q = r.result.transaction('drafts').objectStore('drafts').get('acc_a:draft_401_00005'); q.onsuccess = () => resolve(!!q.result && q.result.status === 'pending'); }; })));
      await context.close();

      // timeouts and cancel
      const c2 = await newContext();
      await login(c2);
      const p2 = await openApp(c2);
      await p2.evaluate(() => JagaOfflineSync.stop());
      S.hang.add('/api/daily');
      const timeout = await p2.evaluate(async () => { const t = Date.now(); try { await api('/api/daily', { timeoutMs: 700 }); return { ok: true }; } catch (e) { return { offline: !!e.offline, timedOut: !!e.timedOut, message: e.message, ms: Date.now() - t }; } });
      check('Timeout: a stalled API call fails after its timeout as a retryable network failure', timeout.offline && timeout.timedOut && timeout.ms < 3000 && /lambat/.test(timeout.message), timeout);
      check('Timeout: JSON 20 s / upload 90 s / health 10 s are configured', await p2.evaluate(() => API_TIMEOUT_MS === 20000) && /UPLOAD_TIMEOUT_MS = 90000/.test(fs_offlineSync()) && /HEALTH_TIMEOUT_MS = 10000/.test(fs_offlineSync()));
      S.hangAnalyze = true;
      await photoOnReview(p2);
      await p2.evaluate(() => { executeCropPathologyAnalysis(); });
      const uploading = await until(p2, () => activeOfflineCapture && JagaOfflineSync.isUploading(activeOfflineCapture.clientRequestId), null, 8000);
      const progress = await p2.evaluate(() => ({ state: scanState, cancelVisible: !document.getElementById('btn-cancel-analysis').classList.contains('hidden') && document.getElementById('btn-cancel-analysis').offsetParent !== null }));
      await p2.evaluate(() => cancelAnalysis());
      await p2.waitForTimeout(600);
      const after = await p2.evaluate(async () => ({ state: scanState, photo: !!selectedImageBase64, drafts: (await JagaNative.list({ accountId: 'acc_a' })).drafts.length, uploading: JagaOfflineSync.isUploading('x') }));
      check('Cancel: "Batalkan" aborts the running upload and keeps the photo on screen', uploading && progress.state === 'sending' && after.state === 'review' && after.photo && after.drafts === 0 && S.aborted >= 1, { uploading, progress, after, aborted: S.aborted });
      check('Sync/cancel: no page errors', page.errors.length === 0 && p2.errors.length === 0, [page.errors, p2.errors]);
      await c2.close();
    });

    /* IndexedDB v1 -> v2 split migration with real Chromium IndexedDB in the old format (audit M6). Lossless. */
    await scenario('idb-migration', async () => {
      const context = await newContext();
      const pre = await context.newPage();
      await pre.goto(BASE + '/__blank');
      const original = await pre.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 48; c.getContext('2d').fillStyle = '#3a6'; c.getContext('2d').fillRect(0, 0, 64, 48);
        const draftImage = c.toDataURL('image/jpeg', 0.9).split(',')[1];
        c.getContext('2d').fillStyle = '#a63'; c.getContext('2d').fillRect(0, 0, 32, 24);
        const photo = c.toDataURL('image/jpeg', 0.9).split(',')[1];
        return { draftImage, photo };
      });
      await pre.evaluate(original => new Promise((resolve, reject) => {
        const request = indexedDB.open('jagakebond-offline-v1', 1);
        request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('drafts', { keyPath: 'key' }).createIndex('accountId', 'accountId', { unique: false }); db.createObjectStore('cache', { keyPath: 'key' }); };
        request.onsuccess = () => {
          const db = request.result; const tx = db.transaction(['drafts', 'cache'], 'readwrite');
          tx.objectStore('drafts').put({ key: 'acc_a:legacy_draft_0001', accountId: 'acc_a', clientRequestId: 'legacy_draft_0001', imageBase64: original.draftImage, fields: { cropHint: 'Kopi', lat: '-6.2', lng: '106.8' }, fingerprint: 'fp-legacy', createdMs: 1700000000000, status: 'pending' });
          tx.objectStore('drafts').put({ key: 'acc_a:legacy_sub_00002', accountId: 'acc_a', clientRequestId: 'legacy_sub_00002', imageBase64: original.draftImage, fields: {}, fingerprint: 'fp2', createdMs: 1700000001000, status: 'submitted', jobId: 'job_legacy' });
          tx.objectStore('cache').put({ key: 'acc_a:cache:photo:record_job_old', accountId: 'acc_a', value: { imageBase64: original.photo, metadata: { lat: -6.2, lng: 106.8, locationSource: 'gps' } } });
          tx.objectStore('cache').put({ key: 'acc_a:cache:records', accountId: 'acc_a', value: [{ id: 'cached_rec', crop: 'Kopi' }] });
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }), original);
      await pre.close();
      // Inspect the migrated rows before the separate manual upload check.
      await context.addInitScript(() => {
        Object.defineProperty(window, 'JagaOfflineSync', {
          configurable: true,
          set(sync) {
            sync.start = () => {};
            Object.defineProperty(window, 'JagaOfflineSync', { value: sync, writable: true, configurable: true });
          },
        });
      });
      await login(context);
      const page = await openApp(context);
      const migrated = await page.evaluate(async () => {
        const list = (await JagaOfflineStore.list({ accountId: 'acc_a' })).drafts;
        const draft = (await JagaOfflineStore.draftGet({ accountId: 'acc_a', clientRequestId: 'legacy_draft_0001' })).draft;
        const photo = await JagaOfflineStore.photoGet({ accountId: 'acc_a', photoId: 'record_job_old' });
        const raw = await new Promise(resolve => { const r = indexedDB.open('jagakebond-offline-v1'); r.onsuccess = () => { const db = r.result; const tx = db.transaction(['drafts', 'draftImages', 'cache', 'photos'], 'readonly'); const out = { version: db.version, stores: [...db.objectStoreNames] };
          tx.objectStore('drafts').get('acc_a:legacy_draft_0001').onsuccess = e => { out.inline = 'imageBase64' in (e.target.result || {}); out.status = e.target.result.status; out.fingerprint = e.target.result.fingerprint; };
          tx.objectStore('draftImages').count().onsuccess = e => { out.images = e.target.result; };
          tx.objectStore('cache').get('acc_a:cache:photo:record_job_old').onsuccess = e => { out.oldPhotoEntry = !!e.target.result; };
          tx.objectStore('cache').get('acc_a:cache:records').onsuccess = e => { out.recordsCache = !!e.target.result; };
          tx.objectStore('photos').get('acc_a:record_job_old').onsuccess = e => { out.blob = e.target.result && e.target.result.blob instanceof Blob; };
          tx.oncomplete = () => { db.close(); resolve(out); }; }; });
        return { count: list.length, listHasImage: list.some(d => 'imageBase64' in d), draftImage: draft && draft.imageBase64, fields: draft && draft.fields, createdMs: draft && draft.createdMs, submitted: list.find(d => d.clientRequestId === 'legacy_sub_00002'), photo: photo.imageBase64, photoMeta: photo.metadata, raw };
      });
      check('IDB migration: database upgraded to v2 with the split stores', migrated.raw.version === 2 && ['draftImages', 'photos', 'thumbs', 'meta'].every(s => migrated.raw.stores.includes(s)), migrated.raw);
      check('IDB migration: every draft kept, metadata and status unchanged', migrated.count === 2 && migrated.raw.status === 'pending' && migrated.raw.fingerprint === 'fp-legacy' && migrated.createdMs === 1700000000000 && migrated.fields.cropHint === 'Kopi' && migrated.submitted && migrated.submitted.jobId === 'job_legacy', migrated);
      check('IDB migration: draft photos moved out of the rows byte for byte', !migrated.raw.inline && !migrated.listHasImage && migrated.raw.images === 2 && migrated.draftImage === original.draftImage);
      check('IDB migration: cached private photos become Blobs byte for byte', migrated.raw.blob && !migrated.raw.oldPhotoEntry && migrated.photo === original.photo && migrated.photoMeta.locationSource === 'gps');
      check('IDB migration: other caches survive', migrated.raw.recordsCache);
      check('IDB migration: migrated drafts still upload', await page.evaluate(() => JagaOfflineSync.run({ manual: true }).then(async () => (await JagaOfflineStore.list({ accountId: 'acc_a' })).drafts.find(d => d.clientRequestId === 'legacy_draft_0001').status === 'submitted')) && S.uploads.some(u => u.clientRequestId === 'legacy_draft_0001'));
      check('IDB migration: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Best-effort private photo copy (H3): a full phone never blocks the capture; JagaMedia.delete; LRU cap. */
    await scenario('quota', async () => {
      const context = await newContext();
      await login(context);
      const page = await openApp(context);
      await page.evaluate(() => {
        window.__realPhotoPut = JagaOfflineStore.photoPut;
        JagaOfflineStore.photoPut = async () => { const e = new DOMException('The quota has been exceeded.', 'QuotaExceededError'); throw e; };
      });
      await photoOnReview(page);
      await page.evaluate(() => executeCropPathologyAnalysis());
      const done = await until(page, () => ['sent', 'result'].includes(scanState), null, 15000);
      const toast = await page.textContent('#toast-notification');
      check('Quota: the capture is still saved and sent when the private copy does not fit', done && S.uploads.length === 1, { state: await page.evaluate(() => scanState), uploads: S.uploads });
      check('Quota: the farmer gets a plain Bahasa note, no raw English', /Penyimpanan HP|Salinan asli/.test(toast) && !/quota|exceeded/i.test(toast), toast);
      const media = await page.evaluate(async () => {
        JagaOfflineStore.photoPut = window.__realPhotoPut;
        const store = window.JagaOfflineStore;
        const b64 = document.createElement('canvas').toDataURL('image/jpeg').split(',')[1];
        await JagaMedia.put({ accountId: 'acc_a', photoId: 'record_delete_me', imageBase64: b64, metadata: {} });
        const had = !!(await JagaMedia.get({ accountId: 'acc_a', photoId: 'record_delete_me' })).imageBase64;
        const first = await JagaMedia.delete({ photoId: 'record_delete_me' });
        const again = await JagaMedia.delete({ photoId: 'record_delete_me' });
        const gone = !(await JagaMedia.get({ accountId: 'acc_a', photoId: 'record_delete_me' })).imageBase64;
        return { had, first, again, gone, persist: typeof store.requestPersistence };
      });
      check('JagaMedia.delete removes the private copy and is idempotent', media.had && media.first.deleted === true && media.again.deleted === false && media.gone, media);
      const lru = await page.evaluate(async () => {
        const c = document.createElement('canvas'); c.width = 8; c.height = 8; const b64 = c.toDataURL('image/jpeg').split(',')[1];
        for (let i = 0; i < 175; i += 1) await JagaOfflineStore.photoPut({ accountId: 'acc_a', photoId: 'lru_' + i, imageBase64: b64, metadata: {} });
        await JagaOfflineStore.evictPhotos('acc_a');
        return new Promise(resolve => { const r = indexedDB.open('jagakebond-offline-v1'); r.onsuccess = () => { const q = r.result.transaction('photos').objectStore('photos').getAllKeys(); q.onsuccess = () => resolve({ count: q.result.length, oldestKept: q.result.includes('acc_a:lru_0'), newestKept: q.result.includes('acc_a:lru_174') }); }; });
      });
      check('LRU: the private photo cache stays inside its cap, oldest out first', lru.count <= 160 && !lru.oldestKept && lru.newestKept, lru);
      check('storage.persist() is requested after sign-in', await page.evaluate(() => typeof JagaOfflineStore.requestPersistence === 'function'));
      check('Deleting a record deletes its private copy (contract 5.6)', /deleteQuietly\(\{ photoId: recordId \}\)/.test(fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8')));
      check('Quota: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Stale GPS (H6) and the GPS watcher lifecycle. */
    await scenario('gps', async () => {
      const context = await newContext();
      const gate = await openApp(context, { signedIn: false });
      check('GPS watcher does not run on the login screen', await gate.evaluate(() => window.__geo.watch) === 0);
      await gate.close();
      await login(context);
      const page = await openApp(context);
      const geo1 = await page.evaluate(() => ({ ...window.__geo, wanted: typeof watchWanted !== 'undefined' && watchWanted, id: typeof watchId !== 'undefined' ? watchId : 'n/a' }));
      check('GPS watcher starts after sign-in (once)', geo1.watch === 1, geo1);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      const paused = await page.evaluate(() => window.__geo.clear);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      const geo2 = await page.evaluate(() => ({ ...window.__geo }));
      check('GPS watcher pauses while the app is hidden and resumes when visible', paused >= 1 && geo2.watch === geo1.watch + 1, { paused, geo1, geo2 });
      await page.evaluate(() => navigateToMenu('scan'));
      await page.waitForFunction(() => { const v = document.getElementById('camera-stream'); return v && v.videoWidth > 0 && !v.classList.contains('hidden'); }, null, { timeout: 10000 });
      const stale = await page.evaluate(() => {
        stopLiveLocationWatcher();
        currentCoords = { ...currentCoords, lat: -6.3, lng: 106.9, accuracy: 5, fixMs: Date.now() - 120000, locationName: 'Tempat lama' };
        takeSnapshotForReview();
        const meta = selectedPhotoMetadata;
        return { lat: meta.lat, accuracy: meta.accuracy, source: meta.locationSource, chip: document.getElementById('scan-location-text').textContent, warning: !document.getElementById('scan-location-warning').classList.contains('hidden') };
      });
      check('Stale GPS: a fix older than 60 s is not stamped on the photo', stale.lat === null && stale.accuracy === null && stale.source === 'unknown', stale);
      check('Stale GPS: the review says "Lokasi belum terbaca" and offers to place the photo', /belum terbaca/i.test(stale.chip) && stale.warning, stale);
      const fresh = await page.evaluate(() => {
        resetToLiveCamera();
        return new Promise(resolve => setTimeout(() => {
          currentCoords = { ...currentCoords, lat: -6.3, lng: 106.9, accuracy: 7, fixMs: Date.now() - 5000, locationName: 'Ciomas, Bogor' };
          takeSnapshotForReview();
          resolve({ lat: selectedPhotoMetadata.lat, accuracy: selectedPhotoMetadata.accuracy, chip: document.getElementById('scan-location-text').textContent });
        }, 1500));
      });
      check('Fresh GPS: a recent fix is stamped with its accuracy', fresh.lat === -6.3 && fresh.accuracy === 7 && /±7 m/.test(fresh.chip), fresh);
      check('GPS: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Polling only while something is pending, paused while hidden (audit M5). */
    await scenario('polling', async () => {
      const context = await newContext();
      await login(context);
      const page = await openApp(context);
      await page.waitForTimeout(1500);
      const idleStart = S.pendingCalls;
      await page.waitForTimeout(24000);
      check('Polling: nothing pending -> no background polling', S.pendingCalls - idleStart === 0, { calls: S.pendingCalls - idleStart });
      S.jobMode = 'queued';
      await photoOnReview(page);
      await page.evaluate(() => executeCropPathologyAnalysis());
      await until(page, () => scanState === 'sent', null, 10000);
      await page.evaluate(() => { resetToLiveCamera(); navigateToMenu('home'); });
      const busyStart = S.pendingCalls;
      await page.waitForTimeout(23000);
      check('Polling: a submitted photo is checked in the background', S.pendingCalls - busyStart >= 1, { calls: S.pendingCalls - busyStart });
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      const hiddenStart = S.pendingCalls;
      await page.waitForTimeout(23000);
      check('Polling: paused while the app is hidden', S.pendingCalls - hiddenStart === 0, { calls: S.pendingCalls - hiddenStart });
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      S.jobMode = 'done';
      const result = await until(page, () => farmRecords.some(r => r.id.startsWith('record_job_')) &&
        /\d/.test(document.querySelector('#nav-btn-log .nav-badge')?.textContent || ''), null, 25000);
      const badge = await page.evaluate(() => document.querySelector('#nav-btn-log .nav-badge')?.textContent || '');
      check('Polling: the background result lands in Riwayat with a badge (G9)', result && /\d/.test(badge), { result, badge });
      check('Polling: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Scan flow UX (S2-S7) and button rules at 360x780. */
    await scenario('scan-ux', async () => {
      const context = await newContext({ viewport: { width: 360, height: 780 } });
      await login(context);
      const page = await openApp(context);
      await page.evaluate(() => JagaOfflineSync.stop());
      const audit = () => page.evaluate(() => {
        const nav = document.querySelector('#app-shell > nav').getBoundingClientRect();
        const out = [];
        document.querySelectorAll('#view-scan button, #view-scan label.btn, #offline-drafts button').forEach(b => {
          const r = b.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(b).visibility === 'hidden') return;
          const label = b.querySelector('.btn-label') || b;
          const lh = parseFloat(getComputedStyle(label).lineHeight) || 20;
          if (b.classList.contains('scan-preview-hit')) return;   // transparent tap area over the photo, not a button face
          out.push({ text: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 30), h: Math.round(r.height), wrapped: label.scrollHeight > lh * 1.6 || label.scrollWidth > label.clientWidth + 1 });
        });
        return { buttons: out.filter(b => b.text), overflow: document.documentElement.scrollWidth > innerWidth, navTop: nav.top };
      });
      await photoOnReview(page);
      await page.waitForTimeout(200);
      const review = await page.evaluate(() => { const a = document.getElementById('btn-run-analysis').getBoundingClientRect(), f = document.getElementById('scan-frame').getBoundingClientRect(), nav = document.querySelector('#app-shell > nav').getBoundingClientRect(); return { analyseTop: a.top, analyseBottom: a.bottom, navTop: nav.top, frameH: f.height, vh: innerHeight, actions: document.querySelectorAll('#btn-run-analysis,#btn-run-fast').length, fast: !!document.getElementById('btn-run-fast'), quota: document.getElementById('fast-quota-status').textContent, primary: document.getElementById('btn-run-analysis').classList.contains('btn-primary') }; });
      check('S2: "Analisis" is visible above the nav without scrolling', review.analyseBottom <= review.navTop && review.analyseTop > 0, review);
      check('S2: the photo preview takes at most ~40 % of the height', review.frameH <= review.vh * 0.4 + 2, review);
      check('S3: one primary "Analisis"; the daily fast allowance is explained in plain text', review.primary && review.actions === 1 && !review.fast && /sisa 2 dari 3/.test(review.quota) && /antrean biasa/.test(review.quota), review);
      let a = await audit();
      check('Buttons (review): >= 44 px, labels never wrap, no horizontal overflow', !a.overflow && a.buttons.every(b => b.h >= 44 && !b.wrapped), a);
      S.jobMode = 'queued';
      await page.evaluate(() => executeCropPathologyAnalysis());
      await until(page, () => scanState === 'sent', null, 10000);
      const sent = await page.evaluate(() => ({ title: document.getElementById('sent-title').textContent, text: document.getElementById('sent-text').textContent, next: !!document.getElementById('btn-next-photo').offsetParent, history: !!document.getElementById('btn-open-history').offsetParent }));
      check('S4: after upload "Foto terkirim" + "Ambil foto berikutnya" / "Lihat di Riwayat"', /Foto terkirim/.test(sent.title) && /beberapa menit/.test(sent.text) && sent.next && sent.history, sent);
      S.jobMode = 'done';
      const shown = await until(page, () => scanState === 'result', null, 20000);
      const result = await page.evaluate(() => ({ badge: document.getElementById('res-badge-severity').textContent, action: document.getElementById('res-geo-brief').textContent, words: document.getElementById('res-confidence-words').textContent, listen: !!document.getElementById('res-listen').offsetParent }));
      check('S4/S6: the result appears on the scan screen when it arrives, in plain words', shown && result.badge === 'Waspada' && /Buang daun/.test(result.action) && /Dugaan dari foto, belum dikonfirmasi/.test(result.words) && result.listen, result);
      a = await audit();
      check('Buttons (result): >= 44 px, labels never wrap, no horizontal overflow', !a.overflow && a.buttons.every(b => b.h >= 44 && !b.wrapped), a);
      // Owner phone test 2026-10-28: the second photo could not be sent because the Analisis buttons stayed disabled
      // after the first send. Use REAL taps here (the checks above call the function directly).
      S.jobMode = 'queued';
      await page.evaluate(() => takeAnotherPhoto());
      await photoOnReview(page);
      await page.waitForTimeout(200);
      const second = await page.evaluate(() => ({ analyse: document.getElementById('btn-run-analysis').disabled, busy: scanBusy }));
      check('Second photo: "Analisis" is enabled again after the first send', !second.analyse && !second.busy, second);
      await page.click('#btn-run-analysis');
      check('Second photo: tapping "Analisis" sends it', await until(page, () => scanState === 'sent', null, 10000));
      // S7: provider outage -> "Kirim ulang"; refused photo -> "Foto ulang"
      S.jobMode = 'provider';
      await page.evaluate(() => resetToLiveCamera());
      await photoOnReview(page);
      await page.evaluate(() => executeCropPathologyAnalysis());
      await until(page, () => scanState === 'failed', null, 20000);
      const outage = await page.evaluate(() => ({ text: document.getElementById('analysis-failed-text').textContent, retry: document.getElementById('btn-retry-label').textContent, retryShown: !document.getElementById('btn-retry-analysis').classList.contains('hidden') }));
      check('S7: provider outage keeps the photo and offers "Kirim ulang"', /Foto Anda aman/.test(outage.text) && !/ditolak triase/i.test(outage.text) && outage.retry === 'Kirim ulang' && outage.retryShown, outage);
      S.jobMode = 'rejected';
      await page.evaluate(() => resetToLiveCamera());
      await photoOnReview(page);
      await page.evaluate(() => executeCropPathologyAnalysis());
      await until(page, () => scanState === 'failed', null, 20000);
      const refused = await page.evaluate(() => ({ retryShown: !document.getElementById('btn-retry-analysis').classList.contains('hidden'), retakePrimary: document.getElementById('btn-retake-after-fail').classList.contains('btn-primary') }));
      check('S7: a refused photo makes "Foto ulang" the one primary action', !refused.retryShown && refused.retakePrimary, refused);
      // S5: started from a tree -> never asked again
      S.jobMode = 'done';
      S.records.acc_a = [makeRecord(1, { id: 'rec_tree', cropId: 'tree_9', cropName: 'Kopi depan', crop: 'Kopi' })];
      await page.evaluate(() => refreshAllData());
      await page.evaluate(() => { resetToLiveCamera(); return startTreeCapture('tree_9'); });
      await photoOnReview(page);
      await page.evaluate(() => { selectedCaptureTree = { ...selectedCaptureTree }; executeCropPathologyAnalysis(); });
      await until(page, () => scanState === 'result', null, 20000);
      const tree = await page.evaluate(() => ({ card: !document.getElementById('scan-assign-card').classList.contains('hidden'), modal: !document.getElementById('modal-crop-assign').classList.contains('hidden'), upload: true }));
      check('S5: a photo started from a tree is not asked "which tree" again', !tree.card && !tree.modal && S.uploads.at(-1).clientRequestId && [...S.jobs.values()].at(-1).context.cropId === 'tree_9', tree);
      // Drafts strip D1
      const jpeg = (await tinyJpeg(page)).split(',')[1];
      await page.evaluate(async () => { for (const d of (await JagaNative.list({ accountId: 'acc_a' })).drafts) await JagaNative.remove({ accountId: 'acc_a', clientRequestId: d.clientRequestId }); workflowJobs.clear(); }).catch(() => undefined);
      for (const j of S.jobs.values()) j.acked = true;
      await page.evaluate(async () => { for (const d of (await JagaNative.list({ accountId: 'acc_a' })).drafts) await JagaNative.remove({ accountId: 'acc_a', clientRequestId: d.clientRequestId }); workflowJobs.clear(); });
      await page.evaluate(async b64 => { await JagaOfflineStore.enqueue({ accountId: 'acc_a', clientRequestId: 'strip_draft_001', imageBase64: b64, fields: { cropHint: 'Kopi', lat: '-6.2', lng: '106.8' } }); navigateToMenu('log'); await updateOfflineDraftCount(); }, jpeg);
      const strip = await page.evaluate(() => { const s = document.getElementById('offline-drafts'); return { shown: !s.hidden, height: s.getBoundingClientRect().height, summary: document.getElementById('drafts-summary').textContent, collapsed: document.getElementById('offline-drafts-list').hidden, coords: /-?\d+\.\d{3,}/.test(s.textContent) }; });
      check('D1: Riwayat opens with one compact strip "1 belum terkirim · Kirim sekarang"', strip.shown && strip.collapsed && strip.height <= 72 && /^1 belum terkirim$/.test(strip.summary), strip);
      await page.click('#drafts-toggle');
      const row = await page.evaluate(() => { const r = document.querySelector('.draft-row'); return r && { chips: r.querySelectorAll('.draft-chip').length, primary: r.querySelectorAll('.draft-row-actions > .btn').length, title: r.querySelector('.draft-row-title').textContent, more: !!r.querySelector('.draft-more summary'), coords: /-?\d+\.\d{3,}/.test(r.textContent) }; });
      check('D1: each row has a thumbnail, a name, ONE chip, ONE primary action and a "⋯" menu; no raw coordinates', row && row.chips === 1 && row.primary === 1 && row.title === 'Kopi' && row.more && !row.coords && !strip.coords, row);
      a = await audit();
      check('Buttons (drafts strip): >= 44 px, labels never wrap', a.buttons.every(b => b.h >= 44 && !b.wrapped), a);
      const chip = await page.evaluate(() => { const c = document.getElementById('status-chip'); return { shown: !c.classList.contains('hidden'), text: c.textContent, label: c.getAttribute('aria-label'), h: c.getBoundingClientRect().height }; });
      check('G8: header status chip shows the waiting photo and opens the drafts', chip.shown && /1 belum terkirim/.test(chip.text) && /foto belum terkirim/.test(chip.label) && chip.h >= 44, chip);
      // G10 back button: closes the top-most layer first, then goes home, then backgrounds the app
      const back = await page.evaluate(() => {
        const steps = [];
        openAccountModal(); document.dispatchEvent(new Event('jagaBack')); steps.push(document.getElementById('modal-account').classList.contains('hidden'));
        navigateToMenu('log'); document.dispatchEvent(new Event('jagaBack')); steps.push(!document.getElementById('view-home').classList.contains('hidden'));
        return steps;
      });
      check('G10: jagaBack closes a dialog first, then returns to Beranda', back[0] && back[1], back);
      check('Scan UX: no page errors', page.errors.length === 0, page.errors);
      await context.close();
    });

    /* Old Android WebView shims (audit M13). */
    await scenario('polyfills', async () => {
      const context = await newContext();
      const page = await context.newPage();
      await page.addInitScript(() => { delete Object.hasOwn; delete Array.prototype.at; delete String.prototype.at; if (window.crypto) { try { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }); } catch (_) { /* ignore */ } } });
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-gate:not(.hidden)', { timeout: 15000 });
      const ok = await page.evaluate(() => ({ hasOwn: Object.hasOwn({ a: 1 }, 'a'), at: [1, 2, 3].at(-1), sat: 'abc'.at(-1), uuid: /^[0-9a-f-]{36}$/.test(crypto.randomUUID()) }));
      check('Polyfills: Object.hasOwn, .at() and crypto.randomUUID exist on an old engine', ok.hasOwn && ok.at === 3 && ok.sat === 'c' && ok.uuid, ok);
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
    console.log(JSON.stringify(checks, null, 2));
    const failed = checks.filter(c => !c.ok);
    console.log('web-0220: ' + (checks.length - failed.length) + '/' + checks.length + ' checks passed' + (failed.length ? '; FAILED: ' + failed.map(c => c.name).join(' | ') : ''));
    if (failed.length || !checks.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); try { server.close(); } catch (_) { /* closed */ } process.exitCode = 1; });

function fs_offlineSync() { return fs.readFileSync(path.join(FRONTEND, 'offline-sync.js'), 'utf8'); }

