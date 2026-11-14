/* 0.2.4.15 quality pass: status chips wrap, Peta counts plants without a location, the bottom menu stays on screen
   with the phone held sideways, no 12 px text in the fixed rules, and uncaught errors reach /api/client-errors. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),checks=[];
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(p));});
function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const now=Date.now();
const rec=(id,crop,sev,lat,lng)=>({id,cropId:'p-'+id,crop,cropName:crop,condition:sev==='Healthy'?'Tanaman Sehat':'Bercak Daun',severity:sev,confidence:.8,source:'ai',lat,lng,timestampMs:now-3600e3,createdMs:now-3600e3});
const records=[rec('a','Cabai (Chili)','Severe',-6.2,106.8),rec('b','Kopi (Coffee)','Moderate',null,null),rec('c','Teh (Tea)','Healthy',null,null)];
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 async function open(viewport){
  const context=await browser.newContext({viewport,serviceWorkers:'block'}),errors=[],reports=[];
  await context.route(u=>u.protocol==='https:',r=>r.abort());
  await context.addCookies([{name:'jk_csrf',value:'fixture',url:'http://127.0.0.1:'+server.address().port}]);
  await context.route('**/api/**',route=>{const req=route.request(),p=new URL(req.url()).pathname;let body={};
   if(p==='/api/auth/me')body={ok:true,account:{id:'quality-fixture',name:'Data contoh',role:'user'},csrf:'fixture'};
   if(p==='/api/auth/google/config')body={enabled:false};
   if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.4.15',capabilities:{recordsPaging:true,treeContinuity:true}};
   if(p==='/api/records')body={items:records,next:null};
   if(p==='/api/queue/pending'||p==='/api/farms')body=[];
   if(p==='/api/client-errors'){reports.push({method:req.method(),body:JSON.parse(req.postData()||'{}'),csrf:req.headers()['x-csrf-token']});body={ok:true,recorded:true};}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof loadedOnce!=='undefined'&&loadedOnce);
  return{context,page,errors,reports};
 }
 // ---- phone portrait
 {const{context,page,errors,reports}=await open({width:360,height:740});
  await page.evaluate(()=>navigateToMenu('log'));await page.waitForTimeout(400);
  const chips=await page.evaluate(()=>[...document.querySelectorAll('#log-chips .chip')].map(c=>{const r=c.getBoundingClientRect();return{f:c.dataset.filter,left:r.left,right:r.right,h:r.height};}));
  check('360px: all five status chips are on screen (they wrap instead of scrolling away)',chips.length===5&&chips.every(c=>c.left>=0&&c.right<=360&&c.h>=44),chips);
  check('360px: no sideways page scroll on Riwayat',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>navigateToMenu('map'));await page.waitForTimeout(900);
  const hint=await page.evaluate(()=>{const row=document.getElementById('map-unlocated-row'),b=document.getElementById('map-unlocated');const r=b.getBoundingClientRect();return{hidden:row.hidden,text:b.innerText.trim(),h:r.height,inView:r.left>=0&&r.right<=innerWidth,shifted:document.getElementById('view-map').classList.contains('has-unlocated'),all:document.querySelector('#map-toolbar [data-count="all"]').textContent};});
  check('Peta: "2 tanaman belum punya lokasi" shows next to the 1 plant on the map',!hint.hidden&&hint.text==='2 tanaman belum punya lokasi'&&hint.all==='1'&&hint.h>=44&&hint.inView&&hint.shifted,hint);
  await page.click('#map-unlocated');await page.waitForTimeout(400);
  check('tapping it opens Riwayat with a hint on where to set the location',await page.evaluate(()=>currentMenuName==='log'&&/Ubah lokasi/.test(document.getElementById('toast-notification')?.innerText||'')));
  const small=await page.evaluate(()=>['.assessment-caveat','.capture-location-tools small','.workflow-dialog p','.workflow-tree-group summary small'].map(sel=>{const probe=document.createElement('div');probe.innerHTML={'.assessment-caveat':'<p class="assessment-caveat">x</p>','.capture-location-tools small':'<div class="capture-location-tools"><small>x</small></div>','.workflow-dialog p':'<section class="workflow-dialog"><p>x</p></section>','.workflow-tree-group summary small':'<details class="workflow-tree-group"><summary><small>x</small></summary></details>'}[sel];document.body.append(probe);const el=probe.querySelector(sel.split(' ').pop()==='small'?'small':sel.includes('caveat')?'.assessment-caveat':'p');const fs=parseFloat(getComputedStyle(el).fontSize);probe.remove();return{sel,fs};}));
  check('text in the formerly 12 px rules is now at least 13 px',small.every(s=>s.fs>=13),small);
  // error reporting: an uncaught error and an unhandled rejection reach the server once each, with the app's CSRF header
  await page.evaluate(()=>{setTimeout(()=>{throw new Error('Uji kesalahan kontak budi@desa.id');},0);Promise.reject(new Error('Uji penolakan'));setTimeout(()=>{throw new Error('Uji kesalahan kontak budi@desa.id');},10);});
  await page.waitForTimeout(4500);
  const sent=reports.map(r=>r.body);
  check('uncaught error reported once, with screen, version and platform',sent.filter(b=>b.kind==='error'&&/Uji kesalahan/.test(b.message)).length===1&&sent.some(b=>b.view==='log'&&b.release===document_release(b)&&b.native===false),sent);
  check('unhandled promise rejection reported',sent.some(b=>b.kind==='rejection'&&/Uji penolakan/.test(b.message)),sent);
  check('reports use POST with the CSRF header',reports.length>0&&reports.every(r=>r.method==='POST'&&r.csrf==='fixture'),reports);
  await page.evaluate(()=>{const e=new Error('Failed to fetch');e.offline=true;Promise.reject(e);});await page.waitForTimeout(2600);
  check('expected offline failures are not reported',!reports.some(r=>/Failed to fetch/.test(r.body.message)),reports.map(r=>r.body.message));
  check('portrait: only the deliberate test errors reached the page',errors.every(m=>/^Uji |^Failed to fetch$/.test(m)),errors);
  await context.close();}
 // ---- phone held sideways
 {const{context,page,errors}=await open({width:844,height:390});
  const nav=await page.evaluate(()=>{const n=document.querySelector('nav[aria-label="Menu utama"]');const r=n?n.getBoundingClientRect():null;const shell=document.getElementById('app-shell').getBoundingClientRect();return{nav:r&&{top:r.top,bottom:r.bottom,visible:n.getClientRects().length>0},shell:shell.height,inner:innerHeight,pageScroll:document.scrollingElement.scrollHeight};});
  check('844x390: the bottom menu is fully on screen (no 500 px shell)',nav.nav&&nav.nav.visible&&nav.nav.bottom<=nav.inner+1&&nav.shell<=nav.inner+1,nav);
  check('landscape: no uncaught page errors',errors.length===0,errors);
  await context.close();}
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
const bad=checks.filter(c=>!c.ok);console.log(`quality-0255: ${checks.length-bad.length}/${checks.length} checks passed`);process.exitCode=bad.length?1:0;
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
function document_release(){return fs.readFileSync(path.join(ROOT,'index.html'),'utf8').match(/name="jk-release" content="([^"]+)"/)[1];}
