/* 0.2.4.18 petak: the plot sheet on Peta has Ubah and an X icon, a Ringkasan petak teaser; the summary (also from
   Riwayat > Petak) evaluates elevation, plant conditions and species x pest/disease, and redraws itself whenever a
   plant in the plot changes; a record's species and date can be corrected by hand; the guide explains both.
   Runs under the field app's strict CSP. Synthetic data only. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),APP_PY=path.resolve(__dirname,'../../app/backend/app.py'),checks=[];
const arg=process.argv.indexOf('--shots'),OUT=arg<0?null:path.resolve(process.argv[arg+1]);if(OUT)fs.mkdirSync(OUT,{recursive:true});
const CSP=(()=>{const block=fs.readFileSync(APP_PY,'utf8').match(/\nAPP_CSP\s*=\s*\(([\s\S]*?)\n\)/);return [...block[1].matchAll(/"([^"]*)"/g)].map(m=>m[1]).join('');})();
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);return res.end();}
 const headers={'Content-Type':mime[path.extname(p)]||'application/octet-stream'};if(p.endsWith('.html'))headers['Content-Security-Policy']=CSP;res.writeHead(200,headers);res.end(fs.readFileSync(p));});
function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const now=Date.now(),day=86400e3;let seq=0;
const rec=(plant,crop,sev,cond,days,elev,extra={})=>({id:'r'+(++seq),cropId:plant,crop,cropName:crop,condition:cond,severity:sev,confidence:.8,source:'ai',
 lat:-6.2+seq*1e-5,lng:106.8+seq*1e-5,elevation:elev,farmId:'plot1',timestampMs:now-days*day,createdMs:now-days*day,updatedMs:now-days*day,locationName:'Petak Uji',correctedFields:[],
 assessment:sev==='Healthy'?null:{version:1,findings:[cond],possible_causes:[cond],actions:['Pisahkan daun.'],prevention:['Jaga jarak.'],nutrition:[],monitoring:['Foto lagi.'],escalation:['Hubungi penyuluh.']},...extra});
const records=[rec('p1','Cabai (Chili)','Severe','Antraknosa',1,1180,{imageUrl:'/api/photos/plot-fixture'}),rec('p1','Cabai (Chili)','Moderate','Bercak daun',8,1180),
 rec('p2','Cabai (Chili)','Moderate','Kutu daun',2,1175),rec('p3','Kopi (Coffee)','Moderate','Karat daun',3,1190),
 rec('p4','Kopi (Coffee)','Healthy','Tanaman Sehat',20,1185),rec('p5','Tomat (Tomato)','Moderate','Kutu daun',4,1170)];
const farms=[{id:'plot1',name:'Petak Uji',crop:'Cabai',areaM2:1450,ring:[[-6.2005,106.7995],[-6.2005,106.8015],[-6.1985,106.8015],[-6.1985,106.7995],[-6.2005,106.7995]]}];
const puts=[];
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{browser=await chromium.launch({executablePath:process.env.JK_CHROME||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),errors=[];
 await context.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||'')));try{localStorage.setItem('jk-tour-2:petak-fixture','done');}catch(_){}});
 await context.route(u=>u.protocol==='https:',r=>r.abort());
 await context.addCookies([{name:'jk_csrf',value:'fixture',url:'http://127.0.0.1:'+server.address().port}]);
 await context.route('**/api/**',route=>{const request=route.request(),p=new URL(request.url()).pathname;let body={};
  if(p==='/api/auth/me')body={ok:true,account:{id:'petak-fixture',name:'Data contoh',role:'user'},csrf:'fixture'};
  if(p==='/api/auth/google/config')body={enabled:false};
  if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.4.18',capabilities:{recordsPaging:true,treeContinuity:true}};
  if(p==='/api/records'&&request.method()==='GET')body={items:records,next:null};
  if(p==='/api/farms')body=farms;if(p==='/api/queue/pending'||p==='/api/daily')body=[];
  const m=p.match(/^\/api\/records\/([^/]+)$/);
  if(m&&request.method()==='PUT'){const b=JSON.parse(request.postData()||'{}'),r=records.find(x=>x.id===m[1]);puts.push({id:m[1],body:b});const t=Date.now();
   if(b.correctedCrop)for(const x of records)if(x.id===r.id||(b.applyToPlant!==false&&x.cropId===r.cropId)){x.aiCrop=x.aiCrop||x.crop;x.crop=x.cropName=b.correctedCrop;x.correctedFields=['crop'];x.updatedMs=t;}
   if(b.correctedTimestampMs){r.timestampMs=b.correctedTimestampMs;r.correctedFields=[...new Set([...r.correctedFields,'date'])];r.updatedMs=t;}
   if('observedSeverity' in b){r.observedSeverity=b.observedSeverity;r.updatedMs=t;}
   if('severity' in b){r.severity=b.severity;r.updatedMs=t;}
   if(b.observedProblems){r.observedProblems=b.observedProblems;r.updatedMs=t;}
   body=r;}
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>typeof loadedOnce!=='undefined'&&loadedOnce&&farmRecords.length===6);
 // 1. The plot sheet on Peta
 await page.evaluate(()=>navigateToMenu('map'));await page.waitForTimeout(700);
 await page.evaluate(()=>focusFarm('plot1'));await page.waitForTimeout(300);
 const head=await page.evaluate(()=>{const s=document.getElementById('farm-crops-sheet'),h=s.querySelector('header'),edit=document.getElementById('farm-crops-edit'),close=h.querySelector('[data-act="closeFarmCrops"]');
  const r=e=>e.getBoundingClientRect();return{text:h.innerText,closeText:close.textContent.trim(),closeIcon:!!close.querySelector('svg,i[data-lucide="x"]'),closeLabel:close.getAttribute('aria-label'),
   editLabel:edit.innerText.trim(),editH:r(edit).height,closeW:r(close).width,closeH:r(close).height,side:Math.abs(r(edit).top-r(close).top)<4&&r(edit).right<=r(close).left,teaser:document.getElementById('farm-crops-summary').innerText,teaserH:r(document.getElementById('farm-crops-summary')).height};});
 check('plot sheet: the close button is an X icon, no "Tutup" text',head.closeText===''&&head.closeIcon&&!/Tutup/.test(head.text)&&/Tutup/.test(head.closeLabel),head);
 check('plot sheet: Ubah sits beside the X, both at least 44 px',head.editLabel==='Ubah'&&head.side&&head.editH>=44&&head.closeW>=44&&head.closeH>=44,head);
 check('plot sheet: teaser says Ringkasan petak, plant count and status',/Ringkasan petak/.test(head.teaser)&&/5 tanaman/.test(head.teaser)&&/1 Kritis/.test(head.teaser)&&/Perlu tindakan/.test(head.teaser)&&head.teaserH>=44,head);
 if(OUT)await page.screenshot({path:path.join(OUT,'petak-390-sheet.png')});
 await page.click('#farm-crops-edit');await page.waitForTimeout(300);
 check('Ubah opens the same plot form as Peta > Petak > Ubah',await page.evaluate(()=>!document.getElementById('modal-farm').classList.contains('hidden')&&document.getElementById('farm-modal-title').textContent==='Ubah petak'&&document.getElementById('farm-name-input').value==='Petak Uji'&&editingFarmId==='plot1'));
 await page.evaluate(()=>cancelFarmDraw());await page.waitForTimeout(200);
 await page.evaluate(()=>focusFarm('plot1'));await page.waitForTimeout(200);
 await page.click('#farm-crops-sheet [data-act="closeFarmCrops"]');
 check('X closes the plot sheet',await page.evaluate(()=>document.getElementById('farm-crops-sheet').classList.contains('hidden')));
 // 2. The summary from the polygon
 await page.evaluate(()=>focusFarm('plot1'));await page.waitForTimeout(200);
 await page.click('#farm-crops-summary');await page.waitForTimeout(400);
 const text=()=>page.evaluate(()=>document.getElementById('plot-summary-body').innerText);
 let t=await text();
 check('summary opens from the plot on Peta with the plot name',await page.evaluate(()=>JagaPlotSummary.isOpen()&&document.getElementById('plot-summary-title').textContent==='Petak Uji'));
 const reanalysisButton=await page.evaluate(()=>{
  const button=document.querySelector('#plot-summary-body .plot-reanalyze');
  const label=button.querySelector('span');
  const icon=button.querySelector('svg.lucide-refresh-cw');
  const outer=button.getBoundingClientRect(),inner=label.getBoundingClientRect();
  const glyph=icon?.getBoundingClientRect();
  const original=JagaAssessment.reanalyze;
  let target;
  try{
   JagaAssessment.reanalyze=(id,trigger)=>{target={id,sameButton:trigger===button};};
   button.click();
  }finally{JagaAssessment.reanalyze=original;}
  return {text:label.textContent,height:outer.height,iconWidth:glyph?.width,
   iconHidden:icon?.getAttribute('aria-hidden')==='true',
   left:glyph?.left-outer.left,right:outer.right-inner.right,gap:inner.left-glyph?.right,target};
 });
 check('summary: Analisis Ulang has a rendered refresh icon, balanced spacing and the correct record',
  reanalysisButton.text==='Analisis Ulang'&&reanalysisButton.iconWidth===20&&reanalysisButton.iconHidden
   &&reanalysisButton.height>=44&&reanalysisButton.gap===8
   &&Math.abs(reanalysisButton.left-reanalysisButton.right)<1&&reanalysisButton.left<=14
   &&reanalysisButton.target?.id===records[0].id&&reanalysisButton.target.sameButton,reanalysisButton);
 const noIconGap=await page.evaluate(()=>{
  const icon=document.createElement('i');
  icon.setAttribute('data-lucide','refresh-cw');
  const button=document.querySelector('#plot-summary-body .plot-reanalyze');
  const rendered=button.querySelector('svg');
  rendered.replaceWith(icon);
  const hidden=getComputedStyle(icon).display==='none';
  icon.replaceWith(rendered);
  return hidden;
 });
 check('summary: an unavailable icon takes no button space',noIconGap);
 const tiles=await page.evaluate(()=>[...document.querySelectorAll('#plot-summary-body .stat-tile')].map(e=>[e.className.replace('stat-tile plot-stat','').trim(),e.querySelector('.stat-num').textContent]));
 check('summary: Beranda-style tiles count the latest status per plant',JSON.stringify(tiles)===JSON.stringify([['stat-severe','1'],['stat-moderate','3'],['stat-healthy','1'],['','0']]),tiles);
 check('summary: elevation is descriptive and has no unreviewed crop-fit claim',/Dataran Tinggi, sekitar 1\.180 m dpl/.test(t)&&!/kisaran umum/.test(t),t);
 check('summary: species and their problems, by kind',/Cabai\n2 tanaman · 2 bermasalah/.test(t)&&/Hama\nKutu Daun/.test(t)&&/Penyakit\nAntraknosa/.test(t)&&/Kopi\n2 tanaman · 1 bermasalah/.test(t),t);
 check('summary: co-occurrence is counted without claiming spread',/Dugaan Kutu Daun tercatat pada 2 tanaman dari 2 jenis \(Cabai dan Tomat\)/.test(t)&&/belum membuktikan penularan/.test(t),t);
 check('summary: elevation is not used as humidity or pathogen evidence',/Kelembapan, suhu, dan penyebab gejala tidak dapat disimpulkan dari ketinggian saja/.test(t)&&!/sejalan dengan dataran tinggi yang lembap/.test(t),t);
 check('summary: status changes and stale observations are distinguished',/Status pengamatan lebih berat dibanding catatan sebelumnya: 1 tanaman Cabai/.test(t)&&/Belum difoto lebih dari 14 hari: 1 tanaman Kopi/.test(t),t);
 check('summary: inspection advice directs farmers to Riwayat without unreviewed treatment',/Periksa langsung dahulu tanaman berstatus Kritis: 1 tanaman Cabai/.test(t)&&/Buka Riwayat dan ketuk nama tanaman/.test(t)&&!/\b(ml|gram|gr|liter|cc)\b|insektisida|fungisida|pestisida|\bkartu\b/i.test(t),t);
 const small=await page.evaluate(()=>[...document.querySelectorAll('#modal-plot-summary *')].filter(e=>e.childNodes.length&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&e.getClientRects().length).map(e=>[e.className,parseFloat(getComputedStyle(e).fontSize)]).filter(([,s])=>s<13));
 check('summary: no text under 13 px',small.length===0,small);
 if(OUT)await page.screenshot({path:path.join(OUT,'petak-390-summary.png')});
 // 3. Live refresh: a plant in the plot changes while the summary is open
 await page.evaluate(async()=>{const r=farmRecords.find(x=>x.cropId==='p3');const saved=await api('/api/records/'+r.id,{method:'PUT',body:{observedSeverity:'Severe'}});farmRecords=farmRecords.map(x=>x.id===saved.id?saved:x);refreshAllHistoryViews();});
 await page.waitForTimeout(200);t=await text();
 check('live: a status change redraws the open summary',/Perlu tindakan/.test(t)&&await page.evaluate(()=>document.querySelector('#plot-summary-body .stat-severe .stat-num').textContent)==='2',t.slice(0,200));
 await page.evaluate(()=>{farmRecords=[...farmRecords,{id:'r-new',cropId:'p6',crop:'Teh (Tea)',cropName:'Teh (Tea)',condition:'Tanaman Sehat',severity:'Healthy',source:'ai',farmId:'plot1',lat:-6.1995,lng:106.8005,elevation:1180,timestampMs:Date.now(),createdMs:Date.now(),updatedMs:Date.now(),correctedFields:[]}];refreshAllHistoryViews();});
 await page.waitForTimeout(200);t=await text();
 check('live: a new photo in the plot appears at once',/6 tanaman/.test(t)&&/Teh\n1 tanaman · sehat/.test(t)&&!/Teh: kisaran umum/.test(t),t);
 check('live: the plot sheet behind it follows too',await page.evaluate(()=>/6 tanaman/.test(document.getElementById('farm-crops-summary').innerText)&&document.querySelectorAll('#farm-crops-list .att-item').length===6));
 // 4. Ubah jenis dan tanggal while the summary is open
 await page.evaluate(()=>openRecordEdit(farmRecords.find(r=>r.cropId==='p1'&&r.severity==='Severe').id));await page.waitForTimeout(250);
 const form=await page.evaluate(()=>({crop:document.getElementById('record-edit-crop').value,ai:document.getElementById('record-edit-ai').textContent,all:!document.getElementById('record-edit-all-row').hidden&&document.getElementById('record-edit-all').checked,allText:document.getElementById('record-edit-all-text').textContent,date:document.getElementById('record-edit-date').value,max:document.getElementById('record-edit-date').max,loc:document.getElementById('record-edit-location').textContent,status:document.getElementById('record-edit-status').value,disease:document.getElementById('record-edit-disease').value,pest:document.getElementById('record-edit-pest').value,fields:[...document.querySelectorAll('#modal-record-edit label')].map(e=>e.textContent.trim())}));
 check('edit form: species without the English name, AI species shown, all photos ticked',form.crop==='Cabai'&&form.ai==='Dikenali AI sebagai: Cabai (Chili)'&&form.all&&form.allText==='Terapkan ke semua 2 foto tanaman ini',form);
 check('edit form: the photo date and today as the latest date, location shown',/^\d{4}-\d{2}-\d{2}$/.test(form.date)&&form.max>=form.date&&form.loc==='Petak Uji',form);
 check('edit form: status and disease/pest observations are editable',form.status==='Severe'&&form.disease==='Antraknosa'&&form.pest===''&&form.fields.includes('Status tanaman')&&form.fields.includes('Dugaan penyakit')&&form.fields.includes('Dugaan hama'),form);
 if(OUT)await page.screenshot({path:path.join(OUT,'petak-390-edit.png')});
 await page.fill('#record-edit-crop','');await page.click('#record-edit-save');
 check('edit form: an empty species is refused on the phone',await page.evaluate(()=>document.getElementById('record-edit-error').textContent==='Isi jenis tanaman.'&&!document.getElementById('modal-record-edit').classList.contains('hidden')));
 await page.fill('#record-edit-crop','Cabai Rawit');
 const old=await page.evaluate(()=>new Date(farmRecords.find(r=>r.cropId==='p1'&&r.severity==='Severe').timestampMs));
 await page.fill('#record-edit-date','2026-10-20');
 await page.click('#record-edit-save');await page.waitForTimeout(400);
 if(await page.evaluate(()=>!document.getElementById('modal-confirm').classList.contains('hidden')))await page.evaluate(()=>resolveConfirm(false));
 const put=puts.at(-1);
 check('save sends only the changed fields (species to the whole plant, date with the same time of day)',put.body.correctedCrop==='Cabai Rawit'&&!('applyToPlant' in put.body)&&(()=>{const d=new Date(put.body.correctedTimestampMs);return d.getFullYear()===2026&&d.getMonth()===9&&d.getDate()===20&&d.getHours()===new Date(old).getHours();})(),put);
 t=await text();
 check('live: the corrected species shows in the open summary, apart from the other Cabai plant',/Cabai Rawit\n1 tanaman/.test(t)&&/^Cabai\n1 tanaman/m.test(t),t.slice(0,600));
 check('both photos of that plant carry the correction',await page.evaluate(()=>farmRecords.filter(r=>r.cropId==='p1').every(r=>r.crop==='Cabai Rawit'&&r.correctedFields.includes('crop'))));
 // Farmer-entered status, disease and pest stay distinct from the AI result.
 await page.evaluate(()=>openRecordEdit(farmRecords.find(r=>r.cropId==='p2').id));await page.waitForTimeout(200);
 await page.selectOption('#record-edit-status','Severe');await page.fill('#record-edit-disease','Hawar daun');await page.fill('#record-edit-pest','Wereng');
 await page.click('#record-edit-save');await page.waitForTimeout(300);
 const observedPut=puts.at(-1);
 check('edit form: saves farmer status and both observed problems on the selected photo',observedPut.id===records.find(r=>r.cropId==='p2').id&&observedPut.body.observedSeverity==='Severe'&&observedPut.body.observedProblems?.disease==='Hawar daun'&&observedPut.body.observedProblems?.pest==='Wereng'&&!('severity' in observedPut.body),observedPut);
 check('observed problem label is reflected consistently by the shared assessment label',await page.evaluate(()=>JagaAssessment.label(farmRecords.find(r=>r.cropId==='p2'))==='Wereng · Hawar Daun'));
 await page.evaluate(()=>{JagaPlotSummary.close();navigateToMenu('log');switchLogTab('crops');openCropFromHome('p1');});await page.waitForTimeout(400);
 check('Riwayat timeline says the species was corrected and what the AI said',await page.evaluate(()=>[...document.querySelectorAll('.tl-corrected')].some(e=>/Jenis dan tanggal diubah oleh Anda \(AI: Cabai \(Chili\)\)/.test(e.textContent))));
 await page.evaluate(()=>{const b=document.querySelector('.tl-entry [aria-expanded]');b.click();});await page.waitForTimeout(150);
 check('Riwayat Lainnya offers the integrated Ubah Data Tanaman menu',await page.evaluate(()=>[...document.querySelectorAll('.tl-more:not(.hidden) button')].some(b=>/Ubah Data Tanaman/i.test(b.textContent))));
 await page.evaluate(()=>{const r=farmRecords.find(x=>x.cropId==='p5');openRecordEdit(r.id);document.getElementById('record-edit-crop').value='Terong';});
 await page.click('#record-edit-save');await page.waitForTimeout(300);
 if(await page.evaluate(()=>!document.getElementById('modal-confirm').classList.contains('hidden')))await page.evaluate(()=>resolveConfirm(false));
 check('a single-photo plant has no "all photos" choice and sends the species only',!puts.at(-1).body.correctedTimestampMs&&puts.at(-1).body.correctedCrop==='Terong');
 // 5. The summary from Riwayat > Petak
 await page.evaluate(()=>{closeTreeTimeline();switchLogTab('petak');});await page.waitForTimeout(300);
 await page.click('#farm-logs-container .farm-log-summary');await page.waitForTimeout(300);
 check('Riwayat > Petak opens the same summary, with Lihat di peta',await page.evaluate(()=>JagaPlotSummary.isOpen()&&!document.getElementById('plot-summary-map').classList.contains('hidden')));
 await page.click('#plot-summary-map');await page.waitForTimeout(700);
 check('Lihat di peta opens Peta on that plot',await page.evaluate(()=>currentMenuName==='map'&&!document.getElementById('farm-crops-sheet').classList.contains('hidden')&&selectedFarmId==='plot1'));
 // 6. Map plant sheet: Ubah data
 await page.evaluate(()=>{closeFarmCrops();openBottomSheet(farmRecords.find(r=>r.cropId==='p2').id);});await page.waitForTimeout(400);
 check('map plant sheet: the three action labels are concise and in title case',await page.evaluate(()=>{
  const labels=['#sheet-assessment button','#sheet-open-history','#sheet-edit-record'];
  return labels.map(selector=>document.querySelector(selector)?.textContent.trim()).join('|')==='Analisis Lengkap|Riwayat|Ubah Data';
 }));
 await page.click('#sheet-edit-record');await page.waitForTimeout(250);
 check('map plant sheet: Ubah data opens the same edit form',await page.evaluate(()=>!document.getElementById('modal-record-edit').classList.contains('hidden')));
 await page.click('#modal-record-edit [data-act="openRecordEditLocation"]');await page.waitForTimeout(500);
 check('Ubah lokasi from the form opens the location editor above it',await page.evaluate(()=>{const m=document.getElementById('modal-location');if(!m||m.classList.contains('hidden'))return false;const r=m.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.bottom-80)?.closest('#modal-location')!==null;}));
 await page.evaluate(()=>{closeDialogById('modal-location');closeRecordEdit();closeBottomSheet();});
 // 7. Plot deleted while open closes the summary
 await page.evaluate(()=>{JagaPlotSummary.open('plot1');farmList=[];refreshAllHistoryViews();});
 check('a plot that disappears closes its summary',await page.evaluate(()=>!JagaPlotSummary.isOpen()&&document.getElementById('modal-plot-summary').classList.contains('hidden')));
 // 8. The guide
 await page.evaluate(()=>{farmList=[{id:'plot1',name:'Petak Uji',crop:'Cabai',areaM2:1450,ring:[[-6.2005,106.7995],[-6.2005,106.8015],[-6.1985,106.8015],[-6.1985,106.7995],[-6.2005,106.7995]]}];refreshAllHistoryViews();navigateToMenu('home');JagaTour.open();});
 await page.waitForTimeout(600);
 const steps=await page.evaluate(()=>JagaTour.steps());
 check('guide: five core steps include history and map',steps.length===5&&steps.includes('history')&&steps.includes('map'),steps);
  let tour=null;for(let i=0;i<steps.length&&!tour;i++){
   const title=await page.locator('#tour-title').innerText();
   if(title==='Riwayat')tour=await page.locator('#tour-content .tour-body').innerText();
   else{await page.locator('#tour-next').click();await page.waitForTimeout(150);}
  }
  check('guide: Riwayat explains the plot summary in context',!!tour&&tour.includes('Tab Petak')&&tour.includes('ringkasan tiap kebun'),tour);
  if(OUT)await page.screenshot({path:path.join(OUT,'petak-390-guide.png')});
 await page.evaluate(()=>JagaTour.dismiss());
 const csp=await page.evaluate(()=>window.__csp);
 check('no CSP violations',csp.length===0,csp);
 check('no uncaught page errors',errors.length===0,errors);
 await context.close();
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
const bad=checks.filter(c=>!c.ok);console.log(`petak-0257: ${checks.length-bad.length}/${checks.length} checks passed`);process.exitCode=bad.length?1:0;
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
