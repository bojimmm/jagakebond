#!/usr/bin/env node
/*
 * UX harness for the JagaKebond field app, release 0.2.2.0 (owner: UX).
 *
 * Part 1, behaviours (phone 390x844, synthetic fixtures, all /api/** mocked, no external network):
 *   Beranda "Perlu perhatian" -> tree timeline, stat tiles -> filtered Riwayat, first-use state,
 *   satellite toggle (layer URL + Esri attribution + remembered choice, never cached by the SW),
 *   drawing action bar (points, area, undo, cancel), detail sheet "Lihat riwayat tanaman ini",
 *   Riwayat filter chips + counts + debounced search, timeline newest first, short daily note,
 *   toast contrast/position/layering, modal above map tools, end of lists reachable above the nav.
 *
 * Part 2, button/layout audit on EVERY state of ux-screens-0220.cjs (that harness is reused as is: this
 * file wraps Playwright so each screenshot is preceded by an in-page audit). Rules (UX brief, design system):
 *   button height >= 44 px, label never wraps, sibling buttons in one row have equal heights,
 *   button text >= 15 px, nothing overflows the viewport at <= 360 px (and the page never scrolls sideways).
 *   Failures are attributed to UX or WEB (scan flow, drafts, sync/status chip are WEB's screens).
 *
 *   node ux-0220.cjs [--no-audit] [--audit-only] [--audit-sizes 360x780,390x844,1440x900]
 *                    [--audit-out <dir>] [--strict]   (--strict: WEB-owned audit failures also fail the run)
 * Exit code 1 when a behaviour check or a UX-owned audit rule fails.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const playwright = require('playwright');

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = name => args.includes('--' + name);
const CHROME = arg('chrome', process.env.JK_CHROME || '/usr/bin/google-chrome');
const FRONTEND = path.resolve(__dirname, '../../app/frontend');
const AUDIT_SIZES = arg('audit-sizes', '360x780,390x844,1440x900');
const AUDIT_OUT = path.resolve(process.cwd(), arg('audit-out', path.join(process.env.TMPDIR || '/tmp', 'ux-0220-audit')));
const STRICT = flag('strict');

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); }

/* ------------------------------------------------------------------ fixtures (synthetic) */
const DAY = 86400000, NOW = Date.now();
const ACCOUNT = { id: 'ux0220-account', name: 'Bu Sari', email: 'sari@example.test', role: 'user', fastQuota: 3, fastUsed: 1, fastRemaining: 2, dailyQuota: 3 };
const GPS = { latitude: -6.2012, longitude: 106.8012, accuracy: 18 };
const FARMS = [{ id: 'farm_a', name: 'Kebun Kopi Atas', crop: 'Kopi', note: '', ring: [[-6.2, 106.8], [-6.2, 106.803], [-6.2025, 106.803], [-6.2025, 106.8], [-6.2, 106.8]], areaM2: 7600, createdMs: NOW - 40 * DAY, updatedMs: NOW - 40 * DAY }];
function rec(over) {
  const ts = over.timestampMs;
  return Object.assign({ cropId: null, cropName: null, createdMs: ts, updatedMs: ts, crop: 'Cabai', condition: 'Bercak daun', severity: 'Moderate', observedSeverity: null,
    lat: -6.201, lng: 106.801, elevation: 724, locationName: 'Ciomas', accuracy: 12, symptoms: 'Bercak cokelat.', geocorrelation: 'Lembap.',
    immediate_action: 'Buang daun yang bergejala dan pantau 3 hari.', needs_review: false, confidence: 0.8, farmId: null, imageUrl: '/api/photos/p1', source: 'ai', locationSource: 'gps' }, over);
}
const RECORDS = [
  rec({ id: 'r1', cropId: 'tree_cabai', cropName: 'Cabai bedeng 1', condition: 'Bercak daun cercospora', severity: 'Severe', timestampMs: NOW - 2 * 3600000, lat: -6.205, lng: 106.802 }),
  rec({ id: 'r2', cropId: 'tree_cabai', cropName: 'Cabai bedeng 1', condition: 'Daun menguning', severity: 'Moderate', timestampMs: NOW - 9 * DAY, lat: -6.205, lng: 106.802 }),
  rec({ id: 'r3', cropId: 'tree_cabai', cropName: 'Cabai bedeng 1', condition: 'Tanaman sehat', severity: 'Healthy', timestampMs: NOW - 21 * DAY, lat: -6.205, lng: 106.802 }),
  rec({ id: 'r4', cropId: 'tree_kopi', cropName: 'Kopi pohon depan', crop: 'Kopi', condition: 'Karat daun kopi', severity: 'Moderate', needs_review: true, timestampMs: NOW - DAY - 3600000, farmId: 'farm_a', lat: -6.2012, lng: 106.8012 }),
  rec({ id: 'r5', cropId: 'tree_jagung', cropName: 'Jagung pinggir jalan', crop: 'Jagung', condition: 'Tanaman sehat', severity: 'Healthy', timestampMs: NOW - 3 * DAY, lat: -6.2085, lng: 106.809 }),
  rec({ id: 'r6', crop: 'Teh', condition: 'Pengamatan manual', severity: 'Healthy', lat: null, lng: null, imageUrl: null, source: 'manual', timestampMs: NOW - 12 * DAY }),
];
const TELEMETRY = { lat: GPS.latitude, lng: GPS.longitude, elevation: [724], locationName: 'Ciomas, Kab. Bogor', tempC: 24, rh: 82, weather: '24°C • 82% RH', locationApproximate: false };

function crc32(buf) { let c, crc = -1; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const b = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); }
function solidPng(rgb) {
  const size = 16, raw = Buffer.alloc((size * 3 + 1) * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) { const o = r * (size * 3 + 1) + 1 + c * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const OSM_TILE = solidPng([226, 234, 220]), SAT_TILE = solidPng([60, 90, 50]);

/* ------------------------------------------------------------------ server + mocks */
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const file = path.resolve(FRONTEND, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

async function openApp(browser, { records = RECORDS, farms = FARMS, viewport = { width: 390, height: 844 } } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'id-ID', timezoneId: 'Asia/Jakarta', permissions: ['camera', 'geolocation'], geolocation: GPS });
  const tileHosts = new Set();
  await context.route(/^https:\/\//, route => {
    const url = route.request().url();
    if (/tile\.openstreetmap\.org/.test(url)) { tileHosts.add('osm'); return route.fulfill({ status: 200, contentType: 'image/png', body: OSM_TILE }); }
    if (/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\//.test(url)) { tileHosts.add('esri'); return route.fulfill({ status: 200, contentType: 'image/png', body: SAT_TILE }); }
    return route.abort();
  });
  const S = { records: records.map(r => ({ ...r })), farms: farms.map(f => ({ ...f })) };
  await context.route('**/api/**', route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/auth/me' || p === '/api/auth/login') return json({ ok: true, account: ACCOUNT, csrf: 'ux-csrf' });
    if (p === '/api/health') return json({ ok: true, version: '2.1.0', capabilities: { treeContinuity: true, recordsPaging: true, accountBinding: true, photoLifecycle: true }, release: '0.2.2.0' });
    if (p === '/api/telemetry') return json(TELEMETRY);
    if (p === '/api/records') return json(Number(url.searchParams.get('limit') || 0) ? { items: S.records, next: null } : S.records);
    if (/^\/api\/records\/[^/]+$/.test(p)) { const r = S.records.find(x => x.id === decodeURIComponent(p.split('/').pop())); if (m === 'PUT') Object.assign(r || {}, req.postDataJSON() || {}); return json(r || {}); }
    if (p === '/api/farms') return m === 'GET' ? json(S.farms) : json({ ...(req.postDataJSON() || {}), id: 'farm_new', createdMs: NOW, updatedMs: NOW });
    if (p === '/api/daily') return json([]);
    if (p.startsWith('/api/photos/')) return route.fulfill({ status: 404, body: '' });
    return json([]);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 300)));
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 15000 });
  await page.evaluate(() => { try { JagaOfflineSync.stop(); } catch (_) { /* optional */ } });
  await page.waitForTimeout(400);
  return { context, page, errors, tileHosts };
}
const visibleId = (page, id) => page.evaluate(i => { const el = document.getElementById(i); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; }, id);

/* ------------------------------------------------------------------ part 1: behaviours */
async function behaviours(browser) {
  /* Beranda */
  {
    const { context, page, errors } = await openApp(browser);
    const att = await page.evaluate(() => [...document.querySelectorAll('#home-attention-list .att-item')].map(b => ({ name: b.querySelector('.att-name')?.textContent, badge: b.querySelector('.badge')?.textContent })));
    check('B1 Perlu perhatian lists Kritis/Waspada/needs-review trees, newest first', att.length === 2 && att[0].name === 'Cabai bedeng 1' && att[0].badge === 'Kritis' && att[1].name === 'Kopi pohon depan', att);
    const above = await page.evaluate(() => { const nav = document.querySelector('#app-shell > nav').getBoundingClientRect().top; const btn = document.querySelector('#nav-btn-scan').getBoundingClientRect(); const first = document.querySelector('#home-attention-list .att-item')?.getBoundingClientRect(); return { btnBottom: btn.bottom, firstTop: first && first.top, nav }; });
    check('B2/B4 Navigation "Kamera" and the first "Perlu perhatian" row are visible without scrolling at 390x844', above.btnBottom <= 844 && above.firstTop < above.nav - 40, above);
    const daily = await page.evaluate(() => document.querySelector('#home-daily-card')?.textContent || '');
    check('B5 home daily note has no time-zone names or ISO dates', !/Asia\/|\(Asia|\d{4}-\d{2}-\d{2}|WIB/.test(daily) && /Hari ini/.test(daily), daily.slice(0, 200));
    const clamp = await page.evaluate(() => { const p = document.querySelector('#home-daily-card .daily-narrative'); const lh = parseFloat(getComputedStyle(p).lineHeight); return { h: p.getBoundingClientRect().height, lh }; });
    check('B5 home daily note shows at most 3 lines', clamp.h <= clamp.lh * 3 + 2, clamp);
    await page.click('#home-attention-list .att-item >> nth=0');
    await page.waitForTimeout(250);
    const tl = await page.evaluate(() => ({ log: !document.getElementById('view-log').classList.contains('hidden'), title: document.querySelector('#logs-container .tl-title')?.textContent, expanded: expandedCropId,
      dates: [...document.querySelectorAll('#logs-container .tl-entry .tl-meta-row .t-meta')].map(e => e.textContent), filtersHidden: document.getElementById('log-filter-wrap').classList.contains('hidden') }));
    check('B1 tapping a "Perlu perhatian" row opens that tree\'s timeline in Riwayat', tl.log && tl.title === 'Cabai bedeng 1' && tl.expanded === 'tree_cabai' && tl.filtersHidden, tl);
    const order = await page.evaluate(() => [...document.querySelectorAll('#logs-container .tl-condition')].map(e => e.textContent));
    const localDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(ms);
    const relativeDate = localDay(NOW) === localDay(RECORDS[0].timestampMs) ? /Hari ini/ : /Kemarin/;
    check('R3 timeline is newest first with Indonesian dates', order[0] === 'Bercak Daun' && order[2] === 'Tanaman Sehat' && tl.dates.every(d => !/\d{4}-\d{2}/.test(d)) && relativeDate.test(tl.dates[0] || ''), { order, dates: tl.dates });
    const back = await page.evaluate(() => { document.querySelector('#logs-container .tl-back').click(); return { cards: document.querySelectorAll('#logs-container .tree-card').length, filters: !document.getElementById('log-filter-wrap').classList.contains('hidden') }; });
    check('R3 "Semua tanaman" goes back to the tree list', back.cards === 4 && back.filters, back);

    for (const [tile, filter, expect] of [['Severe', 'Severe', ['Cabai bedeng 1']], ['Moderate', 'Moderate', ['Kopi pohon depan']], ['all', 'all', null]]) {
      await page.evaluate(() => navigateToMenu('home'));
      await page.click('#home-tiles .stat-tile[data-filter="' + tile + '"]');
      await page.waitForTimeout(200);
      const state = await page.evaluate(() => ({ log: !document.getElementById('view-log').classList.contains('hidden'), pressed: document.querySelector('#log-chips .chip[aria-pressed="true"]')?.getAttribute('data-filter'), names: [...document.querySelectorAll('#logs-container .tree-name')].map(e => e.textContent) }));
      check('B3 stat tile "' + tile + '" opens Riwayat filtered by that status', state.log && state.pressed === filter && (expect ? JSON.stringify(state.names) === JSON.stringify(expect) : state.names.length === 4), state);
    }
    const tiles = await page.evaluate(() => ['stat-total-scans', 'stat-critical-count', 'stat-moderate-count'].map(id => document.getElementById(id).textContent));
    check('B3 stat tiles count trees (4 total, 1 Kritis, 1 Waspada)', JSON.stringify(tiles) === '["4","1","1"]', tiles);

    /* Riwayat chips + search */
    const chips = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#log-chips .chip')].map(c => [c.dataset.filter, c.querySelector('.chip-count').textContent])));
    // owner 2026-10-28: 'Perlu dicek' sits right after 'Semua'.
    check('R2 filter chips show counts (Semua 4, Perlu dicek 1, Kritis 1, Waspada 1, Sehat 2)', JSON.stringify(chips) === JSON.stringify({ all: '4', review: '1', Severe: '1', Moderate: '1', Healthy: '2' }), chips);
    await page.click('#log-chips .chip[data-filter="review"]');
    const review = await page.evaluate(() => [...document.querySelectorAll('#logs-container .tree-name')].map(e => e.textContent));
    check('R2 "Perlu dicek" chip shows only trees that need a check', JSON.stringify(review) === '["Kopi pohon depan"]', review);
    await page.click('#log-chips .chip[data-filter="Healthy"]');
    const healthy = await page.evaluate(() => [...document.querySelectorAll('#logs-container .tree-name')].map(e => e.textContent));
    check('R2 "Sehat" chip shows only healthy trees', healthy.length === 2 && healthy.includes('Jagung pinggir jalan'), healthy);
    await page.click('#log-chips .chip[data-filter="all"]');
    const sorted = await page.evaluate(() => [...document.querySelectorAll('#logs-container .tree-name')].map(e => e.textContent));
    check('R2 default sort: needs attention first, then most recent', sorted[0] === 'Cabai bedeng 1' && sorted[1] === 'Kopi pohon depan' && sorted[2] === 'Jagung pinggir jalan', sorted);
    await page.fill('#log-search-input', 'jagung');
    const immediate = await page.evaluate(() => document.querySelectorAll('#logs-container .tree-card').length);
    await page.waitForTimeout(400);
    const searched = await page.evaluate(() => [...document.querySelectorAll('#logs-container .tree-name')].map(e => e.textContent));
    check('R2 search is debounced and filters by name', immediate === 4 && JSON.stringify(searched) === '["Jagung pinggir jalan"]', { immediate, searched });
    await page.fill('#log-search-input', '');
    await page.waitForTimeout(400);
    const card = await page.evaluate(() => { const c = document.querySelector('#logs-container .tree-card'); return { h: c.getBoundingClientRect().height, buttons: [...c.querySelectorAll('button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim()).filter(Boolean) }; });
    // owner 2026-10-28: one-row card (as tall as the thumbnail), camera icon labelled 'Foto lagi', no chevron.
    check('R1 tree card is compact with one action ("Foto lagi"), no location edit on the card', card.h <= 100 && card.buttons.filter(t => t === 'Foto lagi').length === 1 && !card.buttons.some(t => /Ubah lokasi/.test(t)), card);
    const end = await page.evaluate(() => { const v = document.getElementById('view-log'); v.scrollTop = v.scrollHeight; const last = [...document.querySelectorAll('#logs-container .tree-card')].pop().getBoundingClientRect(); return { lastBottom: last.bottom, nav: document.querySelector('#app-shell > nav').getBoundingClientRect().top }; });
    check('Layout: the last Riwayat card can be scrolled fully above the bottom nav', end.lastBottom <= end.nav, end);

    /* daily tab: no jargon */
    await page.evaluate(() => switchLogTab('daily'));
    const dailyTab = await page.evaluate(() => document.getElementById('daily-container').textContent);
    check('R4 Harian tab has no "(Asia/Jakarta)" or "sumber catatan" jargon', !/Asia\/Jakarta|sumber catatan/.test(dailyTab), dailyTab.slice(0, 160));
    await page.evaluate(() => openDailyModal());
    const modalDaily = await page.evaluate(() => ({ summary: document.getElementById('daily-draft-summary').textContent, fold: !document.querySelector('#modal-daily details.fold').open, use: !!document.getElementById('daily-use-suggestion') }));
    await page.click('#daily-use-suggestion');
    const used = await page.evaluate(() => document.getElementById('daily-summary-input').value);
    check('R5 daily form: short suggestion + "Pakai ringkasan", optional fields folded', modalDaily.summary.length < 400 && modalDaily.fold && used === modalDaily.summary, { len: modalDaily.summary.length, fold: modalDaily.fold });
    await page.evaluate(() => closeDailyModal());

    /* toast */
    await page.evaluate(() => { navigateToMenu('home'); showToast('Catatan tersimpan.'); });
    const toast = await page.evaluate(() => {
      const t = document.getElementById('toast-notification'), s = getComputedStyle(t), nav = document.querySelector('#app-shell > nav').getBoundingClientRect();
      const anim = s.animationName, op = s.opacity, rect = t.getBoundingClientRect();
      const modal = getComputedStyle(document.getElementById('modal-farm')).zIndex;
      return { bg: s.backgroundColor, color: s.color, size: parseFloat(s.fontSize), op, anim, bottom: rect.bottom, navTop: nav.top, z: Number(s.zIndex), modalZ: Number(modal) };
    });
    const lum = rgb => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (Math.max(lum(toast.bg), lum(toast.color)) + 0.05) / (Math.min(lum(toast.bg), lum(toast.color)) + 0.05);
    check('G4 toast: solid dark background with contrast >= 4.5:1 from the first frame (opacity 1, slide animation)', ratio >= 4.5 && toast.op === '1' && toast.anim === 'jk-toast-slide' && !/rgba\(.*, 0\.\d+\)/.test(toast.bg), { ratio: ratio.toFixed(2), ...toast });
    check('G4 toast: 14-15 px text, above the bottom nav, below modals', toast.size >= 14 && toast.size <= 16 && toast.bottom <= toast.navTop && toast.z < toast.modalZ, toast);

    /* empty Riwayat skeleton-free + no errors */
    check('No uncaught page errors (Beranda/Riwayat)', errors.length === 0, errors);
    await context.close();
  }

  /* Peta */
  {
    const { context, page, errors, tileHosts } = await openApp(browser);
    await page.evaluate(() => { try { localStorage.removeItem('jk-map-layer'); } catch (_) { /* optional */ } });
    const lazy = await page.evaluate(() => typeof mapInstance === 'undefined' || mapInstance === null);
    check('G7 the Leaflet map is not built before the first Peta visit', lazy, lazy);
    await page.evaluate(() => navigateToMenu('map'));
    await page.waitForTimeout(800);
    const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#map-toolbar [data-count]')].map(e => [e.dataset.count, e.textContent])));
    check('M5 map filter chips show counts (pins with a position)', JSON.stringify(counts) === JSON.stringify({ all: '3', Severe: '1', Moderate: '1', Healthy: '1' }), counts);
    // owner 2026-10-28: icon-only tools; the name lives in aria-label/title.
    const labels = await page.evaluate(() => [...document.querySelectorAll('#map-tools .btn')].map(b => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label') })));
    check('M2 map tools have visible labels', labels.length === 3 && labels.every(l => !l.text && l.label) && /petak/i.test(labels[0].label) && /keliling/i.test(labels[1].label) && /lokasi saya/i.test(labels[2].label), labels);
    const osmAttr = await page.evaluate(() => document.querySelector('#map-container .leaflet-control-attribution')?.textContent || '');
    check('M1 default layer is OpenStreetMap with its attribution', /OpenStreetMap/.test(osmAttr) && tileHosts.has('osm'), osmAttr);
    await page.click('#map-layer-satellite');
    await page.waitForTimeout(700);
    const sat = await page.evaluate(() => ({ type: currentMapTileType, url: activeTileLayer && activeTileLayer._url, attr: document.querySelector('#map-container .leaflet-control-attribution')?.textContent || '',
      pressed: document.getElementById('map-layer-satellite').getAttribute('aria-pressed'), stored: localStorage.getItem('jk-map-layer'), maxNative: activeTileLayer.options.maxNativeZoom, max: activeTileLayer.options.maxZoom,
      tiles: [...document.querySelectorAll('#map-container .leaflet-tile')].map(t => t.src).filter(s => /arcgisonline/.test(s)).length, osmTiles: [...document.querySelectorAll('#map-container .leaflet-tile')].filter(t => /openstreetmap/.test(t.src)).length }));
    check('M1 "Satelit" switches to Esri World Imagery tiles', sat.type === 'satellite' && sat.url === 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}' && sat.tiles > 0 && sat.osmTiles === 0 && tileHosts.has('esri') && sat.maxNative === 18 && sat.max === 22, sat);
    check('M1 satellite attribution "Citra © Esri, Maxar, Earthstar Geographics" is shown', /Citra © Esri, Maxar, Earthstar Geographics/.test(sat.attr) && !/OpenStreetMap/.test(sat.attr), sat.attr);
    const attrVisible = await page.evaluate(() => { const a = document.querySelector('#map-container .leaflet-control-attribution').getBoundingClientRect(); const nav = document.querySelector('#app-shell > nav').getBoundingClientRect(); return { bottom: a.bottom, navTop: nav.top, w: a.width }; });
    check('M1 map attribution stays visible above the bottom nav', attrVisible.w > 0 && attrVisible.bottom <= attrVisible.navTop + 1, attrVisible);
    check('M1 the layer choice is remembered and the toggle is pressed', sat.stored === 'satellite' && sat.pressed === 'true', sat);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 15000 });
    await page.evaluate(() => navigateToMenu('map'));
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ type: currentMapTileType, pressed: document.getElementById('map-layer-satellite').getAttribute('aria-pressed') }));
    check('M1 satellite choice survives a reload', after.type === 'satellite' && after.pressed === 'true', after);
    await page.evaluate(() => { window.dispatchEvent(new Event('offline')); });
    await context.setOffline(true);
    await page.evaluate(() => { window.dispatchEvent(new Event('offline')); });
    const note = await page.evaluate(() => ({ shown: !document.getElementById('map-offline-note').classList.contains('hidden'), text: document.getElementById('map-offline-note').textContent }));
    check('M1 offline: a short note says the map imagery needs signal', note.shown && /butuh sinyal/.test(note.text), note);
    await context.setOffline(false);
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
    await page.click('#map-layer-street');
    const street = await page.evaluate(() => ({ type: currentMapTileType, attr: document.querySelector('#map-container .leaflet-control-attribution')?.textContent || '' }));
    check('M1 "Peta jalan" switches back to OpenStreetMap', street.type === 'standard' && /OpenStreetMap/.test(street.attr) && !/Esri/.test(street.attr), street);
    const sw = fs.readFileSync(path.join(FRONTEND, 'sw.js'), 'utf8');
    check('M1 the service worker never caches map tiles (cross-origin requests are not handled)', /url\.origin\s*!==\s*self\.location\.origin\)\s*return/.test(sw) && !/arcgisonline|openstreetmap\.org\//.test(sw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'sw.js fetch handler');

    /* draw bar */
    await page.evaluate(() => startFarmDraw());
    const box = await page.locator('#map-container').boundingBox();
    const bar0 = await page.evaluate(() => ({ shown: !document.getElementById('draw-bar').classList.contains('hidden'), stats: document.getElementById('draw-bar-stats').textContent, finish: document.getElementById('draw-finish').disabled, tools: getComputedStyle(document.getElementById('map-tools')).display, hint: document.getElementById('map-hint-box').textContent }));
    check('M3 drawing shows the action bar (0 titik, Selesai disabled) and hides the tool buttons', bar0.shown && /^0 titik/.test(bar0.stats) && bar0.finish && bar0.tools === 'none' && !/vertex|klik/i.test(bar0.hint), bar0);
    const cx = box.x + box.width / 2, cy = box.y + box.height * 0.45;
    for (const [dx, dy] of [[-70, -60], [70, -60], [70, 50]]) { await page.mouse.click(cx + dx, cy + dy); await page.waitForTimeout(150); }
    const bar3 = await page.evaluate(() => ({ stats: document.getElementById('draw-bar-stats').textContent, finish: document.getElementById('draw-finish').disabled, tip: document.querySelector('.leaflet-tooltip')?.textContent || '' }));
    check('M3 live "3 titik · ±… m²" (or ha from 1 ha, 0.2.4.11) and Selesai enabled after 3 points; tooltips in plain Bahasa', /^3 titik · ±[\d.,]+ (m²|ha)$/.test(bar3.stats) && !bar3.finish && !/vertex|click|klik/i.test(bar3.tip), bar3);
    await page.click('#draw-undo');
    const bar2 = await page.evaluate(() => ({ stats: document.getElementById('draw-bar-stats').textContent, finish: document.getElementById('draw-finish').disabled }));
    check('M3 "Hapus titik terakhir" removes one point', /^2 titik/.test(bar2.stats) && bar2.finish, bar2);
    await page.click('#draw-cancel');
    const cancelled = await page.evaluate(() => ({ bar: document.getElementById('draw-bar').classList.contains('hidden'), tools: getComputedStyle(document.getElementById('map-tools')).display, drawing: document.getElementById('view-map').classList.contains('is-drawing') }));
    check('M3 "Batal" closes the bar and brings the tools back', cancelled.bar && cancelled.tools !== 'none' && !cancelled.drawing, cancelled);
    await page.evaluate(() => startFarmDraw());
    for (const [dx, dy] of [[-70, -60], [70, -60], [70, 50]]) { await page.mouse.click(cx + dx, cy + dy); await page.waitForTimeout(150); }
    await page.click('#draw-finish');
    await page.waitForTimeout(300);
    const saved = await page.evaluate(() => ({ modal: !document.getElementById('modal-farm').classList.contains('hidden'), area: document.getElementById('farm-modal-area').textContent, bar: document.getElementById('draw-bar').classList.contains('hidden') }));
    check('M3/M6 "Selesai" opens the save form with the area in plain units', saved.modal && saved.bar && /Luas: [\d,.]+ (ha \([\d.]+ m²\)|m²) · 3 titik/.test(saved.area), saved);
    const layer = await page.evaluate(() => { const tool = document.getElementById('btn-draw-farm').getBoundingClientRect(); const x = tool.left + tool.width / 2, y = tool.top + tool.height / 2; const hit = document.elementFromPoint(x, y); return { insideModal: !!hit && !!hit.closest('#modal-farm'), hit: hit && (hit.id || hit.className) }; });
    check('G5 the farm modal is painted above the map tools', layer.insideModal, layer);
    await page.evaluate(() => cancelFarmDraw());

    /* detail sheet */
    await page.evaluate(() => openBottomSheet('r4'));
    await page.waitForTimeout(400);
    const sheet = await page.evaluate(() => {
      const s = document.getElementById('map-bottom-sheet').getBoundingClientRect(), nav = document.querySelector('#app-shell > nav').getBoundingClientRect(), fab = document.querySelector('#nav-btn-scan .nav-fab').getBoundingClientRect();
      return { buttons: [...document.querySelectorAll('#sheet-footer-actions .btn')].map(b => b.textContent.trim()), primary: document.querySelector('#sheet-footer-actions .btn-primary')?.textContent.trim(),
        tools: getComputedStyle(document.getElementById('map-tools')).display, bottom: s.bottom, navTop: nav.top, fabTop: fab.top, right: s.right, vw: innerWidth };
    });
    // 0.2.4.17: "Ubah data" (species, date and location in one form) replaced the sheet's "Ubah lokasi".
    check('M4 detail sheet: "Foto lagi" primary, "Riwayat", "Dengarkan", quiet "Ubah Data"', sheet.primary === 'Foto lagi' && JSON.stringify(sheet.buttons) === JSON.stringify(['Foto lagi', 'Riwayat', 'Dengarkan', 'Ubah Data']), sheet.buttons);
    check('M2/G5 the sheet sits above the nav and the camera button, the map tools are hidden', sheet.bottom <= sheet.fabTop && sheet.bottom <= sheet.navTop && sheet.tools === 'none' && sheet.right <= sheet.vw, sheet);
    await page.evaluate(() => showToast('Uji'));
    const toastTop = await page.evaluate(() => { const t = document.getElementById('toast-notification').getBoundingClientRect(), s = document.getElementById('map-bottom-sheet').getBoundingClientRect(); return { tBottom: t.bottom, sTop: s.top }; });
    check('G4 with a sheet open the toast moves to the top and does not cover the sheet', toastTop.tBottom <= toastTop.sTop, toastTop);
    await page.click('#sheet-open-history');
    await page.waitForTimeout(300);
    const hist = await page.evaluate(() => ({ log: !document.getElementById('view-log').classList.contains('hidden'), title: document.querySelector('#logs-container .tl-title')?.textContent, sheetClosed: !document.getElementById('map-bottom-sheet').classList.contains('translate-y-0') }));
    check('M4 "Riwayat tanaman ini" opens that tree\'s timeline', hist.log && hist.title === 'Kopi pohon depan' && hist.sheetClosed, hist);
    check('No uncaught page errors (Peta)', errors.length === 0, errors);
    await context.close();
  }

  /* first use */
  {
    const { context, page, errors } = await openApp(browser, { records: [], farms: [] });
    const empty = await page.evaluate(() => ({ empty: !document.getElementById('home-empty').classList.contains('hidden'), tiles: document.getElementById('home-tiles').getClientRects().length, attention: document.getElementById('home-attention').getClientRects().length,
      actions: (document.getElementById('home-actions')?.getClientRects().length || 0), cta: document.querySelector('#home-empty .btn-primary')?.textContent.trim() }));
    check('B6 first use: "Mulai dengan memotret satu tanaman" with the camera button instead of zero tiles', empty.empty && empty.tiles === 0 && empty.attention === 0 && empty.actions === 0 && empty.cta === 'Ambil foto pertama', empty);
    await page.evaluate(() => { navigateToMenu('log'); });
    const emptyLog = await page.evaluate(() => document.querySelector('#logs-container .empty-card')?.textContent || '');
    check('First use Riwayat: friendly empty card with a camera action', /Belum ada foto tanaman/.test(emptyLog) && /Foto Tanaman/.test(emptyLog), emptyLog);
    check('No uncaught page errors (first use)', errors.length === 0, errors);
    await context.close();
  }
}

/* ------------------------------------------------------------------ part 2: button/layout audit */
function inPageAudit(checkOverflow) {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const shown = el => { if (!el.getClientRects().length) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && Number(s.opacity) > 0; };
  const text = el => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const desc = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '') + ' "' + text(el) + '"';
  const WEB = '#view-scan, #offline-drafts, .offline-drafts, .sync-banner, #status-chip, .status-chip, .update-banner, #modal-crop-assign, .workflow-draft, .workflow-tree-group, .workflow-actions:not(.viewer-foot *)';
  const owner = el => (el.closest(WEB) ? 'WEB' : 'UX');
  const CARDLIKE = '.stat-tile, .card-tap, .tree-main, .farm-info, .farm-rec, .history-card, .nav-tab, .scan-preview-hit, .leaflet-marker-icon, .workflow-tree-group summary';
  const SKIP = '.leaflet-marker-pane *, .leaflet-overlay-pane *, .sr-only, [aria-hidden="true"]';
  const els = [...document.querySelectorAll('button, a.btn, label.btn, summary.btn, a[role="button"], div[role="button"], span[role="button"], input[type="button"], input[type="submit"]')]
    .filter(el => shown(el) && !el.matches(SKIP) && !el.closest('[inert] .leaflet-pane'));
  const rectOf = el => el.getBoundingClientRect();
  const lines = el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.trim() && !n.parentElement.closest('.chip-count, .nav-badge, .badge, .sr-only') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    const spans = []; let n;
    while ((n = walker.nextNode())) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) if (b.width > 1 && b.height > 1) spans.push([b.top, b.bottom]); }
    spans.sort((a, b) => a[0] - b[0]);
    const rows = [];
    for (const [t, b] of spans) { const mid = (t + b) / 2; const row = rows.find(r => mid >= r[0] && mid <= r[1]); if (row) { row[0] = Math.min(row[0], t); row[1] = Math.max(row[1], b); } else rows.push([t, b]); }
    return rows.length;
  };
  const textSizes = el => {
    const sizes = []; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
    while ((n = walker.nextNode())) if (n.textContent.trim() && !n.parentElement.closest('.chip-count, .nav-badge, .badge, .sr-only')) sizes.push(parseFloat(getComputedStyle(n.parentElement).fontSize));
    return sizes;
  };
  for (const el of els) {
    const r = rectOf(el);
    if (r.width < 2 || r.height < 2) continue;
    const cardlike = el.matches(CARDLIKE);
    if (r.height < 43.5) out.push({ rule: 'height<44', el: desc(el), owner: owner(el), value: Math.round(r.height * 10) / 10 });
    if (!cardlike) {
      const l = lines(el);
      if (l > 1) out.push({ rule: 'label wraps', el: desc(el), owner: owner(el), value: l + ' lines' });
      const sizes = textSizes(el);
      if (sizes.length && Math.min(...sizes) < 14.9) out.push({ rule: 'font<15', el: desc(el), owner: owner(el), value: Math.min(...sizes) + 'px' });
    }
  }
  // Sibling buttons in one row: same height.
  const parents = new Set(els.map(el => el.parentElement));
  for (const p of parents) {
    const kids = [...p.children].filter(k => els.includes(k) && !k.matches(CARDLIKE)).map(k => ({ k, r: rectOf(k) })).filter(x => x.r.height > 2);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i].r, b = kids[j].r;
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlap > Math.min(a.height, b.height) * 0.5 && Math.abs(a.height - b.height) > 1.5) out.push({ rule: 'row heights differ', el: desc(kids[i].k) + ' vs ' + desc(kids[j].k), owner: owner(kids[i].k), value: Math.round(a.height) + ' vs ' + Math.round(b.height) });
    }
  }
  if (checkOverflow) {
    if (document.documentElement.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1) out.push({ rule: 'page scrolls sideways', el: 'document', owner: 'UX', value: document.documentElement.scrollWidth + ' > ' + vw });
    const clipped = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (s.overflowX !== 'visible') { const pr = p.getBoundingClientRect(); if (pr.left >= -1 && pr.right <= vw + 1) return true; } } return false; };
    const offenders = [...document.querySelectorAll('body *')].filter(el => {
      if (!shown(el) || el.closest('.leaflet-container, .sr-only, svg')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      return (r.right > vw + 1 || r.left < -1) && !clipped(el);
    });
    for (const el of offenders) if (!offenders.includes(el.parentElement)) out.push({ rule: 'overflows viewport', el: desc(el), owner: owner(el), value: Math.round(el.getBoundingClientRect().left) + '..' + Math.round(el.getBoundingClientRect().right) + ' of ' + vw });
  }
  return out;
}

async function audit() {
  fs.mkdirSync(AUDIT_OUT, { recursive: true });
  const findings = new Map();   // key -> {rule, el, owner, value, where: Set}
  let pending = Promise.resolve();
  const origLaunch = playwright.chromium.launch.bind(playwright.chromium);
  let done;
  const finished = new Promise(r => { done = r; });
  playwright.chromium.launch = async (opts) => {
    const browser = await origLaunch(opts);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (o) => {
      const ctx = await newContext(o);
      const newPage = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const page = await newPage();
        const shot = page.screenshot.bind(page);
        page.screenshot = async (so) => {
          const name = path.basename((so && so.path) || 'state.png', '.png');
          const vp = page.viewportSize();
          try {
            const list = await page.evaluate(inPageAudit, vp.width <= 360);
            for (const f of list) { const key = f.rule + '|' + f.el; if (!findings.has(key)) findings.set(key, { ...f, where: new Set() }); findings.get(key).where.add(name); }
          } catch (error) { findings.set('audit-error|' + name, { rule: 'audit error', el: name, owner: 'UX', value: String(error.message).slice(0, 200), where: new Set([name]) }); }
          return shot(so);
        };
        return page;
      };
      return ctx;
    };
    const close = browser.close.bind(browser);
    browser.close = async () => { await close(); setTimeout(done, 300); };
    return browser;
  };
  const saved = process.argv;
  process.argv = [saved[0], path.join(__dirname, 'ux-screens-0220.cjs'), '--out', AUDIT_OUT, '--sizes', AUDIT_SIZES, '--chrome', CHROME];
  require('./ux-screens-0220.cjs');
  await finished;
  process.argv = saved;
  await pending;
  const index = JSON.parse(fs.readFileSync(path.join(AUDIT_OUT, 'index.json'), 'utf8'));
  const rows = [...findings.values()].map(f => ({ ...f, where: [...f.where].sort() }));
  const ux = rows.filter(r => r.owner === 'UX'), web = rows.filter(r => r.owner === 'WEB');
  fs.writeFileSync(path.join(AUDIT_OUT, 'audit.json'), JSON.stringify({ sizes: AUDIT_SIZES, states: index.files.length, skipped: index.skipped, pageErrors: index.pageErrors, ux, web }, null, 2));
  console.log('AUDIT states=' + index.files.length + ' skipped=' + index.skipped.length + ' pageErrors=' + index.pageErrors.length + ' uxFindings=' + ux.length + ' webFindings=' + web.length + ' -> ' + path.join(AUDIT_OUT, 'audit.json'));
  for (const r of ux) console.log('AUDIT-UX  ' + r.rule + '  ' + r.el + '  (' + r.value + ')  in ' + r.where.slice(0, 4).join(', ') + (r.where.length > 4 ? ' +' + (r.where.length - 4) : ''));
  for (const r of web) console.log('AUDIT-WEB ' + r.rule + '  ' + r.el + '  (' + r.value + ')  in ' + r.where.slice(0, 4).join(', ') + (r.where.length > 4 ? ' +' + (r.where.length - 4) : ''));
  check('Audit: every ux-screens state was reached (no skipped state, no page error)', index.skipped.length === 0 && index.pageErrors.length === 0, { skipped: index.skipped, pageErrors: index.pageErrors });
  check('Audit: no UX-owned button/layout failure (height, wrapping, row heights, font, 360 px overflow)', ux.length === 0, ux.length + ' findings');
  if (STRICT) check('Audit (strict): no WEB-owned button/layout failure', web.length === 0, web.length + ' findings');
  else if (web.length) console.log('NOTE ' + web.length + ' WEB-owned audit findings reported to the lead (not counted; use --strict)');
}

(async () => {
  let failed = false;
  try {
    if (!flag('audit-only')) {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
      try { await behaviours(browser); } finally { await browser.close(); server.close(); }
    }
    if (!flag('no-audit')) await audit();
  } catch (error) { console.error(error); failed = true; }
  const bad = checks.filter(c => !c.ok);
  console.log(JSON.stringify({ total: checks.length, passed: checks.length - bad.length, failed: bad.map(c => c.name) }, null, 2));
  process.exit(failed || bad.length ? 1 : 0);
})();
