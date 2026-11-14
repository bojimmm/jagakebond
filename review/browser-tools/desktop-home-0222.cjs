#!/usr/bin/env node
/*
 * Owner feedback 2026-10-28 (desktop Beranda), release 0.2.2.2. Synthetic fixtures, every /api/** mocked, no network.
 *
 *   D1 "Buka peta" lines up with the location card, "Foto Tanaman" with the stat tiles (right column; swapped in 0.2.2.3).
 *   D2 the three stat tiles are exactly as wide as "Perlu perhatian".
 *   D3 "Catatan harian" ends level with the bottom of the "Perlu perhatian" list.
 *   D4 "Foto terbaru" spans the full width and slides with arrows that hide at each end.
 *   D5 no chevron on the Beranda cards (desktop and phone).
 *   D6 Gemini-style menu: "Ciutkan menu" right of the name; collapsed, the logo is "Buka menu" (hover swaps the icon);
 *      the logo and icons never move; labels stay for screen readers; the choice is remembered.
 *   D7 corners follow the 12 / 8 rule on every visible element of Beranda, Riwayat and Peta (desktop and phone).
 * Owner feedback 2026-10-28 (phone), same release:
 *   E1 every "take a photo" button opens a working camera once the previous photo was sent (no "Simpan atau batalkan").
 *   E2 a tree's camera button after a sent photo opens the camera for that tree; an UNSENT photo asks before it is dropped.
 *   E3 each timeline entry shows the AI confidence ("Keyakinan AI 80%"), amber when low.
 *   E4 plant cards: photo and camera button are vertically centred; the status sits in the text column.
 *   E5 timeline: one line from dot centre to dot centre, dots centred on the line and on their status row.
 *   E6 the geotag stamp renders at several photo sizes, also with no metadata; the images are saved for review (--shots).
 *
 *   node desktop-home-0222.cjs [--shots <dir>] [--chrome /usr/bin/google-chrome]
 * Exit code 1 when a check fails.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const playwright = require('playwright');

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const CHROME = arg('chrome', process.env.JK_CHROME || '/usr/bin/google-chrome');
const FRONTEND = path.resolve(__dirname, '../../app/frontend');
const SHOTS = arg('shots', '');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail ?? null).slice(0, 600))); }

/* ------------------------------------------------------------------ fixtures (synthetic) */
const DAY = 86400000, NOW = Date.now();
const ACCOUNT = { id: 'dh0222-account', name: 'Bu Sari', email: 'sari@example.test', role: 'user', fastQuota: 3, fastUsed: 1, fastRemaining: 2, dailyQuota: 3 };
const GPS = { latitude: -6.2012, longitude: 106.8012, accuracy: 18 };
const FARMS = [{ id: 'farm_a', name: 'Kebun Kopi Atas', crop: 'Kopi', note: '', ring: [[-6.2, 106.8], [-6.2, 106.803], [-6.2025, 106.803], [-6.2025, 106.8], [-6.2, 106.8]], areaM2: 7600, createdMs: NOW - 40 * DAY, updatedMs: NOW - 40 * DAY }];
const CROPS = ['Cabai', 'Kopi', 'Jagung', 'Padi', 'Pisang', 'Mangga', 'Teh', 'Kakao', 'Tomat', 'Terong', 'Durian', 'Jeruk', 'Kelapa', 'Salak'];
const SEVERITIES = ['Severe', 'Moderate', 'Healthy', 'Moderate', 'Healthy', 'Healthy', 'Severe', 'Healthy', 'Moderate', 'Healthy', 'Healthy', 'Healthy', 'Healthy', 'Healthy'];
const RECORDS = CROPS.map((crop, i) => ({
  id: 'r' + i, cropId: 'tree_' + i, cropName: crop + ' ' + (i + 1), crop, condition: SEVERITIES[i] === 'Healthy' ? 'Tanaman sehat' : 'Bercak daun', severity: SEVERITIES[i],
  observedSeverity: null, timestampMs: NOW - (i * 7 + 2) * 3600000, createdMs: NOW - (i * 7 + 2) * 3600000, updatedMs: NOW - (i * 7 + 2) * 3600000,
  lat: -6.201 - i * 0.0004, lng: 106.801 + i * 0.0003, elevation: 724, locationName: 'Ciomas', accuracy: 12, symptoms: 'Bercak cokelat.', geocorrelation: 'Lembap.',
  immediate_action: 'Buang daun yang bergejala dan pantau 3 hari.', needs_review: i === 3, confidence: 0.8, farmId: i < 3 ? 'farm_a' : null,
  imageUrl: '/api/photos/p' + (i % 4), source: 'ai', locationSource: 'gps',
}));
// tree_0 has two older photos, so its timeline has three entries (one with a low confidence).
RECORDS.push({ ...RECORDS[0], id: 'r0b', condition: 'Daun menguning', severity: 'Moderate', confidence: 0.42, needs_review:true, timestampMs: NOW - 5 * DAY, createdMs: NOW - 5 * DAY, updatedMs: NOW - 5 * DAY },
  { ...RECORDS[0], id: 'r0c', condition: 'Tanaman sehat', severity: 'Healthy', confidence: 0.93, timestampMs: NOW - 12 * DAY, createdMs: NOW - 12 * DAY, updatedMs: NOW - 12 * DAY });
const TELEMETRY = { lat: GPS.latitude, lng: GPS.longitude, elevation: [724], locationName: 'Ciomas, Kab. Bogor, Jawa Barat', tempC: 24, rh: 82, weather: '24°C • 82% RH', locationApproximate: false };

function crc32(buf) { let c, crc = -1; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ -1) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const b = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); }
function solidPng(rgb) {
  const size = 16, raw = Buffer.alloc((size * 3 + 1) * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) { const o = r * (size * 3 + 1) + 1 + c * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PHOTOS = [solidPng([96, 140, 70]), solidPng([150, 120, 60]), solidPng([70, 110, 90]), solidPng([170, 160, 80])];
const TILE = solidPng([226, 234, 220]);

/* ------------------------------------------------------------------ server + mocks */
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const file = path.resolve(FRONTEND, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

async function openApp(browser, viewport, context) {
  context = context || await browser.newContext({ viewport, serviceWorkers: 'block', locale: 'id-ID', timezoneId: 'Asia/Jakarta', permissions: ['camera', 'geolocation'], geolocation: GPS });
  await context.route(/^https:\/\//, route => /tile|arcgisonline/.test(route.request().url()) ? route.fulfill({ status: 200, contentType: 'image/png', body: TILE }) : route.abort());
  await context.route('**/api/**', route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/auth/me' || p === '/api/auth/login') return json({ ok: true, account: ACCOUNT, csrf: 'dh-csrf' });
    if (p === '/api/health') return json({ ok: true, version: '2.1.0', capabilities: { treeContinuity: true, recordsPaging: true, accountBinding: true, photoLifecycle: true }, release: '0.2.2.2' });
    if (p === '/api/telemetry') return json(TELEMETRY);
    if (p === '/api/records') return json(Number(url.searchParams.get('limit') || 0) ? { items: RECORDS, next: null } : RECORDS);
    if (p === '/api/farms') return json(FARMS);
    if (p === '/api/daily') return json([]);
    if (p.startsWith('/api/photos/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PHOTOS[Number(p.slice(-1)) || 0] });
    return json([]);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 300)));
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 15000 });
  await page.evaluate(() => { try { JagaOfflineSync.stop(); } catch (_) { /* optional */ } });
  await page.waitForTimeout(500);
  return { context, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

/* Every visible element with rounded corners must use 8 or 12 px (11 px = 12 px inside a 1 px border),
   or be a circle / pill (radius >= half its height). */
function radiusAudit(page, scope) {
  return page.evaluate(scopeSel => {
    const bad = [];
    for (const el of document.querySelectorAll(scopeSel + ' *, ' + scopeSel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || !el.getClientRects().length) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') continue;
      for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius']) {
        const v = s[corner];
        if (!v || v === '0px') continue;
        if (v.includes('%')) { if (parseFloat(v) >= 50) continue; }
        const px = parseFloat(v);
        if ([8, 11, 12].includes(px) || px >= Math.min(r.height, r.width) / 2 - 0.5) continue;
        bad.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''), corner, v });
        break;
      }
    }
    return bad.slice(0, 20);
  }, scope);
}

async function desktop(browser, width, height) {
  const tag = width + 'x' + height;
  const { context, page, errors } = await openApp(browser, { width, height });
  const desktopShell = await page.evaluate(() => {
    const rail = document.getElementById('desktop-nav');
    const header = document.querySelector('#app-shell > header');
    const profile = header.querySelector('.account-btn');
    const title = document.getElementById('desktop-page-title');
    const iconSizes = [...rail.querySelectorAll('[data-view] svg')].map(icon => icon.getBoundingClientRect().width);
    const topBar = header.getBoundingClientRect();
    const bounds = profile.getBoundingClientRect();
    return { iconSizes, profileText: profile.textContent.trim(), profileHeight: bounds.height,
      profileInset: topBar.right - bounds.right, title: title.textContent, titleInBar: title.parentElement === header,
      barBackground: getComputedStyle(header).backgroundColor,
      titleSize: parseFloat(getComputedStyle(title).fontSize),
      titleInset: title.getBoundingClientRect().left - topBar.left };
  });
  const headerInset = Math.min(48, Math.max(24, width * 0.03));
  check(`${tag} the title and profile are back in the white desktop top bar`,
    desktopShell.title === 'Beranda' && desktopShell.titleInBar
    && desktopShell.barBackground === 'rgb(255, 255, 255)' && desktopShell.profileText === ACCOUNT.name
    && desktopShell.profileHeight >= 44 && near(desktopShell.profileInset, headerInset), desktopShell);
  check(`${tag} all four sidebar icons are 22px`, desktopShell.iconSizes.length === 4
    && desktopShell.iconSizes.every(size => near(size, 22)), desktopShell.iconSizes);
  check(`${tag} the heading is 20px at its original inset`, near(desktopShell.titleSize, 20, 0.1)
    && near(desktopShell.titleInset, headerInset), desktopShell);
  await page.locator('#app-shell > header .account-btn').click();
  check(`${tag} the desktop profile opens the account dialog`, await page.locator('#modal-account').isVisible());
  await page.evaluate(() => closeDialog('modal-account'));
  const g = await page.evaluate(() => {
    const box = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
    return { place: box('#home-place-card'),
      tiles: box('#home-tiles'), attention: box('#home-attention'), attList: box('#home-attention-list'), daily: box('#home-daily'), dailyCard: box('#home-daily-card > .card'),
      recent: box('#home-recent'), carousel: box('#home-history-carousel') };
  });
  check(`D1 ${tag} duplicate home shortcuts are removed`, await page.locator('#home-actions').count()===0);
  check(`D2 ${tag} location and summary span the same full width`,near(g.place.left,g.tiles.left)&&near(g.place.right,g.tiles.right),g);
  check(`D3 ${tag} "Catatan harian" starts with and ends level with "Perlu perhatian"`, near(g.daily.top, g.attention.top) && near(g.dailyCard.bottom, g.attList.bottom), { daily: g.daily, dailyCard: g.dailyCard, attList: g.attList });
  check(`D4 ${tag} "Foto terbaru" runs from the left edge to the right edge, and the photos stay inside those edges`, near(g.recent.left, g.place.left) && near(g.recent.right, g.place.right) && near(g.carousel.left, g.place.left) && near(g.carousel.right, g.place.right), { recent: g.recent, carousel: g.carousel, place: g.place,  });
  await shot(page, `home-${tag}`);

  const nav = () => page.evaluate(() => { const row = document.getElementById('home-history-carousel'); const btn = s => document.querySelector('#home-recent .carousel-nav.' + s); return { prev: !btn('is-prev').hidden && btn('is-prev').getClientRects().length > 0, next: !btn('is-next').hidden && btn('is-next').getClientRects().length > 0, left: row.scrollLeft, max: row.scrollWidth - row.clientWidth, cards: row.children.length }; });
  const start = await nav();
  check(`D4 ${tag} slider shows 12 photos, starts with only the "next" arrow`, start.cards === 12 && start.max > 0 && start.next && !start.prev, start);
  await page.click('#home-recent .carousel-nav.is-next');
  await page.waitForTimeout(900);
  const moved = await nav();
  check(`D4 ${tag} the "next" arrow slides the row and brings back "previous"`, moved.left > 100 && moved.prev, moved);
  for (let i = 0; i < 6 && (await nav()).next; i++) { await page.click('#home-recent .carousel-nav.is-next'); await page.waitForTimeout(900); }
  const end = await nav();
  check(`D4 ${tag} at the end the "next" arrow hides`, !end.next && end.prev && near(end.left, end.max, 3), end);
  await page.evaluate(() => { const v = document.getElementById("view-home"); v.scrollTop = v.scrollHeight; });
  await shot(page, `home-slid-${tag}`);
  await page.evaluate(() => { document.getElementById("view-home").scrollTop = 0; });

  const chevrons = await page.evaluate(() => document.querySelectorAll('#view-home .lucide-chevron-right, #view-home .att-chev').length - document.querySelectorAll('#view-home .carousel-nav .lucide-chevron-right').length);
  check(`D5 ${tag} no chevron on the Beranda cards`, chevrons === 0, chevrons);

  /* D6 collapsible menu, Gemini-style: "Ciutkan menu" right of the name; collapsed, the logo is "Buka menu"; icons never move */
  const icons = () => page.evaluate(() => {
    const at = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2]; };
    const toggle = document.getElementById('desktop-nav-toggle'), name = document.querySelector('#desktop-nav .brand-name');
    return { logo: at(document.querySelector('#desktop-nav-expand img')), items: [...document.querySelectorAll('#desktop-nav [data-view] svg')].map(at),
      toggleShown: toggle.getClientRects().length > 0, toggleRightOfName: toggle.getClientRects().length > 0 && toggle.getBoundingClientRect().left >= name.getBoundingClientRect().right,
      toggleMid: toggle.getClientRects().length ? (toggle.getBoundingClientRect().top + toggle.getBoundingClientRect().bottom) / 2 : null,
      logoMid: (document.querySelector('#desktop-nav-expand').getBoundingClientRect().top + document.querySelector('#desktop-nav-expand').getBoundingClientRect().bottom) / 2 };
  });
  const before = await page.evaluate(() => ({ nav: document.getElementById('desktop-nav').getBoundingClientRect().width, main: document.querySelector('#app-shell > main').getBoundingClientRect().width }));
  const open = await icons();
  check(`D6 ${tag} expanded: "Ciutkan menu" sits right of "JagaKebond", level with the logo`, open.toggleShown && open.toggleRightOfName && near(open.toggleMid, open.logoMid), open);
  await page.click('#desktop-nav-toggle');
  await page.waitForTimeout(400);
  const rail = await page.evaluate(() => {
    const navEl = document.getElementById('desktop-nav'), logo = document.getElementById('desktop-nav-expand');
    const buttons = [...navEl.querySelectorAll('[data-view]')];
    return { nav: navEl.getBoundingClientRect().width, main: document.querySelector('#app-shell > main').getBoundingClientRect().width,
      labelsHidden: buttons.every(b => b.querySelector('span:last-child').getBoundingClientRect().width <= 1),
      nameHidden: document.querySelector('#desktop-nav .brand-name').getBoundingClientRect().width <= 1,
      names: buttons.map(b => b.textContent.trim()), titles: buttons.map(b => b.title), iconsCentred: buttons.every(b => { const r = b.getBoundingClientRect(), i = b.querySelector('svg').getBoundingClientRect(); return Math.abs((i.left + i.right) / 2 - (r.left + r.right) / 2) <= 1.5; }),
      expanded: logo.getAttribute('aria-expanded'), label: logo.getAttribute('aria-label'), focusable: logo.tabIndex === 0 && !logo.hasAttribute('aria-hidden'), stored: localStorage.getItem('jk-nav-collapsed') };
  });
  const closed = await icons();
  check(`D6 ${tag} the menu collapses to a 72 px icon rail and the page widens`, near(rail.nav, 72) && rail.main > before.main + 150 && rail.labelsHidden && rail.nameHidden && rail.iconsCentred && !closed.toggleShown, { before, rail });
  check(`D6 ${tag} the logo and every menu icon stay exactly where they were`, JSON.stringify(open.logo) === JSON.stringify(closed.logo) && JSON.stringify(open.items) === JSON.stringify(closed.items), { open, closed });
  check(`D6 ${tag} collapsed buttons keep their names (screen reader + tooltip) and the logo is the "Buka menu" button`, JSON.stringify(rail.names) === '["Beranda","Peta","Foto Tanaman","Riwayat"]' && JSON.stringify(rail.titles) === JSON.stringify(rail.names) && rail.expanded === 'false' && rail.label === 'Buka menu' && rail.focusable && rail.stored === '1', rail);
  const collapsedProfile = await page.evaluate(() => {
    const button = document.querySelector('#app-shell > header .account-btn');
    const bounds = button.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, label: button.getAttribute('aria-label'),
      name: button.textContent.trim(), inset: innerWidth - bounds.right };
  });
  check(`${tag} collapsing the sidebar leaves the profile in its top-bar position`, collapsedProfile.width >= 44
    && collapsedProfile.height >= 44 && collapsedProfile.label === 'Akun saya'
    && collapsedProfile.name === ACCOUNT.name && near(collapsedProfile.inset, headerInset), collapsedProfile);
  const plain = await page.evaluate(() => ({ img: getComputedStyle(document.querySelector('#desktop-nav-expand img')).visibility, ico: getComputedStyle(document.querySelector('#desktop-nav-expand .brand-open-ico')).display }));
  await page.hover('#desktop-nav-expand');
  await page.waitForTimeout(100);
  const hovered = await page.evaluate(() => ({ img: getComputedStyle(document.querySelector('#desktop-nav-expand img')).visibility, ico: getComputedStyle(document.querySelector('#desktop-nav-expand .brand-open-ico')).display, svg: !!document.querySelector('#desktop-nav-expand .brand-open-ico svg') }));
  check(`D6 ${tag} hovering the collapsed logo swaps it for the "open menu" icon`, plain.img === 'visible' && plain.ico === 'none' && hovered.img === 'hidden' && hovered.ico !== 'none' && hovered.svg, { plain, hovered });
  await shot(page, `home-rail-hover-${tag}`);
  await page.mouse.move(width - 10, height - 10);
  const railGrid = await page.evaluate(() => {const p=document.querySelector('#home-place-card').getBoundingClientRect(),t=document.querySelector('#home-tiles').getBoundingClientRect();return{pLeft:p.left,pRight:p.right,tLeft:t.left,tRight:t.right};});
  check(`D6 ${tag} expanded home cards stay aligned with collapsed rail`,near(railGrid.pLeft,railGrid.tLeft)&&near(railGrid.pRight,railGrid.tRight),railGrid);
  await shot(page, `home-rail-${tag}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof JagaAppAccount === 'function' && JagaAppAccount() && loadedOnce, null, { timeout: 15000 });
  const remembered = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('jk-nav-collapsed'), nav: document.getElementById('desktop-nav').getBoundingClientRect().width }));
  check(`D6 ${tag} the collapsed menu is remembered after a reload`, remembered.cls && near(remembered.nav, 72), remembered);
  await page.evaluate(() => navigateToMenu('map'));
  const mapTitle = await page.evaluate(() => {
    const title = document.getElementById('desktop-page-title');
    const bar = title.parentElement;
    const map = document.getElementById('map-container').getBoundingClientRect();
    const toolbar = document.getElementById('map-toolbar').getBoundingClientRect();
    return { text: title.textContent, barBottom: bar.getBoundingClientRect().bottom,
      mapTop: map.top, toolbarTop: toolbar.top, background: getComputedStyle(bar).backgroundColor };
  });
  check(`${tag} Peta starts below its restored white top bar`,
    mapTitle.text === 'Peta' && near(mapTitle.mapTop, mapTitle.barBottom)
    && mapTitle.toolbarTop > mapTitle.barBottom && mapTitle.background === 'rgb(255, 255, 255)', mapTitle);
  await page.waitForTimeout(400);
  await shot(page, `map-rail-${tag}`);
  await page.click('#desktop-nav-expand');
  await page.waitForTimeout(400);
  const reopened = await page.evaluate(() => ({ nav: document.getElementById('desktop-nav').getBoundingClientRect().width, map: document.getElementById('map-container').getBoundingClientRect().width, leaflet: mapInstance ? mapInstance.getSize().x : null, stored: localStorage.getItem('jk-nav-collapsed'), logoHidden: document.getElementById('desktop-nav-expand').getAttribute('aria-hidden') === 'true' && document.getElementById('desktop-nav-expand').tabIndex === -1 }));
  check(`D6 ${tag} clicking the logo expands the menu again and the map re-measures`, near(reopened.nav, 232) && reopened.stored === '0' && reopened.logoHidden && near(reopened.map, reopened.leaflet, 2), reopened);
  const after = await icons();
  check(`D6 ${tag} after expanding, the logo and icons are back exactly where they started`, JSON.stringify(open.logo) === JSON.stringify(after.logo) && JSON.stringify(open.items) === JSON.stringify(after.items), { open, after });

  /* D8 Riwayat desktop layout: processing, tabs, search/filters and cards stack in one full-width column. */
  await page.evaluate(async () => {
    navigateToMenu('log');
    closeTreeTimeline();
    workflowJobs.set('layout-processing', { id: 'layout-processing', status: 'queued', position: 0, createdMs: Date.now() });
    await updateOfflineDraftCount();
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const drafts = document.getElementById('offline-drafts');
    drafts.hidden = false;
    drafts.dataset.tone = 'busy';
    document.getElementById('drafts-summary').textContent = '1 sedang dianalisis';
  });
  const logLayout = await page.evaluate(() => {
    const box = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width }; };
    return {
      view: box('#view-log'), drafts: box('#offline-drafts'), tabs: box('#log-tabs'),
      filter: box('#log-filter-wrap'), search: box('#log-search-wrap'), chips: box('#log-chips'),
      cards: box('#logs-container'), firstCard: box('#logs-container .tree-card'),
      columns: getComputedStyle(document.getElementById('view-log')).gridTemplateColumns,
    };
  });
  check(`D8 ${tag} the processing panel, tabs, search/filters and crop cards share the full content width`,
    near(logLayout.drafts.left, logLayout.filter.left) && near(logLayout.drafts.right, logLayout.filter.right) &&
    near(logLayout.search.left, logLayout.filter.left) && near(logLayout.search.right, logLayout.filter.right) &&
    near(logLayout.cards.left, logLayout.filter.left) && near(logLayout.cards.right, logLayout.filter.right) &&
    logLayout.columns.trim().split(/\s+/).length === 1, logLayout);
  check(`D8 ${tag} sections stack in order: processing, tabs, search/filter, then crop cards`,
    logLayout.drafts.bottom <= logLayout.tabs.top + 1 && logLayout.tabs.bottom <= logLayout.filter.top + 1 &&
    logLayout.filter.bottom < logLayout.firstCard.top && logLayout.cards.bottom >= logLayout.firstCard.bottom, logLayout);
  // Seed the shell's public activity state for this placement check. The mock queue can clear the
  // in-memory job while the page switches sections, which is outside this layout assertion.
  await page.evaluate(() => JagaShell.setDraftState({ label: '1 sedang dianalisis', counts: { processing: 1 } }));
  const statusChip = await page.locator('#app-shell > header #status-chip').evaluate(el => ({
    visible: !!el.getClientRects().length,
    display: getComputedStyle(el).display,
    text: el.textContent.trim(),
  }));
  check(`${tag} the desktop status chip returns to the top bar when there is activity`,
    statusChip.visible && statusChip.display !== 'none', statusChip);
  await shot(page, `riwayat-layout-${tag}`);

  /* D7 corners */
  for (const view of ['home', 'log', 'map']) {
    await page.evaluate(v => navigateToMenu(v), view);
    await page.waitForTimeout(300);
    const bad = await radiusAudit(page, '#app-shell');
    check(`D7 ${tag} ${view}: every rounded corner is 8 or 12 px (or a circle/pill)`, bad.length === 0, bad);
  }
  await page.evaluate(() => navigateToMenu('scan'));
  check(`${tag} the camera page heading is Foto Tanaman`,
    await page.locator('#desktop-page-title').innerText() === 'Foto Tanaman');
  check(`${tag} no page errors`, errors.length === 0, errors);
  await context.close();
}

async function phone(browser) {
  const { context, page, errors } = await openApp(browser, { width: 390, height: 844 });
  check('Phone: profile remains available in the top bar', await page.locator('#app-shell > header .account-btn').isVisible()
    && !await page.locator('#desktop-page-title').isVisible());
  const chevrons = await page.evaluate(() => document.querySelectorAll('#home-attention-list .lucide-chevron-right, #home-attention-list .att-chev').length);
  check('D5 390x844 no chevron on the Perlu perhatian cards', chevrons === 0, chevrons);
  const arrows = await page.evaluate(() => [...document.querySelectorAll('.carousel-nav')].filter(b => b.getClientRects().length > 0).length);
  check('D4 390x844 touch phones swipe the photos (no arrows)', arrows === 0 || !(await page.evaluate(() => matchMedia('(hover: none)').matches)), arrows);
  const order = await page.evaluate(() => [...document.getElementById('view-home').children].filter(e => e.getClientRects().length).map(e => e.id));
  check('Phone Beranda keeps its order (location, actions, tiles, Perlu perhatian, photos, daily)', JSON.stringify(order) === JSON.stringify(['home-place-card', 'home-tiles', 'home-attention', 'home-recent', 'home-daily']), order);
  await shot(page, 'home-390x844');
  for (const view of ['home', 'log', 'map']) {
    await page.evaluate(v => navigateToMenu(v), view);
    await page.waitForTimeout(300);
    const bad = await radiusAudit(page, '#app-shell');
    check(`D7 390x844 ${view}: every rounded corner is 8 or 12 px (or a circle/pill)`, bad.length === 0, bad);
  }
  const phoneLogLayout = await page.evaluate(async () => {
    navigateToMenu('log');
    closeTreeTimeline();
    workflowJobs.set('layout-processing', { id: 'layout-processing', status: 'queued', position: 0, createdMs: Date.now() });
    await updateOfflineDraftCount();
    const drafts = document.getElementById('offline-drafts');
    drafts.hidden = false;
    drafts.dataset.tone = 'busy';
    document.getElementById('drafts-summary').textContent = '1 sedang dianalisis';
    const view = document.getElementById('view-log');
    const b = sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    return {
      display: getComputedStyle(view).display,
      drafts: b('#offline-drafts'), tabs: b('#log-tabs'), filter: b('#log-filter-wrap'), cards: b('#logs-container'),
    };
  });
  check('D8 390x844 Riwayat keeps its phone stack and section order',
    phoneLogLayout.display === 'flex' &&
    phoneLogLayout.drafts.bottom <= phoneLogLayout.tabs.top + 1 &&
    phoneLogLayout.tabs.bottom <= phoneLogLayout.filter.top + 1 &&
    phoneLogLayout.filter.bottom < phoneLogLayout.cards.top + 1, phoneLogLayout);
  check('390x844 no page errors', errors.length === 0, errors);
  await context.close();
}

async function phoneFixes(browser) {
  const { context, page, errors } = await openApp(browser, { width: 390, height: 844 });
  const fakePhoto = state => page.evaluate(s => { selectedImageBase64 = document.createElement('canvas').toDataURL('image/jpeg'); setScanState(s); navigateToMenu('log'); }, state);
  const scanNow = () => page.evaluate(() => {
    const toast = document.getElementById('toast-notification');
    return { scan: !document.getElementById('view-scan').classList.contains('hidden'), state: scanState, photo: !!selectedImageBase64,
      toast: toast.classList.contains('hidden') ? '' : toast.textContent, confirm: !document.getElementById('modal-confirm').classList.contains('hidden'),
      tree: (document.getElementById('capture-tree-context') || {}).textContent || '' };
  });

  /* E1 */
  for (const [label, sel] of [['bottom nav "Kamera"', '#nav-btn-scan']]) {
    await fakePhoto('sent');
    await page.evaluate(() => navigateToMenu('home'));
    await page.click(sel);
    await page.waitForTimeout(250);
    const st = await scanNow();
    check(`E1 ${label} after a sent photo opens a fresh camera`, st.scan && st.state === 'live' && !st.photo && !/Simpan atau batalkan/.test(st.toast), st);
  }

  /* E2 */
  await fakePhoto('result');
  await page.waitForTimeout(200);
  await page.click('#logs-container .tree-card .tree-cam >> nth=0');
  await page.waitForTimeout(300);
  const tree = await scanNow();
  check('E2 a tree camera button after a finished photo opens the camera for that tree, with no blocking message',
    tree.scan && tree.state === 'live' && !tree.confirm && /Foto lanjutan/.test(tree.tree) && !/Simpan atau batalkan/.test(tree.toast), tree);
  await fakePhoto('review');
  await page.waitForTimeout(200);
  await page.click('#logs-container .tree-card .tree-cam >> nth=1');
  await page.waitForTimeout(250);
  const asked = await scanNow();
  await page.click('#confirm-cancel-btn');
  await page.waitForTimeout(200);
  const kept = await scanNow();
  check('E2 an UNSENT photo asks first; "Batal" keeps that photo', asked.confirm && kept.photo && kept.state === 'review' && !kept.scan, { asked, kept });
  await page.click('#logs-container .tree-card .tree-cam >> nth=1');
  await page.waitForTimeout(250);
  await page.click('#confirm-ok-btn');
  await page.waitForTimeout(300);
  const dropped = await scanNow();
  check('E2 "Buang dan foto baru" opens the camera for that tree', dropped.scan && dropped.state === 'live' && !dropped.photo && /Foto lanjutan/.test(dropped.tree), dropped);

  /* E4 card geometry */
  await page.evaluate(() => { navigateToMenu('log'); closeTreeTimeline(); });
  await page.waitForTimeout(200);
  const card = await page.evaluate(() => {
    const c = document.querySelector('#logs-container .tree-card'), mid = r => (r.top + r.bottom) / 2;
    const cr = c.getBoundingClientRect(), t = c.querySelector('.tree-thumb').getBoundingClientRect(), b = c.querySelector('.tree-cam').getBoundingClientRect();
    return { card: mid(cr), thumb: mid(t), cam: mid(b), h: cr.height, badgeInText: !!c.querySelector('.tree-main .card-status .badge'), padL: t.left - cr.left, padR: cr.right - b.right };
  });
  check('E4 Riwayat card: photo and camera button share the card centre line, status in the text column, equal side padding',
    near(card.thumb, card.card) && near(card.cam, card.card) && card.badgeInText && near(card.padL, card.padR) && card.h <= 100, card);
  await shot(page, 'riwayat-cards-390x844');
  await page.evaluate(() => navigateToMenu('home'));
  const att = await page.evaluate(() => {
    const c = document.querySelector('#home-attention-list .att-item'), r = c.getBoundingClientRect(), t = c.querySelector('.thumb').getBoundingClientRect();
    return { card: (r.top + r.bottom) / 2, thumb: (t.top + t.bottom) / 2, badge: !!c.querySelector('.att-body .card-status .badge') };
  });
  check('E4 Beranda "Perlu perhatian" card uses the same layout', near(att.card, att.thumb) && att.badge, att);

  /* E3 + E5 timeline */
  await page.evaluate(() => openTreeTimeline('tree_0'));
  await page.waitForTimeout(300);
  const tl = await page.evaluate(() => [...document.querySelectorAll('#logs-container .tl-entry')].map(e => {
    const dot = e.querySelector('.tl-dot').getBoundingClientRect(), badge = e.querySelector('.tl-meta-row .badge').getBoundingClientRect(), box = e.getBoundingClientRect();
    const line = getComputedStyle(e, '::before'), hasLine = line.content !== 'none' && line.content !== 'normal';
    return { dotX: (dot.left + dot.right) / 2, dotY: (dot.top + dot.bottom) / 2, badgeY: (badge.top + badge.bottom) / 2, hasLine,
      lineTop: box.top + parseFloat(line.top), lineBottom: box.bottom - parseFloat(line.bottom), lineX: box.left + parseFloat(line.left) + parseFloat(line.width) / 2,
      conf: (e.querySelector('.tl-confidence') || {}).textContent || '', low: !!e.querySelector('.tl-confidence.is-low') };
  }));
  check('E3 uncertainty uses a review label without an uncalibrated probability',
    tl.length===3 && !tl[0].conf && tl[1].conf==='Perlu Pemeriksaan Langsung' && tl[1].low && !tl[2].conf && tl.every(t=>!t.conf.includes('%')),tl.map(t=>[t.conf,t.low]));
  const tidy = tl.every((t, i) => near(t.dotY, t.badgeY) &&
    (i === tl.length - 1 ? !t.hasLine : t.hasLine && near(t.lineX, t.dotX) && near(t.lineTop, t.dotY) && near(t.lineBottom, tl[i + 1].dotY)));
  check('E5 timeline: dots centred on the line and on their status row; the line runs dot to dot and stops at the last dot', tidy, tl);
  await shot(page, 'timeline-390x844');

  /* E6 stamp */
  const stamps = await page.evaluate(async () => {
    const out = [];
    for (const [w, h] of [[1080, 1440], [480, 640], [1440, 1080]]) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#4d7c0f'); grad.addColorStop(1, '#d9f99d'); g.fillStyle = grad; g.fillRect(0, 0, w, h);
      const meta = { lat: -3.4436123, lng: 104.0439456, accuracy: 9, elevation: '27', weather: '25°C • 98% RH', photoTimestampMs: String(Date.UTC(2026, 9, 28, 12, 42)),
        locationName: 'Petak Kebun Cabe Bapak Slamet Riyadi, Desa Gerinam, Muara Enim, Sumatera Selatan' };
      const url = await bakeStampIntoCanvas(c.toDataURL('image/png'), meta, { severity: 'Moderate', crop: 'Jagung (Corn)', condition: 'Bule (Downy Mildew) pada daun muda dan daun tengah' });
      out.push({ w, h, ok: typeof url === 'string' && url.startsWith('data:image/jpeg'), url });
    }
    const bare = await bakeStampIntoCanvas(document.createElement('canvas').toDataURL('image/png'), {}, null);
    return { out, bare: typeof bare === 'string' };
  });
  check('E6 the stamp renders at portrait, small and landscape sizes, and with no metadata at all', stamps.out.every(s => s.ok) && stamps.bare, stamps.out.map(s => [s.w, s.h, s.ok]));
  if (SHOTS) for (const s of stamps.out) fs.writeFileSync(path.join(SHOTS, `stamp-${s.w}x${s.h}.jpg`), Buffer.from(s.url.split(',')[1], 'base64'));
  check('E 390x844 no page errors', errors.length === 0, errors);
  await context.close();
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await playwright.chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    await desktop(browser, 1440, 900);
    await desktop(browser, 1280, 800);
    await phone(browser);
    await phoneFixes(browser);
  } finally {
    await browser.close();
    server.close();
  }
  const failed = checks.filter(c => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
