/* Synthetic-only browser checks for structured results and explicit catalog opt-in. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),checks=[];
const arg=process.argv.indexOf('--shots'),OUT=arg>=0?path.resolve(process.argv[arg+1]):null;
if(OUT)fs.mkdirSync(OUT,{recursive:true});
function check(name,ok){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name);}
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(p));});
const assessment={version:1,findings:['Bercak pada buah cabai. <img src=x onerror="window.__injected=true">'],possible_causes:['Dugaan antraknosa; konfirmasi penyebab di lapangan.'],actions:['Periksa buah lain pada tanaman yang sama dan catat perubahan.'],prevention:['Periksa aliran air bila petak tergenang.'],nutrition:['Dugaan kekurangan kalium: tepi daun tua menguning lalu mengering.'],monitoring:['Foto bagian yang sama saat pemeriksaan berikutnya.'],escalation:['Hubungi petugas bila gejala meluas.'],missing_information:['Sejak kapan gejala terlihat?']};
const record={id:'record_fixture',cropId:'plant-fixture',crop:'Cabai (Chili)',condition:'Dugaan antraknosa',severity:'Moderate',createdMs:1793275200000,timestampMs:1793275200000,assessment,source:'ai',immediate_action:'Legacy referral',imageUrl:null};
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{for(const width of [320,390,1440]){
 const context=await browser.newContext({viewport:{width,height:1000},locale:'id-ID',serviceWorkers:'block'});let posts=[],delayed=false;
 await context.route(url=>url.protocol==='https:',r=>r.abort());
 await context.route('**/api/**',async route=>{const request=route.request(),p=new URL(request.url()).pathname;let body=[];
  if(p==='/api/auth/me')body={ok:true,account:{id:'advice-fixture',name:'Data contoh',role:'user'},csrf:'fixture'};
  if(p==='/api/auth/google/config')body={enabled:false};
  if(p==='/api/records')body={items:[record],next:null};
  if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.3.6',capabilities:{recordsPaging:true}};
  if(p==='/api/recommendations'){
   posts.push(request.postDataJSON());if(delayed)await new Promise(r=>setTimeout(r,300));
   body={coverage_note:'Katalog contoh produsen; izin belum diverifikasi.',reasons:['Label lengkap dan izin perlu diverifikasi.'],eligible_products:[],references:[{id:'fixture',name:'Produk referensi contoh',composition:'Komposisi dari sumber contoh',status_label:'Referensi produsen; belum diverifikasi',checked_at:'2026-10-30',source_url:'https://example.test/label',missing_evidence:['izin terkini','jeda panen']} ]};
  }
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount()&&loadedOnce);await page.evaluate(()=>JagaOfflineSync.stop());
 await page.evaluate(()=>{navigateToMenu('scan');setScanState('result');lastResultRecord=farmRecords[0];JagaAssessment.render(document.getElementById('res-assessment'),lastResultRecord);document.getElementById('res-geo-brief').parentElement.hidden=true;});
 const host=page.locator('#res-assessment');
 check(width+': seven sections render',await host.locator('.assessment-section').count()===7);
 check(width+': content is text, not HTML injection',!await page.evaluate(()=>window.__injected)&&await host.locator('img').count()===0);
 check(width+': legacy fallback hidden',!await page.locator('#res-geo-brief').isVisible());
 check(width+': action and prevention are distinct',(await host.innerText()).includes('Rekomendasi Tindakan')&&(await host.innerText()).includes('Rekomendasi Pencegahan'));
 check(width+': section titles use proper case',(await host.innerText()).includes('Dugaan Penyebab')&&(await host.innerText()).includes('Kapan Perlu Bantuan'));
 check(width+': nutrition replaces the missing-information list',(await host.innerText()).includes('Kebutuhan Unsur Hara')&&!(await host.innerText()).includes('Informasi yang masih diperlukan'));
 check(width+': every section is bulleted',await host.locator('.assessment-section ul.assessment-list li').count()>=6);
 check(width+': no automatic chemical request',posts.length===0);
 check(width+': opt-in initially collapsed',await host.locator('details').evaluate(e=>!e.open));
 check(width+': speech/share retain prevention',await page.evaluate(()=>JagaAssessment.text(lastResultRecord).includes('Rekomendasi Pencegahan')));
 if(OUT){await page.evaluate(()=>{farmRecords[0].assessment.findings=['Bercak terlihat pada buah cabai; perlu pemeriksaan lebih dekat.'];JagaAssessment.render(document.getElementById('res-assessment'),farmRecords[0]);document.getElementById('res-crop-condition').textContent='Cabai — Dugaan antraknosa · Data contoh';document.getElementById('res-badge-severity').textContent='Waspada';});await page.locator('#post-analysis-card').screenshot({path:path.join(OUT,`assessment-${width}.png`)});}
 await host.locator('summary').click();
 check(width+': terms gate keeps the form closed',await host.locator('form').evaluate(form=>form.hidden));
 await host.locator('form').evaluate(form=>form.requestSubmit());
 check(width+': terms gate prevents request',posts.length===0);
 check(width+': target comes from the analysis, not a dropdown',await host.locator('[name=problem]').inputValue()==='anthracnose'&&await host.locator('select[name=problem]').count()===0);
 await host.locator('[name=accepted]').check();
 check(width+': accepting the terms opens the form',await host.locator('[name=growthStage]').isVisible());
 for(const name of ['growthStage','symptomDuration','affectedExtent','location','harvestWindow','recentInputs'])await host.locator(`[name=${name}]`).fill('Data contoh');
 await host.locator('button[type=submit]').click();
 await host.locator('.input-product').waitFor();
 check(width+': only opted-in record context sent',posts.length===1&&posts[0].recordId===record.id&&posts[0].accepted===true&&posts[0].disclaimerVersion==='id-inputs-1');
 check(width+': missing registration/label clearly shown',(await host.locator('.input-options-result').innerText()).includes('belum diverifikasi'));
 check(width+': reference link protected',await host.locator('.input-product a').getAttribute('rel')==='noopener noreferrer');
 const overflow=await host.evaluate(el=>el.scrollWidth>el.clientWidth+1);check(width+': no horizontal overflow',!overflow);
 if(OUT){await host.locator('.input-product').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(OUT,`catalog-${width}.png`)});}
 await page.evaluate(()=>{openBottomSheet(farmRecords[0].id);});
 check(width+': map sheet keeps a compact link to full analysis',await page.locator('#sheet-assessment button').count()===1&&await page.locator('#sheet-assessment .assessment-section').count()===0);
 await page.evaluate(()=>JagaAssessment.open(farmRecords[0].id));
 check(width+': history assessment opens without a map or photo',await page.locator('#assessment-dialog').isVisible()&&(await page.locator('#assessment-dialog').innerText()).includes('Rekomendasi Pencegahan'));
 const historyScroll=await page.locator('#assessment-dialog .assessment-dialog-body').evaluate(el=>{el.scrollTop=el.scrollHeight;return {scrollable:getComputedStyle(el).overflowY==='auto',end:el.scrollTop+el.clientHeight>=el.scrollHeight-2};});
 check(width+': history analysis exposes its full content',historyScroll.scrollable&&historyScroll.end);
 check(width+': history analysis has no manual target dropdown',await page.locator('#assessment-dialog select').count()===0);
 await page.getByRole('button',{name:'Tutup analisis'}).click();
 await page.evaluate(()=>JagaAssessment.open(farmRecords[0].id));
 check(width+': reopening history keeps all seven sections',await page.locator('#assessment-dialog .assessment-section').count()===7);
 await page.getByRole('button',{name:'Tutup analisis'}).click();
 await page.evaluate(()=>{if(typeof closeBottomSheet==='function')closeBottomSheet();});
 delayed=true;await page.evaluate(()=>{JagaAssessment.render(document.getElementById('res-assessment'),farmRecords[0]);});
 await host.locator('summary').click();await host.locator('[name=accepted]').check();
 for(const name of ['growthStage','symptomDuration','affectedExtent','location','harvestWindow','recentInputs'])await host.locator(`[name=${name}]`).fill('Data contoh');
 const req=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/recommendations');await host.locator('button[type=submit]').click();await req;
 await page.evaluate(()=>accountGeneration++);await page.waitForTimeout(450);
 check(width+': changed account rejects stale result',await host.locator('.input-product').count()===0);
 await page.evaluate(()=>JagaAssessment.clear());check(width+': account cleanup removes assessment dialog',await page.locator('#assessment-dialog').count()===0);
 check(width+': no application errors',errors.length===0);
 await context.close();
}}finally{await browser.close();await new Promise(r=>server.close(r));}
const failed=checks.filter(row=>!row.ok);console.log(`advice-0236: ${checks.length-failed.length}/${checks.length} checks passed`);process.exitCode=failed.length?1:0;
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
