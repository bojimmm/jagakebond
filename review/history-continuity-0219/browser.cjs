const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('../browser-tools/node_modules/playwright');
const root=path.resolve(__dirname,'../../app/frontend');
const out=path.join(__dirname,'evidence');fs.mkdirSync(out,{recursive:true});
const slice=process.argv[2]||'navigation';
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').pathname;const p=path.join(root,name==='/'?'index.html':name);if(!p.startsWith(root+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(p));});
const checks=[];function check(name,ok,detail){checks.push({name,ok:!!ok,detail});}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const page=await browser.newPage({viewport:{width:360,height:800},serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__spoken=[];window.SpeechSynthesisUtterance=function(text){this.text=text;};window.speechSynthesis.speak=u=>window.__spoken.push(u.text);});
 await page.route(/https:\/\//,r=>r.abort());
 await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(p==='/api/auth/me'?{ok:true,account:{id:'fixture219',name:'Fixture',role:'user'}}:p==='/api/health'?{ok:true,version:'2.1.0'}:p==='/api/records'?[{id:'r219',cropId:'tree219',cropName:'Mangga depan',crop:'Mangga',condition:'Pengamatan',severity:'Healthy',lat:-6.25,lng:106.75,date:'Waktu fixture',updatedMs:Date.now(),imageUrl:''}]:[])});});
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount());await page.evaluate(()=>{JagaOfflineSync.stop();farmRecords=[{id:'r219',cropId:'tree219',cropName:'Mangga depan',crop:'Mangga',condition:'Pengamatan',severity:'Healthy',lat:-6.25,lng:106.75,date:'Waktu fixture',updatedMs:Date.now(),imageUrl:''}];});
 if(slice==='navigation'){
  await page.evaluate(()=>{navigateToMenu('map');openFarmPanel();});await page.waitForTimeout(350);
  check('Petak panel opens on map',await page.locator('#farm-sheet').evaluate(e=>!e.hidden&&e.getBoundingClientRect().top<innerHeight));
  for(const menu of ['log','home','scan']){
   await page.evaluate(()=>{navigateToMenu('map');openFarmPanel();});await page.waitForTimeout(350);
   await page.evaluate(menu=>navigateToMenu(menu),menu);await page.waitForTimeout(350);
   check('Petak panel removed from layout and focus on '+menu,await page.locator('#farm-sheet').evaluate(e=>getComputedStyle(e).display==='none'||e.hidden));
   check('Other map sheets closed on '+menu,await page.locator('#farm-crops-sheet').evaluate(e=>e.classList.contains('hidden')));
  }
  await page.evaluate(()=>{navigateToMenu('map');openFarmPanel();closeFarmPanel();});
  check('Explicit close removes panel from focus order',await page.locator('#farm-sheet').evaluate(e=>e.hidden||getComputedStyle(e).display==='none'));
 }
 if(slice==='layout'){
  for(const [width,height] of [[320,568],[360,800],[375,667],[768,900],[800,360],[1440,900]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>{navigateToMenu('scan');layoutScanFrame();});await page.waitForTimeout(150);
   const bounds=await page.evaluate(()=>{const a=document.getElementById('btn-snap-photo').getBoundingClientRect(),b=document.querySelector('#nav-btn-scan .nav-fab').getBoundingClientRect();return {a:{top:a.top,bottom:a.bottom,left:a.left,right:a.right},b:{top:b.top,bottom:b.bottom,left:b.left,right:b.right},overflow:document.documentElement.scrollWidth>innerWidth};});
   check('Shutter unobscured at '+width+'x'+height,bounds.a.bottom<=bounds.b.top-8||bounds.a.right<=bounds.b.left||bounds.a.left>=bounds.b.right,bounds);
   check('No horizontal overflow '+width,!bounds.overflow);
  }
  await page.setViewportSize({width:360,height:800});await page.evaluate(()=>{navigateToMenu('log');renderLogRecords();});
  // 0.2.2.0 (UX brief R1): each tree card has one small 'Foto lagi' action; 'Ubah lokasi' moved into the timeline.
  const style=await page.locator('#logs-container .tree-card .btn').first().evaluate(e=>({height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontFamily,text:(e.getAttribute('aria-label')||e.textContent).trim()}));
  check('Location action slim visual with safe target',style.height>=44&&/Foto lagi/.test(style.text),style);
  check('Google Sans is loaded',await page.evaluate(async()=>{await document.fonts.ready;return document.fonts.check('13px "Google Sans"');})&&style.font.includes('Google Sans'));
  await page.screenshot({path:path.join(out,'history.png'),fullPage:true});
  await page.evaluate(()=>navigateToMenu('scan'));await page.waitForTimeout(150);await page.screenshot({path:path.join(out,'camera.png'),fullPage:true});
 }
 if(slice==='continuity'){
  await page.evaluate(()=>{navigateToMenu('log');renderLogRecords();});const b=page.locator('#logs-container .tree-card').getByRole('button',{name:'Foto lagi',exact:true}); // 0.2.2.0: R1 copy
  check('Each tree offers direct follow-up camera',await b.count()===1);
  if(await b.count()){
   await b.click();check('Same camera view opens with tree identity',await page.evaluate(()=>!document.getElementById('view-scan').classList.contains('hidden')&&selectedCaptureTree?.cropId==='tree219'));
   check('Tree context explicitly visible',await page.locator('#capture-tree-context').textContent().then(t=>t.includes('Mangga depan')));
   check('Navigation preserves identity of an unsent photo',await page.evaluate(()=>{selectedImageBase64='data:image/jpeg;base64,YWJj';navigateToMenu('log');const retained=selectedCaptureTree?.cropId==='tree219';navigateToMenu('scan');return retained;}));
   const queued=await page.evaluate(async()=>{
    let captured=null;const native=JagaNative.enqueue,put=JagaMedia.put;
    JagaNative.enqueue=async value=>{captured=value;};JagaMedia.put=async()=>({});
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
    selectedImageBase64='data:image/jpeg;base64,YWJj';selectedPhotoMetadata={source:'gallery-unknown'};
    await executeCropPathologyAnalysis();JagaNative.enqueue=native;JagaMedia.put=put;
    return captured;
   });
   check('Offline queued observation retains tree ID and label',queued?.fields?.cropId==='tree219'&&queued?.fields?.cropName==='Mangga depan',queued?.fields);
   const recovered=await page.evaluate(()=>buildRecordFromJob({id:'job219',context:{cropId:'tree219'}},{crop:'Mangga',severity:'Healthy'},null));
   check('Recovered result joins same tree',recovered.cropId==='tree219');
   check('Already linked result does not ask for a new tree',await page.evaluate(()=>{pendingCropAssignment={record:{id:'new-result',cropId:'tree219',crop:'Mangga',lat:-6.25,lng:106.75}};promptCropAssignment();const closed=document.getElementById('modal-crop-assign').classList.contains('hidden');closeCropAssignModal();return closed&&pendingCropAssignment===null;}));
   await page.evaluate(()=>{resetToLiveCamera();navigateToMenu('log');});check('Cancelling capture clears follow-up identity',await page.evaluate(()=>selectedCaptureTree===null));
   await page.evaluate(()=>startTreeCapture('tree219'));await page.evaluate(()=>resetAccountUiState());check('Account reset clears tree identity',await page.evaluate(()=>selectedCaptureTree===null));
  }
 }
 if(slice==='drafts'){
  await page.evaluate(()=>navigateToMenu('log'));await page.waitForTimeout(200);
  await page.evaluate(async()=>{workflowJobs.clear();const a={accountId:'fixture219',status:'pending',createdMs:Date.now(),fields:{cropId:'tree219',cropName:'Mangga depan',cropHint:'Mangga'}};window.JagaNative.list=async()=>({drafts:[{...a,clientRequestId:'d1'},{...a,clientRequestId:'d2'},{...a,clientRequestId:'d3',fields:{cropId:'tree-other',cropName:'Mangga belakang',cropHint:'Mangga'}}]});await updateOfflineDraftCount();});
  // 0.2.2.0 (UX brief D1): one compact strip, one row per photo titled with its tree identity (not the species).
  const titles=await page.locator('#offline-drafts-list .draft-row-title').allTextContents();
  check('Drafts grouped by tree identity not species',titles.length===3&&titles.filter(t=>t==='Mangga depan').length===2&&titles.filter(t=>t==='Mangga belakang').length===1,titles);
  {
   check('Tree summary includes label and draft count',/^3 belum terkirim/.test(await page.locator('#drafts-summary').textContent())&&titles.includes('Mangga depan'));
   await page.locator('#drafts-toggle').click();check('Expand reveals both retained observations',await page.locator('#offline-drafts-list .draft-row:visible').count()===3&&await page.locator('#offline-drafts-list [data-view-draft]').count()===3);
   await page.evaluate(()=>updateOfflineDraftCount());check('Refresh preserves expanded tree',await page.evaluate(()=>JagaDraftsStrip.isExpanded()&&!document.getElementById('offline-drafts-list').hidden));
   await page.screenshot({path:path.join(out,'drafts.png'),fullPage:true});
  }
 }
 if(slice==='daily'){
  await page.evaluate(()=>{const today=Date.now();farmRecords=[{id:'a',cropId:'a',crop:'Mangga',condition:'Daun sehat',severity:'Healthy',createdMs:today},{id:'b',cropId:'b',crop:'Pisang',condition:'Bercak daun',severity:'Moderate',createdMs:today}];renderHomeDaily();});
  const text=await page.locator('#home-daily-card .daily-narrative').textContent().catch(()=>null);// 0.2.2.0 (UX brief B5): a short plain summary (at most ~3 lines) that keeps the facts and the advice.
  check('Daily display is a thorough paragraph',text&&text.length<=320&&!text.includes(';')&&/Mangga/.test(text)&&/Pisang/.test(text)&&/Saran/.test(text),{text});
  const listen=page.locator('#home-daily-card').getByRole('button',{name:'Dengarkan',exact:true});check('Daily narration control exists',await listen.count()===1);
  if(await listen.count()){await listen.click();check('Narration matches displayed paragraph exactly',await page.evaluate(text=>window.__spoken.at(-1)===text,text));}
  await page.screenshot({path:path.join(out,'daily.png'),fullPage:true});
 }
 check('No uncaught application errors',errors.length===0,errors);
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(out,slice+'.json'),JSON.stringify({scope:'Synthetic real-browser fixtures; no live user, device or production',checks},null,2));console.log(JSON.stringify({slice,checks:checks.length,failed:checks.filter(c=>!c.ok)},null,2));if(checks.some(c=>!c.ok))process.exitCode=1;}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
