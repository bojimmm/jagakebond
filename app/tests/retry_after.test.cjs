'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { retryAfterDelayMs } = require('../frontend/offline-sync.js');

function installSync(rows, clock) {
  const sent = [];
  let accountId = 'A';
  const store = {
    async pendingForSync(id) { return rows.filter(row => row.accountId === id && row.status === 'pending'); },
    async update(id, requestId, changes) {
      const row = rows.find(item => item.accountId === id && item.clientRequestId === requestId);
      if (row) Object.assign(row, changes);
    },
    async markFailure() {}, async lock() {},
  };
  const root = {
    JagaNative: { isNative: () => false }, JagaOfflineStore: store,
    JagaAppAccount: () => ({ id: accountId }),
    addEventListener() {}, removeEventListener() {},
    fetch: async (url, options) => {
      if (url === '/api/health') return { ok: true, json: async () => ({ version: '2.1.0' }) };
      const id = options.body.get('clientRequestId');
      sent.push({ accountId, id });
      const row = rows.find(item => item.clientRequestId === id);
      if (id === 'fast' && !row.failedOnce) {
        row.failedOnce = true;
        return { status: 429, ok: false, headers: { get: () => row.retryAfter || '86400' }, json: async () => ({}) };
      }
      return { status: 200, ok: true, json: async () => ({ job_id: 'job-' + id }) };
    },
  };
  const FixedDate = class extends Date { static now() { return clock.now; } };
  const context = { window: root, globalThis: root, Date: FixedDate, navigator: { onLine: true }, document: { cookie: '' },
    Uint8Array, atob: value => Buffer.from(value, 'base64').toString('binary'), FormData, Blob, fetch: root.fetch,
    setInterval: () => 1, clearInterval() {}, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/offline-sync.js'), 'utf8'), context);
  return { sync: root.JagaOfflineSync, rows, sent, setAccount(id) { accountId = id; } };
}
const draft = (id, accountId = 'A') => ({ accountId, clientRequestId: id, imageBase64: 'YQ==', fields: {}, status: 'pending' });

test('honors Retry-After values beyond one hour up to 24 hours', () => {
  assert.equal(retryAfterDelayMs('7200'), 7_200_000);
  assert.equal(retryAfterDelayMs('86400'), 86_400_000);
});
test('bounds excessive Retry-After and falls back for invalid values', () => {
  assert.equal(retryAfterDelayMs('999999999999999999999999'), 86_400_000);
  assert.equal(retryAfterDelayMs('9'.repeat(400)), 86_400_000);
  assert.equal(retryAfterDelayMs('0'), 60_000);
  assert.equal(retryAfterDelayMs('-3'), 60_000);
  assert.equal(retryAfterDelayMs('tomorrow'), 60_000);
  assert.equal(retryAfterDelayMs(null), 60_000);
  assert.equal(retryAfterDelayMs('1'), 1_000);
});
test('a fast-tier 429 defers only that draft and normal draft uploads in the same run', async () => {
  const clock = { now: 1000 };
  const harness = installSync([draft('fast'), draft('normal')], clock);
  await harness.sync.run();
  assert.deepEqual(harness.sent.map(item => item.id), ['fast', 'normal']);
  assert.equal(harness.rows[0].nextAttemptAtMs, 86_401_000);
  assert.equal(harness.rows[1].status, 'submitted');
});
test('deferred deadline persists across sync instances and does not block another account', async () => {
  const clock = { now: 5000 };
  const rows = [draft('fast'), draft('normal')];
  const first = installSync(rows, clock);
  await first.sync.run();
  const restarted = installSync(rows, clock);
  await restarted.sync.run();
  assert.deepEqual(restarted.sent.map(item => item.id), []);
  restarted.setAccount('B');
  restarted.rows.push(draft('account-b', 'B'));
  await restarted.sync.run();
  assert.deepEqual(restarted.sent.map(item => item.id), ['account-b']);
});
test('a deferred draft becomes eligible at its persisted deadline', async () => {
  const clock = { now: 1000 };
  const row = draft('fast'); row.nextAttemptAtMs = 2000; row.failedOnce = true;
  const harness = installSync([row], clock);
  await harness.sync.run();
  assert.deepEqual(harness.sent, []);
  clock.now = 2000;
  await harness.sync.run();
  assert.deepEqual(harness.sent.map(item => item.id), ['fast']);
});
test('invalid Retry-After uses the native-compatible one-minute fallback', () => {
  assert.equal(retryAfterDelayMs('invalid'), 60000);
});
