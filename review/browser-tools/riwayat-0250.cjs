/* 0.2.4.10: on phones, Riwayat shows the analysis count once - in the "N sedang dianalisis" strip, not also as a header chip. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),checks=[];
const arg=process.argv.indexOf('--shots'),OUT=arg<0?null:path.resolve(process.argv[arg+1]);if(OUT)fs.mkdirSync(OUT,{recursive:true});
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(p));});
function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const S={pending:[],job:{id:'job-riwayat-a',status:'queued',position:0}};
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});const errors=[];
 await context.route(url=>url.protocol==='https:',route=>route.abort());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;let body={};
  if(p==='/api/auth/me')body={ok:true,account:{id:'riwayat-fixture-account',name:'Data contoh',role:'user'},csrf:'fixture'};
  if(p==='/api/auth/google/config')body={enabled:false};
  if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.4.10',capabilities:{recordsPaging:true,treeContinuity:true}};
  if(p==='/api/records')body={items:[],next:null};
  if(p==='/api/queue/pending')body=S.pending;
  if(p==='/api/analyze/job-riwayat-a')body=S.job;
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>typeof JagaAppAccount==='function'&&JagaAppAccount()&&typeof loadedOnce!=='undefined'&&loadedOnce);
 await page.evaluate(()=>{JagaOfflineSync.stop();navigateToMenu('log');});
 const state=()=>page.evaluate(()=>{const chip=document.getElementById('status-chip'),strip=document.getElementById('offline-drafts');
  return{chip:!!chip&&!chip.classList.contains('hidden'),chipText:chip?chip.textContent.trim():'',bodyClass:document.body.classList.contains('has-status-chip'),
   strip:!!strip&&!strip.hidden,stripText:(document.getElementById('drafts-summary')||{}).textContent||''};});
 // One analysis starts while the farmer is already on Riwayat: a single refresh must not flash the duplicate chip.
 S.pending=[{id:'job-riwayat-a',status:'queued',position:1}];
 const first=await page.evaluate(async()=>{
  // Record every chip state the refresh passes through, not only the final one: the bug was a brief flash.
  const chip=document.getElementById('status-chip'),strip=document.getElementById('offline-drafts');let flashed=false;
  const seen=()=>{if(chip&&!chip.classList.contains('hidden'))flashed=true;};
  const observer=new MutationObserver(seen);if(chip)observer.observe(chip,{attributes:true,attributeFilter:['class']});
  workflowRefresh=null;await refreshWorkflow();await updateOfflineDraftCount();
  await new Promise(r=>setTimeout(r,50));observer.disconnect();seen();
  return{chip:flashed,strip:!!strip&&!strip.hidden};});
 check('390px Riwayat: strip appears with the first refresh',first.strip,first);
 check('390px Riwayat: no duplicate chip on that same refresh',!first.chip,first);
 let s=await state();
 check('390px Riwayat: strip reads "1 sedang dianalisis"',s.strip&&s.stripText.trim()==='1 sedang dianalisis',s);
 check('390px Riwayat: header chip and its spacing class are off',!s.chip&&!s.bodyClass,s);
 if(OUT)await page.screenshot({path:path.join(OUT,'riwayat-390-processing.png')});
 await page.locator('#drafts-toggle').click();
 check('390px Riwayat: strip still opens the per-photo list',await page.evaluate(()=>{const l=document.getElementById('offline-drafts-list');return !!l&&!l.hidden&&l.children.length>0;}));
 // 0.2.4.14: the strip's down arrow sits in the middle; a photo being analysed opens the Analisis ulang style progress.
 const arrow=await page.evaluate(()=>{const t=document.getElementById('drafts-toggle').getBoundingClientRect(),c=document.querySelector('#drafts-toggle .drafts-chevron').getBoundingClientRect(),l=document.getElementById('drafts-summary').getBoundingClientRect();return{toggle:(t.left+t.right)/2,chevron:(c.left+c.right)/2,labelLeft:l.left-t.left,labelRight:l.right,chevronLeft:c.left};});
 check('390px Riwayat: the strip arrow is centred and clear of the summary',Math.abs(arrow.toggle-arrow.chevron)<=2&&arrow.labelLeft<=16&&arrow.labelRight<=arrow.chevronLeft,arrow);
 const open=page.locator('#offline-drafts-list .draft-row-open');
 check('390px Riwayat: the analysing photo is a labelled button with a hint',await open.count()===1&&/Lihat kemajuan analisis/.test(await open.getAttribute('aria-label'))&&/Ketuk untuk melihat kemajuan/.test(await open.innerText()));
 await open.click();await page.waitForTimeout(400);
 const dlg=()=>page.evaluate(()=>{const d=document.getElementById('reanalysis-dialog'),m=document.getElementById('reanalysis-meter');return{shown:!d.classList.contains('hidden'),title:document.getElementById('reanalysis-title').textContent,first:d.querySelector('[data-reanalysis-step="prepare"] span').textContent,
  now:Number(m.getAttribute('aria-valuenow')),width:document.getElementById('reanalysis-progress-fill').style.transform,steps:[...d.querySelectorAll('.reanalysis-step')].map(s=>s.dataset.state),status:document.getElementById('reanalysis-status').textContent,detail:document.getElementById('reanalysis-detail').textContent,close:document.getElementById('reanalysis-close-label').textContent,tone:d.dataset.tone,font:getComputedStyle(d.querySelector('.reanalysis-step')).fontSize};});
 let d=await dlg();
 check('tapping it opens "Analisis foto" with Terkirim / Antrean / Analisis / Hasil',d.shown&&d.title==='Analisis foto'&&d.first==='Terkirim'&&d.font==='13px',d);
 check('queued: Menunggu giliran with the queue position and the meter value set',/Menunggu giliran/.test(d.status)&&/Posisi antrean: 1/.test(d.detail)&&d.now>=18&&d.width==='scaleX('+d.now/100+')',d);
 S.job={id:'job-riwayat-a',status:'claimed',stage:'diagnose:start',stageLabel:'Menganalisa gejala…'.replace('Menganalisa','Menganalisis')};await page.waitForTimeout(3000);d=await dlg();
 check('claimed: the bar moves to the diagnosis stage and Antrean is done',d.now>=66&&d.steps[0]==='done'&&d.steps[1]==='done'&&d.steps[2]==='active'&&/Menganalisis gejala/.test(d.status),d);
 S.job={id:'job-riwayat-a',status:'rejected',error:'Foto terlalu buram.'};await page.waitForTimeout(3000);d=await dlg();
 check('refused: the dialog says so with the reason and offers Tutup',d.tone==='error'&&/Analisis tidak selesai/.test(d.status)&&/Foto terlalu buram/.test(d.detail)&&d.close==='Tutup',d);
 check('refused: the "hasilnya tetap masuk ke Riwayat" note is gone',await page.evaluate(()=>document.querySelector('#reanalysis-dialog .reanalysis-safe-note').hidden));
 if(OUT)await page.screenshot({path:path.join(OUT,'riwayat-390-progress.png')});
 await page.locator('#reanalysis-close-button').click();
 check('Tutup closes the progress dialog',await page.evaluate(()=>document.getElementById('reanalysis-dialog').classList.contains('hidden')));
 S.job={id:'job-riwayat-a',status:'queued',position:0};
 await page.evaluate(()=>navigateToMenu('home'));
 s=await state();
 check('390px Beranda: the chip shows "1 dianalisis"',s.chip&&s.chipText==='1 dianalisis',s);
 await page.evaluate(()=>navigateToMenu('log'));
 s=await state();
 check('390px back on Riwayat: chip hides again',!s.chip&&s.strip,s);
 await page.setViewportSize({width:1366,height:900});
 await page.waitForTimeout(150);
 s=await state();
 check('1366px Riwayat: desktop keeps both the chip and the strip',s.chip&&s.chipText==='1 dianalisis'&&s.strip,s);
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(150);
 s=await state();
 check('rotated back to 390px: chip hides',!s.chip&&s.strip,s);
 // Other states are not duplicates: a failed analysis keeps its header alert on phones.
 S.pending=[{id:'job-riwayat-b',status:'failed',error:'Foto terlalu gelap.'}];
 await page.evaluate(async()=>{workflowRefresh=null;await refreshWorkflow();await updateOfflineDraftCount();});
 s=await state();
 check('390px Riwayat: a failed analysis keeps the "1 gagal" chip',s.chip&&s.chipText==='1 gagal',s);
 // 0.2.4.11: a photo the server refused was sent - the strip must not call it "belum terkirim" nor offer "Kirim sekarang".
 const send=await page.evaluate(()=>{const b=document.getElementById('drafts-send');return !!b&&!b.classList.contains('hidden');});
 check('390px Riwayat: the strip names the refused photo "1 gagal"',s.strip&&s.stripText.trim()==='1 gagal',s);
 check('390px Riwayat: no "Kirim sekarang" when nothing can be sent',!send,{send});
 S.pending=[];
 await page.evaluate(async()=>{workflowRefresh=null;await refreshWorkflow();await updateOfflineDraftCount();});
 s=await state();
 check('390px Riwayat: nothing pending hides both',!s.chip&&!s.strip,s);
 check('no uncaught page errors',errors.length===0,errors);
 await context.close();
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
// 0.2.4.11 copy: KBBI "analisis" and no "yatim" anywhere a farmer or admin reads.
for(const name of fs.readdirSync(ROOT).filter(n=>/\.(js|html)$/.test(n))){const text=fs.readFileSync(path.join(ROOT,name),'utf8');
 check(name+': no "analisa"/"dianalisa" and no "yatim"',!/(di|meng)?analisa|yatim/i.test(text));}
const bad=checks.filter(c=>!c.ok);console.log(`riwayat-0250: ${checks.length-bad.length}/${checks.length} checks passed`);process.exitCode=bad.length?1:0;
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
