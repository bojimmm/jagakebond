const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright');
(async () => {
  const server = http.createServer((req, res) => res.end('<!doctype html><title>Draft collision fixture</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox']});
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.addScriptTag({path:path.resolve(__dirname, '../../app/frontend/offline-store.js')});
    const result = await page.evaluate(async () => {
      const accountId = 'collision-proof-owner';
      await JagaOfflineStore.activate(accountId);
      for (const [clientRequestId, imageBase64, cropHint] of [['collision-source','c291cmNl','Source'], ['collision-target','dGFyZ2V0','Target']]) {
        await JagaOfflineStore.enqueue({accountId, clientRequestId, imageBase64, fields:{cropHint}});
      }
      const snapshot = () => Promise.all(['collision-source','collision-target'].map(clientRequestId => JagaOfflineStore.draftGet({accountId,clientRequestId})));
      const before = await snapshot();
      let rejected = false;
      try {
        await JagaOfflineStore.draftEdit({accountId, clientRequestId:'collision-source', newClientRequestId:'collision-target', fields:{cropHint:'Replacement'}});
      } catch (_) { rejected = true; }
      const after = await snapshot();
      return {rejected, unchanged:JSON.stringify(before) === JSON.stringify(after), beforeCount:before.filter(x=>x.draft).length, afterCount:after.filter(x=>x.draft).length};
    });
    assert.equal(result.rejected, true);
    assert.equal(result.unchanged, true);
    assert.equal(result.beforeCount, 2);
    assert.equal(result.afterCount, 2);
    console.log(JSON.stringify({passed:true,scope:'Disposable Chromium IndexedDB; no production',...result}));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
