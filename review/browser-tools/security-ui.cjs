const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../../app/frontend');
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep)){res.writeHead(400);res.end();return;}try{const data=fs.readFileSync(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const checks=[];
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});const page=await context.newPage();
 const check=(name,ok,detail)=>checks.push({name,ok:!!ok,...(detail?{detail}:{})});
 try{
 await page.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(new URL(r.request().url()).pathname==='/api/auth/me'?{ok:true,account:{id:'security-fixture',name:'Fixture',email:'fixture@example.test'}}:[])}));
 await page.route(/https:\/\//,r=>r.abort());
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>JagaAppAccount() && loadedOnce);
 await page.waitForTimeout(100);
 const result=await page.evaluate(async()=>{
  const result={};
  refreshAllData=async()=>undefined;
  try{result.deviceTimeFormats=typeof formatPhotoDate(new Date(0),'fixture')==='string';}catch{result.deviceTimeFormats=false;}
  const evil='<img src=x onerror="window.__xss=1">';
  const evilId="q');window.__xss=2;//";
  const img='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const rec={id:evilId,cropId:'safe',cropName:evil,crop:'Kopi',condition:evil,date:evil,locationName:evil,immediate_action:evil,lat:null,lng:null,severity:'Moderate',imageUrl:img,timestampMs:1};
  farmRecords=[rec];dailyRecommendations=[{id:evilId,title:evil,date:evil,summary:evil,actions:[evil],zones:[evil],sourceRecordIds:[],timestampMs:1}];
  expandedCropId='safe';refreshAllHistoryViews();
  await new Promise(r=>setTimeout(r,150));
  result.noMarkup=window.__xss===undefined&&!document.querySelector('#logs-container img[onerror], #home-history-carousel img[onerror], #daily-container img[onerror]');
  let clicked=null;openViewerForRecord=id=>clicked=id;
  document.querySelector('#logs-container img').click();
  result.literalRecordId=clicked===evilId&&window.__xss===undefined;
  farmRecords[0].cropId=evilId;renderHomeHistoryCarousel();openCropFromHome=id=>clicked=id;clicked=null;
  document.querySelector('#home-history-carousel button').click();
  result.literalCropId=clicked===evilId&&window.__xss===undefined;
  farmRecords[0].cropId='__proto__';try{const groups=groupRecordsByCrop(farmRecords);result.prototypeSafe=groups.length===1&&groups[0].cropId==='__proto__';}catch{result.prototypeSafe=false;}
  farmList=[{id:evilId,name:evil,crop:'Kopi',ring:[],areaM2:1}];renderFarmList();focusFarm=id=>clicked=id;clicked=null;
  document.querySelector('#farm-sheet-list button')?.click();
  result.literalFarmId=clicked===evilId&&window.__xss===undefined;
  result.invalidStampDoesNotHang=await Promise.race([bakeStampIntoCanvas('data:image/jpeg;base64,invalid',{}).then(()=>true),new Promise(r=>setTimeout(()=>r(false),400))]);
  const originalFetch=fetch, originalAccount=currentAccount;
  let releaseRequest;
  fetch=async()=>new Promise(resolve=>releaseRequest=()=>resolve({status:200,ok:true,text:async()=>JSON.stringify([{id:'owner-A-record'}])}));
  const pendingApi=api('/api/records');accountGeneration++;currentAccount={id:'different-fixture-owner'};
  releaseRequest();
  try{await pendingApi;result.staleApiRejected=false;}catch(error){result.staleApiRejected=error.stale===true;}
  fetch=originalFetch;currentAccount=originalAccount;accountGeneration++;
  return result;
 });
 for(const [name,ok]of Object.entries(result))check(name,ok);
 await page.evaluate(()=>{currentCoords={lat:45,lng:90,elevation:100,accuracy:3,weather:'Fixture current weather'};});
 // The real installed offline shell caches this local dependency. This fixture
 // blocks service workers, so load it before cutting the simulated connection.
 await page.evaluate(()=>JagaFeatures.load('photoMetadata'));
 await context.setOffline(true);
 await page.evaluate(async()=>{await JagaFeatures.load('photoMetadata');exifr.parse=async()=>null;navigateToMenu('scan');resetToLiveCamera();});
 const upload=page.locator('input[type=file]').first();
 await upload.setInputFiles(path.join(root,'img/crops/crop-kopi.webp'));
 await page.locator('#photo-review-controls').waitFor({state:'visible'});
 check('Gallery with no EXIF preserves missing time/location/weather',await page.evaluate(()=>selectedPhotoMetadata.captureTimeMs===null&&selectedPhotoMetadata.lat===null&&selectedPhotoMetadata.lng===null&&selectedPhotoMetadata.weather===null));
 await page.evaluate(()=>executeCropPathologyAnalysis());
 await page.evaluate(async()=>{await JagaFeatures.load('photoMetadata');resetToLiveCamera();document.querySelector('input[type=file]').value='';exifr.parse=async()=>({latitude:0,longitude:0,altitude:0,DateTimeOriginal:new Date(0)});});
 await upload.setInputFiles(path.join(root,'img/crops/crop-kopi.webp'));
 await page.locator('#photo-review-controls').waitFor({state:'visible'});
 check('EXIF zero coordinates altitude and epoch preserved with unknown accuracy',await page.evaluate(()=>selectedPhotoMetadata.lat===0&&selectedPhotoMetadata.lng===0&&selectedPhotoMetadata.elevation===0&&selectedPhotoMetadata.captureTimeMs===0&&selectedPhotoMetadata.accuracy===null));
 await page.evaluate(()=>executeCropPathologyAnalysis());
 check('Two captures in same visit use distinct stable keys',await page.evaluate(async()=>{const rows=(await JagaNative.list({accountId:JagaAppAccount().id})).drafts;return rows.length===2&&rows[0].clientRequestId!==rows[1].clientRequestId;}));
 await context.setOffline(false);
 const receiptResult=await page.evaluate(async()=>{
  const originalNative=JagaNative,originalApi=api,originalUpdate=JagaOfflineStore.update;
  let browserWrites=0;
  JagaNative={isNative:()=>true,list:async()=>({drafts:[{accountId:currentAccount.id,clientRequestId:'capture_terminal_fixture',jobId:'job_fixture',status:'submitted',createdMs:1}]})};
  JagaOfflineStore.update=async()=>{browserWrites++;throw new Error('No browser shadow outbox on native');};
  api=async()=>({id:'job_fixture',status:'failed',error:'Fixture analysis failed'});
  await resumeSubmittedDrafts();
  const text=document.getElementById('offline-drafts-list').innerText;
  const removable=!!document.querySelector('[data-discard-draft="capture_terminal_fixture"]');
  JagaNative=originalNative;api=originalApi;JagaOfflineStore.update=originalUpdate;
  return {ok:browserWrites===0&&removable&&text.includes('Fixture analysis failed'),detail:JSON.stringify({browserWrites,removable,text})};
 });
 check('Native terminal receipt remains visibly actionable without IndexedDB shadow',receiptResult.ok,receiptResult.detail);
 for(const [id,open] of [
  ['modal-confirm',()=>{confirmAction({title:'Fixture',message:'Cancel safely'});} ],
  ['modal-crop-assign',()=>{setDialogOpen('modal-crop-assign');}],
  ['modal-account',()=>openAccountModal()],['modal-daily',()=>openDailyModal()],
  ['modal-record-edit',()=>openStatusModal(farmRecords[0].id)],
  ['modal-date-picker',()=>openDatePickerModal()],
  ['modal-farm',()=>openFarmModal([[0,0],[0,.001],[.001,.001],[0,0]],'Fixture')],
  ['photo-viewer',()=>openPhotoViewer('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','Fixture','','','')],
 ]){
  await page.evaluate(()=>{navigateToMenu('log');document.querySelector('#nav-btn-log').focus();});
  await page.evaluate(open);
  check(id+' contains initial focus',await page.evaluate(id=>document.getElementById(id).contains(document.activeElement),id));
  check(id+' makes background inert',await page.evaluate(()=>document.querySelector('#app-shell > main').inert));
  for(let i=0;i<12;i++)await page.keyboard.press('Tab');
  check(id+' traps Tab',await page.evaluate(id=>document.getElementById(id).contains(document.activeElement),id));
  await page.keyboard.press('Escape');
  check(id+' Escape closes',await page.locator('#'+id).isHidden());
  check(id+' restores trigger',await page.evaluate(()=>document.activeElement.id==='nav-btn-log'));
 }
 }finally{fs.writeFileSync(path.resolve(__dirname,'../security-ui-results.json'),JSON.stringify({scope:'Synthetic hostile browser fixtures, no production',checks},null,2));console.log(JSON.stringify(checks,null,2));await browser.close();await new Promise(r=>server.close(r));}
 if(checks.some(x=>!x.ok))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
