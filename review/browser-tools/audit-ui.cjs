const fs = require('fs');
const path = require('path');
const http = require('http');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../../app/frontend');
const out = path.resolve(__dirname, '../screenshots');
fs.mkdirSync(out, {recursive:true});
const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
const server = http.createServer((req,res)=>{
  let name = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if (!file.startsWith(root+path.sep)) {res.writeHead(400);res.end();return;}
  try {const data=fs.readFileSync(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);}
  catch {res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 const results=[];
 try {
  for(const viewport of [{width:320,height:568},{width:360,height:800},{width:768,height:1024},{width:1440,height:900}]){
   const context=await browser.newContext({viewport,permissions:['camera','geolocation'],geolocation:{latitude:0,longitude:0,accuracy:30},serviceWorkers:'block'});
   const page=await context.newPage();let signedIn=false;
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/api/**',route=>{
    const u=new URL(route.request().url());let body=[];
    if(u.pathname==='/api/auth/me')body=signedIn?{ok:true,account:{id:'synthetic-browser-owner',name:'Fixture petani',email:'fixture@example.test',role:'user',dailyQuota:20},csrf:'synthetic-csrf'}:{ok:false,account:null};
    if(u.pathname==='/api/health')body={ok:true,version:'fixture'};
    if(u.pathname==='/api/telemetry')body={lat:0,lng:0,elevation:null,weather:null,locationName:null};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   });
   await page.route(/https:\/\/.*(google\.com\/vt|tile\.openstreetmap\.org|arcgisonline|cartocdn)/,route=>route.abort());
   await page.goto(base,{waitUntil:'networkidle',timeout:60000});await page.waitForTimeout(900);
   const authBackgroundInert=await page.evaluate(()=>document.querySelector('#app-shell > main').inert && document.getElementById('desktop-nav').inert);
   await page.screenshot({path:path.join(out,`login-${viewport.width}.png`),fullPage:true});
   await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
   const loginAxe=await page.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary})).slice(0,12)}));});
   signedIn=true;await page.reload({waitUntil:'networkidle',timeout:60000});await page.waitForTimeout(500);
   const views=[];
   for (const menu of ['home','scan','map','log']){
    await page.evaluate(menu=>navigateToMenu(menu),menu);await page.waitForTimeout(300);
    const metrics=await page.evaluate(menu=>{
     const rect=id=>{const el=document.getElementById(id);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(el).display};};
     return {menu,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,shell:rect('app-shell'),view:rect('view-'+menu),camera:rect('scan-frame'),nav:['home','scan','map','log'].map(x=>rect('nav-btn-'+x))};
    },menu);
    await page.addScriptTag({path:require.resolve('axe-core/axe.min.js')});
    const accessibility=await page.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary})).slice(0,12)}));});
    metrics.accessibility=accessibility;
    metrics.layoutChecks=await page.evaluate(menu=>{
      const visible=el=>!!el&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().height>0;
      const unexpectedModals=Array.from(document.querySelectorAll('[id^="modal-"]')).filter(visible).map(x=>x.id);
      const within=el=>{if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;};
      const checks={noSpuriousDialogs:unexpectedModals.length===0,unexpectedModals};
      if(menu==='scan'){
        const frame=document.getElementById('scan-frame'),r=frame.getBoundingClientRect();
        checks.cameraWithinViewport=within(frame);checks.camera3by4=Math.abs(r.width/r.height-.75)<.01;
        checks.shutterWithinViewport=within(document.getElementById('btn-snap-photo'));
      }
      if(menu==='map'){
        const view=document.getElementById('view-map').getBoundingClientRect();
        const toolbar=document.getElementById('map-toolbar').getBoundingClientRect();
        checks.mapToolbarAtTop=toolbar.top>=view.top&&toolbar.top-view.top<=24;
        checks.mapToolbarWithinViewport=within(document.getElementById('map-toolbar'));
      }
      return checks;
    },menu);
    await page.screenshot({path:path.join(out,`${menu}-${viewport.width}.png`),fullPage:true});views.push(metrics);
   }
   results.push({viewport,errors,loginAxe,authBackgroundInert,views});await context.close();
  }
  fs.writeFileSync(path.resolve(__dirname,'../browser-baseline.json'),JSON.stringify({scope:'Synthetic UI fixture; no real diagnosis, no production state; map tiles intentionally blocked',results},null,2));
  console.log(JSON.stringify(results.map(r=>({width:r.viewport.width,errors:r.errors,axe:r.loginAxe.map(x=>({id:x.id,impact:x.impact,nodes:x.nodes.length})),views:r.views.map(v=>({menu:v.menu,documentWidth:v.documentWidth,shellWidth:v.shell.width,camera:v.menu==='scan'?v.camera:null}))})),null,2));
  if(results.some(r=>!r.authBackgroundInert||r.errors.length||r.loginAxe.length||r.views.some(v=>v.accessibility.length||v.documentWidth>v.viewport+1||Object.values(v.layoutChecks).some(x=>x===false))))process.exitCode=1;
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
