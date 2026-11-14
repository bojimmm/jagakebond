const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../../app/frontend');
const server=http.createServer((req,res)=>{let f=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(f===root)f=path.join(root,'index.html');try{if(!f.startsWith(root+path.sep))throw Error();const b=fs.readFileSync(f);res.setHeader('Content-Type',f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.html')?'text/html':'application/octet-stream');res.end(b);}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const checks=[];
 try{
 for(const scenario of ['queue-response','queue-between-saves','logout-local-lock','telemetry-order','telemetry-account']){
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  await page.route('**/api/**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(r.request().url().includes('/auth/me')?{ok:true,account:{id:'fixture-A',name:'Fixture',email:'fixture@example.test'}}:[])}));await page.route(/https:\/\//,r=>r.abort());
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount()&&loadedOnce);await page.waitForTimeout(100);
  const result=await page.evaluate(async scenario=>{
   refreshAllData=async()=>undefined;
   let release;
   if(scenario==='queue-response'){
    let saves=0;fetch=async()=>new Promise(r=>release=()=>r({status:200,ok:true,text:async()=>JSON.stringify([{id:'job_A',status:'done',diagnosis:{}}])}));saveRecord=async()=>{saves++;return {id:'fixture'};};
    const run=recoverPendingAnalyses();for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,5));if(!release)throw Error('Recovery never reached held queue request');accountGeneration++;currentAccount={id:'fixture-B'};release();await run;return {ok:saves===0,saves};
   }
   if(scenario==='queue-between-saves'){
    let saves=0,acks=0;api=async()=>[{id:'job_A1',status:'done',diagnosis:{}},{id:'job_A2',status:'done',diagnosis:{}}];
    saveRecord=async()=>{saves++;if(saves===1){accountGeneration++;currentAccount={id:'fixture-B'};}return {id:'fixture'};};acknowledgeJob=()=>acks++;
    await recoverPendingAnalyses();return {ok:saves===1&&acks===0,saves,acks};
   }
   if(scenario==='logout-local-lock'){
    let locks=0;JagaNative={isNative:()=>true,lock:async()=>{locks++;}};api=async()=>new Promise(r=>release=()=>r({ok:true}));
    const old=accountGeneration,run=logout();for(let i=0;!release&&i<100;i++)await new Promise(r=>setTimeout(r,5));const ok=currentAccount===null&&accountGeneration>old&&locks>0&&!document.getElementById('auth-gate').classList.contains('hidden');release();await run;return {ok,locks};
   }
   const pending=[];fetch=async()=>new Promise(r=>pending.push(data=>r({ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data)})));
   applyLiveGpsReading(1,1,3);
   if(scenario==='telemetry-order'){
    applyLiveGpsReading(2,2,5);const singleFlight=pending.length===1;pending[0]({locationName:'Old fix',elevation:[11],weather:'Old'});await new Promise(r=>setTimeout(r,10));
    const rejected=currentCoords.locationName===null&&currentCoords.elevation===null;
    applyLiveGpsReading(2,2,5,true);pending[1]({locationName:'Newest fix',elevation:[22],weather:'New'});await new Promise(r=>setTimeout(r,10));
    return {ok:singleFlight&&rejected&&currentCoords.locationName==='Newest fix'&&currentCoords.elevation===22,coords:currentCoords};
   }
   accountGeneration++;currentAccount={id:'fixture-B'};currentCoords={lat:3,lng:3,locationName:'Owner B',elevation:33};pending[0]({locationName:'Owner A',elevation:[11]});await new Promise(r=>setTimeout(r,10));return {ok:currentCoords.locationName==='Owner B'&&currentCoords.elevation===33,coords:currentCoords};
  },scenario);checks.push({name:scenario,...result});await context.close();
 }
 }finally{console.log(JSON.stringify(checks,null,2));fs.writeFileSync(path.resolve(__dirname,'../account-races-results.json'),JSON.stringify({scope:'Deterministic Chromium timing fixtures, never production',checks},null,2));await browser.close();await new Promise(r=>server.close(r));}
 if(checks.some(c=>!c.ok))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
