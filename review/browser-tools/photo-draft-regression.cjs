const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../app/frontend');
const runtime = fs.readFileSync(path.resolve(__dirname, '../../android-client/node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js'), 'utf8');
const checks = [];
const check = (name, ok, detail) => checks.push({name, ok: !!ok, detail});
const server = http.createServer((req, res) => {
  let file = path.join(root, new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, 'index.html');
  res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox']});
  try {
    for (const [width, height] of [[320, 568], [360, 740], [390, 460], [390, 844], [412, 915], [740, 360], [768, 1024], [1440, 900]]) {
      const context = await browser.newContext({viewport: {width, height}, serviceWorkers: 'block'});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route(/https:\/\//, route => route.abort());
      await page.addInitScript({content: `window.Capacitor={Plugins:{}};window.fixtureDrafts=[];window.androidBridge={postMessage(raw){const c=JSON.parse(raw);let data={ok:true};if(c.methodName==='request'){const p=c.options.path;data={status:200,body:p==='/api/auth/me'?{ok:true,account:{id:'photo_fixture',name:'Fixture',role:'admin',email:'fixture@example.test'}}:p==='/api/health'?{ok:true,version:'2.1.0'}:[]};}if(c.methodName==='list')data={drafts:window.fixtureDrafts};queueMicrotask(()=>Capacitor.fromNative({callbackId:c.callbackId,pluginId:c.pluginId,methodName:c.methodName,success:true,data}));}};\n${runtime}\nconst p=Capacitor.Plugins.JagaSync={};for(const m of ['request','activate','lock','list','enqueue','remove'])p[m]=o=>Capacitor.nativePromise('JagaSync',m,o);`});
      await page.goto('http://127.0.0.1:' + server.address().port, {waitUntil: 'networkidle'});
      await page.waitForFunction(() => JagaAppAccount());
      await page.evaluate(() => { fixtureDrafts = [{accountId:currentAccount.id,clientRequestId:'photo-pending',status:'blocked',error:'server_update_required',createdMs:1}]; return updateOfflineDraftCount(); });
      await page.evaluate(() => navigateToMenu('scan'));
      const jpeg = await page.evaluate(() => { const c=document.createElement('canvas');c.width=900;c.height=1200;c.getContext('2d').fillRect(0,0,900,1200);return c.toDataURL('image/jpeg').split(',')[1]; });
      await page.locator('input[type=file]').first().setInputFiles({name:'portrait-fixture.jpg',mimeType:'image/jpeg',buffer:Buffer.from(jpeg,'base64')});
      await page.waitForFunction(() => !document.getElementById('photo-review-controls').classList.contains('hidden'));
      await page.waitForTimeout(150);
      const geometry = await page.evaluate(() => {
        layoutScanFrame();
        const rect = id => {const r=document.getElementById(id).getBoundingClientRect();return {width:r.width,height:r.height,x:r.x,y:r.y};};
        return {stage:rect('scan-stage'),frame:rect('scan-frame'),view:rect('view-scan'),overflow:document.documentElement.scrollWidth>innerWidth,scroll:document.getElementById('view-scan').scrollHeight>document.getElementById('view-scan').clientHeight};
      });
      // 0.2.2.0 (UX brief S2): in review the photo is a compact preview (<= ~40 % of the height, tap to enlarge) so the
      // primary action stays visible without scrolling; it must still be big enough to recognise the plant.
      check(`Photo stays readable at ${width}x${height}`, geometry.frame.width >= 96 && geometry.frame.height <= 0.42*height + 2 && geometry.frame.width <= geometry.stage.width + 1, geometry);
      check(`Photo keeps 3:4 at ${width}x${height}`, Math.abs(geometry.frame.height/geometry.frame.width - 4/3)<0.015, geometry.frame);
      check(`No page horizontal overflow at ${width}x${height}`, !geometry.overflow, geometry);
      await page.locator('#btn-run-analysis').scrollIntoViewIfNeeded();
      const action = await page.locator('#btn-run-analysis').evaluate(el => {const r=el.getBoundingClientRect(),nav=document.querySelector('#app-shell > nav').getBoundingClientRect();return {height:r.height,top:r.top,bottom:r.bottom,navTop:nav.top,visible:r.top>=0 && r.bottom<=innerHeight && (nav.width===0 || r.bottom<=nav.top)};});
      check(`Analysis button reachable above navigation at ${width}x${height}`, action.visible && action.height>=44, action);
      if (width === 390 && height === 844) {
        check('Backend incompatibility visible in banner', (await page.locator('#sync-status').textContent()).includes('Server perlu diperbarui'));
        await page.locator('#sync-retry').click();
        check('Manual sync does not hide server incompatibility', (await page.locator('#sync-status').textContent()).includes('Server perlu diperbarui'));
        const scenarios = [
          // 0.2.2.0 (UX brief D1/G1): one short plain-Bahasa status per photo instead of HTTP codes.
          [{status:'blocked',error:'authentication_required'}, 'Masuk lagi'],
          [{status:'blocked',error:'health_http_403'}, 'Server belum bisa dicek'],
          [{status:'pending',error:'retry_after',nextAttemptAtMs:Date.now()+3600000}, 'dicoba lagi'],
          [{status:'uploading'}, 'Sedang dikirim'],
          [{status:'failed',error:'http_422'}, 'Ditolak server']
        ];
        for (const [draft, expected] of scenarios) {
          await page.evaluate(async draft => {fixtureDrafts=[{accountId:currentAccount.id,clientRequestId:'status-fixture',createdMs:1,...draft}];syncNotice='';await updateOfflineDraftCount();}, draft);
          check('Draft status exposed: '+expected, (await page.locator(draft.status==='failed'?'#offline-drafts-list':'#sync-status').textContent()).includes(expected));
          if(draft.status==='failed')check('Terminal upload failure is not counted as pending',await page.locator('.sync-banner').evaluate(el=>el.hidden));
        }
        await page.evaluate(async()=>{fixtureDrafts=[];syncNotice='';await updateOfflineDraftCount();});
        check('Zero drafts hides banner', await page.locator('.sync-banner').evaluate(el=>el.hidden));
        await page.evaluate(()=>{JagaNative.activate=async()=>{throw Error('Synthetic secure session unavailable');};});
        await page.locator('#sync-retry').evaluate(el=>el.click());
        await page.waitForTimeout(100);
        // Raw English platform errors are replaced by Bahasa (audit L5); the failure itself must still be visible.
        check('Native activation failure is visible', (await page.locator('#sync-status').textContent()).includes('Belum bisa mengirim'));
        await page.screenshot({path:path.resolve(__dirname,'../screenshots/photo-review-fixed-390.png'),fullPage:true});
        await page.evaluate(()=>{fixtureDrafts=[];syncNotice='';return updateOfflineDraftCount();});
        await page.locator('#scan-retake').click();
        await page.waitForTimeout(150);
        check('Retake exits scrolling review layout', await page.locator('#view-scan').evaluate(el=>el.dataset.scanState==='live'&&!el.classList.contains('photo-review-mode')));
      }
      check(`No uncaught browser errors at ${width}x${height}`, errors.length===0, errors);
      await context.close();
    }
  } finally {
    fs.writeFileSync(path.resolve(__dirname,'../photo-draft-results.json'),JSON.stringify({scope:'Real browser DOM/gallery FileReader and Capacitor runtime; synthetic account/network/native-draft fixtures; no production mutation or physical Android',checks},null,2));
    console.log(JSON.stringify(checks,null,2));
    await browser.close(); await new Promise(r=>server.close(r));
  }
  if(checks.some(c=>!c.ok))process.exitCode=1;
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
