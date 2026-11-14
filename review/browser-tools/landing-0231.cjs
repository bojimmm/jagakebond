#!/usr/bin/env node
/* Public landing/legal regression. Synthetic API only; no production or Google traffic. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const FRONT = path.resolve(__dirname, '../../app/frontend');
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt >= 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok:!!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(detail))); }
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.woff':'font/woff', '.webmanifest':'application/manifest+json' };
let registration = false;
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://local');
  const json = (data,status=200) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/auth/options') return json({passwordRegistration:registration});
  if (url.pathname === '/api/auth/me') return json({ok:false,account:null});
  if (url.pathname === '/api/auth/google/config') return json({enabled:false,clientId:null});
  if (url.pathname === '/api/auth/login') return json({detail:'Email atau kata sandi salah'},401);
  if (url.pathname === '/api/auth/register') return json({detail:'Pendaftaran ditutup oleh admin'},403);
  if (url.pathname === '/api/health') return json({ok:true,version:'2.1.0',release:'0.2.3.4',capabilities:{treeContinuity:true,recordsPaging:true,accountBinding:true,photoLifecycle:true}});
  if (url.pathname.startsWith('/api/')) return json([]);
  const aliases = {'/':'/index.html','/privacy':'/privacy.html','/terms':'/terms.html'};
  const file = path.resolve(FRONT,'.'+(aliases[url.pathname] || url.pathname));
  if (!file.startsWith(FRONT+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200,{'Content-Type':MIME[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'}); res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:'+server.address().port;
  const browser = await chromium.launch({executablePath:process.env.JK_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  try {
    for (const [width,height] of [[1920,1080],[1440,1000],[1280,800],[390,844],[360,780],[320,640],[844,390]]) {
      const context = await browser.newContext({viewport:{width,height},serviceWorkers:'block',colorScheme:'dark',locale:'id-ID'});
      const page = await context.newPage();
      const errors=[], external=[], requests=[];
      page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>requests.push(request.url()));
      await context.route(/^https:\/\//,route=>{external.push(route.request().url());return route.abort();});
      await page.goto(base,{waitUntil:'networkidle'});
      await page.waitForSelector('#auth-gate:not(.hidden)');
      const layout = await page.evaluate(()=>{
        const gate=document.getElementById('auth-gate'), form=document.getElementById('auth-form');
        const buttons=[...gate.querySelectorAll('button')].filter(el=>el.getClientRects().length);
        return {overflow:gate.scrollWidth>gate.clientWidth+1,form:form.getBoundingClientRect().width,
          background:getComputedStyle(gate).backgroundColor,scheme:getComputedStyle(gate).colorScheme,
          small:buttons.filter(el=>el.getBoundingClientRect().height<44 || parseFloat(getComputedStyle(el).fontSize)<15).map(el=>el.id),
          registration:document.getElementById('auth-tab-register').hidden,google:document.getElementById('google-signin').hidden};
      });
      check(`${width}x${height}: no horizontal overflow, usable form and light surface in dark device mode`,!layout.overflow && layout.form>=260 && layout.background==='rgb(255, 255, 255)' && layout.scheme==='light',layout);
      check(`${width}x${height}: controls >=44px / >=15px text; closed registration and Google remain hidden`,!layout.small.length && layout.registration && layout.google,layout);
      if (width>=1024) {
        await page.waitForFunction(() => [...document.querySelectorAll('.landing-farmer img, .landing-app-shot img')]
          .every(img => img.complete && img.naturalWidth >= 416));
        const previews = await page.evaluate(() => ({
          farmer: document.querySelector('.landing-farmer img').currentSrc,
          sources: [...document.querySelectorAll('.landing-app-shot img')].map(img => img.currentSrc),
          labels: [...document.querySelectorAll('.landing-app-shot img')].map(img => img.alt),
          captions: document.querySelectorAll('.landing-app-shot figcaption').length,
          featureRow: !!document.querySelector('.landing-features, .landing-eyebrow, .auth-reassurance'),
          mapLayered: (() => {
            const map = document.querySelector('.landing-app-map');
            const home = document.querySelector('.landing-app-home');
            const mapBox = map.getBoundingClientRect();
            const homeBox = home.getBoundingClientRect();
            const photoBox = document.querySelector('.landing-farmer').getBoundingClientRect();
            return mapBox.top < homeBox.bottom && mapBox.bottom > homeBox.bottom
              && mapBox.left < homeBox.right && mapBox.right > photoBox.left
              && Number(getComputedStyle(map).zIndex) < Number(getComputedStyle(home).zIndex);
          })(),
          backdrop: getComputedStyle(document.querySelector('.landing-art-backdrop')).filter,
          farmerCorner: getComputedStyle(document.querySelector('.landing-farmer img')).borderBottomRightRadius,
          transforms: [...document.querySelectorAll('.landing-app-shot')].map(el => getComputedStyle(el).transform),
          gradient: getComputedStyle(document.getElementById('auth-gate')).backgroundImage
        }));
        check(`${width}: farmer photo and all three app previews load with descriptive alt text`,
          previews.farmer.endsWith('landing-farmer.webp?v=1') && previews.sources.length === 3
          && previews.sources[0].endsWith('landing-app-map.png?v=1')
          && previews.sources[1].endsWith('landing-app-home.png?v=1')
          && previews.sources[2].endsWith('landing-app-history.png?v=5')
          && previews.labels.length === 3 && previews.labels.every(label => label.startsWith('Contoh ')), previews);
        check(`${width}: desktop layout has a blurred backdrop and caption-free previews`,
          !previews.captions && !previews.featureRow && previews.mapLayered && previews.backdrop.startsWith('blur(')
          && parseFloat(previews.farmerCorner) > 0
          && previews.transforms.every(value => value !== 'none') && previews.gradient.startsWith('radial-gradient('), previews);
      } else check(`${width}: desktop artwork and screenshots are not fetched on phones/tablets`,!requests.some(url=>/landing-farmer\.webp|landing-app-(home|history|map)\.png/.test(url)),requests.filter(url=>url.includes('landing-')));
      await page.fill('#auth-password','synthetic-password');
      await page.click('#auth-toggle-password');
      check(`${width}: password reveal works with accessible state`,await page.locator('#auth-password').getAttribute('type')==='text' && await page.locator('#auth-toggle-password').getAttribute('aria-pressed')==='true');
      await page.click('#auth-toggle-password');
      await page.fill('#auth-email','synthetic@example.test');
      await page.click('#auth-submit');
      await page.waitForSelector('#auth-error:not(.hidden)');
      check(`${width}: wrong password keeps sign-in available with clear Bahasa error`,(await page.locator('#auth-error').textContent()).includes('kata sandi salah') && !await page.locator('#auth-submit').isDisabled());
      await page.click('.auth-help summary');
      check(`${width}: password help describes the actual admin reset path`,(await page.locator('.auth-help p').textContent()).includes('admin kebun'));
      if (SHOTS) { await page.fill('#auth-email',''); await page.fill('#auth-password',''); await page.locator('#auth-error').evaluate(el=>el.classList.add('hidden')); await page.locator('.auth-help').evaluate(el=>el.open=false); await page.locator('#auth-gate').evaluate(el=>el.scrollTop=0); await page.screenshot({path:path.join(SHOTS,`login-${width}x${height}.png`)}); }
      await page.locator('.landing-footer a').first().scrollIntoViewIfNeeded();
      const footer = await page.locator('.landing-footer').evaluate(el => ({
        height: el.getBoundingClientRect().height,
        slogan: !!el.querySelector(':scope > span'),
        centered: getComputedStyle(el.querySelector('nav')).justifyContent === 'center',
        language: el.querySelector('nav [lang="id"]').textContent,
        links: [...el.querySelectorAll('a')].map(link => link.getBoundingClientRect().height),
      }));
      check(`${width}: slim, centered footer retains legal links and language`,
        footer.height <= 68 && !footer.slogan && footer.centered && footer.language === 'Bahasa Indonesia'
        && footer.links.length === 2 && footer.links.every(height => height >= 44), footer);
      check(`${width}: no page errors or external requests while Google is disabled`,!errors.length && !external.length,{errors,external});
      await context.close();
    }
    registration=true;
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    const page=await context.newPage();
    await page.goto(base,{waitUntil:'networkidle'});
    await page.waitForSelector('#auth-tab-register:not([hidden])');
    await page.click('#auth-tab-register');
    check('Open registration exposes the name field, correct title and new-password autocomplete',await page.locator('#auth-name').isVisible() && (await page.locator('#auth-title').textContent()).includes('Mulai catatan') && await page.locator('#auth-password').getAttribute('autocomplete')==='new-password');
    await page.click('#auth-tab-login');
    check('Return to sign-in restores the title and password protection',(await page.locator('#auth-title').textContent()).includes('Masuk ke kebun') && await page.locator('#auth-password').getAttribute('type')==='password');
    for (const name of ['privacy','terms']) {
      for (const width of [390,1440]) {
        await page.setViewportSize({width,height:900});
        const response=await page.goto(`${base}/${name}.html`,{waitUntil:'networkidle'});
        const legal=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,email:document.querySelector('a[href="mailto:adzril.taibkhadzim@gmail.com"]')!==null,headings:document.querySelectorAll('article h2').length,font:parseFloat(getComputedStyle(document.body).fontSize),toc:[...document.querySelectorAll('.legal-toc a')].every(a=>document.querySelector(a.getAttribute('href')))}));
        check(`${name} ${width}: public readable policy, contact and working contents`,response.status()===200 && !legal.overflow && legal.email && legal.headings>=8 && legal.font>=16 && legal.toc,legal);
        if(SHOTS) await page.screenshot({path:path.join(SHOTS,`${name}-${width}.png`),fullPage:true});
      }
    }
    await context.close();
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
  const failed=checks.filter(c=>!c.ok); console.log(`landing-0231: ${checks.length-failed.length}/${checks.length} checks passed`); process.exitCode=failed.length?1:0;
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
