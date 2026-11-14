const fs=require('fs');
const path=require('path');
// This existing offline workflow starts after the separately-tested first-use guide.
require('./tour-fixture.cjs');
const {chromium}=require('playwright');
const base=process.argv[2],jpeg=process.argv[3];
const parsed=new URL(base);
if(parsed.hostname!=='127.0.0.1'||parsed.protocol!=='http:'||['','8000','8010','80'].includes(parsed.port))throw new Error('Refusing non-isolated target');
const output=path.resolve(__dirname,'../offline-e2e.json');
const checks=[];function check(name,ok,detail=''){checks.push({name,ok:!!ok,detail});if(!ok)throw new Error(name+' '+detail);}
async function waitAsync(page,predicate,arg){
 const deadline=Date.now()+25000;
 while(Date.now()<deadline){if(await page.evaluate(predicate,arg))return;await page.waitForTimeout(100);}
 const diagnostic=await page.evaluate(async()=>({drafts:await JagaNative.list({accountId:JagaAppAccount().id}),sync:document.getElementById('sync-status')?.textContent,notice:typeof syncNotice==='undefined'?null:syncNotice,network:window.fixtureNetwork}));
 throw new Error('Async IndexedDB condition timed out: '+JSON.stringify(diagnostic));
}
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 const context=await browser.newContext({viewport:{width:390,height:844},permissions:['camera','geolocation'],geolocation:{latitude:0,longitude:0,accuracy:30}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.stack || e.message));
 await page.addInitScript(()=>{window.fixtureNetwork=[];const real=fetch;window.fetch=async(...args)=>{const url=String(args[0]),tracked=/\/api\/(analyze|health)/.test(url);if(tracked)fixtureNetwork.push({url,event:'start'});try{const response=await real(...args);if(tracked)fixtureNetwork.push({url,event:'response',status:response.status});return response;}catch(e){if(tracked)fixtureNetwork.push({url,event:'error',message:e.message});throw e;}};});
 const admin=await browser.newContext();
 try {
  let response=await context.request.post(base+'/api/auth/register',{data:{email:'offline-fixture-a@example.test',password:'SyntheticFixture123',name:'Petani A (uji)'}});
  check('Synthetic account A registration',response.status()===200);const accountA=(await response.json()).account;
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof JagaAppAccount==='function'&&JagaAppAccount());
  check('Real app identifies authenticated fixture',await page.evaluate(id=>JagaAppAccount().id===id,accountA.id));
  await page.waitForFunction(()=>navigator.serviceWorker.controller,{timeout:20000});
  check('Real service worker controls app shell',true);
  await context.setOffline(true);await page.evaluate(()=>navigateToMenu('scan'));
  await page.locator('input[type=file]').first().setInputFiles({name:'gallery-fixture.jpg',mimeType:'image/jpeg',buffer:fs.readFileSync(jpeg)});
  await page.locator('#photo-review-controls').waitFor({state:'visible'});
  // 0.2.2.0 (UX brief S3): the optional crop hint is behind 'Tambah jenis tanaman (opsional)'.
  if(await page.locator('#crop-hint-toggle').isVisible())await page.locator('#crop-hint-toggle').click();
  await page.locator('#crop-hint-input').fill('Kopi — pengamatan uji');
  await page.locator('#btn-run-analysis').click();
  await waitAsync(page,async()=>{const a=JagaAppAccount();return a&&(await JagaNative.list({accountId:a.id})).drafts.length===1;});
  let draft=(await page.evaluate(async()=>JagaNative.list({accountId:JagaAppAccount().id}))).drafts[0];
  check('Offline gallery capture durably queued before network',draft.status==='pending',draft.status);
  const requestId=draft.clientRequestId;
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof JagaAppAccount==='function'&&JagaAppAccount());
  draft=(await page.evaluate(async()=>JagaNative.list({accountId:JagaAppAccount().id}))).drafts[0];
  check('Offline reload restores same-account draft and key',draft&&draft.clientRequestId===requestId);
  check('No horizontal overflow on offline reopen',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  let lost=false,accepted=null;
  await page.route('**/api/analyze',async route=>{
   if(route.request().method()==='POST'&&!lost){const r=await route.fetch();accepted=await r.json();lost=true;return route.abort('failed');}
   return route.continue();
  });
  await page.evaluate(()=>{for(const name of ['start','stop']){const real=JagaOfflineSync[name];JagaOfflineSync[name]=function(...args){fixtureNetwork.push({event:'sync-'+name});return real.apply(this,args);};}});
  await context.setOffline(false);
  await page.evaluate(()=>syncPendingDrafts());
  await waitAsync(page,async()=>{const a=JagaAppAccount();const rows=a&&(await JagaNative.list({accountId:a.id})).drafts;return rows&&rows.length>0;});
  for(let i=0;i<30&&!lost;i++)await page.waitForTimeout(100);
  check('Upload accepted on actual backend but client response deliberately lost',lost&&accepted&&accepted.job_id);
  await page.evaluate(()=>syncPendingDrafts());
  await waitAsync(page,async key=>{const a=JagaAppAccount();return a&&(await JagaNative.list({accountId:a.id})).drafts.some(d=>d.clientRequestId===key&&d.status==='submitted'&&d.jobId);},requestId);
  draft=(await page.evaluate(async()=>JagaNative.list({accountId:JagaAppAccount().id}))).drafts.find(d=>d.clientRequestId===requestId);
  check('Lost-response retry recovers identical backend job',draft.jobId===accepted.job_id,JSON.stringify({receipt:draft.jobId,accepted:accepted.job_id,key:requestId}));
  await page.reload({waitUntil:'networkidle'});
  await page.waitForFunction(()=>typeof JagaAppAccount==='function'&&JagaAppAccount());
  draft=(await page.evaluate(async()=>JagaNative.list({accountId:JagaAppAccount().id}))).drafts.find(d=>d.clientRequestId===requestId);
  check('Submitted receipt survives page reload while analysis waiting',draft&&draft.jobId===accepted.job_id&&draft.status==='submitted');
  response=await admin.request.post(base+'/api/auth/login',{data:{email:'admin@jagakebond.local',password:'AdminLokal123'}});
  check('Isolated admin login for fixture assertion',response.status()===200);
  const adminCsrf=(await response.json()).csrf;
  response=await admin.request.get(base+'/api/admin/queue?limit=50');
  const jobs=(await response.json()).jobs.filter(j=>j.accountId===accountA.id);
  check('Exactly one server job after response-loss retry',jobs.length===1,String(jobs.length));
  const workerHeaders={'X-Worker-Token':'dev-local-worker-token'};
  const claimed=await (await admin.request.get(base+'/api/queue/next?worker=offline-e2e',{headers:workerHeaders})).json();
  check('Synthetic worker obtains the current fenced claim',claimed.job?.id===accepted.job_id&&!!claimed.job?.claimToken);
  response=await admin.request.post(base+'/api/analyze/'+accepted.job_id+'/result',{headers:workerHeaders,data:{claimToken:claimed.job.claimToken,triage:{usable:true,is_plant:true,reason:'Foto sintetis jelas.'},diagnosis:{crop:'Kopi (fixture integrasi)',condition:'Hasil sintetis pengujian, bukan diagnosis nyata',severity:'Moderate',confidence:.6,needs_review:true,symptoms_id:'Gejala sintetis fixture',immediate_action_id:'Semprot bahan kimia',assessment:{version:1,active_conditions:[],findings:['Gejala sintetis.'],possible_causes:[],actions:['Periksa daun.'],prevention:[],nutrition:[],monitoring:['Foto ulang.'],escalation:[]}}}});
  check('Synthetic worker result passes actual authenticated completion route',response.status()===200);
  await page.evaluate(()=>recoverPendingAnalyses());
  await page.waitForFunction(()=>farmRecords.some(r=>r.source==='ai'),{timeout:20000});
  const record=await page.evaluate(()=>farmRecords.find(r=>r.source==='ai'));
  check('Recovered result is owned authoritative record',record.id==='record_'+accepted.job_id&&record.needs_review===true);
  const serverPhoto=record.serverImageUrl||record.imageUrl;
  check('Recovered result retains server fallback and prefers device preview',typeof serverPhoto==='string'&&serverPhoto.startsWith('/api/photos/')&&record.imageUrl.startsWith('data:image/jpeg;'));
  const localPhoto=await page.evaluate(id=>JagaMedia.get({accountId:String(JagaAppAccount().id),photoId:id}),record.id);
  check('Recovered original remains in private device archive after receipt recovery',typeof localPhoto.imageBase64==='string'&&localPhoto.imageBase64.length>0);
  response=await context.request.get(base+serverPhoto);
  check('Recovered photo endpoint serves a real JPEG',response.status()===200&&(await response.body()).subarray(0,2).equals(Buffer.from([255,216])));
  await page.evaluate(id=>{pendingStatusRecordId=id;return confirmStatusChange('Healthy');},record.id);
  response=await context.request.get(base+'/api/records');const after=(await response.json()).find(r=>r.id===record.id);
  check('Farmer status changes separately from immutable AI result',after.observedSeverity==='Healthy'&&after.severity==='Moderate'&&after.confidence===.6);
  // 0.2.4.16: the strict CSP (script-src 'self') blocks an injected <script>; evaluate axe through the devtools channel instead.
  await page.evaluate(fs.readFileSync(require.resolve('axe-core/axe.min.js'),'utf8'));
  const audits=[];
  for(const state of ['history','daily-dialog']){
   await page.evaluate(state=>state==='history'?navigateToMenu('log'):openDailyModal(),state);
   const violations=await page.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));});
   audits.push({state,violations});
   if(state==='daily-dialog'){
    await page.keyboard.press('Escape');
    check('Daily dialog closes with real Escape key',await page.locator('#modal-daily').isHidden());
   }
  }
  check('Rendered populated history and daily dialog pass automated accessibility',audits.every(x=>x.violations.length===0),JSON.stringify(audits));
  // Persist another draft then log out; browser data must not bleed into account B.
  await context.setOffline(true);
  await page.evaluate(()=>{navigateToMenu('scan');resetToLiveCamera();});
  await page.locator('input[type=file]').first().setInputFiles({name:'second-fixture.jpg',mimeType:'image/jpeg',buffer:fs.readFileSync(jpeg)});
  await page.locator('#photo-review-controls').waitFor({state:'visible'});await page.locator('#btn-run-analysis').click();
  await waitAsync(page,async()=>{const a=JagaAppAccount();return a&&(await JagaNative.list({accountId:a.id})).drafts.some(d=>d.status==='pending');});
  check('New photo receives a fresh idempotency key',await page.evaluate(async old=>(await JagaNative.list({accountId:JagaAppAccount().id})).drafts.some(d=>d.status==='pending'&&d.clientRequestId!==old),requestId));
  await page.evaluate(()=>logout());
  check('Offline logout locks app session',await page.evaluate(()=>!JagaAppAccount()));
  check('Offline logout rejects access to A drafts',await page.evaluate(async id=>{try{await JagaNative.list({accountId:id});return false;}catch{return true;}},accountA.id));
  await context.setOffline(false);
  response=await context.request.post(base+'/api/auth/register',{data:{email:'offline-fixture-b@example.test',password:'SyntheticFixture123',name:'Petani B (uji)'}});
  const accountB=(await response.json()).account;check('Synthetic account B registration',response.status()===200);
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(id=>typeof JagaAppAccount==='function'&&JagaAppAccount()?.id===id,accountB.id);
  check('Account B has no A drafts or history',await page.evaluate(async()=>farmRecords.length===0&&(await JagaNative.list({accountId:JagaAppAccount().id})).drafts.length===0));
  check('No frontend runtime errors throughout real HTTP fixture',errors.length===0,errors.join('; '));
 }finally{
  fs.writeFileSync(output,JSON.stringify({scope:'Real Chromium+IndexedDB+service-worker+isolated FastAPI HTTP; worker diagnosis explicitly synthetic, no model/production call',checks,errors},null,2));
  console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,total:checks.length,failed:checks.filter(x=>!x.ok),errors},null,2));
  await context.close();await admin.close();await browser.close();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
