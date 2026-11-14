const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const path = require('node:path');

const source = process.env.JK_FRONTEND ? path.join(process.env.JK_FRONTEND, 'native-adapter.js') : path.resolve(__dirname, '../../app/frontend/native-adapter.js');
function adapter() {
  const calls = [];
  const window = {
    Capacitor: { isNativePlatform: () => true, Plugins: { JagaSync: {
      request: async args => { calls.push(args); return {status: 200, body: '{"ok":true,"status":"cancelled"}'}; },
    } } },
  };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {window});
  return {bridge: window.JagaNative, calls};
}

test('native cancellation reaches the API bridge with the requested job', async () => {
  const {bridge, calls} = adapter();
  const result = await bridge.request({path: '/api/analyze/job_fixture/cancel', method: 'POST', body: {}});
  assert.equal(result.body.status, 'cancelled');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{path: '/api/analyze/job_fixture/cancel', method: 'POST', body: {}}]);
});

test('cancellation does not expand access to worker or arbitrary routes', async () => {
  const {bridge, calls} = adapter();
  for (const value of ['/api/analyze/job_fixture/result', '/api/analyze/job_fixture/release', '/api/worker/config', 'https://other.invalid/api/analyze/job_fixture/cancel', '/api/analyze/../cancel']) {
    await assert.rejects(bridge.request({path: value, method: 'POST', body: {}}), /Rute API/);
  }
  assert.equal(calls.length, 0);
});
