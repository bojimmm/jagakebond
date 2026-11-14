// Admin console 0.2.2.0 — real Chromium against a DISPOSABLE backend (synthetic data only, never production).
// Run (from review/browser-tools):  node admin-0220.cjs
// Needs: PY (python with the backend deps), TMPDIR (short path), /usr/bin/google-chrome, playwright + axe-core.
// Checks: strict CSP with zero violations, nothing external, login error text, views never shown together,
// keyboard-operable dialogs (role/aria-modal/focus trap/Escape/focus restore), session expiry clears data,
// polling pauses while the tab is hidden and never drops focus, stacked cards at 390 px, the shared-kit
// button audit (>=44 px, >=15 px labels that do not wrap, equal heights per row, no overflow), axe, screenshots.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const SHOTS = path.resolve(__dirname, '../screenshots/admin-0220');
const PY = process.env.JK_TEST_PYTHON || process.env.PY || 'python3';
const ADMIN_EMAIL = 'admin@jagakebond.local';
const ADMIN_PW = 'AdminLokal123';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
fs.mkdirSync(SHOTS, { recursive: true });

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail !== undefined && !ok ? { detail: String(detail).slice(0, 600) } : {}) }); if (!ok) console.log('FAIL', name, '::', String(detail).slice(0, 300)); };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixture backend
async function startBackend(routerPort) {
  const folder = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jk-admin0220-'));
  const app = path.join(folder, 'app');
  const skip = new Set(['data', '.env', 'venv', '.git', '__pycache__', 'node_modules']);
  fs.cpSync(path.join(ROOT, 'app'), app, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || folder, TMPDIR: process.env.TMPDIR || folder, LANG: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1', COOKIE_SECURE: '0', SECRET_KEY: 'synthetic-admin-0220-browser-key', WORKER_TOKEN: 'dev-local-worker-token',
    ADMIN_EMAIL, ADMIN_PASSWORD: ADMIN_PW, ALLOW_REGISTRATION: '0', SEED_DEMO_DATA: '0',
    NINEROUTER_KEY: 'synthetic-router-key-0220-abcdef', NINEROUTER_URL: 'http://127.0.0.1:9' };
  const log = fs.openSync(path.join(folder, 'server.log'), 'w');
  const server = spawn(PY, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', String(port), '--workers', '1'], { cwd: app, env, stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    if (server.exitCode !== null) throw new Error('backend exited: ' + fs.readFileSync(path.join(folder, 'server.log'), 'utf8').slice(-800));
    await sleep(150);
  }
  return { base, server, folder, env };
}

function startFakeRouter() {
  const state = { hits: [] };
  const server = http.createServer((req, res) => {
    state.hits.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gemini/gemma-4-26b-a4b-it' }, { id: 'gemini/gemma-4-31b-it' }] }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

// ---------------------------------------------------------------- in-page helpers
const buttonAudit = (rootSelector) => {
  const root = document.querySelector(rootSelector) || document.body;
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('.sr-only') && !el.closest('[hidden]'); };
  const lines = (el) => {
    const tops = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.nodeValue.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) if (rect.width > 0) tops.push(rect.top);
    }
    const rows = [];
    tops.sort((a, b) => a - b).forEach((t) => { if (!rows.length || t - rows[rows.length - 1] > 6) rows.push(t); });
    return rows.length;
  };
  const els = [...root.querySelectorAll('button, a.btn, [role="tab"], .chip')].filter(visible);
  const problems = [], report = [];
  for (const el of els) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const hasText = !!el.textContent.trim();
    const m = { label, cls: el.className.toString().replace(/\s+/g, ' ').slice(0, 50), h: Math.round(r.height * 10) / 10, w: Math.round(r.width), fs: parseFloat(cs.fontSize), radius: cs.borderTopLeftRadius, padX: cs.paddingLeft, lines: hasText ? lines(el) : 0 };
    report.push(m);
    if (r.height < 43.5) problems.push(`height ${m.h} < 44 :: ${label}`);
    if (r.width < 43.5) problems.push(`width ${m.w} < 44 :: ${label}`);
    if (hasText && m.fs < 15) problems.push(`font ${m.fs}px < 15 :: ${label}`);
    if (m.lines > 1) problems.push(`label wraps onto ${m.lines} lines :: ${label}`);
    if (el.scrollWidth > el.clientWidth + 1 && hasText) problems.push(`label overflows its button :: ${label}`);
    for (const span of el.querySelectorAll('span')) if (span.scrollWidth > span.clientWidth + 1 && getComputedStyle(span).overflow === 'hidden') problems.push(`label is cut off :: ${label}`);
    { const box = el.getBoundingClientRect(); for (const span of el.querySelectorAll('span')) { const s = span.getBoundingClientRect(); if (s.width && (s.left < box.left + Number.parseFloat(cs.borderLeftWidth) - 0.5 || s.right > box.right - Number.parseFloat(cs.borderRightWidth) + 0.5)) problems.push(`label touches the edge :: ${label}`); } }
  }
  // siblings in one row must have the same height
  const parents = new Map();
  for (const el of els) { const p = el.parentElement; if (!parents.has(p)) parents.set(p, []); parents.get(p).push(el); }
  for (const [, kids] of parents) {
    if (kids.length < 2) continue;
    const rects = kids.map((k) => k.getBoundingClientRect());
    for (let i = 1; i < kids.length; i++) if (Math.abs(rects[i].top - rects[0].top) < 3 && Math.abs(rects[i].height - rects[0].height) > 1) problems.push(`siblings differ in height (${rects[0].height} vs ${rects[i].height}) :: ${kids[0].textContent.trim().slice(0, 20)} / ${kids[i].textContent.trim().slice(0, 20)}`);
  }
  // inputs / selects / checkbox rows are touch targets too
  for (const el of root.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea, label.check')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5) problems.push(`field height ${Math.round(r.height)} < 44 :: ${el.id || el.className}`);
  }
  // nothing may overflow the viewport sideways
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) { problems.push(`overflows viewport :: <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 40)}"> ${Math.round(r.left)}..${Math.round(r.right)}`); break; }
  }
  return { problems, count: els.length, report };
};

async function axeRun(page, scope) {
  await page.evaluate(AXE);
  return page.evaluate(async (ctx) => {
    const res = await axe.run(ctx ? document.querySelector(ctx) : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(0, 3).join(' | ')) }));
  }, scope || null);
}

const waitToast = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast-region').textContent), re.source, { timeout: 20000 });
const visibleViews = (page) => page.evaluate(() => ['boot-view', 'login-view', 'denied-view', 'console-view'].filter((id) => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none' && !e.hidden; }));

(async () => {
  const router = await startFakeRouter();
  let backend;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    backend = await startBackend(router.port);
    const base = backend.base;
    const seed = spawnSync(PY, [path.join(__dirname, 'admin-0220-seed.py'), base], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (seed.status !== 0) throw new Error('seed failed: ' + seed.stderr.slice(-800));
    const SEED = JSON.parse(seed.stdout.trim().split('\n').pop());
    check('seeded 32 accounts and 9 jobs through the public API', SEED.accounts.length === 32 && SEED.jobs.length === 9);

    // the server itself sends the strict policy for the admin page (BE3), and static assets exist
    const adminResp = await fetch(base + '/admin');
    const serverCsp = adminResp.headers.get('content-security-policy') || '';
    check('server sends a strict CSP on /admin', /script-src 'self'(;|$)/.test(serverCsp) && !/unsafe-inline.*script-src|script-src[^;]*unsafe/.test(serverCsp) && serverCsp.includes("object-src 'none'"), serverCsp);
    for (const asset of ['/admin.js?v=6', '/ui-kit.css?v=3', '/vendor/tailwind.generated.css', '/vendor/lucide-0.468.0.umd.min.js', '/vendor/fonts/google-sans/GoogleSans-latin.woff']) {
      const r = await fetch(base + asset);
      check('asset is served: ' + asset, r.status === 200, r.status);
    }

    for (const vp of [{ name: '390', width: 390, height: 844 }, { name: '1440', width: 1440, height: 900 }]) {
      const phone = vp.width < 700;
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, serviceWorkers: 'block', locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
      await context.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
      // the strict CSP is enforced even if the server did not send it
      await context.route(/\/admin(\.html)?(\?.*)?$/, async (route) => { const r = await route.fetch(); await route.fulfill({ response: r, headers: { ...r.headers(), 'content-security-policy': CSP } }); });
      const page = await context.newPage();
      const external = [], pageErrors = [], badAssets = [], consoleCsp = [];
      page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.hostname !== '127.0.0.1') external.push(r.url()); });
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => { if (/content security policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 200)); });
      page.on('response', (r) => { const t = r.request().resourceType(); if (['stylesheet', 'script', 'font', 'document'].includes(t) && r.status() >= 400) badAssets.push(r.status() + ' ' + r.url()); });
      const T = (s) => `[${vp.name}] ${s}`;

      // ---------------------------------------------------------- login
      await page.goto(base + '/admin', { waitUntil: 'networkidle' });
      await page.waitForSelector('#login-view:not([hidden])');
      check(T('only the login view is shown'), (await visibleViews(page)).join() === 'login-view', await visibleViews(page));
      check(T('view containers use the hidden attribute'), await page.evaluate(() => ['denied-view', 'console-view', 'boot-view'].every((id) => document.getElementById(id).hasAttribute('hidden'))));
      await page.screenshot({ path: path.join(SHOTS, `login-${vp.name}.png`), fullPage: true });
      let v = await axeRun(page); check(T('axe: login has no violations'), v.length === 0, JSON.stringify(v));
      let audit = await page.evaluate(buttonAudit, 'body'); check(T('button audit: login'), audit.problems.length === 0, audit.problems.join(' || '));
      await page.fill('#login-email', ADMIN_EMAIL); await page.fill('#login-password', 'salah-sandi-1');
      await page.click('#login-form [type="submit"]');
      await page.waitForSelector('#login-error:not([hidden])');
      const errText = await page.textContent('#login-error');
      check(T('wrong password shows the Bahasa message, not "unauthenticated"'), /Email atau kata sandi salah/.test(errText) && !/unauthenticated/i.test(errText), errText);
      check(T('the login button is usable again after the error'), await page.evaluate(() => !document.querySelector('#login-form [type="submit"]').disabled));
      await page.fill('#login-password', ADMIN_PW);
      await page.click('#login-form [type="submit"]');
      await page.waitForSelector('#console-view:not([hidden])');
      await page.waitForSelector('#health-title');
      check(T('after login only the console is shown'), (await visibleViews(page)).join() === 'console-view', await visibleViews(page));
      check(T('header shows the admin email'), (await page.textContent('#me-label')).includes(ADMIN_EMAIL));

      // ---------------------------------------------------------- overview
      const ov = await page.textContent('#panel-overview');
      check(T('overview shows pipeline status, worker, router, queue and photo storage'), ['Worker AI', 'Router dan model', 'Antrean analisis', 'Foto di server', 'Buat akun petani', 'Kesalahan aplikasi', 'Periksa foto tanpa catatan'].every((t) => ov.includes(t)), ov.slice(0, 300));
      await page.screenshot({ path: path.join(SHOTS, `overview-${vp.name}.png`), fullPage: true });
      v = await axeRun(page); check(T('axe: overview has no violations'), v.length === 0, JSON.stringify(v));
      audit = await page.evaluate(buttonAudit, 'body'); check(T('button audit: overview'), audit.problems.length === 0, audit.problems.join(' || '));
      check(T('exactly one primary button on the overview'), (await page.locator('#panel-overview .btn-primary').count()) === 1);
      await page.click('[data-action="storage-inventory"]');
      await page.waitForSelector('#inventory-result :text("Hanya laporan")', { timeout: 15000 });
      check(T('orphan-file check is report-only (no delete button)'), (await page.locator('#inventory-result button').count()) === 0);
      await page.click('[data-action="overview-test-router"]');
      await page.waitForSelector('#overview-router-test .notice', { timeout: 30000 });
      check(T('stored router test reports honestly (dead address)'), /tidak dapat dihubungi|menolak|HTTP/i.test(await page.textContent('#overview-router-test')), await page.textContent('#overview-router-test'));
      // worker banner from a mocked overview (BE1's worker status)
      await page.route('**/api/admin/overview', async (route) => {
        const r = await route.fetch(); const j = await r.json();
        j.worker = { lastSeenMs: Date.now() - 60000, lastError: '401', lastErrorMs: Date.now() - 1000, authFailing: true, stale: false };
        j.pipeline = { level: 'bad', title: 'Ada masalah pada analisis AI', issues: [{ level: 'bad', code: 'worker_auth_failing', text: 'Router menolak kunci worker. Analisis berhenti sampai kunci diperbaiki.', action: 'settings' }] };
        await route.fulfill({ response: r, json: j });
      });
      await page.click('[data-action="overview-refresh"]');
      await page.waitForSelector('#panel-overview :text("Router menolak kunci worker")');
      check(T('a failing worker shows a clear banner with the next step'), (await page.textContent('#panel-overview')).includes('Router menolak kunci worker') && (await page.locator('[data-action="goto-tab"][data-tab="settings"]').count()) >= 1);
      check(T('the worker card says "Ditolak router"'), (await page.textContent('#panel-overview')).includes('Ditolak router'));
      audit = await page.evaluate(buttonAudit, 'body'); check(T('button audit: overview with banner'), audit.problems.length === 0, audit.problems.join(' || '));
      await page.unroute('**/api/admin/overview');
      await page.click('[data-action="overview-refresh"]');

      // ---------------------------------------------------------- tabs (roles + keyboard)
      check(T('tabs expose tablist/tab roles with aria-selected'), await page.evaluate(() => document.querySelector('#tabs').getAttribute('role') === 'tablist' && [...document.querySelectorAll('#tabs [role=tab]')].filter((t) => t.getAttribute('aria-selected') === 'true').length === 1));
      await page.focus('#tab-overview'); await page.keyboard.press('ArrowRight');
      check(T('arrow keys move between tabs'), await page.evaluate(() => document.activeElement.id === 'tab-accounts'));
      await page.keyboard.press('Enter');
      await page.waitForSelector('#accounts-list .rtable');

      // ---------------------------------------------------------- accounts
      const rows = await page.locator('#accounts-list tbody tr').count();
      check(T('accounts are paged (25 per page) with a total'), rows === 25 && /25 dari 3\d akun/.test(await page.textContent('#accounts-count')), (await page.textContent('#accounts-count')) + ' rows=' + rows);
      const rowDisplay = await page.evaluate(() => getComputedStyle(document.querySelector('#accounts-list tbody tr')).display);
      check(T(phone ? 'accounts are stacked cards on a phone' : 'accounts are a table on a laptop'), phone ? rowDisplay === 'flex' : rowDisplay === 'table-row', rowDisplay);
      await page.screenshot({ path: path.join(SHOTS, `accounts-${vp.name}.png`), fullPage: true });
      v = await axeRun(page); check(T('axe: accounts has no violations'), v.length === 0, JSON.stringify(v));
      audit = await page.evaluate(buttonAudit, 'body'); check(T('button audit: accounts'), audit.problems.length === 0, audit.problems.join(' || '));
      check(T('each row button has its own accessible name'), await page.evaluate(() => [...document.querySelectorAll('#accounts-list tbody button')].every((b) => /@/.test(b.getAttribute('aria-label') || ''))));
      await page.click('[data-action="accounts-more"]');
      await page.waitForFunction(() => document.querySelectorAll('#accounts-list tbody tr').length > 25);
      check(T('"Muat lebih banyak" appends the next page'), (await page.locator('#accounts-list tbody tr').count()) >= 33 && (await page.locator('[data-action="accounts-more"]').count()) === 0);
      await page.fill('#account-search', 'petani07');
      await page.waitForFunction(() => document.querySelectorAll('#accounts-list tbody tr').length === 1, null, { timeout: 8000 });
      check(T('search narrows to the farmer and keeps focus in the box'), (await page.evaluate(() => document.activeElement.id)) === 'account-search');
      await page.fill('#account-search', '');
      await page.waitForFunction(() => document.querySelectorAll('#accounts-list tbody tr').length === 25, null, { timeout: 8000 });

      // dialog: create account
      await page.click('[data-action="create-account"]');
      await page.waitForSelector('#modal .dialog');
      const dlg = await page.evaluate(() => { const d = document.querySelector('#modal .dialog'); return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), label: !!document.getElementById(d.getAttribute('aria-labelledby')), inside: d.contains(document.activeElement), inert: document.getElementById('app').inert }; });
      check(T('dialog has role, aria-modal, a label and takes focus; page behind is inert'), dlg.role === 'dialog' && dlg.modal === 'true' && dlg.label && dlg.inside && dlg.inert, JSON.stringify(dlg));
      await page.screenshot({ path: path.join(SHOTS, `create-dialog-${vp.name}.png`) });
      v = await axeRun(page); check(T('axe: create dialog has no violations'), v.length === 0, JSON.stringify(v));
      audit = await page.evaluate(buttonAudit, '#modal'); check(T('button audit: create dialog'), audit.problems.length === 0, audit.problems.join(' || '));
      let trapped = true;
      for (let i = 0; i < 25; i++) { await page.keyboard.press('Tab'); if (!(await page.evaluate(() => document.querySelector('#modal .dialog').contains(document.activeElement)))) trapped = false; }
      for (let i = 0; i < 25; i++) { await page.keyboard.press('Shift+Tab'); if (!(await page.evaluate(() => document.querySelector('#modal .dialog').contains(document.activeElement)))) trapped = false; }
      check(T('Tab and Shift+Tab stay inside the dialog'), trapped);
      await page.keyboard.press('Escape');
      check(T('Escape closes the dialog and focus returns to the button'), await page.evaluate(() => document.getElementById('modal').hidden && document.activeElement.dataset.action === 'create-account' && !document.getElementById('app').inert));
      // create a farmer with a generated password
      await page.click('[data-action="create-account"]');
      await page.fill('#na-email', 'baru.uji@contoh.id'); await page.fill('#na-name', 'Petani Baru Uji');
      await page.click('[data-action="gen-password"]');
      check(T('generated password fills both fields (>=12 chars)'), await page.evaluate(() => { const a = document.getElementById('na-password').value; return a.length >= 12 && a === document.getElementById('na-password2').value; }));
      await page.selectOption('#na-role', 'admin');
      check(T('choosing Admin asks for your password'), await page.isVisible('#na-reauth'));
      await page.click('#modal [type="submit"]');
      check(T('creating an admin without the password is stopped with a clear message'), (await page.textContent('#modal-error')).includes('kata sandi Anda'), await page.textContent('#modal-error'));
      await page.selectOption('#na-role', 'user');
      await page.click('#modal [type="submit"]');
      await waitToast(page, /Akun dibuat/);
      check(T('farmer account is created (toast, dialog closed)'), (await page.textContent('#toast-region')).includes('Akun dibuat') && await page.evaluate(() => document.getElementById('modal').hidden));
      // edit with a confirm step
      await page.fill('#account-search', 'baru.uji');
      await page.waitForFunction(() => document.querySelectorAll('#accounts-list tbody tr').length === 1);
      await page.click('[data-action="edit-account"]');
      await page.selectOption('#ea-role', 'priority');
      await page.click('#modal [type="submit"]');
      check(T('a role change shows a summary and asks to confirm'), (await page.textContent('#ea-summary')).includes('Prioritas') && (await page.textContent('#modal [type="submit"]')).includes('Ya, simpan'));
      await page.click('#modal [type="submit"]');
      await page.waitForFunction(() => document.getElementById('modal').hidden);
      // the list reloads after the dialog closes: wait for it instead of racing it
      await page.waitForFunction(() => document.getElementById('accounts-list').textContent.includes('Prioritas'), null, { timeout: 8000 }).catch(() => {});
      check(T('the role change is applied'), (await page.textContent('#accounts-list')).includes('Prioritas'), await page.textContent('#accounts-list'));
      // reset password
      await page.click('[data-action="reset-password"]');
      await page.fill('#rp-password', 'Pendek1'); await page.fill('#rp-password2', 'Pendek1');
      await page.click('#modal [type="submit"]');
      check(T('too-short password is refused inline'), (await page.textContent('#modal-error')).includes('minimal'));
      await page.click('[data-action="gen-password"][data-prefix="rp"]');
      await page.click('#modal [type="submit"]');
      await waitToast(page, /diatur ulang/);
      check(T('password reset confirmed'), (await page.textContent('#toast-region')).includes('diatur ulang'));
      // delete
      await page.click('[data-action="delete-account"]');
      check(T('delete stays disabled until the email is typed'), await page.evaluate(() => document.getElementById('del-submit').disabled));
      await page.screenshot({ path: path.join(SHOTS, `delete-dialog-${vp.name}.png`) });
      audit = await page.evaluate(buttonAudit, '#modal'); check(T('button audit: delete dialog'), audit.problems.length === 0, audit.problems.join(' || '));
      await page.fill('#del-confirm', 'baru.uji@contoh.id');
      await page.click('#del-submit');
      await waitToast(page, /Akun dihapus/);
      check(T('delete reports the photo cleanup'), /Foto: \d+ dibersihkan, \d+ menunggu, \d+ perlu ditinjau|Tidak ada foto di server/.test(await page.textContent('#toast-region')), await page.textContent('#toast-region'));
      check(T('the header stays one compact row'), await page.evaluate(() => { const h = document.querySelector('.a-header'); const t = h.querySelector('h1'); return h.getBoundingClientRect().height <= 80 && t.scrollHeight <= t.clientHeight + 1; }), await page.evaluate(() => document.querySelector('.a-header').getBoundingClientRect().height));
      await page.fill('#account-search', '');

      // ---------------------------------------------------------- settings
      await page.click('#tab-settings');
      await page.waitForSelector('#settings-form');
      await page.screenshot({ path: path.join(SHOTS, `settings-${vp.name}.png`), fullPage: true });
      v = await axeRun(page); check(T('axe: settings has no violations'), v.length === 0, JSON.stringify(v));
      audit = await page.evaluate(buttonAudit, 'body'); check(T('button audit: settings'), audit.problems.length === 0, audit.problems.join(' || '));
      check(T('secret hint shows at most 2 characters'), /\(••••[a-z0-9]{2}\)/i.test(await page.textContent('#set-NINEROUTER_KEY-state')) || /\(••••\)/.test(await page.textContent('#set-NINEROUTER_KEY-state')), await page.textContent('#set-NINEROUTER_KEY-state'));
      check(T('save is disabled until something changes'), await page.evaluate(() => document.getElementById('settings-save').disabled));
      // The backend is shared by both viewports: pick a draft address that differs from what is stored now.
      const storedUrl = await page.evaluate(async () => (await (await fetch('/api/admin/settings')).json()).settings.find((s) => s.key === 'NINEROUTER_URL').value);
      const draftUrl = storedUrl === `http://127.0.0.1:${router.port}` ? `http://localhost:${router.port}` : `http://127.0.0.1:${router.port}`;
      const hitsBefore = router.state.hits.length;
      await page.fill('#set-NINEROUTER_URL', draftUrl);
      check(T('changing the router address asks for the password'), await page.isVisible('#settings-reauth'));
      await page.click('[data-action="test-router"]');
      await page.waitForSelector('#router-test .notice-ok', { timeout: 30000 });
      const apiSettings = await page.evaluate(async () => (await (await fetch('/api/admin/settings')).json()).settings.find((s) => s.key === 'NINEROUTER_URL').value);
      check(T('testing the DRAFT router works without saving it'), apiSettings === storedUrl && router.state.hits.slice(hitsBefore).some((h) => h.url === '/v1/models'), apiSettings + ' (stored before: ' + storedUrl + ')');
      await page.click('#settings-save');
      check(T('saving without the password is stopped inline'), (await page.textContent('#settings-error')).includes('kata sandi'), await page.textContent('#settings-error'));
      await page.fill('#set-NINEROUTER_URL', 'http://evil.example.com');
      await page.fill('#settings-reauth', ADMIN_PW);
      await page.click('#settings-save');
      await page.waitForSelector('#settings-error:not([hidden])');
      check(T('a foreign router host is refused with the Bahasa reason'), (await page.textContent('#settings-error')).includes('tidak diizinkan'), await page.textContent('#settings-error'));
      await page.fill('#set-NINEROUTER_URL', draftUrl);
      await page.fill('#settings-reauth', ADMIN_PW);
      await page.click('#settings-save');
      await waitToast(page, /tersimpan/);
      check(T('router address saved with the password'), (await page.textContent('#toast-region')).includes('tersimpan'));
      await page.click('[data-action="clear-secret"][data-id="GEOCODE_API_KEY"]').catch(() => {});
      await page.screenshot({ path: path.join(SHOTS, `settings-after-${vp.name}.png`), fullPage: true });

      // ---------------------------------------------------------- queue
      await page.click('#tab-queue');
      await page.waitForSelector('#queue-list .rtable');
      await page.screenshot({ path: path.join(SHOTS, `queue-${vp.name}.png`), fullPage: true });
      v = await axeRun(page); check(T('axe: queue has no violations'), v.length === 0, JSON.stringify(v));
      audit = await page.evaluate(buttonAudit, 'body'); check(T('button audit: queue'), audit.problems.length === 0, audit.problems.join(' || '));
      check(T('queue rows offer only the actions that are allowed'), await page.evaluate(() => [...document.querySelectorAll('#queue-list tbody tr')].every((tr) => {
        const t = tr.textContent; const requeue = !!tr.querySelector('[data-action="job-requeue"]'), cancel = !!tr.querySelector('[data-action="job-cancel"]');
        if (/Selesai/.test(t)) return !requeue && !cancel; if (/Menunggu/.test(t)) return !requeue && cancel; if (/Ditolak/.test(t)) return requeue && !cancel; return true; })));
      await page.click('[data-action="queue-filter"][data-status="problem"]');
      await page.waitForFunction(() => [...document.querySelectorAll('#queue-list tbody tr')].every((tr) => /Ditolak|Gagal/.test(tr.textContent)) && document.querySelectorAll('#queue-list tbody tr').length >= 1, null, {timeout:8000}).catch(async error=>{
        throw new Error('Queue filter did not settle: '+await page.locator('#queue-list').innerText()+'; '+error.message);
      });
      check(T('the "Bermasalah" chip filters rejected/failed jobs'), (await page.getAttribute('[data-action="queue-filter"][data-status="problem"]', 'aria-pressed')) === 'true');
      await page.click('[data-action="job-requeue"]');
      check(T('requeue asks for confirmation first'), (await page.getAttribute('#modal .dialog', 'role')) === 'alertdialog');
      await page.screenshot({ path: path.join(SHOTS, `requeue-confirm-${vp.name}.png`) });
      await page.click('[data-action="confirm-yes"]');
      await waitToast(page, /dikembalikan|tidak bisa|Pekerjaan ini/);
      check(T('requeue works for a rejected job'), (await page.textContent('#toast-region')).includes('dikembalikan'), await page.textContent('#toast-region'));
      await page.click('[data-action="queue-filter"][data-status="queued"]');
      await page.waitForSelector('[data-action="job-cancel"]');
      await page.click('[data-action="job-cancel"]');
      await page.fill('#cancel-reason', 'Uji batal ' + 'x'.repeat(10));
      await page.click('#modal [type="submit"]');
      await page.waitForFunction(() => document.getElementById('modal').hidden);
      await page.click('[data-action="queue-filter"][data-status=""]');
      await page.waitForSelector('[data-action="job-trace"]');
      await page.click('[data-action="job-trace"]');
      await page.waitForSelector('#trace-body .kv');
      check(T('job trace opens in a dialog'), (await page.textContent('#trace-body')).includes('Status'));
      await page.keyboard.press('Escape');

      // ---------------------------------------------------------- audit
      await page.click('#tab-audit');
      await page.waitForSelector('#audit-list .rtable');
      const auditText = await page.textContent('#audit-list');
      check(T('routine sign-in/out rows are hidden by default'), !/>Masuk<|\bMasuk\b.*account\.login/.test(auditText) && (await page.locator('#audit-list [title="account.login"]').count()) === 0);
      check(T('the audit shows old -> new values'), auditText.includes('peran: Normal -> Prioritas'), auditText.slice(0, 200));
      await page.screenshot({ path: path.join(SHOTS, `audit-${vp.name}.png`), fullPage: true });
      v = await axeRun(page); check(T('axe: audit has no violations'), v.length === 0, JSON.stringify(v));
      audit = await page.evaluate(buttonAudit, 'body'); check(T('button audit: audit'), audit.problems.length === 0, audit.problems.join(' || '));
      await page.check('#audit-routine');
      await page.waitForFunction(() => document.querySelector('#audit-list [title="account.login"]'));
      check(T('the toggle brings sign-in/out rows back'), true);
      await page.selectOption('#audit-action', 'account.update');
      await page.waitForFunction(() => { const b = [...document.querySelectorAll('#audit-list tbody [title]')]; return b.length >= 1 && b.every((x) => x.title === 'account.update'); });
      check(T('filter by action type'), (await page.locator('#audit-list tbody tr').count()) >= 1);
      await page.selectOption('#audit-action', ''); await page.uncheck('#audit-routine');
      await page.waitForFunction(() => document.querySelectorAll('#audit-list tbody tr').length >= 50 && document.querySelector('[data-action="audit-more"]'));
      check(T('audit pagination: "Muat lebih banyak" appears and appends'), await (async () => { const before = await page.locator('#audit-list tbody tr').count(); await page.click('[data-action="audit-more"]'); await page.waitForFunction((n) => document.querySelectorAll('#audit-list tbody tr').length > n, before); return true; })());

      // ---------------------------------------------------------- session expiry clears everything
      await page.click('#tab-accounts');
      await page.waitForSelector('#accounts-list .rtable');
      await page.click('[data-action="edit-account"]');
      await context.clearCookies();
      await page.click('#modal [type="submit"]').catch(() => {});
      await page.click('[data-action="tab"][data-tab="queue"]', { timeout: 2000 }).catch(() => {});
      await page.evaluate(() => switchTab('queue'));
      await page.waitForSelector('#login-view:not([hidden])');
      const cleared = await page.evaluate(() => ({ modal: document.getElementById('modal').hidden, panels: ['overview', 'accounts', 'settings', 'queue', 'audit'].every((k) => document.getElementById('panel-' + k).innerHTML.trim() === ''), accounts: ACCOUNTS.length, me: ME, notice: document.getElementById('login-notice').textContent, views: ['boot-view', 'denied-view', 'console-view'].every((id) => document.getElementById(id).hidden) }));
      check(T('session expiry closes the dialog, clears cached data and says why'), cleared.modal && cleared.panels && cleared.accounts === 0 && cleared.me === null && /Sesi Anda berakhir/.test(cleared.notice) && cleared.views, JSON.stringify(cleared));

      check(T('zero CSP violations'), (await page.evaluate(() => window.__csp)).length === 0 && consoleCsp.length === 0, JSON.stringify(await page.evaluate(() => window.__csp)) + consoleCsp.join('|'));
      check(T('no request left this origin'), external.length === 0, external.join(', '));
      check(T('no stylesheet/script/font failed to load'), badAssets.length === 0, badAssets.join(', '));
      check(T('no uncaught page errors'), pageErrors.length === 0, pageErrors.join(' | '));
      await context.close();
    }

    // ---------------------------------------------------------- polling pause (fake clock) + focus kept
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.clock.install();
      let queueCalls = 0;
      page.on('request', (r) => { if (/\/api\/admin\/queue\?/.test(r.url())) queueCalls++; });
      await page.goto(base + '/admin', { waitUntil: 'networkidle' });
      await page.fill('#login-email', ADMIN_EMAIL); await page.fill('#login-password', ADMIN_PW);
      await page.click('#login-form [type="submit"]');
      await page.waitForSelector('#console-view:not([hidden])');
      await page.click('#tab-queue');
      await page.waitForSelector('#queue-list .rtable');
      await page.focus('[data-action="queue-refresh"]');
      const start = queueCalls;
      await page.clock.fastForward(10500); await page.waitForTimeout(400);
      check('queue polls every 10 s while the tab is visible', queueCalls === start + 1, `${start} -> ${queueCalls}`);
      check('a background refresh keeps the focus on the same button', await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'queue-refresh'));
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      const hiddenStart = queueCalls;
      await page.clock.fastForward(60000); await page.waitForTimeout(400);
      check('polling is paused while the tab is hidden', queueCalls === hiddenStart, `${hiddenStart} -> ${queueCalls}`);
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForTimeout(500);
      check('coming back refreshes once and polling resumes', queueCalls === hiddenStart + 1, `${hiddenStart} -> ${queueCalls}`);
      await page.clock.fastForward(10500); await page.waitForTimeout(400);
      check('polling resumed after the tab came back', queueCalls === hiddenStart + 2, `${queueCalls}`);
      await page.uncheck('#queue-auto');
      const offStart = queueCalls;
      await page.clock.fastForward(30000); await page.waitForTimeout(300);
      check('"Segarkan otomatis" off stops polling', queueCalls === offStart);
      await context.close();
    }
  } catch (error) {
    check('harness ran to completion', false, error && error.stack || error);
  } finally {
    await browser.close();
    router.server.close();
    if (backend) { backend.server.kill('SIGTERM'); await sleep(500); try { fs.rmSync(backend.folder, { recursive: true, force: true }); } catch (e) { /* temp */ } }
    const failed = checks.filter((c) => !c.ok);
    fs.writeFileSync(path.resolve(__dirname, '../admin-0220-results.json'), JSON.stringify({ scope: 'Disposable backend, synthetic data, no production', passed: checks.length - failed.length, total: checks.length, checks }, null, 2));
    console.log(`admin-0220: ${checks.length - failed.length}/${checks.length} checks passed`);
    failed.forEach((c) => console.log('  FAILED:', c.name, '::', c.detail || ''));
    process.exitCode = failed.length ? 1 : 0;
  }
})();
