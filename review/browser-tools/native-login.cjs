const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../../app/frontend');
const bridgeFile=path.resolve(__dirname,'../../android-client/node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js');
const runtime=fs.readFileSync(bridgeFile,'utf8');
const server=http.createServer((req,res)=>{let file=path.join(root,new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())file=path.join(root,'index.html');res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(file));});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});const checks=[];
 try{
 for(const scenario of ['injected-plugin','missing-plugin','null-login','html-login']){
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  await page.route(/https:\/\//,r=>r.abort());
  await page.addInitScript({content:`window.Capacitor={Plugins:{}};window.nativeCalls=[];window.androidBridge={postMessage(raw){const call=JSON.parse(raw);nativeCalls.push({method:call.methodName,path:call.options?.path});const profile={id:'native_fixture',name:'Fixture',email:'fixture@example.test'};let data={ok:true};if(call.methodName==='request'){const p=call.options.path;let body=p==='/api/auth/me'?{ok:false}:p==='/api/auth/login'?{ok:true,account:profile}:[];if(p==='/api/auth/login'&&${JSON.stringify(scenario)}==='null-login')body=null;if(p==='/api/auth/login'&&${JSON.stringify(scenario)}==='html-login')body='<html>Local fallback</html>';data={status:p==='/api/auth/me'?401:200,body,headers:{'content-type':'application/json'}};}if(call.methodName==='list')data={drafts:[]};queueMicrotask(()=>Capacitor.fromNative({callbackId:call.callbackId,pluginId:call.pluginId,methodName:call.methodName,success:true,data}));}};\n${runtime}\nif(${JSON.stringify(scenario)}!=='missing-plugin'){const plugin=Capacitor.Plugins.JagaSync={};for(const method of ['request','activate','lock','list','enqueue','remove'])plugin[method]=options=>Capacitor.nativePromise('JagaSync',method,options);}`});
  await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
  await page.locator('#auth-email').fill('fixture@example.test');await page.locator('#auth-password').fill('SYNTHETIC_TEST_ONLY');await page.locator('#auth-submit').click();await page.waitForTimeout(300);
  const result=await page.evaluate(()=>({native:JagaNative.isNative(),account:JagaAppAccount()?.id||null,error:document.getElementById('auth-error').textContent,calls:nativeCalls,registerPlugin:typeof Capacitor.registerPlugin}));
  const ok=scenario==='injected-plugin'?result.native&&result.account==='native_fixture'&&result.calls.some(c=>c.path==='/api/auth/login'):!result.account&&!!result.error&&!result.error.includes('Cannot read properties')&&(scenario!=='missing-plugin'||!result.calls.some(c=>c.path==='/api/auth/login'));
  checks.push({scenario,ok,...result});await context.close();
 }
 }finally{console.log(JSON.stringify(checks,null,2));fs.writeFileSync(path.resolve(__dirname,'../native-login-results.json'),JSON.stringify({scope:'Real Capacitor 8 native-bridge.js plus JSExport-equivalent plugin methods and synthetic native replies in Chromium; not physical-device evidence',checks},null,2));await browser.close();await new Promise(r=>server.close(r));}
 if(checks.some(c=>!c.ok))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
