const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const source=path.resolve(__dirname,'../../app/frontend');
(async()=>{
 const server=http.createServer((req,res)=>{res.end('<!doctype html><title>Isolated outbox tests</title>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const checks=[];
 try{
 for(const scenario of ['400','413','422','409','429','401','restart-during-post','switch-during-health','native-photo-generation']){
  const context=await browser.newContext();const page=await context.newPage();
  await page.goto('http://127.0.0.1:'+server.address().port);
  if(scenario==='native-photo-generation')await page.evaluate(()=>{
   window.Capacitor={registerPlugin:()=>({request:()=>new Promise(r=>window.releasePhoto=r),lock:async()=>({ok:true})})};
  });
  for(const file of ['native-adapter.js','offline-store.js','offline-sync.js'])await page.addScriptTag({path:path.join(source,file)});
  const result=await page.evaluate(async scenario=>{
   if(scenario==='native-photo-generation'){
    const pending=JagaNative.resolveImageUrl('/api/photos/photo_fixture');await JagaNative.lock();
    releasePhoto({status:200,encoding:'base64',body:'YWJj',headers:{'content-type':'image/jpeg'}});
    return {ok:await pending==='',detail:'Delayed native photo must not produce an old-account blob after lock'};
   }
   let account={id:'fixture-A'},posts=0,auth=false;JagaAppAccount=()=>account;onOfflineSyncError=e=>{auth=auth||!!e.auth;};
   await JagaOfflineStore.activate(account.id);
   await JagaOfflineStore.enqueue({accountId:account.id,clientRequestId:'capture_test_'+scenario.replace(/-/g,'_'),imageBase64:'YWJj',fields:{}});
   let release;
   fetch=async(url)=>{
    if(url==='/api/health'){
     if(scenario==='switch-during-health')await new Promise(r=>release=r);
     return {ok:true,json:async()=>({ok:true,version:'2.1.0'})};
    }
    posts++;if(scenario==='restart-during-post'){await new Promise(r=>release=r);throw new TypeError('Synthetic lost upload response');}const status=Number(scenario);return {ok:false,status,headers:{get:()=>scenario==='429'?'1':null},json:async()=>({detail:'Synthetic '+scenario})};
   };
   const run=JagaOfflineSync.run();
   if(scenario==='restart-during-post'){
    for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,5));
    if(!release)throw Error('Upload never reached held POST');
    JagaOfflineSync.start();release();await run;JagaOfflineSync.stop();
    const row=(await JagaOfflineStore.list({accountId:account.id})).drafts[0];
    return {ok:row.status==='pending'&&posts===1,detail:JSON.stringify({status:row.status,posts})};
   }
   if(scenario==='switch-during-health'){
    for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,5));
    JagaOfflineSync.stop();await JagaOfflineStore.lock();account={id:'fixture-B'};await JagaOfflineStore.activate(account.id);release();await run;
    return {ok:posts===0,detail:'Original-owner photo must never POST with new-owner session; posts='+posts};
   }
   await run;await JagaOfflineSync.run();
   if(scenario==='401'){
    let locked=false;try{await JagaOfflineStore.list({accountId:account.id});}catch{locked=true;}
    return {ok:auth&&locked&&posts===1,detail:JSON.stringify({auth,locked,posts})};
   }
   const rows=(await JagaOfflineStore.list({accountId:account.id})).drafts;
   return {ok:posts===1&&(scenario==='429'?rows[0].status==='pending':scenario==='409'?rows[0].status==='conflict':rows[0].status==='failed'),detail:JSON.stringify({posts,status:rows[0].status})};
  },scenario);
  checks.push({name:scenario,...result});await context.close();
 }
 }finally{console.log(JSON.stringify(checks,null,2));fs.writeFileSync(path.resolve(__dirname,'../offline-faults-results.json'),JSON.stringify({scope:'Real browser IndexedDB with synthetic network/native responses; not device evidence',checks},null,2));await browser.close();await new Promise(r=>server.close(r));}
 if(checks.some(x=>!x.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
