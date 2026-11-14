/* Real-browser regression; every API response is synthetic, no production access. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend');
const arg=process.argv.indexOf('--shots'),OUT=arg>=0?path.resolve(process.argv[arg+1]):null;
if(OUT)fs.mkdirSync(OUT,{recursive:true});
const NOW=Date.parse('2026-10-29T10:00:00Z'),YESTERDAY=NOW-86400000;
const checks=[];function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);res.end();return;}const b=fs.readFileSync(p);res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(b);});
const leaf='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" fill="#e2eed4"/><path d="M14 58C5 24 32 12 58 8C66 35 45 61 14 58Z" fill="#43864d"/><path d="M12 64L53 16" stroke="#c3e28e" stroke-width="3"/></svg>').toString('base64');
function rows(){return [
 {id:'a',cropId:'plant-a',crop:'Ketapang (Sea Almond)',cropName:'Ketapang (Sea Almond)',condition:'Sehat',severity:'Healthy',createdMs:NOW-5000,uploadedMs:NOW-5000,updatedMs:NOW-5000,timestampMs:NOW,imageUrl:leaf},
 {id:'b',cropId:'plant-b',crop:'Ketapang (Tropical Almond)',condition:'Sehat',severity:'Healthy',createdMs:NOW-4000,updatedMs:NOW,timestampMs:NOW,imageUrl:leaf},
 {id:'c',cropId:'plant-c',crop:'Pisang (Banana)',condition:'Sigatoka Kuning',severity:'Moderate',createdMs:YESTERDAY,updatedMs:NOW,timestampMs:YESTERDAY,imageUrl:leaf},
 {id:'d',cropId:'plant-d',crop:'Cabai',condition:'Bercak daun',severity:'Severe',createdMs:NOW-3000,timestampMs:NOW,imageUrl:leaf}];}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{for(const width of [320,390,1440]){
 const context=await browser.newContext({viewport:{width,height:900},locale:'id-ID',timezoneId:'Asia/Jakarta',serviceWorkers:'block'});
 await context.addInitScript(({now})=>{const RealDate=Date;window.__fieldNow=now;window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[window.__fieldNow]));}static now(){return window.__fieldNow;}};},{now:NOW});
 let records=rows(),writes=0;const errors=[];
 await context.route(/^https:\/\//,route=>route.abort());
 await context.route('**/api/**',route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname;let body=[];
  if(req.method()!=='GET')writes++;
  if(p==='/api/auth/me')body={ok:true,account:{id:'field-fixture',name:'Data contoh',role:'user'},csrf:'fixture'};
  if(p==='/api/auth/google/config')body={enabled:false};
  if(p==='/api/records')body={items:records,next:null};
  if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.3.4',capabilities:{treeContinuity:true,recordsPaging:true}};
  if(p==='/api/telemetry')body={};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>typeof JagaAppAccount==='function'&&JagaAppAccount()&&loadedOnce);
 await page.evaluate(()=>JagaOfflineSync.stop());
 const alignment=async selector=>page.locator(selector).evaluateAll(cards=>cards.map(c=>{const photo=c.querySelector('.thumb'),status=c.querySelector('.card-status');return {delta:Math.abs(photo.getBoundingClientRect().bottom-status.getBoundingClientRect().bottom),overflow:c.scrollWidth>c.clientWidth+1};}));
 let boxes=await alignment('#home-attention-list .att-item');check(`${width}: home photo/status bottoms align`,boxes.length>0&&boxes.every(b=>b.delta<=1&&!b.overflow),boxes);
 const text=await page.locator('#home-daily-card').innerText();check(`${width}: today excludes an old photo edited today`,/Hari ini/.test(text)&&/3 foto dari 3 tanaman/.test(text)&&!text.includes('Pisang'),text);
 await page.evaluate(()=>navigateToMenu('log'));
 boxes=await alignment('#logs-container .tree-card');check(`${width}: history photo/status bottoms align`,boxes.length===4&&boxes.every(b=>b.delta<=1&&!b.overflow),boxes);
 const names=await page.locator('.tree-name').allTextContents();check(`${width}: aliases share one name while plants remain separate`,names.filter(n=>n==='Ketapang (Tropical Almond)').length===2&&names.length===4,names);
 if(OUT)await page.screenshot({path:path.join(OUT,`history-${width}.png`)});
 await page.evaluate(()=>switchLogTab('daily'));
 check(`${width}: Harian shows today's live summary without needing a saved note`,(await page.locator('.daily-live').innerText()).includes('3 foto dari 3 tanaman'));
 await page.evaluate(()=>openDailyModal());await page.fill('#daily-summary-input','Catatan saya tetap utuh.');
 records.push({...records[0],id:'new-photo',createdMs:NOW,uploadedMs:NOW,severity:'Moderate',observedSeverity:null,condition:'Perlu diperiksa'});
 await page.evaluate(()=>refreshAllData());
 check(`${width}: new uploaded photo refreshes home, history and open suggestion`,(await page.locator('#home-daily-card').innerText()).includes('4 foto dari 3 tanaman')&&(await page.locator('.daily-live').innerText()).includes('4 foto dari 3 tanaman')&&(await page.locator('#daily-draft-summary').innerText()).includes('4 foto dari 3 tanaman'));
 check(`${width}: automatic refresh preserves typed personal notes`,await page.inputValue('#daily-summary-input')==='Catatan saya tetap utuh.');
 await page.evaluate(()=>{closeDailyModal();window.__fieldNow=Date.parse('2026-10-29T17:00:01Z');document.dispatchEvent(new Event('visibilitychange'));});
 check(`${width}: midnight/resume changes to the new day without stale data`,/belum ada foto/i.test(await page.locator('#home-daily-card').innerText())&&/belum ada foto/i.test(await page.locator('.daily-live').innerText()));
 check(`${width}: derived summary never writes automatic archive entries`,writes===0,writes);
 if(width>=1024){
  await page.evaluate(()=>{navigateToMenu('home');for(let n=0;n<3;n++)JagaShell.noteResult({id:'unseen-fixture-'+n});applyDesktopNav(true);});await page.waitForTimeout(300);
  const badge=await page.locator('#desktop-nav .nav-badge').evaluate(el=>({w:el.getBoundingClientRect().width,clip:getComputedStyle(el).clip}));
  check(`${width}: pending count stays visible in the collapsed rail`,badge.w>=18&&badge.clip==='auto',badge);
  const frames=await page.evaluate(async()=>{const icons=[...document.querySelectorAll('#desktop-nav > button > svg')],frames=[];const sample=()=>icons.map(icon=>{const b=icon.getBoundingClientRect(),s=getComputedStyle(icon);return {x:b.x,w:b.width,h:b.height,visible:s.visibility==='visible'&&s.display!=='none'&&Number(s.opacity)>0,connected:icon.isConnected};});const before=sample();toggleDesktopNav();const end=performance.now()+320;do{frames.push(sample());await new Promise(requestAnimationFrame);}while(performance.now()<end);return {before,frames};});
  const stable=frames.before.length===4&&frames.frames.length>5&&frames.frames.every(frame=>frame.every((i,n)=>i.connected&&i.visible&&Math.abs(i.w-frames.before[n].w)<0.6&&Math.abs(i.x-frames.before[n].x)<0.6));
  check(`${width}: menu icons remain visible and fixed throughout expansion`,stable,frames);
 }
 if(OUT){await page.evaluate(()=>{navigateToMenu('home');window.__fieldNow=Date.parse('2026-10-29T10:00:00Z');renderDailyRecommendations();});await page.screenshot({path:path.join(OUT,`home-${width}.png`)});}
 check(`${width}: no page errors`,errors.length===0,errors);
 await context.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));}
const failed=checks.filter(c=>!c.ok);console.log(`field-0233: ${checks.length-failed.length}/${checks.length} checks passed`);process.exitCode=failed.length?1:0;
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});

