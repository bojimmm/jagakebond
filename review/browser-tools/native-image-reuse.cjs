const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const script = path.resolve(__dirname, '../../app/frontend/native-adapter.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQZkAAAAASUVORK5CYII=', 'base64').toString('base64');

(async () => {
  const server = http.createServer((req, res) => res.end('<!doctype html><meta charset="utf-8"><img id="reuse">'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const requests = [];
    await page.addInitScript(({ png }) => {
      window.pendingImages = [];
      window.createdImageUrls = [];
      window.revokedImageUrls = [];
      const realCreate = URL.createObjectURL.bind(URL), realRevoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url=realCreate(value);createdImageUrls.push(url);return url; };
      URL.revokeObjectURL = url => { revokedImageUrls.push(url);return realRevoke(url); };
      window.Capacitor = { isNativePlatform: () => true, Plugins: { JagaSync: {
        request: async ({ path }) => { window.imageRequests.push(path); return { status:200, encoding:'base64', body:png, headers:{'content-type':'image/png'} }; }
      } } };
      window.imageRequests = [];
    }, { png });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({ path: script });
    await page.evaluate(() => { document.getElementById('reuse').src = '/api/photos/first-photo'; });
    await page.waitForFunction(() => document.getElementById('reuse').src.startsWith('blob:'));
    const first = await page.locator('#reuse').getAttribute('src');
    await page.evaluate(() => { document.getElementById('reuse').src = '/api/photos/second-photo'; });
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => ({ src:document.getElementById('reuse').src, requests:window.imageRequests }));
    requests.push(...result.requests);
    assert.equal(requests.join(','), '/api/photos/first-photo,/api/photos/second-photo');
    assert.ok(first.startsWith('blob:'));
    assert.ok(result.src.startsWith('blob:'));
    assert.notEqual(result.src, first);
    await page.evaluate(() => JagaNative.revokeImages());
    await page.evaluate(() => { document.getElementById('reuse').src = '/api/photos/first-photo'; });
    await page.waitForFunction(() => document.getElementById('reuse').src.startsWith('blob:'));
    const afterLock = await page.evaluate(() => ({src:document.getElementById('reuse').src,requests:window.imageRequests}));
    assert.equal(afterLock.requests.length,3);
    assert.ok(afterLock.src.startsWith('blob:'));
    await page.evaluate(({png})=>{
      const plugin=Capacitor.Plugins.JagaSync;
      plugin.request=({path})=>new Promise(resolve=>pendingImages.push({path,resolve:()=>resolve({status:200,encoding:'base64',body:png,headers:{'content-type':'image/png'}})}));
      for(const id of ['same-a','same-b']){const image=document.createElement('img');image.id=id;document.body.append(image);image.src='/api/photos/shared-photo';}
    },{png});
    await page.waitForFunction(()=>pendingImages.length===2);
    await page.evaluate(()=>pendingImages.splice(0).forEach(item=>item.resolve()));
    await page.waitForFunction(()=>['same-a','same-b'].every(id=>document.getElementById(id).src.startsWith('blob:')));
    const revocation=await page.evaluate(()=>{const made=[...createdImageUrls];JagaNative.revokeImages();return{made,revoked:revokedImageUrls};});
    assert.equal(revocation.made.length,5);
    assert.deepEqual(revocation.revoked.slice(-5).sort(),revocation.made.sort());
    console.log(JSON.stringify({ passed:true, requests:afterLock.requests, firstResolved:true, reusedElementResolvedSecondSource:result.src !== first, reusedElementResolvedAgainAfterImageLock:true, simultaneousSamePhotoObjectUrlsAllRevoked:true }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
