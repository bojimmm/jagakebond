/* Synthetic 0.2.4.3 checks: short labels, compact chemical disclosure, re-analysis and both tree camera sizes. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),checks=[];
function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(p));});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
const candidates=[process.env.CHROME_PATH,'/usr/bin/google-chrome','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean);
const executablePath=candidates.find(p=>fs.existsSync(p));
try{browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(executablePath?{executablePath}:{})});
for(const width of [390,1440]){
 const context=await browser.newContext({viewport:{width,height:900},locale:'id-ID',serviceWorkers:'block'});const errors=[],writes=[];
 await context.route(url=>url.protocol==='https:',r=>r.abort());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('about:blank');
 const photo=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=800;const g=c.getContext('2d');g.fillStyle='#dcead4';g.fillRect(0,0,600,800);g.fillStyle='#438254';g.beginPath();g.ellipse(310,400,180,290,.35,0,Math.PI*2);g.fill();return c.toDataURL('image/jpeg',.9);});
 const oldAssessment={version:1,active_conditions:['Antraknosa','Ulat grayak'],findings:['Bercak melingkar pada buah dan daun berlubang.'],possible_causes:['Dugaan antraknosa pada buah; periksa bercak lain.','Dugaan ulat grayak dari lubang daun; periksa bagian bawah daun.'],actions:['Periksa bagian bawah daun dan catat bercak baru.'],prevention:['Jaga kebersihan area perawatan.'],nutrition:['Bandingkan pola gejala dengan uji tanah.'],monitoring:['Foto ulang tiga hari lagi.'],escalation:['Hubungi penyuluh bila meluas.']};
 const newAssessment={version:1,active_conditions:['Bercak daun'],findings:['Bercak kecil melingkar pada daun.'],possible_causes:['Bercak daun cercospora; konfirmasi di lapangan.'],actions:['Pisahkan daun yang paling parah.'],prevention:['Jaga jarak tanam.'],nutrition:['Belum ada bukti kekurangan hara.'],monitoring:['Amati bercak baru.'],escalation:['Hubungi penyuluh bila meluas.']};
 let currentRecord={id:'reanalysis-record',cropId:'reanalysis-plant',cropName:'Cabai',crop:'Cabai',condition:'Antraknosa + Ulat grayak',severity:'Moderate',confidence:.78,source:'ai',lat:-6.2,lng:106.8,timestampMs:1793318400000,createdMs:1793318400000,imageUrl:photo,serverImageUrl:'/api/photos/photo-test',assessment:oldAssessment,needs_review:false};
 const manualRecord={...currentRecord,id:'manual-record',cropId:'manual-plant',cropName:'Tomat',source:'manual',condition:'Catatan manual'};
 let done=false,analysisPolls=0;
 await context.route('**/api/**',async route=>{const request=route.request(),p=new URL(request.url()).pathname;let body={};
  if(request.method()!=='GET'){writes.push({path:p,body:request.postDataJSON?request.postDataJSON():null});}
  if(p==='/api/auth/me')body={ok:true,account:{id:'synthetic-owner',name:'Data contoh',role:'user'},csrf:'fixture'};
  else if(p==='/api/auth/google/config')body={enabled:false};
  else if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.4.3',capabilities:{recordsPaging:true,treeContinuity:true}};
  else if(p==='/api/records'&&request.method()==='GET')body={items:[currentRecord,manualRecord],next:null};
  else if(p==='/api/records/reanalysis-record/reanalyze')body={jobId:'job-reanalysis',job_id:'job-reanalysis',status:'queued',position:0,source:'original-photo-no-stamp'};
  else if(p==='/api/analyze/job-reanalysis'){analysisPolls+=1;if(done)currentRecord={...currentRecord,condition:'Bercak daun',severity:'Moderate',confidence:.88,needs_review:false,assessment:newAssessment,previousCondition:currentRecord.condition};body=done?{id:'job-reanalysis',status:'done',diagnosis:{crop:'Cabai',condition:'Bercak daun',severity:'Moderate',confidence:.88,needs_review:false,assessment:newAssessment}}:{id:'job-reanalysis',status:'queued',position:0};}
  else if(p==='/api/daily'||p==='/api/farms')body=[];else body={};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount()&&loadedOnce);await page.evaluate(()=>JagaOfflineSync.stop());
 await page.evaluate(()=>{navigateToMenu('log');switchLogTab('crops');});
 const cam=page.locator('.tree-card .tree-cam').first();const camBox=await cam.boundingBox();
 check(width+': history camera target is 56x56',camBox&&Math.round(camBox.width)===56&&Math.round(camBox.height)===56,camBox);
 const camIcon=await cam.locator('svg').evaluate(el=>getComputedStyle(el).width);check(width+': history camera glyph is larger',camIcon==='26px',camIcon);
 await page.locator('.tree-card .tree-main').first().click();
 const timelineCam=page.locator('.tl-hero .tree-cam').first();await timelineCam.waitFor();const timelineCamBox=await timelineCam.boundingBox();
 check(width+': timeline camera target matches the 56x56 card button',timelineCamBox&&Math.round(timelineCamBox.width)===56&&Math.round(timelineCamBox.height)===56,timelineCamBox);
 const timelineCamIcon=await timelineCam.locator('svg').evaluate(el=>getComputedStyle(el).width);check(width+': timeline camera glyph matches the 26px card glyph',timelineCamIcon==='26px',timelineCamIcon);
 await page.evaluate(()=>JagaAssessment.open('reanalysis-record'));
 const dialog=page.locator('#assessment-dialog');
 check(width+': summary heading uses proper case',(await dialog.locator('.assessment-summary-label').innerText())==='Dugaan Hama / Penyakit');
 check(width+': summary names both coexisting findings',(await dialog.locator('.assessment-summary-current').innerText())==='Antraknosa · Ulat',await dialog.locator('.assessment-summary-current').innerText());
 check(width+': chemical disclosure uses proper case',(await dialog.locator('summary').innerText()).trim()==='Tinjau Opsi Kimia / Pupuk');
 const detailsBox=await dialog.locator('.input-options').boundingBox();check(width+': chemical disclosure card is compact',detailsBox&&detailsBox.height<=60,detailsBox);
 await dialog.locator('summary').click();
 const checksToOpen=dialog.locator('.input-terms .input-check');
 for(let i=0;i<2;i++){const box=await checksToOpen.nth(i).boundingBox(),input=await checksToOpen.nth(i).locator('input').boundingBox(),text=await checksToOpen.nth(i).locator('.input-check-text').boundingBox();check(width+': checklist '+(i+1)+' aligns checkbox with first line',box&&input&&text&&Math.abs(input.y-text.y)<=2&&text.x-input.x-input.width>=8&&text.x-input.x-input.width<=12,{box,input,text});}
 check(width+': dialog does not overflow horizontally',await dialog.locator('.assessment-dialog-panel').evaluate(el=>el.scrollWidth<=el.clientWidth));
 check(width+': analysis dialog has no re-analysis control',await dialog.locator('.assessment-reanalyze').count()===0);
 await page.evaluate(()=>JagaAssessment.clear());
 const entry=page.locator('.tl-entry').first();
 await entry.getByRole('button',{name:'Lainnya'}).click();
 const reanalyze=entry.getByRole('button',{name:'Analisis ulang'});
 await reanalyze.waitFor();
 check(width+': Lainnya shows the re-analysis action',await reanalyze.isVisible());
 check(width+': starting re-analysis does not navigate to the analysis dialog',!(await page.locator('#assessment-dialog').isVisible().catch(()=>false)));
 await page.evaluate(()=>{const original=window.setTimeout;window.__restoreFastTimers=()=>{window.setTimeout=original};window.setTimeout=(fn,ms,...args)=>original(fn,Math.min(ms,80),...args);});
 done=false;
 await reanalyze.click();
 const progress=page.locator('#reanalysis-dialog');
 await progress.waitFor({state:'visible',timeout:5000});
 check(width+': re-analysis shows the same progress meter as a new photo',await progress.locator('.reanalysis-meter').count()===1&&await progress.locator('[data-reanalysis-step]').count()===4&&/Menyiapkan|antrean|dianalisis/i.test(await progress.innerText()),await progress.innerText());
 done=true;
 await page.waitForFunction(()=>farmRecords.find(r=>r.id==='reanalysis-record')?.condition==='Bercak daun',null,{timeout:15000});
  const refreshed=progress.getByRole('button',{name:'Lihat hasil terbaru'});
  await refreshed.waitFor({state:'visible',timeout:5000});
  check(width+': completed progress offers the refreshed result',await refreshed.isVisible());
 await page.evaluate(()=>window.__restoreFastTimers?.()); const updated=await page.evaluate(()=>farmRecords.find(r=>r.id==='reanalysis-record'));
 check(width+': same record is updated after re-analysis',updated&&updated.condition==='Bercak daun'&&updated.assessment.possible_causes[0].startsWith('Bercak daun'),updated);
 check(width+': previous short hypothesis remains separate',updated&&updated.previousCondition==='Antraknosa + Ulat grayak',updated&&updated.previousCondition);
 await page.evaluate(()=>JagaAssessment.open('reanalysis-record'));
 check(width+': dialog shows the new short disease name',(await dialog.locator('.assessment-summary-current').innerText())==='Bercak Daun',await dialog.locator('.assessment-summary-current').innerText());
 check(width+': dialog omits the previous-analysis notice',!(await dialog.innerText()).includes('Dugaan sebelum analisis ulang'),await dialog.innerText());
 await page.evaluate(()=>JagaAssessment.clear());
 const post=writes.find(row=>row.path==='/api/records/reanalysis-record/reanalyze');check(width+': client sends no diagnosis or stamped image',post&&Object.keys(post.body||{}).length===0,post);
 check(width+': one re-analysis request is sent',writes.filter(row=>row.path==='/api/records/reanalysis-record/reanalyze').length===1);
 await page.evaluate(()=>JagaAssessment.clear());
 await page.evaluate(()=>JagaAssessment.open('manual-record'));check(width+': manual record has no re-analysis control',await page.locator('.assessment-reanalyze').count()===0);
 await page.evaluate(()=>JagaAssessment.clear());
 check(width+': no uncaught page errors',errors.length===0,errors);
 await context.close();
}
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
const failed=checks.filter(row=>!row.ok);console.log(`reanalysis-0241: ${checks.length-failed.length}/${checks.length} checks passed`);process.exitCode=failed.length?1:0;
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});


