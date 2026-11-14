/* 0.2.4.16 hardening (audit F10-F14): the field app runs under the strict CSP from backend/app.py (no inline script),
   every control works through data-act, workflow-ui extends app.js through JagaHooks, meters animate transform,
   and the z-index tokens keep the old values. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),APP_PY=path.resolve(__dirname,'../../app/backend/app.py'),checks=[];
const CSP=(()=>{const block=fs.readFileSync(APP_PY,'utf8').match(/\nAPP_CSP\s*=\s*\(([\s\S]*?)\n\)/);return [...block[1].matchAll(/"([^"]*)"/g)].map(m=>m[1]).join('');})();
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);return res.end();}
 const headers={'Content-Type':mime[path.extname(p)]||'application/octet-stream'};if(p.endsWith('.html'))headers['Content-Security-Policy']=CSP;res.writeHead(200,headers);res.end(fs.readFileSync(p));});
function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const now=Date.now();
const rec=(id,crop,sev,lat,lng,farmId)=>({id,cropId:'p-'+id,crop,cropName:crop,condition:sev==='Healthy'?'Tanaman Sehat':'Bercak Daun',severity:sev,confidence:.8,source:'ai',lat,lng,farmId,timestampMs:now-3600e3,createdMs:now-3600e3,
 assessment:{version:1,findings:['Bercak.'],possible_causes:['Bercak daun'],actions:['Pisahkan daun.'],prevention:['Jaga jarak.'],nutrition:[],monitoring:['Foto lagi.'],escalation:['Hubungi penyuluh.']}});
const records=[rec('a','Cabai (Chili)','Severe',-6.2,106.8,'plot1'),rec('b','Kopi (Coffee)','Moderate',-6.21,106.81,'plot1'),rec('c','Teh (Tea)','Healthy',null,null,null)];
const farms=[{id:'plot1',name:'Petak Uji',crop:'Cabai',areaM2:1200,ring:[[-6.205,106.795],[-6.205,106.815],[-6.195,106.815],[-6.195,106.795],[-6.205,106.795]]}];
(async()=>{
 // static: nothing inline is left for the CSP to forbid
 const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
 check('index.html has no inline on*= handlers and no inline <script> body',!/\son[a-z]+="/.test(html)&&!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html),html.match(/\son[a-z]+="[^"]{0,40}/g));
 const jsLeft=fs.readdirSync(ROOT).filter(n=>n.endsWith('.js')).filter(n=>/\son(click|change|input|error|load)="/.test(fs.readFileSync(path.join(ROOT,n),'utf8')));
 check('no script builds inline on*= handlers into markup',jsLeft.length===0,jsLeft);
 check("the field-app CSP no longer allows inline script",/script-src 'self'(;| )/.test(CSP)&&!/script-src[^;]*unsafe-inline/.test(CSP),CSP);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),errors=[];
  await context.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||'')+' '+(e.sample||'')));try{localStorage.setItem('jk-tour-2:hardening-fixture','done');}catch(_){}});
  await context.route(u=>u.protocol==='https:',r=>r.abort());
  await context.addCookies([{name:'jk_csrf',value:'fixture',url:'http://127.0.0.1:'+server.address().port}]);
  await context.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;let body={};
   if(p==='/api/auth/me')body={ok:true,account:{id:'hardening-fixture',name:'Data contoh',role:'user'},csrf:'fixture'};
   if(p==='/api/auth/google/config')body={enabled:false};
   if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.4.16',capabilities:{recordsPaging:true,treeContinuity:true}};
   if(p==='/api/records')body={items:records,next:null};if(p==='/api/farms')body=farms;if(p==='/api/queue/pending'||p==='/api/daily')body=[];
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof loadedOnce!=='undefined'&&loadedOnce);
  check('the app signs in and renders under the strict CSP',await page.evaluate(()=>!!JagaAppAccount()&&farmRecords.length===3));
  check('hooks registered by workflow-ui for menu, account reset, camera, refresh and telemetry',await page.evaluate(()=>typeof JagaHooks==='object'&&typeof saveRecord==='function'&&typeof updateOfflineDraftCount==='function'&&typeof downloadStampedPhoto==='function'));
  // every action in the page, including the rendered lists, names a real function
  await page.evaluate(()=>{navigateToMenu('log');});await page.waitForTimeout(300);
  const unresolved=await page.evaluate(()=>[...new Set([...document.querySelectorAll('[data-act]')].map(e=>e.dataset.act))].filter(n=>typeof JagaActions.resolve(n)!=='function'));
  check('every data-act in the page resolves to a function',unresolved.length===0,unresolved);
  // hook: entering Riwayat refreshes the drafts strip (it used to be a navigateToMenu re-assignment)
  const hooked=await page.evaluate(async()=>{let n=0;const real=window.updateOfflineDraftCount;window.updateOfflineDraftCount=async(...a)=>{n++;return real(...a);};navigateToMenu('home');navigateToMenu('log');await new Promise(r=>setTimeout(r,50));window.updateOfflineDraftCount=real;return n;});
  check("menu-shown hook still refreshes the drafts on every screen change",hooked===2,hooked);
  // real clicks and events through data-act
  await page.click('#nav-btn-home');check('bottom nav click (data-act) changes the screen',await page.evaluate(()=>currentMenuName==='home'));
  await page.click('#nav-btn-log');await page.waitForTimeout(250);
  await page.click('#logs-container .tree-card .tree-main');await page.waitForTimeout(250);
  check('a rendered tree card opens its timeline (data-act with an argument)',await page.evaluate(()=>!!expandedCropId));
  await page.click('.tl-back');await page.waitForTimeout(200);
  check('"Semua tanaman" closes it',await page.evaluate(()=>!expandedCropId));
  await page.click('#log-chips .chip[data-filter="Severe"]');await page.waitForTimeout(200);
  check('status chip filters (data-act)',await page.locator('#logs-container .tree-card').count()===1);
  await page.click('#log-chips .chip[data-filter="all"]');
  await page.fill('#log-search-input','Kopi');await page.waitForTimeout(250);
  check('search box filters on input (data-on="input")',await page.locator('#logs-container .tree-card').count()===1);
  await page.fill('#log-search-input','');await page.waitForTimeout(150);
  await page.click('button[data-act="openAccountModal"]');
  check('header account button opens Akun',await page.locator('#modal-account').isVisible());
  await page.evaluate(()=>closeAccountModal());
  await page.evaluate(()=>navigateToMenu('map'));await page.waitForTimeout(600);
  await page.click('.map-filter-btn[data-sev="Moderate"]');
  check('map filter passes its own element ($this)',await page.evaluate(()=>document.querySelector('.map-filter-btn[data-sev="Moderate"]').getAttribute('aria-pressed')==='true'));
  await page.click('.map-filter-btn[data-sev="all"]');
  await page.evaluate(()=>navigateToMenu('scan'));await page.waitForTimeout(300);
  await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=640;c.height=480;const g=c.getContext('2d');g.fillStyle='#3d8b3d';g.fillRect(0,0,640,480);
   const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));const input=document.querySelector('input[type=file][aria-label="Pilih foto dari galeri"]');
   const dt=new DataTransfer();dt.items.add(new File([blob],'uji.jpg',{type:'image/jpeg'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForTimeout(1200);
  check('gallery input change reaches handleImageSelected ($event, data-on="change")',await page.evaluate(()=>scanState==='review'||!!selectedImageBase64));
  // F14 meters, F13 tokens
  const motion=await page.evaluate(()=>{const fill=document.getElementById('reanalysis-progress-fill'),scan=document.querySelector('.scan-meter > div');return{re:getComputedStyle(fill).transitionProperty,scan:getComputedStyle(scan).transitionProperty,reScaled:/^scaleX\(/.test(fill.style.transform)&&!fill.style.width};});
  check('progress fills animate transform, not width',motion.re==='transform'&&motion.scan==='transform'&&motion.reScaled,motion);
  const z=await page.evaluate(()=>{const probe=(cls,tag='div')=>{const el=document.createElement(tag);el.className=cls;document.body.append(el);const v=getComputedStyle(el).zIndex;el.remove();return v;};
   return{tour:probe('tour-coach'),dialog:probe('assessment-dialog'),toolbar:probe('map-toolbar'),note:probe('map-note'),bar:probe('draw-bar'),menu:probe('draft-more-menu'),sheet:probe('farm-crops-sheet'),workflow:probe('workflow-modal')};});
  check('z-index tokens keep the old values',z.tour==='1000'&&z.dialog==='90'&&z.toolbar==='20'&&z.note==='21'&&z.bar==='22'&&z.menu==='25'&&z.sheet==='35'&&z.workflow==='2000',z);
  const violations=await page.evaluate(()=>window.__csp);
  check('no CSP violations while using the app',violations.length===0,violations);
  check('no uncaught page errors',errors.length===0,errors);
  await context.close();
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
 const bad=checks.filter(c=>!c.ok);console.log(`hardening-0256: ${checks.length-bad.length}/${checks.length} checks passed`);process.exitCode=bad.length?1:0;
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
