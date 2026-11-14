#!/usr/bin/env node
/*
 * 0.2.3.0 "Masuk dengan Google" + admin registration inbox — real Chromium against DISPOSABLE backends
 * (synthetic data only, never production, nothing fetched from Google).
 *
 *   G1 disabled server (no GOOGLE_CLIENT_ID): no Google block, no request to accounts.google.com, CSP unchanged.
 *   G2 enabled server: the block and Google's button appear on the sign-in card; GIS is loaded once, lazily, with a
 *      server nonce; the CSP admits only the GIS paths.
 *   G3 an unknown Google account gets the pending message ("Permintaan masuk sudah dikirim. ...").
 *   G4 admin console "Pendaftaran": lists both requests, Setujui / Tolak ask for the admin password, the card empties.
 *   G5 the approved person then signs in with Google; the rejected one sees the rejection message.
 *   G6 Android path (google-signin.js in a VM with a stub Capacitor plugin): serverClientId + nonce go to
 *      JagaSync.googleSignIn, the idToken is posted; cancel is silent, no-credential has its own message.
 *   G7 no console errors, no page errors and no CSP violations on any page.
 *
 * GIS is mocked by routing https://accounts.google.com/gsi/client to a stub whose button asks the harness (over a
 * routed https://accounts.google.com/gsi/__mint URL) for an ID token signed with the backend's test key.
 *
 *   node google-0230.cjs [--chrome /usr/bin/google-chrome]      (needs PY = python with the backend deps)
 * Exit code 1 when a check fails.
 */
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), vm = require('vm'), crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const CHROME = arg('chrome', process.env.JK_CHROME || '/usr/bin/google-chrome');
const ROOT = path.resolve(__dirname, '../..');
const PY = process.env.JK_TEST_PYTHON || process.env.PY || 'python3';
const ADMIN_EMAIL = 'admin@jagakebond.local';
const ADMIN_PW = 'AdminLokal123';
const CLIENT_ID = '424242-harness.apps.googleusercontent.test';
const PENDING = 'Permintaan masuk sudah dikirim. Tunggu persetujuan admin.';
const REJECTED = 'Permintaan masuk Anda ditolak admin. Hubungi admin bila ini keliru.';
const PEOPLE = {
  setuju: { sub: '110000000000000000001', email: 'setuju@example.test', name: 'Pak Setuju' },
  tolak: { sub: '110000000000000000002', email: 'tolak@example.test', name: 'Bu Tolak' },
};

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 600))); }
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/* ------------------------------------------------------------------ disposable backends */
async function startBackend(label, googleClientId) {
  const folder = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jk-google0230-' + label + '-'));
  const app = path.join(folder, 'app');
  const skip = new Set(['data', '.env', 'venv', '.git', '__pycache__', 'node_modules']);
  fs.cpSync(path.join(ROOT, 'app'), app, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  const port = await freePort();
  const keyFile = path.join(folder, 'key.pem');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || folder, TMPDIR: process.env.TMPDIR || folder, LANG: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1', COOKIE_SECURE: '0', SECRET_KEY: 'synthetic-google-0230-browser-key', WORKER_TOKEN: 'dev-local-worker-token-0230-abcdefgh',
    ADMIN_EMAIL, ADMIN_PASSWORD: ADMIN_PW, ALLOW_REGISTRATION: '0', SEED_DEMO_DATA: '0', NINEROUTER_KEY: '', NINEROUTER_URL: 'http://127.0.0.1:9' };
  if (googleClientId) env.GOOGLE_CLIENT_ID = googleClientId;
  const log = fs.openSync(path.join(folder, 'server.log'), 'w');
  const server = spawn(PY, [path.join(__dirname, 'google-0230-server.py'), app, keyFile, String(port)], { cwd: app, env, stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
    if (server.exitCode !== null) throw new Error('backend exited: ' + fs.readFileSync(path.join(folder, 'server.log'), 'utf8').slice(-800));
    await sleep(150);
  }
  return { base, server, folder, key: fs.readFileSync(keyFile, 'utf8') };
}

function mint(key, nonce, who) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'RS256', kid: 'harness-0230', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: who.sub, email: who.email,
    email_verified: true, name: who.name, nonce, iat: now, exp: now + 3600 }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + body), key);
  return header + '.' + body + '.' + b64u(signature);
}

/* The GIS stand-in: same API surface the page uses (initialize + renderButton), a plain button that fetches a
   token for window.__gsiWho and hands it to the callback exactly like Google would. */
const GSI_STUB = `(function () {
  var config = null;
  window.__gsi = { inits: 0, renders: 0 };
  window.google = { accounts: { id: {
    initialize: function (c) { config = c; window.__gsi.inits++; window.__gsi.nonce = c.nonce; window.__gsi.clientId = c.client_id; },
    renderButton: function (el, opts) {
      window.__gsi.renders++; window.__gsi.opts = opts;
      var b = document.createElement('button'); b.type = 'button'; b.id = 'gsi-stub-button'; b.className = 'btn btn-secondary btn-block';
      b.textContent = 'Masuk dengan Google';
      b.addEventListener('click', function () {
        var nonce = config.nonce;
        fetch('https://accounts.google.com/gsi/__mint?who=' + encodeURIComponent(window.__gsiWho || '') + '&nonce=' + encodeURIComponent(nonce))
          .then(function (r) { return r.text(); }).then(function (token) { config.callback({ credential: token, select_by: 'btn' }); });
      });
      el.appendChild(b);
    },
  } } };
})();`;

async function newContext(browser, backend, record) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block', locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  });
  await context.route(/^https:\/\//, (route) => {
    const url = new URL(route.request().url());
    record.external.push(url.origin + url.pathname);
    if (url.origin === 'https://accounts.google.com' && url.pathname === '/gsi/client') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: GSI_STUB });
    }
    if (url.origin === 'https://accounts.google.com' && url.pathname === '/gsi/__mint') {
      const who = PEOPLE[url.searchParams.get('who')];
      return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' },
        body: who ? mint(backend.key, url.searchParams.get('nonce'), who) : 'no-such-person' });
    }
    return route.abort();
  });
  return context;
}

/* Chromium logs every 4xx answer as "Failed to load resource". Two refusals are part of the script (the wrong admin
   password and the rejected person); they are counted separately and must be exactly those two. */
const EXPECTED_REFUSALS = [/\/api\/admin\/registrations\/[^/]+\/approve$/, /\/api\/auth\/google$/];
function watch(page, record) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = (msg.location() && msg.location().url) || '';
    const refusal = /^Failed to load resource: the server responded with a status of 403/.test(msg.text())
      && EXPECTED_REFUSALS.some((re) => re.test(where.split('?')[0]));
    (refusal ? (record.refusals = record.refusals || []) : record.console).push(msg.text().slice(0, 200) + ' @ ' + where);
  });
  page.on('pageerror', (e) => record.pageErrors.push(String(e.message).slice(0, 300)));
}
const gateOpen = (page) => page.evaluate(() => !document.getElementById('auth-gate').classList.contains('hidden'));
const noticeText = (page) => page.evaluate(() => { const n = document.getElementById('google-notice'); return n && !n.hidden ? n.textContent.trim() : ''; });

async function openField(context, backend, record) {
  const page = await context.newPage();
  watch(page, record);
  const response = await page.goto(backend.base + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.session === 'signed-out' || (!document.getElementById('auth-gate').classList.contains('hidden')), null, { timeout: 15000 }).catch(() => undefined);
  return { page, response };
}

async function googleClick(page, who, expectText) {
  await page.evaluate((w) => { window.__gsiWho = w; }, who);
  await page.waitForSelector('#gsi-stub-button', { timeout: 10000 });
  await page.click('#gsi-stub-button');
  if (expectText) await page.waitForFunction((t) => { const n = document.getElementById('google-notice'); return n && !n.hidden && n.textContent.trim() === t; }, expectText, { timeout: 10000 });
}

/* ------------------------------------------------------------------ G6: the Android path, without a phone */
async function nativePath() {
  const source = fs.readFileSync(path.join(ROOT, 'app/frontend/google-signin.js'), 'utf8');
  const make = (pluginBehaviour) => {
    const elements = {};
    const element = (id) => elements[id] || (elements[id] = { id, hidden: true, disabled: false, className: '', textContent: '', attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, fn) { this['on' + type] = fn; } });
    ['google-signin', 'google-button', 'google-native-button', 'google-notice'].forEach(element);
    const calls = { api: [], plugin: [], signedIn: null };
    const root = {
      document: { readyState: 'complete', getElementById: (id) => elements[id] || null, head: { appendChild() { throw new Error('no GIS script on Android'); } } },
      addEventListener() {}, setTimeout, clearTimeout, Promise, Date, Math, Number, String, Error,
      Capacitor: { isNativePlatform: () => true, Plugins: { JagaSync: { googleSignIn: async (opts) => { calls.plugin.push(opts); return pluginBehaviour(opts); } } } },
      api: async (p, o) => {
        calls.api.push({ path: p, body: o && o.body });
        if (p === '/api/auth/google/config') return { enabled: true, clientId: CLIENT_ID };
        if (p === '/api/auth/google/nonce') return { nonce: 'native-nonce-' + calls.api.length + '-abcdefghijkl', expiresMs: Date.now() + 600000 };
        if (p === '/api/auth/google') return o.body.credential === 'token-ok' ? { ok: true, account: { id: 'acct_native' }, csrf: 'c' } : { ok: false, code: 'registration_pending' };
        throw new Error('unexpected ' + p);
      },
      afterSignIn: async (account) => { calls.signedIn = account.id; },
      userMessage: (error, fallback) => fallback,
    };
    root.window = root;
    vm.runInNewContext(source, root);
    return { root, elements, calls };
  };
  const tick = () => new Promise((r) => setTimeout(r, 20));

  const ok = make(async () => ({ idToken: 'token-ok' }));
  await ok.root.JagaGoogle.onGate(true);
  check('G6 Android: the native button is shown (no web GIS script)', ok.elements['google-signin'].hidden === false && ok.elements['google-native-button'].hidden === false);
  await ok.elements['google-native-button'].onclick(); await tick();
  const nonceCall = ok.calls.api.find((c) => c.path === '/api/auth/google/nonce');
  const post = ok.calls.api.find((c) => c.path === '/api/auth/google');
  check('G6 Android: googleSignIn gets serverClientId = the web client id and the server nonce',
    ok.calls.plugin.length === 1 && ok.calls.plugin[0].serverClientId === CLIENT_ID && /^native-nonce-/.test(ok.calls.plugin[0].nonce) && !!nonceCall, ok.calls.plugin);
  check('G6 Android: the idToken and the same nonce are posted, then the app signs in',
    post && post.body.credential === 'token-ok' && post.body.nonce === ok.calls.plugin[0].nonce && ok.calls.signedIn === 'acct_native', post);

  const pending = make(async () => ({ idToken: 'token-new-person' }));
  await pending.root.JagaGoogle.onGate(true);
  await pending.elements['google-native-button'].onclick(); await tick();
  check('G6 Android: a new person sees the pending message', pending.elements['google-notice'].textContent === PENDING && pending.calls.signedIn === null);

  const cancelled = make(async () => { const e = new Error('cancelled'); e.code = 'google_cancelled'; throw e; });
  await cancelled.root.JagaGoogle.onGate(true);
  await cancelled.elements['google-native-button'].onclick(); await tick();
  check('G6 Android: cancelling the Google sheet shows nothing and posts nothing',
    cancelled.elements['google-notice'].hidden === true && !cancelled.calls.api.some((c) => c.path === '/api/auth/google') && cancelled.elements['google-native-button'].disabled === false);

  const none = make(async () => { const e = new Error('none'); e.code = 'google_no_credential'; throw e; });
  await none.root.JagaGoogle.onGate(true);
  await none.elements['google-native-button'].onclick(); await tick();
  check('G6 Android: no Google account on the phone has its own message',
    /Belum ada akun Google di HP ini/.test(none.elements['google-notice'].textContent) && none.elements['google-notice'].hidden === false, none.elements['google-notice'].textContent);

  const old = make(async () => ({}));
  delete old.root.Capacitor.Plugins.JagaSync.googleSignIn;
  await old.root.JagaGoogle.onGate(true);
  check('G6 Android: an APK without googleSignIn shows no Google button', old.elements['google-signin'].hidden === true);
}

/* ------------------------------------------------------------------ main */
(async () => {
  let off, on, browser;
  const record = { console: [], pageErrors: [], external: [] };
  try {
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    [off, on] = await Promise.all([startBackend('off', ''), startBackend('on', CLIENT_ID)]);

    /* ---------------- G1 disabled */
    {
      const rec = { console: [], pageErrors: [], external: [] };
      const context = await newContext(browser, off, rec);
      const { page, response } = await openField(context, off, rec);
      await sleep(800);
      const csp = response.headers()['content-security-policy'] || '';
      check('G1 disabled: the sign-in card shows no Google block', await page.evaluate(() => document.getElementById('google-signin').hidden === true
        && getComputedStyle(document.getElementById('google-signin')).display === 'none'));
      check('G1 disabled: nothing was requested from accounts.google.com', !rec.external.some((u) => u.includes('accounts.google.com')), rec.external);
      check('G1 disabled: the CSP does not mention Google', csp && !csp.includes('accounts.google.com'), csp);
      check('G1 disabled: no console/page errors or CSP violations',
        !rec.console.length && !rec.pageErrors.length && !(await page.evaluate(() => window.__csp.length)), { c: rec.console, p: rec.pageErrors, csp: await page.evaluate(() => window.__csp) });
      await context.close();
    }

    /* ---------------- G2 + G3 enabled, unknown people */
    const context = await newContext(browser, on, record);
    const { page, response } = await openField(context, on, record);
    await page.waitForSelector('#gsi-stub-button', { timeout: 15000 });
    const csp = response.headers()['content-security-policy'] || '';
    check('G2 enabled: the CSP admits the GIS script, frame, style and connect paths only',
      csp.includes("script-src 'self' https://accounts.google.com/gsi/client;") && csp.includes('frame-src') && csp.includes('https://accounts.google.com/gsi/style')
      && csp.includes("connect-src 'self' data: blob: https://accounts.google.com/gsi/;"), csp);
    check('G2 enabled: COOP lets Google\'s popup report back', response.headers()['cross-origin-opener-policy'] === 'same-origin-allow-popups', response.headers()['cross-origin-opener-policy']);
    const g = await page.evaluate(() => ({ block: !document.getElementById('google-signin').hidden, inits: window.__gsi.inits, renders: window.__gsi.renders,
      nonce: window.__gsi.nonce, clientId: window.__gsi.clientId, opts: window.__gsi.opts, divider: document.querySelector('.google-divider').textContent.trim(),
      scripts: [...document.querySelectorAll('script[src*="accounts.google.com"]')].length,
      inCard: !!document.querySelector('#auth-form + #google-signin #gsi-stub-button') }));
    check('G2 enabled: Google\'s button is drawn on the sign-in card, under the form, after "atau"', g.block && g.inCard && g.divider === 'atau', g);
    check('G2 enabled: GIS is loaded once and initialised with the client id and a server nonce',
      g.scripts === 1 && g.inits === 1 && g.renders === 1 && g.clientId === CLIENT_ID && typeof g.nonce === 'string' && g.nonce.length >= 32, g);
    check('G2 enabled: button options (Indonesian, pill corners, fits the card)', g.opts && g.opts.locale === 'id' && g.opts.shape === 'pill' && g.opts.width >= 200 && g.opts.width <= 400, g.opts);

    await googleClick(page, 'setuju', PENDING);
    check('G3 an unknown Google account gets the pending message and stays signed out', (await noticeText(page)) === PENDING && await gateOpen(page));
    const after = await page.evaluate(() => ({ inits: window.__gsi.inits, nonce: window.__gsi.nonce }));
    check('G3 the button is set up again with a NEW nonce (nonces are single use)', after.inits === 2 && after.nonce !== g.nonce, after);
    await googleClick(page, 'tolak', PENDING);

    /* ---------------- G4 admin inbox */
    const adminPage = await context.newPage();
    watch(adminPage, record);
    await adminPage.goto(on.base + '/admin', { waitUntil: 'networkidle' });
    await adminPage.fill('#login-email', ADMIN_EMAIL);
    await adminPage.fill('#login-password', ADMIN_PW);
    await adminPage.click('#login-form [type="submit"]');
    await adminPage.waitForSelector('#console-view:not([hidden])');
    const quick = await adminPage.waitForSelector('[data-action="goto-tab"][data-tab="accounts"]', { timeout: 10000 }).then((el) => el.textContent()).catch(() => '');
    check('G4 Beranda links to the waiting requests', /Pendaftaran menunggu: 2/.test(quick), quick);
    await adminPage.click('#tab-accounts');
    await adminPage.waitForSelector('#registrations .reg-list li');
    const list = await adminPage.evaluate(() => ({ rows: [...document.querySelectorAll('#registrations .reg-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
      title: document.getElementById('regs-title').textContent }));
    check('G4 "Pendaftaran" lists both requests with name, email and time',
      list.title === 'Pendaftaran' && list.rows.length === 2 && list.rows.some((r) => r.includes('Pak Setuju') && r.includes('setuju@example.test') && r.includes('minta masuk'))
      && list.rows.some((r) => r.includes('Bu Tolak')), list);
    await adminPage.click('[data-action="reg-approve"][aria-label="Setujui setuju@example.test"]');
    await adminPage.waitForSelector('#modal:not([hidden]) form[data-form="registration"]');
    const dialog = await adminPage.evaluate(() => ({ title: document.getElementById('modal-title').textContent, pw: !!document.getElementById('rg-reauth'),
      modal: document.querySelector('#modal .dialog').getAttribute('aria-modal') }));
    check('G4 Setujui opens a dialog that asks for the admin password', dialog.title === 'Setujui pendaftaran?' && dialog.pw && dialog.modal === 'true', dialog);
    await adminPage.click('#modal [type="submit"]');
    const missing = await adminPage.waitForSelector('#modal-error:not([hidden])').then((el) => el.textContent());
    check('G4 without the password nothing is sent', /kata sandi Anda/.test(missing), missing);
    await adminPage.fill('#rg-reauth', 'salah-sekali-123');
    await adminPage.click('#modal [type="submit"]');
    const wrong = await adminPage.waitForFunction(() => { const e = document.getElementById('modal-error'); return e && !e.hidden && /salah/i.test(e.textContent) && e.textContent; }).then((h) => h.jsonValue());
    check('G4 a wrong password is refused by the server', /salah/i.test(wrong), wrong);
    await adminPage.fill('#rg-reauth', ADMIN_PW);
    await adminPage.click('#modal [type="submit"]');
    await adminPage.waitForFunction(() => /Disetujui/.test(document.getElementById('toast-region').textContent));
    await adminPage.waitForFunction(() => document.querySelectorAll('#registrations .reg-list li').length === 1);
    const linked = await adminPage.waitForFunction(() => [...document.querySelectorAll('#accounts-list tr')].some((tr) => tr.textContent.includes('setuju@example.test') && tr.textContent.includes('Google')), null, { timeout: 10000 }).then(() => true).catch(() => false);
    check('G4 approving creates the account (marked Google in the list) and removes the request', linked);
    await adminPage.click('[data-action="reg-reject"][aria-label="Tolak tolak@example.test"]');
    await adminPage.waitForSelector('#modal:not([hidden]) form[data-decision="reject"]');
    const danger = await adminPage.evaluate(() => document.querySelector('#modal [type="submit"]').className);
    await adminPage.fill('#rg-reauth', ADMIN_PW);
    await adminPage.click('#modal [type="submit"]');
    await adminPage.waitForFunction(() => /ditolak/.test(document.getElementById('toast-region').textContent));
    const empty = await adminPage.waitForFunction(() => /Tidak ada permintaan baru/.test(document.getElementById('registrations').textContent)).then(() => true).catch(() => false);
    check('G4 Tolak is a red action and leaves "Tidak ada permintaan baru."', /btn-danger-solid/.test(danger) && empty, danger);
    check('G4 admin console: no CSP violations under its strict policy', (await adminPage.evaluate(() => window.__csp.length)) === 0, await adminPage.evaluate(() => window.__csp));
    const adminCsp = await adminPage.evaluate(async () => (await fetch('/admin')).headers.get('content-security-policy'));
    check('G4 /admin keeps its strict CSP (no Google)', adminCsp && !adminCsp.includes('google'), adminCsp);
    await adminPage.close();

    /* ---------------- G5 the decisions as the field app sees them */
    await googleClick(page, 'setuju');
    await page.waitForFunction(() => /^ready:/.test(document.documentElement.dataset.session || ''), null, { timeout: 20000 });
    const signed = await page.evaluate(() => ({ gate: !document.getElementById('auth-gate').classList.contains('hidden'), who: JagaAppAccount() && JagaAppAccount().email }));
    check('G5 the approved person signs in with Google', !signed.gate && signed.who === 'setuju@example.test', signed);
    const wasSignedIn = await page.evaluate(() => document.getElementById('auth-gate').classList.contains('hidden'));
    await page.evaluate(() => logout());
    await page.waitForFunction(() => document.documentElement.dataset.session === 'signed-out');
    await page.waitForSelector('#gsi-stub-button', { timeout: 10000 });
    await googleClick(page, 'tolak', REJECTED);
    check('G5 the rejected person sees the rejection message and stays out', wasSignedIn && (await noticeText(page)) === REJECTED && await gateOpen(page));
    const radius = await page.evaluate(() => [...document.querySelectorAll('#google-signin, #google-signin *')].filter((el) => {
      const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return false;
      const v = parseFloat(getComputedStyle(el).borderTopLeftRadius); return v && ![8, 11, 12].includes(v) && v < Math.min(r.width, r.height) / 2 - 0.5;
    }).map((el) => el.id || el.className));
    check('G5 the Google block follows the 12 / 8 corner rule', radius.length === 0, radius);

    check('G7 field app: no CSP violations', (await page.evaluate(() => window.__csp.length)) === 0, await page.evaluate(() => window.__csp));
    await page.close();
    await context.close();

    /* ---------------- G6 Android */
    await nativePath();

    const gsiLoads = record.external.filter((u) => u === 'https://accounts.google.com/gsi/client').length;
    check('G7 GIS script fetched once per page load (2 field-app loads)', gsiLoads <= 2 && gsiLoads >= 1, gsiLoads);
    check('G7 no console errors and no page errors (besides the two scripted 403 refusals)',
      !record.console.length && !record.pageErrors.length && (record.refusals || []).length === 2, { console: record.console, page: record.pageErrors, refusals: record.refusals });
  } catch (error) {
    check('harness ran to the end', false, String(error && error.stack || error).slice(0, 800));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const b of [off, on]) if (b) { b.server.kill('SIGTERM'); fs.rmSync(b.folder, { recursive: true, force: true }); }
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\ngoogle-0230: ${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
