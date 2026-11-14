/* Actual Leaflet/Geoman with synthetic API and synthetic tiles, never farmer data. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),checks=[];
const arg=process.argv.indexOf('--shots'),OUT=arg<0?null:path.resolve(process.argv[arg+1]);
if(OUT)fs.mkdirSync(OUT,{recursive:true});
const farms=[
 {id:'plot-a',name:'Petak contoh A',crop:'Cabai',areaM2:100,ring:[[-3.000045,103.999955],[-3.000045,104.000045],[-2.999955,104.000045],[-2.999955,103.999955],[-3.000045,103.999955]]},
 {id:'plot-b',name:'Petak contoh B',crop:'Tomat',areaM2:100,ring:[[-3.000045,104.000095],[-3.000045,104.000185],[-2.999955,104.000185],[-2.999955,104.000095],[-3.000045,104.000095]]}
];
const record={id:'record-fixture',crop:'Cabai',cropId:'plant-fixture',farmId:'plot-a',condition:'Data contoh',severity:'Healthy',lat:-3,lng:104,createdMs:1793318400000,timestampMs:1793318400000,imageUrl:'/api/photos/map_photo'};
const records = [
  record,
  {...record, id:'old-photo', timestampMs:record.timestampMs - 3600000, imageUrl:'/api/photos/older_photo'},
  {...record, id:'remote', cropId:'remote', crop:'Rambutan', lat:-3.1, lng:104.1, imageUrl:'/api/photos/offscreen_photo'},
  {...record, id:'unreadable', cropId:'unreadable', crop:'Tomat', severity:'Moderate', lat:-3.00007, imageUrl:'/api/photos/missing_photo'},
  {...record, id:'critical', cropId:'critical', crop:'Kopi', severity:'Severe', lat:-2.99993, lng:104.000025, imageUrl:''},
];
const pinPhoto = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBUODAsLDBkSEw8VHhsgHx4bHR0hJTApISMtJB0dKjkqLTEzNjY2ICg7Pzo0PjA1NjP/2wBDAQkJCQwLDBgODhgzIh0iMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzP/wAARCABgAGADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAQF/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AlQErFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/9k=','base64');
const tile='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#476241"/><path d="M0 75L256 110M45 0L95 256" stroke="#749260" stroke-width="24"/><path d="M0 180L256 235" stroke="#96886a" stroke-width="9"/><g fill="#354f32"><circle cx="35" cy="35" r="26"/><circle cx="165" cy="45" r="32"/><circle cx="200" cy="170" r="40"/><circle cx="45" cy="215" r="28"/></g></svg>';
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(p));});
function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{browser=await chromium.launch({executablePath:process.env.JK_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
for(const width of [390,1440]){
 const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'}),requests=[],writes=[],errors=[],thumbnails=[];
 await context.route(url=>url.protocol==='https:',route=>{
  const u=new URL(route.request().url());let z;
  if(u.hostname==='tile.openstreetmap.org')z=Number(u.pathname.split('/')[1]);
  else if(u.hostname==='server.arcgisonline.com')z=Number(u.pathname.split('/tile/')[1]?.split('/')[0]);
  else return route.abort();
  requests.push({host:u.hostname,z});return route.fulfill({status:200,contentType:'image/svg+xml',body:tile});
 });
 await context.route('**/api/**',route=>{const req=route.request(),p=new URL(req.url()).pathname;let body=[];
  if(req.method()!=='GET')writes.push(p);
  if(p==='/api/auth/me')body={ok:true,account:{id:'map-fixture',name:'Data contoh',role:'user'},csrf:'fixture'};
  if(p==='/api/auth/google/config')body={enabled:false};
  if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.3.7',capabilities:{recordsPaging:true,treeContinuity:true}};
  if(p==='/api/records')body={items:records,next:null};
  if(p.endsWith('/thumbnail')) {
    thumbnails.push(p);
    if(p==='/api/photos/map_photo/thumbnail') return route.fulfill({contentType:'image/jpeg',body:pinPhoto});
    return route.fulfill({status:404,contentType:'application/json',body:'{}'});
  }
  if(p==='/api/farms')body=farms;
  if(p==='/api/telemetry')body={};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>JagaAppAccount()&&loadedOnce&&farmList.length===2);
 await page.evaluate(()=>{JagaOfflineSync.stop();navigateToMenu('map');});
 await page.waitForFunction(()=>!mapNeedsFit&&!mapInstance._animatingZoom);
 await page.evaluate(()=>mapInstance.setView([-3,104],17,{animate:false}));
 check(`${width}: wide map uses letters and requests no thumbnails`,thumbnails.length===0
   && await page.locator('.map-pin-circle.has-photo').count()===0,thumbnails);
 await page.evaluate(()=>mapInstance.setView([-3,104],21,{animate:false}));
 const photoPin=page.locator('.leaflet-marker-icon[title^="Cabai"] .map-pin');
 await photoPin.locator('img:not([hidden])').waitFor();
 check(`${width}: close view loads the latest photo with a white circle border and keeps the missing-photo letter`,
   await photoPin.locator('.map-pin-circle').evaluate(el=>el.classList.contains('has-photo')
     && getComputedStyle(el).backgroundColor==='rgb(255, 255, 255)')
   && await page.locator('.leaflet-marker-icon[title^="Tomat"] .map-pin').textContent()==='T'
   && await page.locator('.leaflet-marker-icon[title^="Tomat"] .map-pin-circle.has-photo').count()===0);
 const colors=await page.evaluate(()=>Object.fromEntries(
   [...document.querySelectorAll('.custom-farm-pin:not(:has(.map-pin-stack))')]
     .map(pin=>[pin.title.split(' — ')[0],getComputedStyle(pin.querySelector('.map-pin-body')).fill])));
 check(`${width}: Sehat, Waspada and Kritis use green, yellow and red pins`,
   colors.Cabai==='rgb(21, 128, 61)'&&colors.Tomat==='rgb(243, 191, 49)'&&colors.Kopi==='rgb(220, 38, 38)',colors);
 const diameter=()=>photoPin.locator('.map-pin-circle').evaluate(el=>el.getBoundingClientRect().width);
 const smaller=await diameter();
 await page.evaluate(()=>mapInstance.setView([-3,104],22,{animate:false}));
 await photoPin.locator('img:not([hidden])').waitFor();
 check(`${width}: zooming in enlarges the photo circle without refetching`,
   (await diameter())>smaller&&thumbnails.filter(url=>url.includes('/map_photo/')).length===1);
 const centered=await photoPin.evaluate(pin=>{
   const body=pin.querySelector('.map-pin-body').getBoundingClientRect();
   const ring=pin.querySelector('.map-pin-circle').getBoundingClientRect();
   const photo=pin.querySelector('img').getBoundingClientRect();
   const close=(a,b)=>Math.abs(a-b)<0.15;
   return close(ring.width,ring.height)&&close(photo.width,photo.height)
     && close(ring.left+ring.width/2,body.left+body.width/2)
     && close(ring.top+ring.height/2,body.top+24*body.height/58)
     && close(photo.left-ring.left,ring.right-photo.right)
     && close(photo.top-ring.top,ring.bottom-photo.bottom);
 });
 check(`${width}: the ring and photo are concentric with the round pin head`,centered);
 check(`${width}: older and offscreen photos are not requested`,!thumbnails.some(url=>/older_photo|offscreen_photo/.test(url)),thumbnails);
 await page.evaluate(()=>mapInstance.setView([-3,104],17,{animate:false}));
 check(`${width}: zooming out restores the letter marker`,await photoPin.locator('img').count()===0);
 await page.evaluate(()=>mapInstance.setView([-3,104],21,{animate:false}));
 await photoPin.locator('img:not([hidden])').waitFor();
 check(`${width}: zooming back reuses the thumbnail`,thumbnails.filter(url=>url.includes('/map_photo/')).length===1,thumbnails);
 const source=JSON.stringify(await page.evaluate(()=>farmList.map(f=>f.ring)));
 for(const [type,native] of [['standard',19],['satellite',18]]){
  await page.waitForFunction(()=>!mapInstance._animatingZoom);
  requests.length=0;
  await page.evaluate(type=>{setMapLayer(type);mapInstance.stop();mapInstance.setView([-3,104],21,{animate:false});},type);
  await page.waitForFunction(()=>mapInstance.getZoom()===21&&!mapInstance._animatingZoom);
  await page.locator('#map-container').hover();await page.mouse.wheel(0,-1000);
  await page.waitForFunction(()=>mapInstance.getZoom()===22&&!mapInstance._animatingZoom).catch(async error=>{console.log('Zoom diagnostic',await page.evaluate(()=>({zoom:mapInstance.getZoom(),max:mapInstance.getMaxZoom(),wheel:mapInstance.scrollWheelZoom.enabled(),active:activeTileLayer.options,animating:mapInstance._animatingZoom,dialogs:[...document.querySelectorAll('[role=dialog]')].filter(e=>e.offsetWidth&&e.offsetHeight).map(e=>e.id)})));throw error;});
  await page.waitForTimeout(200);
  const state=await page.evaluate(()=>({zoom:mapInstance.getZoom(),max:mapInstance.getMaxZoom(),native:activeTileLayer._tileZoom,tiles:[...document.querySelectorAll('#map-container img.leaflet-tile')].filter(img=>img.complete&&img.naturalWidth>0).length,tileLevels:[...document.querySelectorAll('#map-container img.leaflet-tile')].filter(img=>img.complete&&img.naturalWidth>0).map(img=>{const p=new URL(img.currentSrc).pathname;return Number(p.includes('/tile/')?p.split('/tile/')[1].split('/')[0]:p.split('/')[1]);})}));
  check(`${width}: ${type} wheel zoom reaches 22 with visible tiles`,state.zoom===22&&state.max===22&&state.native===native&&state.tiles>0,state);
  check(`${width}: ${type} never requests unsupported native tile levels`,state.tileLevels.length>0&&state.tileLevels.every(z=>z<=native)&&requests.every(r=>r.z<=native),{requested:requests,visible:state.tileLevels});
  await page.evaluate(()=>mapInstance.zoomIn(3,{animate:false}));
  check(`${width}: ${type} maximum remains bounded`,await page.evaluate(()=>mapInstance.getZoom())===22);
  if(OUT)await page.screenshot({path:path.join(OUT,`${type}-${width}.png`)});
 }
 const boundary=await page.evaluate(()=>{const layer=farmLayer.getLayers()[0],el=layer.getElement();return{stroke:getComputedStyle(el).stroke,filter:getComputedStyle(el).filter,weight:layer.options.weight,fill:layer.options.fillOpacity};});
 check(`${width}: saved polygon has magenta edge and contrasting halo`,boundary.stroke==='rgb(192, 38, 211)'&&boundary.filter!=='none'&&boundary.weight>=3,boundary);
 await page.evaluate(()=>focusFarm('plot-a'));
 const selected=await page.evaluate(()=>{const a=farmLayer.getLayers().find(l=>l.options.farmId==='plot-a'),b=farmLayer.getLayers().find(l=>l.options.farmId==='plot-b');return{selected:a.options.weight,other:b.options.weight,solid:!a.options.dashArray,pressed:a.getElement().getAttribute('aria-pressed')};});
 check(`${width}: selected plot remains distinct without changing geometry`,selected.selected>selected.other&&selected.solid&&selected.pressed==='true'&&source===JSON.stringify(await page.evaluate(()=>farmList.map(f=>f.ring))),selected);
 await page.evaluate(()=>{startFarmDraw();mapInstance.setView([-3,104],22,{animate:false});});
 const box=await page.locator('#map-container').boundingBox(),cx=box.x+box.width/2,cy=box.y+box.height*.60;
 for(const [dx,dy]of[[-50,0],[50,0],[0,70]])await page.mouse.click(cx+dx,cy+dy);
 await page.locator('#draw-finish').click();
 await page.waitForFunction(()=>!!pendingFarmLayer);
 check(`${width}: newly drawn polygon uses the visible boundary style`,await page.evaluate(()=>pendingFarmLayer.options.color==='#c026d3'&&pendingFarmLayer.getElement().classList.contains('farm-boundary')));
 await page.evaluate(()=>{closeDialog('modal-farm');cancelFarmDraw();openFarmEdit('plot-a');editFarmGeometry();mapInstance.setZoom(22,{animate:false});});
 check(`${width}: editing polygon stays visible at close zoom`,await page.evaluate(()=>editingFarmLayer.options.color==='#c026d3'&&editingFarmLayer.options.weight===5&&editingFarmLayer.pm.enabled()&&mapInstance.getZoom()===22));
 await page.evaluate(()=>{cancelFarmDraw();Object.defineProperty(navigator,'geolocation',{configurable:true,value:{watchPosition(callback){window.__mapGps=callback;return 17;},clearWatch(){}}});currentCoords.lat=-3;currentCoords.lng=104;toggleGpsTrace();for(const [lat,lng]of[[-3,104],[-2.99995,104],[-2.99995,104.00005]])__mapGps({coords:{latitude:lat,longitude:lng,accuracy:2}});});
 check(`${width}: GPS boundary trace uses the same magenta`,await page.evaluate(()=>traceLayer.getLayers().filter(l=>l instanceof L.Polyline).every(l=>l.options.color==='#c026d3')&&traceLayer.getLayers().some(l=>l instanceof L.Polyline)));
 await page.evaluate(()=>{cancelFarmDraw();openLocationEditor('record','record-fixture');});
 await page.waitForFunction(()=>workflowLocationMap&&workflowLocationPlots.getLayers().length===2);
 await page.evaluate(()=>workflowLocationMap.setView([-3,104],21,{animate:false}));
 const fieldsBefore=await page.locator('#location-lat').inputValue()+'|'+await page.locator('#location-lng').inputValue();
 await page.locator('#location-map .leaflet-control-zoom-in').click();
 await page.waitForFunction(()=>workflowLocationMap.getZoom()===22);
 check(`${width}: location editor zooms closer without changing the pin`,fieldsBefore===await page.locator('#location-lat').inputValue()+'|'+await page.locator('#location-lng').inputValue());
 const locate=await page.evaluate(()=>{const controls=document.querySelectorAll('#location-map .location-locate-btn');const stale=document.querySelectorAll('#location-map .location-recenter-btn');const btn=controls[0];if(controls.length!==1||stale.length!==0||!btn)return{ok:false,controls:controls.length,stale:stale.length};currentCoords.lat=-3.2;currentCoords.lng=104.5;btn.click();const c=workflowLocationMap.getCenter();return{ok:true,controls:controls.length,stale:stale.length,lat:c.lat,lng:c.lng,pin:document.getElementById('location-lat').value,label:btn.getAttribute('aria-label'),size:Math.round(btn.getBoundingClientRect().width)};});
 check(`${width}: location editor has only the latest "Ke lokasi saya" button`,locate.ok&&locate.controls===1&&locate.stale===0&&/Ke lokasi saya/.test(locate.label||'')&&locate.size>=44&&Math.abs(locate.lat+3.2)<0.01&&Math.abs(locate.lng-104.5)<0.01&&locate.pin===fieldsBefore.split('|')[0],locate);
 await page.locator('#location-plot').selectOption('plot-b');
 const editor=await page.evaluate(()=>{const a=workflowLocationPlots.getLayers().find(l=>l.options.farmId==='plot-a'),b=workflowLocationPlots.getLayers().find(l=>l.options.farmId==='plot-b');return{max:workflowLocationMap.getMaxZoom(),a:a.options.weight,b:b.options.weight,color:b.options.color,filter:getComputedStyle(b.getElement()).filter};});
 check(`${width}: editor plot selection keeps clear contrasting boundaries`,editor.max===22&&editor.b>editor.a&&editor.color==='#c026d3'&&editor.filter!=='none',editor);
 if(OUT)await page.screenshot({path:path.join(OUT,`location-${width}.png`)});
 await page.locator('#location-close').click();
 await page.evaluate(()=>{
  const plant=farmRecords.find(r=>r.id==='record-fixture');
  farmRecords.push({...plant,id:'same-gps',cropId:'same-gps',crop:'Terung',cropName:'Terung',severity:'Severe'});
  mapInstance.setView([-3,104],22,{animate:false});renderMapMarkers();
 });
 const geometry=()=>page.evaluate(()=>{
  const pins=mapMarkersLayer.getLayers();
  const byId=new Map(farmRecords.map(record=>[record.id,record]));
  const boxes=pins.map(pin=>pin.getElement().getBoundingClientRect());
  const anchor=marker=>{
   const latLng=marker.getLatLng(),options=marker.options;
   const record=byId.get(options.recordId||options.plants[0].recordId);
   return latLng.lat===record.lat&&latLng.lng===record.lng;
  };
  return {anchored:pins.every(anchor),separated:boxes.every((box,i)=>boxes.slice(i+1).every(other=>
   box.right<=other.left||box.left>=other.right||box.top>=other.bottom||box.bottom<=other.top)),
  touch:boxes.every(box=>box.width>=44&&box.height>=44)};
 });
 const two=page.locator('.leaflet-marker-icon[title="2 Tanaman Berdekatan"]');
 check(`${width}: two crops at one GPS point use two stacked layers`,
   await two.locator('.map-pin-count').innerText()==='2'&&await two.locator('.map-pin-body').count()===2);
 await page.locator('.leaflet-marker-icon[title^="Tomat"]').click();
 check(`${width}: a single pin opens the crop directly`,await page.locator('#sheet-crop-title').innerText()==='Tomat');
 await page.evaluate(()=>{closeBottomSheet();mapInstance.stop();mapInstance.setView([-3,104],22,{animate:false});mapInstance.panBy([45,20],{animate:false});});
 const panned=await geometry();
 check(`${width}: panning keeps pins on their recorded anchors with separate 44px targets`,
   panned.anchored&&panned.separated&&panned.touch,panned);
 await page.evaluate(()=>mapInstance.setView([-3,104],17,{animate:false}));
 check(`${width}: zooming out groups the overlapping pins with the full crop count`,
   await page.locator('.map-pin-count').innerText()==='4');
 await page.evaluate(()=>{
  const plant=farmRecords.find(r=>r.id==='record-fixture');
  farmRecords.push({...plant,id:'near-gps',cropId:'near-gps',crop:'Padi',cropName:'Padi',lat:-3.000009,lng:104.000005});
  for(let i=0;i<4;i++)farmRecords.push({...plant,id:'dense-'+i,cropId:'dense-'+i,crop:'Jagung '+i,cropName:'Jagung '+i});
  mapInstance.setView([-3,104],22,{animate:false});renderMapMarkers();
 });
 const cluster=page.locator('.leaflet-marker-icon[title="7 Tanaman Berdekatan"]');
 check(`${width}: seven overlapping plants draw only three pin layers`,
   await cluster.locator('.map-pin-count').innerText()==='7'&&await cluster.locator('.map-pin-body').count()===3);
 check(`${width}: each stack layer is centered above the front pin`,
   await cluster.locator('.map-pin-body').evaluateAll(layers=>{
     const [back,middle,front]=layers.map(layer=>layer.getBoundingClientRect());
     const x=box=>box.left+box.width/2;
     return Math.abs(x(front)-x(middle))<0.15&&Math.abs(x(front)-x(back))<0.15
       && back.top<middle.top&&middle.top<front.top;
   }));
 await cluster.press('Enter');
 const nearby=page.locator('#farm-crops-sheet[data-mode="nearby"]');
 await nearby.locator('.map-nearby-photo img:not([hidden])').first().waitFor();
 check(`${width}: dense group opens an accessible list of the seven matching plants`,
   await nearby.isVisible()&&await nearby.locator('.map-nearby-plant').count()===7
   && await nearby.getByRole('heading',{name:'Pilih Tanaman'}).isVisible()
   && !await nearby.locator('#farm-crops-edit').isVisible()&&!await nearby.locator('#farm-crops-summary').isVisible());
 if(OUT)await page.screenshot({path:path.join(OUT,`stack-${width}.png`)});
 await nearby.getByRole('button',{name:/^Jagung 3/}).click();
 check(`${width}: choosing a plant in the group opens its existing details`,await page.locator('#sheet-crop-title').innerText()==='Jagung 3');
 check(`${width}: zoom/styling/selection makes no server writes or farm changes`,writes.length===0&&source===JSON.stringify(await page.evaluate(()=>farmList.map(f=>f.ring))),writes);
 check(`${width}: no page errors or horizontal overflow`,errors.length===0&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),errors);
 await context.close();
}
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
const bad=checks.filter(c=>!c.ok);console.log(`map-0237: ${checks.length-bad.length}/${checks.length} checks passed`);process.exitCode=bad.length?1:0;
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
