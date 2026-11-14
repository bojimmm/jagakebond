/* Real browser, synthetic accounts only. Tour is NOT auto-dismissed here. */
const fs=require('fs'),path=require('path'),http=require('http'),{chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),checks=[];
const shots=process.argv.includes('--shots')?process.argv[process.argv.indexOf('--shots')+1]:null;
if(shots)fs.mkdirSync(shots,{recursive:true});
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.woff':'font/woff','.webmanifest':'application/manifest+json'};
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://local'),file=path.resolve(ROOT,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));});
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));};
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#a4c783"/></svg>';
const record={id:'tour-record',cropId:'tour-plant',crop:'Cabai',cropName:'Cabai contoh',condition:'Dugaan ulat pemakan daun',severity:'Moderate',confidence:.8,source:'ai',lat:-6.2,lng:106.8,timestampMs:Date.now(),createdMs:Date.now(),imageUrl:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'),assessment:{version:1,findings:['Daun berlubang'],possible_causes:['Dugaan ulat pemakan daun'],actions:['Periksa bawah daun'],prevention:['Pantau rutin'],monitoring:['Bandingkan foto'],escalation:['Hubungi penyuluh bila meluas'],nutrition:['Dugaan kekurangan hara belum dapat dipastikan; minta uji tanah.']}};
let browser;
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.JK_CHROME||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 async function fixture(width,height,existing=true,init){
  const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block',locale:'id-ID'}),page=await context.newPage(),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  if(init)await context.addInitScript(init);
  await context.route(/^https:\/\//,r=>r.abort());
  await context.route('**/api/**',route=>{
   const p=new URL(route.request().url()).pathname,m=route.request().method();if(m!=='GET')writes.push(p);
   let body=[];
   if(p==='/api/auth/me')body={ok:true,account:{id:'tour-fixture',name:'Data contoh',role:'user',email:'contoh@example.test'},csrf:'test'};
   if(p==='/api/auth/config')body={registrationOpen:false};
   if(p==='/api/auth/google/config')body={enabled:false};
   if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.4.3',capabilities:{treeContinuity:true,recordsPaging:true}};
   if(p==='/api/records')body={items:existing?[record]:[],next:null};
   if(p==='/api/telemetry')body={};
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(url,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.documentElement.dataset.session==='ready:tour-fixture');
  return{context,page,errors,writes};
 }
 for(const [width,height]of [[320,700],[390,844],[1440,920],[844,390]]){
  const tag=width+'x'+height,{context,page,errors,writes}=await fixture(width,height);
  await page.locator('#feature-tour').waitFor({state:'visible'});
  check(tag+' existing account receives guide without losing records',await page.evaluate(()=>farmRecords.length===1&&JagaAppAccount().id==='tour-fixture'));
  check(tag+' labeled modal and app inert',await page.locator('#feature-tour').getAttribute('aria-modal')==='true'&&await page.evaluate(()=>document.querySelector('#app-shell').inert));
  check(tag+' duplicate home actions removed',await page.locator('#home-actions').count()===0);
  const baseline=await page.evaluate(()=>({menu:currentMenuName,records:JSON.stringify(farmRecords),draft:selectedImageBase64}));
  for(let n=0;n<5;n++){
   const bounds=await page.evaluate(()=>{const p=document.querySelector('.tour-panel').getBoundingClientRect(),b=document.getElementById('tour-next').getBoundingClientRect();return{p:p.toJSON(),b:b.toJSON(),w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};});
   check(tag+' step '+(n+1)+' controls remain on screen',bounds.p.left>=0&&bounds.p.right<=width+1&&bounds.p.top>=0&&bounds.p.bottom<=height+1&&bounds.b.bottom<=height&&!bounds.overflow,bounds);
   check(tag+' step '+(n+1)+' accurate progress',await page.locator('.tour-progress').textContent()==='Langkah '+(n+1)+' dari 5');
   if(n===1){await page.locator('#tour-back').click();check(tag+' back returns to previous step',(await page.locator('#tour-title').innerText()).includes('Beranda'));await page.locator('#tour-next').click();}
   if(n===2)check(tag+' analysis tutorial explains uncertainty and prevention',(await page.locator('.tour-content').innerText()).includes('pencegahan')&&(await page.locator('.tour-tip').innerText()).includes('dugaan awal'));
   if(shots&&(n===0||n===2))await page.screenshot({path:path.join(shots,'tour-'+tag+'-'+n+'.png')});
   await page.locator('#tour-next').click();
  }
  check(tag+' complete closes guide and preserves screen/data',await page.locator('#feature-tour').isHidden()&&await page.evaluate(b=>currentMenuName===b.menu&&JSON.stringify(farmRecords)===b.records&&selectedImageBase64===b.draft,baseline));
  check(tag+' completion stored per account',await page.evaluate(()=>localStorage.getItem('jk-tour-1:tour-fixture')==='done'));
  await page.reload({waitUntil:'networkidle'});await page.waitForTimeout(800);
  check(tag+' completed guide does not repeat after reload',await page.locator('#feature-tour:not(.hidden)').count()===0);
  await page.getByRole('button',{name:'Akun saya'}).click();await page.locator('#account-open-tour').click();
  check(tag+' replay available through account menu',await page.locator('#feature-tour').isVisible());
  await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
  check(tag+' keyboard focus stays in guide',await page.evaluate(()=>!!document.activeElement.closest('#feature-tour')));
  await page.evaluate(()=>document.dispatchEvent(new Event('jagaBack')));
  check(tag+' Android back dismisses to account menu',await page.locator('#feature-tour').isHidden()&&await page.locator('#modal-account').isVisible());
  check(tag+' replay returns focus to its trigger',await page.evaluate(()=>document.activeElement.id==='account-open-tour'));
  await page.evaluate(()=>closeAccountModal());
  await page.evaluate(()=>{navigateToMenu('map');openBottomSheet(farmRecords[0].id);});await page.waitForTimeout(350);
  const b=await page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect().toJSON();return{a:r('#sheet-assessment button'),h:r('#sheet-open-history')};});
  check(tag+' analysis and history share one row',Math.abs(b.a.top-b.h.top)<2&&Math.abs(b.a.bottom-b.h.bottom)<2&&b.a.right<b.h.left,b);
  check(tag+' analysis/history touch targets at least 44px',b.a.height>=44&&b.h.height>=44&&b.a.width>=100&&b.h.width>=100,b);
  check(tag+' full analysis label wraps without ellipsis',await page.locator('#sheet-assessment .btn-label').evaluate(el=>getComputedStyle(el).whiteSpace==='normal'&&el.scrollWidth<=el.clientWidth+1));
  if(shots)await page.screenshot({path:path.join(shots,'sheet-'+tag+'.png')});
  await page.locator('#sheet-assessment button').click();check(tag+' sheet opens complete seven-section analysis',await page.locator('#assessment-dialog .assessment-section').count()===7);
  await page.getByRole('button',{name:'Tutup analisis'}).click();
  await page.locator('#sheet-open-history').click();check(tag+' neighboring history action opens same plant',await page.evaluate(()=>currentMenuName==='log'&&expandedCropId==='tour-plant'));
  await page.evaluate(()=>{farmRecords[0].assessment=null;navigateToMenu('map');openBottomSheet(farmRecords[0].id);});await page.waitForTimeout(350);
  check(tag+' legacy record has no empty analysis action',await page.locator('#sheet-assessment button').count()===0&&await page.locator('#sheet-open-history').isVisible());
  check(tag+' tour and navigation create no API mutations',writes.length===0,writes);
  check(tag+' no uncaught browser errors',errors.length===0,errors);
  await context.close();
 }
 {
  const{context,page}=await fixture(390,844,false);await page.locator('#feature-tour').waitFor({state:'visible'});
  check('new empty account also receives tutorial',await page.evaluate(()=>farmRecords.length===0));
  await page.locator('#tour-skip').click();await page.reload({waitUntil:'networkidle'});await page.waitForTimeout(800);
  check('skip is remembered and does not nag',await page.locator('#feature-tour:not(.hidden)').count()===0&&await page.evaluate(()=>localStorage.getItem('jk-tour-1:tour-fixture')==='skipped'));
  await page.evaluate(()=>{JagaTour.reset();currentAccount={id:'second-tour-fixture'};accountGeneration++;JagaTour.onSignedIn();});
  await page.locator('#feature-tour').waitFor({state:'visible'});check('another account receives its own tutorial',await page.locator('.tour-progress').textContent()==='Langkah 1 dari 5');
  await page.evaluate(()=>forceSignOut(''));
  check('logout cancels guide and clears dialog content',await page.locator('#feature-tour').count()===0&&await page.locator('#auth-gate').isVisible());
  check('logout never marks a different account complete',await page.evaluate(()=>localStorage.getItem('jk-tour-1:second-tour-fixture')===null));await context.close();
 }
 {
  const{context,page,errors}=await fixture(390,844,false,()=>{Storage.prototype.getItem=function(){throw new Error('Storage disabled');};Storage.prototype.setItem=function(){throw new Error('Storage disabled');};});
  await page.locator('#feature-tour').waitFor({state:'visible'});await page.locator('#tour-skip').click();await page.evaluate(()=>JagaTour.onSignedIn());await page.waitForTimeout(800);
  check('blocked storage still allows skipping without session repeat',await page.locator('#feature-tour:not(.hidden)').count()===0&&errors.length===0,errors);await context.close();
 }
 {
  const{context,page}=await fixture(390,844,false,()=>localStorage.setItem('jk-tour-1:tour-fixture','done'));
  await page.evaluate(()=>{localStorage.removeItem('jk-tour-1:tour-fixture');selectedImageBase64='data:image/jpeg;base64,fixture';currentMenuName='scan';JagaTour.onSignedIn();});await page.waitForTimeout(800);
  check('automatic guide waits for an in-progress capture',await page.locator('#feature-tour:not(.hidden)').count()===0&&await page.evaluate(()=>!!selectedImageBase64));
  await page.evaluate(()=>{selectedImageBase64=null;currentMenuName='home';});await page.locator('#feature-tour').waitFor({state:'visible'});
  check('deferred guide appears when capture ends',await page.locator('#tour-title').isVisible());
  await context.setOffline(true);await page.keyboard.press('Escape');await page.evaluate(()=>JagaTour.open());
  check('guide replays without a network connection',await page.locator('#feature-tour').isVisible());
  await page.evaluate(()=>{JagaTour.reset();localStorage.removeItem('jk-tour-1:tour-fixture');JagaTour.onSignedIn();forceSignOut('');});await page.waitForTimeout(800);
  check('stale signed-in timer never opens on login screen',await page.locator('#feature-tour').count()===0);await context.close();
 }
 const failed=checks.filter(c=>!c.ok);console.log('tour-0239: '+(checks.length-failed.length)+'/'+checks.length+' checks passed');process.exitCode=failed.length?1:0;
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});

