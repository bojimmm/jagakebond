const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../../app/frontend'),checks=[];
const out=path.resolve(__dirname,'../final-evidence-217');fs.mkdirSync(out,{recursive:true});
function check(name,ok,detail){checks.push({name,ok:!!ok,detail});}
const server=http.createServer((req,res)=>{const file=path.join(root,new URL(req.url,'http://fixture').pathname);const p=file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?file:path.join(root,'index.html');res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(p));});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const page=await browser.newPage({viewport:{width:360,height:800},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/https:\/\//,r=>r.abort());
 await page.route('**/api/**',r=>{const url=new URL(r.request().url());if(url.pathname==='/api/photos/crop-b')return r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQZkAAAAASUVORK5CYII=','base64')});const value=url.pathname==='/api/auth/me'?{ok:true,account:{id:'parent217',name:'Fixture',role:'user'}}:url.pathname==='/api/health'?{ok:true,version:'2.1.0'}:url.pathname==='/api/telemetry'?{locationName:'Nama tempat uji',elevation:42,tempC:28,rh:76,weather:'28°C • 76% RH',locationProvider:'open-meteo',locationApproximate:true}:[];return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});});
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount());await page.evaluate(()=>{localStorage.setItem('jk-tour-2:parent217','done');JagaTour.reset();JagaOfflineSync.stop();});
 await page.evaluate(()=>{farmRecords=[{id:'record-fixture',cropId:'crop-fixture',crop:'Cabai',condition:'Pengamatan',severity:'Moderate',lat:-6.25,lng:106.75,date:'Waktu uji',updatedMs:Date.now(),imageUrl:''}];});
 for(const [width,height]of [[320,568],[360,800],[768,900],[1440,900]]){
  await page.setViewportSize({width,height});await page.evaluate(()=>openLocationEditor('record','record-fixture'));await page.waitForTimeout(100);
  const geometry=await page.locator('#modal-location').evaluate(m=>{const d=m.querySelector('.workflow-dialog'),b=d.getBoundingClientRect();return{position:getComputedStyle(m).position,display:getComputedStyle(m).display,rect:{x:b.x,y:b.y,width:b.width,height:b.height},screen:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth>innerWidth,scroll:getComputedStyle(d).overflowY};});
  check('Actual location dialog contained '+width+'x'+height,geometry.position==='fixed'&&geometry.rect.x>=0&&geometry.rect.y>=0&&geometry.rect.x+geometry.rect.width<=width+1&&geometry.rect.y+geometry.rect.height<=height+1&&!geometry.overflow,geometry);
  check('Record location editor hides inference-only field '+width,!(await page.locator('#location-crop-wrap').isVisible()));
  await page.screenshot({path:path.resolve(__dirname,'../screenshots/location-217-parent-'+width+'.png'),fullPage:true});
  await page.keyboard.press('Escape');check('Location dialog Escape closes '+width,await page.locator('#modal-location').evaluate(e=>e.classList.contains('hidden')));await page.evaluate(()=>closeDialog('modal-location'));
 }
 await page.setViewportSize({width:360,height:800});await page.evaluate(()=>{navigateToMenu('home');currentCoords={...currentCoords,lat:-6.25,lng:106.75,accuracy:20,locationName:null};telemetrySnapshot=null;updateDashboardTelemetry();});
 const gps=await page.locator('#home-accuracy-tag').evaluate(e=>({text:e.textContent.trim(),w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,band:e.dataset.accuracy,label:e.getAttribute('aria-label')}));
 check('Home GPS is only a labelled green dot',gps.text===''&&gps.w<=12&&gps.h<=12&&gps.band==='good'&&!!gps.label,gps);
 check('Reference location card keeps coordinates and search out of the visible layout',await page.evaluate(()=>{const card=document.getElementById('home-accuracy-tag').closest('section');return !card.querySelector('#home-live-coordinates')&&!card.querySelector('#home-place-search')&&card.querySelector('#home-telemetry-status')?.classList.contains('sr-only')&&!!card.querySelector('#home-temp-val')&&!!card.querySelector('#home-elev-val')&&card.getBoundingClientRect().height<=150;}));
 await page.evaluate(()=>{currentCoords={...currentCoords,lat:-6.25,lng:106.75,accuracy:20};telemetrySnapshot={lat:-6.25,lng:106.75,elevation:640,locationName:'Ciomas, Kab. Bogor, Jawa Barat',locationApproximate:false,tempC:23,rh:85,weather:'23°C • 85% RH',updatedMs:Date.now()};updateDashboardTelemetry();});
 await page.screenshot({path:path.resolve(__dirname,'../screenshots/location-card-217-parent.png'),fullPage:true});
 const telemetryStates=await page.evaluate(async()=>{const real=api;let release;try{api=()=>new Promise(resolve=>release=resolve);telemetrySnapshot=null;telemetryRequest=null;applyLiveGpsReading(-6.25,106.75,20,true);const pending=document.getElementById('home-telemetry-status').textContent;release({locationName:'Kota fixture',locationProvider:'open-meteo',locationApproximate:true,elevation:42,tempC:28,rh:76,weather:'28°C'});await new Promise(r=>setTimeout(r,0));const loaded={name:document.getElementById('home-location-text').textContent,elevation:document.getElementById('home-elev-val').textContent};api=async()=>{throw Error('Fixture provider outage');};applyLiveGpsReading(-6.25,106.75,20,true);await new Promise(r=>setTimeout(r,0));return{pending,loaded,error:document.getElementById('home-telemetry-status').textContent};}finally{api=real;}});
 check('Location card visibly enters loading state',/memperbarui|memuat/i.test(telemetryStates.pending),telemetryStates);
 check('Location card renders returned place and elevation',telemetryStates.loaded.name.includes('Kota fixture')&&telemetryStates.loaded.elevation==='42',telemetryStates);
 check('Failed telemetry ends loading with actionable unavailable state',/gagal|belum dapat|tidak tersedia/i.test(telemetryStates.error),telemetryStates);
 await page.evaluate(()=>navigateToMenu('map'));await page.waitForTimeout(220);
 await page.evaluate(()=>{farmList=[{id:'plot1',name:'Petak uji',ring:[[-6.26,106.74],[-6.26,106.76],[-6.24,106.76],[-6.24,106.74],[-6.26,106.74]],areaM2:1000}];farmRecords=[{id:'old',cropId:'plant',crop:'Cabai',farmId:'plot1',lat:-6.25,lng:106.75,timestampMs:1,updatedMs:1},{id:'new',cropId:'plant',crop:'Cabai',farmId:'plot1',lat:-6.25,lng:106.75,elevation:null,timestampMs:2,updatedMs:2,condition:'Pengamatan',severity:'Moderate',date:'Uji',imageUrl:'/api/photos/crop-b'}];renderFarmPolygons();mapInstance.setView([-6.25,106.75],14);});await page.waitForTimeout(100);
 await page.evaluate(()=>{const shape=farmLayer.getLayers()[0];shape.fire('click');});
 check('Real Leaflet polygon selection opens one latest crop row',await page.locator('#farm-crops-list button').count()===1);
 // 0.2.4.13: the plot sheet shows the Beranda card (photo, condition, status, date), not a bare name.
 check('Plot sheet shows the plant as a full card',await page.evaluate(()=>{const c=document.querySelector('#farm-crops-list .att-item');return !!c&&!!c.querySelector('.att-name')&&!!c.querySelector('.att-sub')&&!!c.querySelector('.card-status [class*="badge"]')&&!c.getAttribute('onclick');}));
 await page.locator('#farm-crops-list button').click();
 check('Selected crop opens correct latest map detail',await page.evaluate(()=>currentDetailRecord?.id==='new'));
 check('Missing altitude renders a real unavailable label, never null/undefined',await page.locator('#sheet-meta-elev').textContent().then(t=>t==='Tidak tersedia'&&!/null|undefined/.test(t)));
 check('Selected crop thumbnail loads the protected photo',await page.waitForFunction(()=>{const e=document.getElementById('sheet-crop-thumb');return e?.complete&&e.naturalWidth===1;},{timeout:1000}).then(()=>true).catch(()=>false));
 await page.screenshot({path:path.resolve(__dirname,'../screenshots/crop-detail-217-parent.png'),fullPage:true});
 await page.locator('#sheet-crop-thumb').click();
 check('Selected crop photo opens a loaded full-screen preview',await page.waitForFunction(()=>{const e=document.getElementById('photo-viewer-image');return !document.getElementById('photo-viewer').classList.contains('hidden')&&e.complete&&e.naturalWidth===1;},{timeout:1000}).then(()=>true).catch(()=>false));
 await page.screenshot({path:path.resolve(__dirname,'../screenshots/crop-preview-217-parent.png'),fullPage:true});
 await page.evaluate(()=>closePhotoViewer());
 await page.evaluate(()=>{closeBottomSheet();closeFarmCrops();focusFarm('plot1');});
 check('Selecting same polygon reopens its dismissed crop list',await page.locator('#farm-crops-sheet').isVisible());
 const polygon=await page.evaluate(()=>{const shape=farmLayer.getLayers()[0],p=shape.getElement();p.focus();return{weight:shape.options.weight,outline:getComputedStyle(p).outlineStyle,svgPaths:farmLayer.getLayers().length,selected:selectedFarmId};});
 check('Only selected polygon boundary is bold, no rectangle outline',polygon.weight>=4&&polygon.outline==='none'&&polygon.svgPaths===1&&polygon.selected==='plot1',polygon);
 await page.evaluate(()=>{selectedFarmId=null;closeFarmCrops();renderFarmPolygons();});
 const svg=page.locator('#map-container .leaflet-overlay-pane path').first();
 const pathReady=await page.evaluate(()=>{const p=farmLayer.getLayers()[0].getElement();return p.getAttribute('role')==='button'&&p.getAttribute('tabindex')==='0';});
 check('Polygon exposes keyboard-operable selection semantics',pathReady);
 if(pathReady){await page.evaluate(()=>farmLayer.getLayers()[0].getElement().focus());await page.keyboard.press('Enter');check('Enter selects polygon and opens crop list',await page.locator('#farm-crops-sheet').isVisible());}
 check('Selected plot sheet leaves map tools accessible',await page.evaluate(()=>{const a=document.getElementById('farm-crops-sheet').getBoundingClientRect(),b=document.getElementById('btn-draw-farm').parentElement.getBoundingClientRect();return a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;}));
 await page.waitForFunction(()=>!mapInstance._animatingZoom && !mapInstance._panAnim?._inProgress);
 await page.evaluate(()=>{mapInstance.stop();mapInstance.invalidateSize();mapInstance.fitBounds(L.latLngBounds(farmList[0].ring),{paddingTopLeft:[32,112],paddingBottomRight:[72,176],animate:false});});
 await page.waitForFunction(()=>!mapInstance._animatingZoom && !mapInstance._panAnim?._inProgress);
 await page.screenshot({path:path.resolve(__dirname,'../screenshots/polygon-217-parent.png'),fullPage:true});
 await page.evaluate(()=>{navigateToMenu('home');farmRecords=[];renderDailyRecommendations();});
 check('Daily home explicitly handles no today uploads',(await page.locator('#home-daily-card').textContent()).toLowerCase().includes('hari ini'));
 const dailyPosts=[],dailyRows=[{id:'legacy',date:'2025-01-01',title:'Rekomendasi lama',sourceRecordIds:[],actions:[],zones:[]}];await page.route('**/api/daily',r=>{if(r.request().method()!=='POST')return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(dailyRows)});const body=r.request().postDataJSON();dailyPosts.push(body);const saved={...body,id:'daily-saved-fixture'};dailyRows.push(saved);return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(saved)});});
 await page.evaluate(()=>{const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);yesterday.setHours(12,0,0,0);farmRecords=[{id:'yesterday-row',cropId:'plant-a',crop:'Cabai',createdMs:yesterday.getTime(),updatedMs:Date.now(),observedSeverity:'Healthy',severity:'Severe'},{id:'today-row',cropId:'plant-b',crop:'Kopi',createdMs:Date.now(),updatedMs:Date.now()}];dailyRecommendations=[{id:'legacy',date:'2025-01-01',title:'Rekomendasi lama',sourceRecordIds:[],actions:[],zones:[]}];renderDailyRecommendations();});
 check('Rendering factual daily log makes no automatic writes',dailyPosts.length===0);
 await page.evaluate(()=>openDailyModal());await page.locator('#modal-daily button').filter({hasText:'Simpan'}).last().click();
 await page.waitForFunction(()=>document.getElementById('modal-daily').classList.contains('hidden'));
 check('Daily save includes only today uploaded source IDs',dailyPosts.length===1&&JSON.stringify(dailyPosts[0].sourceRecordIds)==='["today-row"]',dailyPosts);
 await page.evaluate(()=>refreshAllData());
 check('New daily save preserves legacy archive',await page.evaluate(()=>dailyRecommendations.some(r=>r.id==='legacy')&&dailyRecommendations.some(r=>r.id==='daily-saved-fixture')));
 await page.evaluate(()=>navigateToMenu('scan'));await page.waitForFunction(()=>{const v=document.getElementById('camera-stream');return v.videoWidth>0&&!v.classList.contains('hidden');});
 await page.evaluate(()=>takeSnapshotForReview());await page.evaluate(()=>{navigateToMenu('home');navigateToMenu('scan');});
 check('Selected photo remains unobscured after menu return',await page.locator('#camera-loading').evaluate(e=>e.classList.contains('hidden')));
 await page.evaluate(()=>resetToLiveCamera());await page.waitForFunction(()=>document.getElementById('camera-stream').videoWidth>0);
 check('Camera during switch hides stale video immediately',await page.evaluate(()=>{toggleCameraFacing();return document.getElementById('camera-stream').classList.contains('hidden');}));
 await page.waitForFunction(()=>{const v=document.getElementById('camera-stream');return v.videoWidth>0&&!v.classList.contains('hidden');});
 await page.screenshot({path:path.resolve(__dirname,'../screenshots/home-217-parent.png'),fullPage:true});
 check('No uncaught application errors',errors.length===0,errors);
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(out,'ui-parent-results.json'),JSON.stringify({scope:'Actual browser/Leaflet; synthetic accounts/records/GPS/provider replies, no physical device or production',checks},null,2));console.log(JSON.stringify({checks:checks.length,failed:checks.filter(c=>!c.ok)},null,2));if(checks.some(c=>!c.ok))process.exitCode=1;}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});

