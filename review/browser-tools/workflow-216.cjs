const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../../app/frontend'),checks=[];
const server=http.createServer((req,res)=>{const p=path.join(root,new URL(req.url,'http://local').pathname);const f=p.startsWith(root+path.sep)&&fs.existsSync(p)&&fs.statSync(p).isFile()?p:path.join(root,'index.html');res.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(f));});
const check=(name,ok,details)=>{checks.push({name,ok:!!ok,details});};
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try {
  const page=await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route(/https:\/\//,r=>r.abort());
  // 0.2.2.0: coordinates sit behind an 'Atur koordinat manual' disclosure (UX brief, location modal); the strip of
  // unsent photos is collapsed and rare draft actions are in a per-row '...' menu (UX brief D1).
  const openManual=()=>page.evaluate(()=>document.querySelectorAll('#modal-location details').forEach(d=>{d.open=true;}));
  const revealDraft=async selector=>{await page.evaluate(()=>{if(window.JagaDraftsStrip)JagaDraftsStrip.expand();});const details=page.locator(selector).locator('xpath=ancestor::details');await details.waitFor({state:'attached'});if(!await details.evaluate(e=>e.open))await details.locator('summary').click();};
  const revealDraftOld=async selector=>{const details=page.locator(selector).locator('xpath=ancestor::details');await details.waitFor({state:'attached'});if(!await details.evaluate(e=>e.open))await details.locator('summary').click();};
  await page.route('**/api/**',route=>{const url=new URL(route.request().url()),p=url.pathname;let body=p==='/api/auth/me'?{ok:true,account:{id:'workflow-account',name:'Fixture',email:'fixture@example.test',role:'admin'}}:p==='/api/health'?{ok:true,version:'2.1.0'}:p==='/api/telemetry'?{locationName:null,elevation:null}:[];route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});});
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount());
  await page.evaluate(()=>JagaOfflineSync.stop());
  check('Location editor is available',await page.evaluate(()=>typeof openLocationEditor==='function'));
  if(!checks.at(-1).ok)throw Error('Missing location editor');
  await page.evaluate(()=>{navigateToMenu('scan');selectedImageBase64=document.createElement('canvas').toDataURL('image/jpeg');selectedPhotoMetadata=Object.freeze({source:'gallery-exif',lat:null,lng:null});document.getElementById('scanned-image').src=selectedImageBase64;document.getElementById('scanned-image').classList.remove('hidden');document.getElementById('photo-review-controls').classList.remove('hidden');openLocationEditor('capture');});
  await openManual();await page.locator('#location-lat').fill('-6.2');await page.locator('#location-lng').fill('106.8');await page.locator('#location-save').click();
  check('Manual coordinates retained without invented accuracy',await page.evaluate(()=>selectedPhotoMetadata.lat===-6.2&&selectedPhotoMetadata.lng===106.8&&selectedPhotoMetadata.accuracy===null&&selectedPhotoMetadata.locationSource==='manual'));
  await page.evaluate(()=>{farmList=[{id:'plotA',name:'Petak A',ring:[[-6.2,106.8],[-6.2,106.82],[-6.18,106.82],[-6.18,106.8]]}];openLocationEditor('capture');});
  await page.locator('#location-plot').selectOption('plotA');await page.locator('#location-save').click();
  check('Assign plot puts point inside centre with approximate provenance',await page.evaluate(()=>selectedPhotoMetadata.farmId==='plotA'&&selectedPhotoMetadata.locationSource==='plot'&&JagaWorkflow.inside([selectedPhotoMetadata.lat,selectedPhotoMetadata.lng],farmList[0].ring)));
  await page.evaluate(()=>{currentCoords={...currentCoords,lat:-6.2,lng:106.8,accuracy:110,locationName:null};telemetrySnapshot={lat:-6.2,lng:106.8,accuracy:110,updatedMs:Date.now(),locationName:null};updateDashboardTelemetry();});
  check('Reference location card omits raw coordinates while retaining them internally',await page.evaluate(()=>!document.getElementById('home-live-coordinates')&&!document.getElementById('home-place-search')&&currentCoords.lat===-6.2&&currentCoords.lng===106.8));
  for(const [accuracy,expected]of [[101,'poor'],[100,'fair'],[50,'fair'],[49,'good'],[null,'unknown']]){
   await page.evaluate(n=>{currentCoords.accuracy=n;updateDashboardTelemetry();},accuracy);const badge=page.locator('#home-accuracy-tag');check('Accuracy indicator '+String(accuracy),await badge.getAttribute('data-accuracy')===expected&&(await badge.textContent()).trim()==='');
  }
  const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=900;c.height=1200;return c.toDataURL('image/jpeg').split(',')[1];});
  await page.evaluate(async jpeg=>{await JagaOfflineStore.enqueue({accountId:currentAccount.id,clientRequestId:'pending-fixture-1',imageBase64:jpeg,fields:{lat:null,lng:null,cropHint:'Cabai'}});return updateOfflineDraftCount();},jpeg);
  await page.evaluate(()=>navigateToMenu('log'));await page.waitForSelector('[data-edit-draft="pending-fixture-1"]',{state:'attached'});
  await revealDraft('[data-edit-draft="pending-fixture-1"]');
  check('Draft in Riwayat has edit and delete actions',await page.locator('[data-edit-draft="pending-fixture-1"]').count()===1&&await page.locator('[data-discard-draft="pending-fixture-1"]').count()===1);
  await page.locator('[data-edit-draft="pending-fixture-1"]').click();await openManual();await page.locator('#location-lat').fill('-6.1');await page.locator('#location-lng').fill('106.7');await page.locator('#location-save').click();await page.waitForFunction(()=>document.getElementById('modal-location').classList.contains('hidden'));
  const draft=await page.evaluate(async()=>{return (await JagaOfflineStore.list({accountId:currentAccount.id})).drafts[0];});
  check('Draft edit has new stable request ID and saved location',draft.clientRequestId!=='pending-fixture-1'&&draft.fields.lat==='-6.1'&&draft.fields.lng==='106.7'&&draft.status==='editing',draft);
  check('All native-compatible draft fields are strings or null',Object.values(draft.fields).every(v=>v===null||typeof v==='string'));
  await page.evaluate(async()=>{const row=(await JagaOfflineStore.list({accountId:currentAccount.id})).drafts[0];await JagaOfflineStore.update(currentAccount.id,row.clientRequestId,{status:'pending',nextAttemptAtMs:Date.now()+3600000});const fresh=crypto.randomUUID();await JagaMedia.draftEdit({accountId:currentAccount.id,clientRequestId:row.clientRequestId,newClientRequestId:fresh,fields:row.fields});});
  check('Editing retains per-draft Retry-After deadline',await page.evaluate(async()=>{const row=(await JagaOfflineStore.list({accountId:currentAccount.id})).drafts[0];return row.status==='editing'&&row.nextAttemptAtMs>Date.now();}));
  check('An editing draft cannot be claimed by sync',await page.evaluate(async()=>{const row=(await JagaOfflineStore.list({accountId:currentAccount.id})).drafts[0];return !(await JagaOfflineStore.draftClaim({accountId:currentAccount.id,clientRequestId:row.clientRequestId})).claimed;}));
  await page.evaluate(async()=>{await JagaMedia.put({accountId:currentAccount.id,photoId:'record_fixture',imageBase64:(await JagaOfflineStore.draftGet({accountId:currentAccount.id,clientRequestId:(await JagaOfflineStore.list({accountId:currentAccount.id})).drafts[0].clientRequestId})).draft.imageBase64,metadata:{lat:-6.1,lng:106.7,locationSource:'manual'}});});
  const exported=await page.evaluate(async()=>{await JagaFeatures.load('photoExport');const p=await JagaMedia.get({accountId:currentAccount.id,photoId:'record_fixture'});const uri=JagaMedia.exifJpeg('data:image/jpeg;base64,'+p.imageBase64,p.metadata);return {uri,gps:piexif.load(uri).GPS,comment:piexif.load(uri).Exif[piexif.ExifIFD.UserComment]};});
  check('Export contains real EXIF coordinates and manual provenance',exported.gps['1']==='S'&&exported.gps['3']==='E'&&exported.comment.includes('manual'));
  const exifFixture=path.resolve(__dirname,'../final-evidence/exported-geotag-fixture.jpg');fs.mkdirSync(path.dirname(exifFixture),{recursive:true});fs.writeFileSync(exifFixture,Buffer.from(exported.uri.split(',')[1],'base64'));
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount());await page.evaluate(()=>JagaOfflineSync.stop());
  check('Private photo persists across browser reload',await page.evaluate(async()=>!!(await JagaMedia.get({accountId:currentAccount.id,photoId:'record_fixture'})).imageBase64));
  await page.evaluate(async()=>{const rows=(await JagaOfflineStore.list({accountId:currentAccount.id})).drafts;for(const r of rows)await JagaOfflineStore.remove({accountId:currentAccount.id,clientRequestId:r.clientRequestId});await JagaOfflineStore.enqueue({accountId:currentAccount.id,clientRequestId:'terminal-fixture',imageBase64:document.createElement('canvas').toDataURL('image/jpeg').split(',')[1],fields:{}});await JagaOfflineStore.update(currentAccount.id,'terminal-fixture',{status:'submitted',jobId:'failed-job'});workflowJobs.set('failed-job',{id:'failed-job',status:'failed',error:'Fixture analysis failed',context:{}});await JagaMedia.draftMark({accountId:currentAccount.id,clientRequestId:'terminal-fixture',status:'failed',jobId:'failed-job',error:'Fixture analysis failed'});syncNotice='';await updateOfflineDraftCount();});
  check('Failed analysis is visible in Riwayat',(await page.locator('#offline-drafts-list').textContent()).includes('Fixture analysis failed'));
  await page.evaluate(()=>navigateToMenu('log'));await page.screenshot({path:path.resolve(__dirname,'../screenshots/workflow-216-failed-visible.png'),fullPage:true});
  for(const menu of ['home','map','scan','log']){await page.evaluate(menu=>navigateToMenu(menu),menu);await page.waitForTimeout(30);check('No stale pending banner on '+menu,await page.locator('.sync-banner').evaluate(el=>el.hidden));}
  await page.evaluate(()=>navigateToMenu('log'));await revealDraft('[data-discard-draft="terminal-fixture"]');await page.locator('[data-discard-draft="terminal-fixture"]').click();await page.locator('#modal-confirm button').filter({hasText:/Hapus|Buang/}).last().click();await page.waitForTimeout(200);
  check('Explicitly deleted failure removed from local list',await page.evaluate(async()=>!(await JagaOfflineStore.list({accountId:currentAccount.id})).drafts.length));
  for(const status of ['rejected','cancelled']) {
   const id='terminal-edit-'+status;
   await page.evaluate(async({id,status,jpeg})=>{workflowJobs.clear();await JagaOfflineStore.enqueue({accountId:currentAccount.id,clientRequestId:id,imageBase64:jpeg,fields:{cropHint:'Cabai'}});await JagaOfflineStore.update(currentAccount.id,id,{status});await updateOfflineDraftCount();},{id,status,jpeg});
   await revealDraft('[data-edit-draft="'+id+'"]');await page.locator('[data-edit-draft="'+id+'"]').click();await openManual();await page.locator('#location-lat').fill('0');await page.locator('#location-lng').fill('0');await page.locator('#location-save').click();
   await page.waitForFunction(()=>document.getElementById('modal-location').classList.contains('hidden'));
   check(status+' draft action creates editable fresh payload with zero coordinates',await page.evaluate(async old=>{const rows=(await JagaOfflineStore.list({accountId:currentAccount.id})).drafts;return rows.length===1&&rows[0].clientRequestId!==old&&rows[0].status==='editing'&&rows[0].fields.lat==='0'&&rows[0].fields.lng==='0';},id));
   await page.evaluate(async()=>{for(const row of (await JagaOfflineStore.list({accountId:currentAccount.id})).drafts)await JagaOfflineStore.remove({accountId:currentAccount.id,clientRequestId:row.clientRequestId});await updateOfflineDraftCount();});
  }
  check('Colliding draft edit rejects and preserves both complete payloads',await page.evaluate(async jpeg=>{
   const accountId=currentAccount.id,source='collision-source',target='collision-target';
   for(const [clientRequestId,cropHint] of [[source,'Source crop'],[target,'Target crop']])await JagaOfflineStore.enqueue({accountId,clientRequestId,imageBase64:jpeg,fields:{cropHint}});
   const snapshot=async()=>JSON.stringify(await Promise.all([source,target].map(clientRequestId=>JagaOfflineStore.draftGet({accountId,clientRequestId}))));
   const before=await snapshot();let rejected=false;
   try{await JagaMedia.draftEdit({accountId,clientRequestId:source,newClientRequestId:target,fields:{cropHint:'Unexpected replacement'}});}catch(_){rejected=true;}
   const unchanged=before===await snapshot();
   for(const clientRequestId of [source,target])await JagaOfflineStore.remove({accountId,clientRequestId});
   return rejected&&unchanged;
  },jpeg));
  check('No horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth));check('No uncaught browser errors',errors.length===0,errors);
  await page.screenshot({path:path.resolve(__dirname,'../screenshots/workflow-216-history.png'),fullPage:true});await page.close();
 }finally{await browser.close();server.close();fs.writeFileSync(path.resolve(__dirname,'../workflow-216-results.json'),JSON.stringify({scope:'Real browser and IndexedDB; synthetic API jobs and GPS; no production/device',checks},null,2));console.log(JSON.stringify(checks,null,2));}
 if(checks.some(c=>!c.ok))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
