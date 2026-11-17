/* Node unit tests for the 0.2.2.0 field-app logic that needs no browser (run: node --test tests/web-0220.test.cjs).
   The browser behaviour (service worker, IndexedDB, CSP, cross-tab) is covered by review/browser-tools/web-0220.cjs. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const FRONT = path.resolve(__dirname, '../frontend');
const read = name => fs.readFileSync(path.join(FRONT, name), 'utf8');

/* A function (or a run of consecutive declarations) cut out of app.js by its first and next markers. */
function slice(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'markers not found: ' + start);
  return source.slice(a, b);
}
function stubElement() {
  return { textContent: '', innerText: '', hidden: false, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {}, querySelector: () => null };
}
function browserLike(extra = {}) {
  const listeners = {};
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    createElement: () => stubElement(), body: stubElement(), documentElement: stubElement(), hidden: false, cookie: '' };
  const window = { addEventListener() {}, document, navigator: { onLine: true }, location: { reload() {} } };
  return Object.assign({ window, document, navigator: window.navigator, console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Error,
    Number, String, Object, Array, RegExp, isFinite, Intl, URL, encodeURIComponent, requestAnimationFrame: fn => fn() }, extra);
}

const APP = read('app.js');

test('draftSyncLabel: one short plain-Bahasa label for every draft state (UX D1, AND error values)', () => {
  const ctx = browserLike();
  vm.createContext(ctx);
  vm.runInContext(slice(APP, '    function draftSyncLabel(draft) {', '    async function syncPendingDrafts() {'), ctx);
  const label = d => ctx.draftSyncLabel(d);
  const cases = [
    [{ status: 'pending' }, 'Menunggu dikirim'], [{ status: 'uploading' }, 'Sedang dikirim'], [{ status: 'submitted' }, 'Sedang dianalisis'],
    [{ status: 'editing' }, 'Siap dikirim'], [{ status: 'failed', errorCode: 'http_413' }, 'Foto terlalu besar — foto ulang'],
    [{ status: 'failed', error: 'http_422' }, 'Ditolak server — foto ulang'], [{ status: 'failed', error: 'invalid:polygon' }, 'Ditolak server — foto ulang'],
    [{ status: 'blocked', error: 'health_http_403' }, 'Server belum bisa dicek — dicoba lagi otomatis'], [{ status: 'blocked', error: 'authentication_required' }, 'Masuk lagi untuk mengirim'],
    [{ status: 'blocked', error: 'account_mismatch' }, 'Akun berganti — masuk lagi'], [{ status: 'failed', error: 'image_unreadable' }, 'Foto rusak — hapus lalu foto ulang'],
    [{ status: 'pending', serverCode: 'queue_full' }, 'Antrean Anda penuh — dikirim nanti'], [{ status: 'pending', serverCode: 'decode_busy' }, 'Server sibuk — dicoba lagi otomatis'],
    [{ status: 'pending', errorCode: 'timeout' }, 'Sinyal lemah — dicoba lagi otomatis'], [{ status: 'pending', nextAttemptAtMs: Date.now() + 60000 }, 'Server sibuk — dicoba lagi otomatis'],
    [{ status: 'conflict' }, 'Perlu dicek di Riwayat'], [{ status: 'failed', error: 'Foto ditolak server.' }, 'Gagal — coba lagi'],
  ];
  for (const [draft, expected] of cases) assert.equal(label(draft), expected, JSON.stringify(draft));
  for (const [draft] of cases) assert.doesNotMatch(label(draft), /HTTP|http_|undefined|null|sinkron/i);
  ctx.navigator.onLine = false;
  assert.equal(label({ status: 'pending' }), 'Menunggu sinyal');
});

test('records paging: follows the cursor, keeps server order, accepts the legacy array (contract 5.1)', async () => {
  const ctx = browserLike();
  vm.createContext(ctx);
  vm.runInContext(slice(APP, '    const RECORDS_PAGE = 200;', '    async function loadDaily() {'), ctx);
  const all = Array.from({ length: 450 }, (_, i) => ({ id: 'r' + i }));
  const calls = [];
  ctx.api = async url => { calls.push(url); const u = new URL(url, 'http://x'); const start = Number(u.searchParams.get('cursor') || 0); return { items: all.slice(start, start + 200), next: start + 200 < all.length ? String(start + 200) : null }; };
  const got = await ctx.fetchAllRecords();
  assert.equal(JSON.stringify(got.map(r => r.id)), JSON.stringify(all.map(r => r.id)));
  assert.deepEqual(calls, ['/api/records?limit=200', '/api/records?limit=200&cursor=200', '/api/records?limit=200&cursor=400']);
  ctx.api = async () => all.slice(0, 3);
  assert.equal((await ctx.fetchAllRecords()).length, 3);
  let loops = 0;
  ctx.api = async () => { loops += 1; return { items: [{ id: 'x' }], next: 'same' }; };
  await ctx.fetchAllRecords();
  assert.ok(loops <= 2, 'a server repeating its cursor must not loop forever');
});

test('normalizeRecord: null crop/condition never crash a list; ids become strings (audit M11)', () => {
  const ctx = browserLike();
  vm.createContext(ctx);
  vm.runInContext(slice(APP, '    function canonicalCropName(value) {', '    async function loadDaily() {'), ctx);
  const rec = ctx.normalizeRecord({ id: 7, crop: null, condition: undefined, severity: null, cropName: 12 });
  assert.equal(rec.crop, ''); assert.equal(rec.condition, ''); assert.equal(rec.id, '7'); assert.equal(rec.cropName, '12'); assert.equal(rec.severity, null);
  assert.equal(typeof ctx.normalizeRecord(null).id, 'string');
  assert.equal(ctx.normalizeRecord({ id: 'a', crop: 'Kopi', condition: 'Sehat', severity: 'Healthy' }).crop, 'Kopi');
});

test('session.js: Bahasa messages, no raw English platform errors (audit L5 / M10)', () => {
  const ctx = browserLike({ BroadcastChannel: undefined });
  vm.createContext(ctx);
  vm.runInContext(read('session.js'), ctx);
  assert.equal(ctx.httpMessage(413), 'Berkas terlalu besar.');
  assert.equal(ctx.httpMessage(500), 'Server sedang bermasalah. Coba lagi nanti.');
  assert.equal(ctx.httpMessage(422, 'Petak terlalu rumit.'), 'Petak terlalu rumit.');
  assert.equal(ctx.userMessage(new Error('Failed to fetch')), 'Tidak dapat menghubungi server. Periksa koneksi Anda.');
  assert.equal(ctx.userMessage(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })), 'Penyimpanan HP penuh. Hapus foto lama atau kirim foto yang menunggu, lalu coba lagi.');
  assert.equal(ctx.userMessage(new Error('Cannot read properties of undefined')), 'Terjadi masalah. Coba lagi.');
  assert.equal(ctx.userMessage(new Error('Foto tidak valid.')), 'Foto tidak valid.');
  const timeout = ctx.networkProblem(true);
  assert.ok(timeout.offline && timeout.timedOut);
  assert.equal(vm.runInContext('API_TIMEOUT_MS', ctx), 20000);
});

test('scan-flow.js: GPS freshness gate (audit H6) and the location chip wording (S1)', () => {
  const ctx = browserLike();
  vm.createContext(ctx);
  vm.runInContext(read('scan-flow.js') + '\n;this.__gps=currentGpsStatus;this.__chip=liveLocationModel;this.__badge=severityBadge;this.__conf=confidenceWords;', ctx);
  ctx.validCoordinates = (a, b) => Number.isFinite(a) && Number.isFinite(b);
  const now = Date.now();
  ctx.currentCoords = { lat: -6.2, lng: 106.8, accuracy: 8, fixMs: now - 120000, locationName: 'Ciomas, Bogor' };
  assert.equal(ctx.__gps().state, 'stale');
  assert.equal(ctx.__chip().text, 'Lokasi belum terbaca');
  ctx.currentCoords.fixMs = now - 5000;
  assert.equal(ctx.__gps().state, 'fresh');
  assert.equal(ctx.__chip().text, 'Lokasi: Ciomas ±8 m');
  ctx.currentCoords.accuracy = 150;
  assert.equal(ctx.__gps().state, 'weak');
  ctx.currentCoords.accuracy = 500;
  assert.equal(ctx.__gps().state, 'inaccurate');
  ctx.currentCoords = { lat: null, lng: null };
  assert.equal(ctx.__gps().state, 'none');
  assert.equal(ctx.__badge(null).label, 'Belum dinilai');
  assert.equal(ctx.__badge('Belum').label, 'Belum dinilai');
  assert.match(ctx.__conf(0.3), /Bukti foto belum cukup/);
  assert.match(ctx.__conf(0.8), /belum dikonfirmasi/);
  assert.doesNotMatch(ctx.__conf(0.8), /80%/);
  assert.equal(vm.runInContext('GPS_MAX_AGE_MS', ctx), 60000);
});

test('offline-sync.js: timeouts and backoff constants follow contract 5.9', () => {
  const source = read('offline-sync.js');
  assert.match(source, /API_TIMEOUT_MS = 20000/);
  assert.match(source, /UPLOAD_TIMEOUT_MS = 90000/);
  assert.match(source, /HEALTH_TIMEOUT_MS = 10000/);
  assert.match(source, /'X-JK-Account': accountId/);
  const { retryAfterDelayMs } = require(path.join(FRONT, 'offline-sync.js'));
  assert.equal(retryAfterDelayMs('120'), 120000);
  assert.equal(retryAfterDelayMs('5'), 5000);
});

test('service worker: one cache name, HTML for a script is never cached, tiles never cached (5.7)', () => {
  const sw = read('sw.js');
  assert.equal((sw.match(/jk-v\d+/g) || []).length, 1, 'the cache name appears once');
  assert.match(sw, /const SHELL_CACHE = 'jk-v85';/);
  for (const page of ['app.js', 'session.js', 'shell.js', 'scan-flow.js', 'workflow-ui.js']) assert.doesNotMatch(read(page), /jk-v\d+/, page + ' must not name a cache');
  assert.match(sw, /isValidShellResponse/);
  assert.match(sw, /url\.origin !== self\.location\.origin\) return;/);
});

test('known species aliases and parenthetical English stripping stay consistent', () => {
 const ctx=browserLike();vm.createContext(ctx);
 vm.runInContext(slice(APP,'    function canonicalCropName(value) {','    async function loadDaily() {'),ctx);
 for(const label of ['Ketapang (Sea Almond)','Ketapang (Tropical Almond)','Sea Almond','Terminalia catappa','  ketapang (INDIAN ALMOND)  ']) {
   const row=ctx.normalizeRecord({id:label,cropId:label,crop:label,cropName:label});
   assert.equal(row.crop,'Ketapang');assert.equal(row.cropName,row.crop);assert.equal(row.cropId,label);
 }
 for(const label of ['Almond','Ketapang depan rumah','Ketapang Kencana'])assert.equal(ctx.canonicalCropName(label),label);
 assert.equal(ctx.canonicalCropName('Pisang (Banana)'),'Pisang');
 assert.equal(ctx.canonicalCropName('Tomat (Tomato)'),'Tomat');
});

test('ui revisions: camera zoom, 30-min telemetry, auto daily archive, profile avatar, Proper Case', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const plotJs = read('plot-summary.js');
  assert.match(html, /id="btn-cam-zoom"/);
  assert.match(html, /id="btn-flip-cam"/);
  assert.doesNotMatch(html, /class="reticle-corner/);
  assert.match(APP, /TELEMETRY_REFRESH_MS = 30 \* 60 \* 1000;/);
  assert.doesNotMatch(APP, /TELEMETRY_MOVED_REFRESH_MS/);
  assert.match(APP, /async function syncAutoDailyArchive\(/);
  assert.match(APP, /function toggleAccountAvatar\(/);
  assert.doesNotMatch(css, /\.badge::before\s*\{/);
  assert.match(plotJs, /Perlu Tindakan/);
  assert.match(plotJs, /Perlu Dipantau/);
  assert.match(plotJs, /Belum Ada Data/);
  assert.doesNotMatch(APP, /trendDotsHtml\(/);
});


test('assessment-ui label formatter: pest/disease stays one or two words', () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('assessment-ui.js') + ';this.label=window.JagaAssessment.label;', ctx);
  const label = text => ctx.label({ condition:text });
  const cases = new Map([
    ['Utama adalah hama penggerek batang yang menyerang pucuk.', 'Hama Penggerek'],
    ['Penyebab utama adalah Antraknosa.', 'Antraknosa'],
    ['Dugaan mosaik virus pada daun muda', 'Mosaik'],
    ['Serangan ulat grayak', 'Ulat'],
    ['Dugaan kekurangan unsur hara kalium', 'Kekurangan Kalium'],
    ['Bercak daun cercospora memerlukan konfirmasi', 'Bercak Daun'],
    ['Penyebab utama adalah penyakit jamur', 'Penyakit Jamur'],
  ]);
  for (const [text, expected] of cases) {
    const got = label(text);
    assert.equal(got, expected, text);
    assert.ok(got.split(/\s+/).length <= 2, `too long: ${got}`);
    assert.doesNotMatch(got, /utama|adalah|dugaan|penyebab/i, `explanatory wrapper leaked: ${got}`);
  }
});
test('active pest and disease findings coexist while unsupported alternatives stay out', () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read('assessment-ui.js') + ';this.label=window.JagaAssessment.label;', ctx);
  assert.equal(ctx.label({assessment:{
    active_conditions:['Antraknosa','Ulat grayak'],
    possible_causes:['Dugaan antraknosa.','Dugaan ulat grayak.','Alternatif: bercak daun.']
  }}), 'Antraknosa · Ulat');
  assert.equal(ctx.label({assessment:{
    active_conditions:['Antraknosa dan Ulat grayak'],
    possible_causes:['Dugaan antraknosa.']
  }}), 'Antraknosa · Ulat');
  assert.equal(ctx.label({assessment:{
    possible_causes:['Dugaan antraknosa.','Dugaan ulat grayak.']
  }}), 'Belum Dapat Dipastikan');
});

test('telemetry refresh interval: 30-min gate unless forced manually', async () => {
  let fakeNow = 1_700_000_000_000;
  const FakeDate = Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(fakeNow); }, {
    now: () => fakeNow,
    UTC: Date.UTC,
  });
  const calls = [];
  const ctx = browserLike({
    Date: FakeDate,
    currentAccount: { id: 'u1' },
    accountGeneration: 1,
    locationGeneration: 0,
    telemetryAttemptGeneration: 0,
    telemetryLastAttemptMs: null,
    telemetryRequest: null,
    telemetrySample: null,
    telemetrySnapshot: null,
    telemetryError: false,
    gpsFailure: '',
    currentCoords: { lat: null, lng: null, accuracy: null },
    mapInstance: null,
    mapCenteredOnFix: false,
    validCoordinates: (a, b) => Number.isFinite(a) && Number.isFinite(b),
    updateDashboardTelemetry() {},
    showToast() {},
    api: async (url) => {
      calls.push(url);
      return { elevation: 724, locationName: 'Ciomas', tempC: 24, rh: 82, weather: 'Cerah' };
    },
  });
  vm.createContext(ctx);
  vm.runInContext(slice(APP, 'const TELEMETRY_REFRESH_MS = 30 * 60 * 1000;', '    function requestLiveLocation('), ctx);
  assert.equal(vm.runInContext('TELEMETRY_REFRESH_MS', ctx), 30 * 60 * 1000);

  ctx.applyLiveGpsReading(-6.61, 106.76, 5, false, fakeNow);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);

  fakeNow += 29 * 60 * 1000;
  ctx.applyLiveGpsReading(-6.61, 106.76, 6, false, fakeNow);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1, 'auto GPS fix inside 30 min window must not refetch telemetry');

  ctx.applyLiveGpsReading(-6.61, 106.76, 6, true, fakeNow);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 2, 'manual refresh bypasses 30 min cooldown');

  fakeNow += 30 * 60 * 1000 + 1;
  ctx.applyLiveGpsReading(-6.61, 106.76, 6, false, fakeNow);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 3, 'auto GPS fix after 30 min refreshes telemetry');
});

test('syncAutoDailyArchive: archives past days once idempotently and clears attempt on 5xx', async () => {
  const posted = [];
  const cached = [];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ctx = browserLike({
    currentAccount: { id: 'usr_9' },
    accountGeneration: 1,
    dailyArchiveRunning: false,
    autoDailyAttemptedKeys: new Set(),
    dailyRecommendations: [],
    farmRecords: [],
    recSeverity: r => r.severity || 'Healthy',
    cacheAccountData: async (owner, kind, data) => { cached.push({ owner, kind, count: data.length }); },
    renderDailyRecommendations() {},
  });
  vm.createContext(ctx);
  vm.runInContext(read('daily-log.js') + '\n' + read('assessment-ui.js'), ctx);
  ctx.window.JagaDailyLog = ctx.JagaDailyLog;
  const dayMs = 86400 * 1000;
  const t3 = Date.now() - 3 * dayMs;
  const t4 = Date.now() - 4 * dayMs;
  const t5 = Date.now() - 5 * dayMs;
  const k3 = ctx.JagaDailyLog.dateKey(t3, tz);
  const k4 = ctx.JagaDailyLog.dateKey(t4, tz);
  const k5 = ctx.JagaDailyLog.dateKey(t5, tz);
  ctx.dailyRecommendations = [{ id: 'manual-1', date: `${k3} (${tz})`, timestampMs: 1 }];
  ctx.farmRecords = [
    { id: 'rec-old-1', crop: 'Cabai', condition: 'Bercak Daun', severity: 'Moderate', uploadedMs: t5 },
    { id: 'rec-fail-day', crop: 'Kopi', condition: 'Karat Daun', severity: 'Severe', uploadedMs: t4 },
    { id: 'rec-already', crop: 'Teh', condition: 'Sehat', severity: 'Healthy', uploadedMs: t3 },
    { id: 'rec-today', crop: 'Tomat', condition: 'Sehat', severity: 'Healthy', uploadedMs: Date.now() },
    { id: 'rec-local', crop: 'Jagung', condition: 'Sehat', severity: 'Healthy', localOnly: true, uploadedMs: Date.now() - 10 * dayMs },
  ];
  let failOnce = true;
  ctx.api = async (url, opts) => {
    posted.push(opts.body);
    if (opts.body.id === `auto-daily-usr_9-${k4}` && failOnce) {
      failOnce = false;
      throw Object.assign(new Error('Service unavailable'), { status: 503 });
    }
    return opts.body;
  };
  vm.runInContext(slice(APP, '    async function syncAutoDailyArchive() {', '    function renderDailyRecommendations() {'), ctx);

  await ctx.syncAutoDailyArchive();
  assert.deepEqual(posted.map(b => b.id).sort(), [`auto-daily-usr_9-${k5}`, `auto-daily-usr_9-${k4}`].sort());
  assert.equal(ctx.dailyRecommendations.length, 2);
  assert.equal(cached.length, 1);

  await ctx.syncAutoDailyArchive();
  assert.deepEqual(posted.map(b => b.id), [`auto-daily-usr_9-${k4}`, `auto-daily-usr_9-${k5}`, `auto-daily-usr_9-${k4}`]);
  assert.equal(posted.filter(b => b.id === `auto-daily-usr_9-${k5}`).length, 1, 'already archived day is not reposted');
  assert.equal(posted.filter(b => b.id === `auto-daily-usr_9-${k4}`).length, 2, '503 day clears attempted key and retries');
});

test('scan-flow.js: toggleCameraZoom flips between 1x and 2x and updates video class', async () => {
  const classes = new Set();
  const btn = stubElement();
  btn.classList = {
    add: c => classes.add('btn:' + c),
    remove: c => classes.delete('btn:' + c),
    toggle: (c, on) => on ? classes.add('btn:' + c) : classes.delete('btn:' + c),
    contains: c => classes.has('btn:' + c),
  };
  const video = stubElement();
  video.classList = {
    toggle: (c, on) => on ? classes.add('vid:' + c) : classes.delete('vid:' + c),
    contains: c => classes.has('vid:' + c),
  };
  const ctx = browserLike({
    cameraZoom: 1,
    liveMediaStream: null,
  });
  ctx.document.getElementById = id => (id === 'btn-cam-zoom' ? btn : id === 'camera-stream' ? video : null);
  vm.createContext(ctx);
  vm.runInContext(read('scan-flow.js'), ctx);

  await ctx.toggleCameraZoom();
  assert.equal(ctx.cameraZoom, 2);
  assert.equal(btn.textContent, '2×');
  assert.ok(classes.has('btn:is-active'));
  assert.ok(classes.has('vid:is-zoom-2x'));

  await ctx.toggleCameraZoom();
  assert.equal(ctx.cameraZoom, 1);
  assert.equal(btn.textContent, '1×');
  assert.ok(!classes.has('btn:is-active'));
  assert.ok(!classes.has('vid:is-zoom-2x'));
});

test('i18n.js + daily-log.js: default id, EN crop/condition/pattern translation, canonical ID log save', () => {
  const store = new Map();
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const dispatched = [];
  const ctx = browserLike({ localStorage });
  ctx.window = ctx;
  ctx.window.dispatchEvent = ev => dispatched.push(ev);
  ctx.CustomEvent = function (type, opts) { return { type, detail: opts?.detail }; };
  vm.createContext(ctx);
  vm.runInContext(read('i18n.js') + '\n' + read('daily-log.js'), ctx);

  const i18n = ctx.window.JagaI18n || ctx.JagaI18n;
  const daily = ctx.window.JagaDailyLog || ctx.JagaDailyLog;
  assert.equal(i18n.getLang(), 'id');
  assert.equal(i18n.isEn(), false);
  assert.equal(i18n.t('Masuk'), 'Masuk');

  i18n.setLang('en');
  assert.equal(i18n.getLang(), 'en');
  assert.equal(i18n.isEn(), true);
  assert.equal(store.get('jk_lang'), 'en');
  assert.equal(dispatched.at(-1)?.type, 'jk:langchange');
  assert.equal(i18n.crop('Cabai Rawit'), "Bird's Eye Chili");
  assert.equal(i18n.condition('Bercak Daun'), 'Leaf Spot');
  assert.equal(i18n.severity('Severe'), 'Critical');
  assert.equal(i18n.dateTokens('Senin, 2 Okt'), 'Mon, 2 Oct');
  assert.equal(i18n.t('3 dari 5 tersisa'), '3 of 5 left');
  assert.equal(i18n.t('2 Petak Aktif · 8 Tanaman Terpantau'), '2 Active Plots · 8 Tracked Crops');
  assert.equal(i18n.t('• Cabai: Kritis — Bercak Daun.'), '• Chili: Critical — Leaf Spot.');
  assert.equal(
    i18n.t('Diagnosis sekarang dibuat saat AI mengira tanaman ini Kopi. Analisis ulang memakai foto yang sama dengan jenis Cabai.'),
    'Current diagnosis was generated assuming this crop is Coffee. Re-analyzing uses the same photo as Chili.'
  );

  const draft = { date: '2026-10-20', photoCount: 2, crops: [{ crop: 'Cabai', condition: 'Bercak Daun', severity: 'Severe' }] };
  const enView = daily.narrative(draft);
  const idCanonical = daily.narrative(draft, null, 'id');
  assert.match(enView, /^Today \(Tue, 20 Oct\)/);
  assert.match(enView, /• Chili: Critical — Leaf Spot\./);
  assert.match(idCanonical, /^Hari ini \(Selasa, 20 Okt\)/);
  assert.match(idCanonical, /• Cabai: Kritis — Bercak Daun\./);

  i18n.setLang('id');
  assert.equal(i18n.getLang(), 'id');
  assert.equal(i18n.t('Masuk'), 'Masuk');
});



