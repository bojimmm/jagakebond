const { chromium } = require('../../review/browser-tools/node_modules/playwright');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');

(async () => {
  // Isolate storage from the real app's asynchronous auth/health bootstrap. Its
  // background fetches can otherwise race the deferred-upload network assertion.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Offline storage fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const adapter = path.resolve(__dirname, '../frontend/native-adapter.js');
  const store = path.resolve(__dirname, '../frontend/offline-store.js');
  const sync = path.resolve(__dirname, '../frontend/offline-sync.js');
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.addScriptTag({ path: adapter });
  await page.addScriptTag({ path: store });
  await page.addScriptTag({ path: sync });
  const result = await page.evaluate(async () => {
    const id = 'capture_0123456789';
    await JagaOfflineStore.activate('acct-A');
    await JagaOfflineStore.enqueue({ accountId: 'acct-A', clientRequestId: id,
      imageBase64: 'YWJj', fields: { lat: '0', lng: '0', photoTimestampMs: '0' } });
    await JagaOfflineStore.enqueue({ accountId: 'acct-A', clientRequestId: id,
      imageBase64: 'YWJj', fields: { lng: '0', lat: '0', photoTimestampMs: '0' } });
    const visible = await JagaOfflineStore.list({ accountId: 'acct-A' });
    let conflict = false;
    try { await JagaOfflineStore.enqueue({ accountId: 'acct-A', clientRequestId: id,
      imageBase64: 'ZGVm', fields: { lat: '0', lng: '0', photoTimestampMs: '0' } }); }
    catch (_) { conflict = true; }
    await JagaOfflineStore.lock();
    let locked = false;
    try { await JagaOfflineStore.list({ accountId: 'acct-A' }); } catch (_) { locked = true; }
    await JagaOfflineStore.activate('acct-B');
    const other = await JagaOfflineStore.list({ accountId: 'acct-B' });
    await JagaOfflineStore.lock();
    return { count: visible.drafts.length, photoOmitted: !('imageBase64' in visible.drafts[0]), conflict, locked,
      otherCount: other.drafts.length };
  });
  await page.reload();
  await page.addScriptTag({ path: adapter });
  await page.addScriptTag({ path: store });
  await page.addScriptTag({ path: sync });
  const reloadResult = await page.evaluate(async () => {
    await JagaOfflineStore.activate('acct-A');
    const drafts = await JagaOfflineStore.list({ accountId: 'acct-A' });
    return { count: drafts.drafts.length, id: drafts.drafts[0] && drafts.drafts[0].clientRequestId };
  });
  const oldServerResult = await page.evaluate(async () => {
    await JagaOfflineStore.activate('acct-A');
    const id = 'capture_oldserver_0123';
    await JagaOfflineStore.enqueue({ accountId: 'acct-A', clientRequestId: id, imageBase64: 'YWJj', fields: {} });
    window.JagaAppAccount = () => ({ id: 'acct-A' });
    let uploadCount = 0;
    window.fetch = async url => {
      if (url === '/api/health') return { ok: true, status: 200, json: async () => ({ ok: true, version: '2.0.9' }) };
      uploadCount++;
      throw new Error('Older server must not receive this upload');
    };
    await JagaOfflineSync.run();
    const rows = await JagaOfflineStore.list({ accountId: 'acct-A' });
    return { uploadCount, status: rows.drafts.find(row => row.clientRequestId === id).status };
  });
  await page.evaluate(async () => { await JagaOfflineStore.activate('acct-A'); await JagaOfflineStore.remove({ accountId: 'acct-A', clientRequestId: 'capture_oldserver_0123' }); });
  const syncResult = await page.evaluate(async () => {
    await JagaOfflineStore.activate('acct-A');
    window.JagaAppAccount = () => ({ id: 'acct-A' });
    let accepted = false, attempts = 0;
    window.fetch = async (url, options) => {
      if (url === '/api/health') return { ok: true, status: 200, json: async () => ({ ok: true, version: '2.1.0' }) };
      attempts++;
      const id = options.body.get('clientRequestId');
      if (!accepted) { accepted = true; throw new Error('simulated lost response after server accepted'); }
      if (id !== 'capture_0123456789') throw new Error('idempotency key changed on retry');
      return { status: 200, ok: true, json: async () => ({ job_id: 'job_durable_1', status: 'queued' }) };
    };
    await JagaOfflineSync.run();
    await JagaOfflineSync.run();
    const all = await JagaOfflineStore.list({ accountId: 'acct-A' });
    const pending = await JagaOfflineStore.pendingForSync('acct-A');
    const receipts = await JagaOfflineStore.submitted('acct-A');
    const original = all.drafts.find(row => row.clientRequestId === 'capture_0123456789');
    return { attempts, status: original.status, pending: pending.filter(row => row.clientRequestId === 'capture_0123456789').length, receiptJob: receipts.find(row => row.clientRequestId === 'capture_0123456789')?.jobId };
  });
  assert.deepEqual(result, { count: 1, photoOmitted: true, conflict: true, locked: true, otherCount: 0 });
  assert.deepEqual(reloadResult, { count: 1, id: 'capture_0123456789' });
  assert.deepEqual(oldServerResult, { uploadCount: 0, status: 'pending' });
  await page.evaluate(async () => { await JagaOfflineStore.activate('acct-A'); await JagaOfflineStore.remove({ accountId: 'acct-A', clientRequestId: 'capture_oldserver_0123' }); });
  assert.deepEqual(syncResult, { attempts: 2, status: 'submitted', pending: 0, receiptJob: 'job_durable_1' });
  const deferred = await page.evaluate(async () => {
    await JagaOfflineStore.enqueue({accountId:'acct-A',clientRequestId:'retry_fast_fixture',imageBase64:'YWJj',fields:{tier:'fast'}});
    await JagaOfflineStore.enqueue({accountId:'acct-A',clientRequestId:'retry_normal_fixture',imageBase64:'YWJj',fields:{tier:'normal'}});
    const sent=[];fetch=async(url,options)=>{
      if(url==='/api/health')return{ok:true,json:async()=>({version:'2.1.0'})};
      const id=options.body.get('clientRequestId');sent.push(id);
      return id==='retry_fast_fixture'?{status:429,ok:false,headers:{get:()=> '86400'},json:async()=>({})}:{status:200,ok:true,json:async()=>({job_id:'job_normal_fixture'})};
    };
    await JagaOfflineSync.run();
    const rows=await JagaOfflineStore.pendingForSync('acct-A');
    return{sent,deadline:rows.find(row=>row.clientRequestId==='retry_fast_fixture').nextAttemptAtMs};
  });
  assert.deepEqual(deferred.sent,['retry_fast_fixture','retry_normal_fixture']);
  assert(deferred.deadline>Date.now());
  await page.reload();
  await page.addScriptTag({path:store});await page.addScriptTag({path:sync});
  const persistedRetry=await page.evaluate(async()=>{
    await JagaOfflineStore.activate('acct-A');window.JagaAppAccount=()=>({id:'acct-A'});
    let sent=0;fetch=async()=>{sent++;throw Error('Deferred row must not access network');};
    await JagaOfflineSync.run();const rows=await JagaOfflineStore.pendingForSync('acct-A');
    return{sent,deadline:rows.find(row=>row.clientRequestId==='retry_fast_fixture').nextAttemptAtMs};
  });
  assert.deepEqual(persistedRetry,{sent:0,deadline:deferred.deadline});
  console.log('PASS Retry-After: real IndexedDB deadline survives page reload, skips network, and did not block same-run Normal upload');
  console.log('PASS IndexedDB browser tests: durable reload, account isolation, idempotency, payload conflict, lock, response-loss replay and durable submitted receipt');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
