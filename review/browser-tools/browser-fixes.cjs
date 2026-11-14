const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../browser-tools/node_modules/playwright');

const base = __dirname;
const root = process.env.JK_FRONTEND || path.resolve(base, '../../app/frontend');
const evidence = process.env.JK_AUDIT_BROWSER_EVIDENCE || path.join(base, 'browser-fixes');
fs.mkdirSync(evidence, { recursive: true });
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://fixture').pathname); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404).end(); }
});

(async () => {
  let browser;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });

    // Native cancel path: real adapter and application api wrapper, synthetic JagaSync.
    {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/^https:\/\//, route => route.abort());
      await page.addInitScript(() => {
        const draft = { accountId: 'native-fixture-account', clientRequestId: 'draft-fixture-01', jobId: 'job-fixture-01', status: 'submitted', createdMs: 1, fields: { cropHint: 'Fixture crop' } };
        window.__fixtureCalls = [];
        window.__fixtureDraftRemoved = false;
        const job = { id: draft.jobId, status: 'queued', context: { cropHint: 'Fixture crop' } };
        const response = (path, method) => {
          if (path === '/api/auth/me') return { status: 200, body: { ok: true, account: { id: draft.accountId, name: 'Synthetic Native', role: 'user' } } };
          if (path === '/api/health') return { status: 200, body: { ok: true, version: 'fixture' } };
          if (path === '/api/queue/pending') return { status: 200, body: [job] };
          if (path === '/api/analyze/' + draft.jobId + '/cancel' && method === 'POST') return { status: 200, body: { ...job, status: 'cancelled' } };
          if (path === '/api/analyze/' + draft.jobId + '/ack' && method === 'POST') return { status: 200, body: { ok: true } };
          if (path === '/api/analyze/' + draft.jobId) return { status: 200, body: job };
          return { status: 200, body: [] };
        };
        window.androidBridge = { postMessage() {} };
        window.Capacitor = { Plugins: { JagaSync: {
          request: async options => { window.__fixtureCalls.push({ type: 'request', path: options.path, method: options.method }); return response(options.path, options.method || 'GET'); },
          activate: async () => ({ ok: true }), lock: async () => ({ ok: true }),
          list: async options => { window.__fixtureCalls.push({ type: 'list', accountId: options.accountId }); return { drafts: window.__fixtureDraftRemoved ? [] : [{ ...draft }] }; },
          enqueue: async () => ({ ok: true }),
          remove: async options => { window.__fixtureCalls.push({ type: 'remove', accountId: options.accountId, clientRequestId: options.clientRequestId }); window.__fixtureDraftRemoved = true; return { ok: true }; }
        } } };
      });
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => JagaAppAccount() && JagaNative?.isNative());
      await page.evaluate(() => JagaOfflineSync.stop());
      await page.evaluate(() => navigateToMenu('log'));
      const discard = page.locator('[data-discard-draft="draft-fixture-01"]');
      await discard.waitFor({ state: 'attached', timeout: 10000 });
      // 0.2.2.0 (UX brief D1): drafts live in a compact strip (expand it first); rare actions such as
      // "Hapus" sit in each row's "Pilihan lain" menu (a <details>), which is opened next.
      if (await page.evaluate(() => document.getElementById('offline-drafts-list')?.hidden)) await page.locator('#drafts-toggle').click();
      const draftGroup = discard.locator('xpath=ancestor::details[1]');
      if (!await draftGroup.evaluate(element => element.open)) await draftGroup.locator(':scope > summary').click();
      await discard.waitFor({ state: 'visible', timeout: 10000 });
      check('Native bridge reports true via unchanged adapter and injected plugin', await page.evaluate(() => JagaNative.isNative() && typeof JagaNative.request === 'function'));
      check('Queued fixture draft exposes cancel action', await discard.count() === 1);
      await discard.click();
      await page.locator('#confirm-ok-btn').waitFor({ state: 'visible' });
      check('Confirmation dialog opens before cancellation', await page.locator('#modal-confirm').isVisible());
      await page.locator('#confirm-ok-btn').click();
      await page.waitForFunction(() => window.__fixtureDraftRemoved === true && !document.querySelector('[data-discard-draft="draft-fixture-01"]'));
      const trace = await page.evaluate(() => window.__fixtureCalls.filter(call => call.type === 'request' && /\/api\/analyze\/(job-fixture-01)(\/cancel|\/ack)$/.test(call.path) || call.type === 'remove'));
      const expected = [
        { type: 'request', path: '/api/analyze/job-fixture-01/cancel', method: 'POST' },
        { type: 'request', path: '/api/analyze/job-fixture-01/ack', method: 'POST' },
        { type: 'remove', accountId: 'native-fixture-account', clientRequestId: 'draft-fixture-01' }
      ];
      check('Cancel → ack → native removal exact call sequence', JSON.stringify(trace) === JSON.stringify(expected), trace);
      check('Cancelled draft disappears from UI after native removal', await page.locator('[data-discard-draft="draft-fixture-01"]').count() === 0);
      check('No uncaught native-cancel page errors', errors.length === 0, errors);
      await page.screenshot({ path: path.join(evidence, 'native-cancel.png'), fullPage: true });
      await context.close();
    }

    // Admin successful cleanup and warning feedback are separate synthetic API cases.
    for (const scenario of [
      // 0.2.2.0: deletion queues durable cleanup tickets; the console reports cleaned / waiting / needs-review counts.
      { name: 'cleanup-success', response: { ok: true, accountRemoved: true, photoCleanup: { queued: 1, blocked: 0, pendingAfterDrain: 0, cleaned: 1 }, photoCleanupFailures: 0 }, expectedText: 'Foto: 1 dibersihkan, 0 menunggu, 0 perlu ditinjau', expectedKind: 'toast-ok' },
      { name: 'cleanup-warning', response: { ok: true, accountRemoved: true, photoCleanup: { queued: 2, blocked: 1, pendingAfterDrain: 1, cleaned: 0 }, photoCleanupFailures: 2 }, expectedText: '1 perlu ditinjau', expectedKind: 'toast-warn' }
    ]) {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let fixtureDeleted = false;
      const deleteCalls = [];
      await page.addInitScript(() => { window.tailwind = {}; window.lucide = { createIcons() {} }; });
      await page.route(/^https:\/\//, route => route.abort());
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        let body = {};
        if (url.pathname === '/api/auth/me') body = { ok: true, account: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } };
        else if (url.pathname === '/api/admin/overview') body = { encryption: { available: true, detail: 'Fixture' }, workerTokenConfigured: true, accounts: 1, activeAccounts: 1, activeSessions: 0, queueDepth: 0, jobs24h: 0, jobs24hDone: 0, jobs24hRejected: 0, rejectRate: 0, dbBytes: 1, schemaVersion: 1, byStatus: {}, registrationOpen: false, legacyImported: false };
        else if (url.pathname === '/api/admin/health') body = { routerKeyConfigured: true, routerUrl: 'fixture', triageModel: 'fixture', diagnoseModel: 'fixture', plantAiConfigured: false, n8nConfigured: false };
        else if (url.pathname === '/api/admin/accounts' && route.request().method() === 'GET') body = fixtureDeleted ? [] : [{ id: 'user-fixture-01', name: 'Synthetic User', email: 'user@example.test', role: 'user', isActive: true, fastQuota: 3, fastUsed: 0, recordCount: 1, jobCount: 0, farmCount: 1, sessionCount: 1, lastLoginMs: Date.now() }];
        else if (url.pathname === '/api/admin/accounts/user-fixture-01' && route.request().method() === 'DELETE') {
          deleteCalls.push({ method: 'DELETE', path: url.pathname });
          fixtureDeleted = true;
          body = scenario.response;
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(origin + '/admin.html', { waitUntil: 'networkidle' });
      // 0.2.2.0 admin console: views use the hidden attribute, tabs have roles, row actions carry data-action/data-id.
      await page.waitForFunction(() => !document.getElementById('console-view').hidden);
      await page.locator('#tab-accounts').click();
      await page.locator('[data-action="delete-account"][data-id="user-fixture-01"]').click();
      await page.locator('#del-confirm').fill('user@example.test');
      await page.locator('#del-submit').click();
      await page.waitForFunction(expected => (document.getElementById('toast-region')?.textContent || '').includes(expected), scenario.expectedText);
      await page.waitForFunction(() => !document.querySelector('#panel-accounts [data-id="user-fixture-01"]'));
      const feedback = await page.evaluate(() => ({ text: document.getElementById('toast-region').textContent, className: (document.querySelector('#toast-region .toast') || {}).className || '', listText: document.getElementById('panel-accounts').textContent }));
      check(`${scenario.name}: expected deletion feedback shown`, feedback.text.includes(scenario.expectedText) && feedback.className.includes(scenario.expectedKind), feedback);
      check(`${scenario.name}: account list refreshes after successful delete`, !feedback.listText.includes('user@example.test'), feedback.listText.slice(0, 200));
      check(`${scenario.name}: only synthetic DELETE route called`, JSON.stringify(deleteCalls) === JSON.stringify([{ method: 'DELETE', path: '/api/admin/accounts/user-fixture-01' }]), deleteCalls);
      check(`${scenario.name}: no uncaught admin page errors`, errors.length === 0, errors);
      await page.screenshot({ path: path.join(evidence, `${scenario.name}.png`), fullPage: true });
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    const results = { scope: 'Synthetic local fixture routes only; Chromium Playwright; no real auth, network, native device, or production requests', checks };
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ checks: checks.length, failed: checks.filter(item => !item.ok), evidence }, null, 2));
    if (checks.some(item => !item.ok)) process.exitCode = 1;
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
