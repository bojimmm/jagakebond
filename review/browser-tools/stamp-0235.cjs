/* Real-browser regression; every API response is synthetic, no production access. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend');
const arg=process.argv.indexOf('--shots'),OUT=arg>=0?path.resolve(process.argv[arg+1]):null;
if(OUT)fs.mkdirSync(OUT,{recursive:true});
const NOW=Date.parse('2026-10-29T10:00:00Z'),YESTERDAY=NOW-86400000;
const checks=[];function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);res.end();return;}const b=fs.readFileSync(p);res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(b);});
const leaf='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" fill="#e2eed4"/><path d="M14 58C5 24 32 12 58 8C66 35 45 61 14 58Z" fill="#43864d"/><path d="M12 64L53 16" stroke="#c3e28e" stroke-width="3"/></svg>').toString('base64');
function rows(){return [
 {id:'a',cropId:'plant-a',crop:'Ketapang (Sea Almond)',cropName:'Ketapang (Sea Almond)',condition:'Sehat',severity:'Healthy',createdMs:NOW-5000,uploadedMs:NOW-5000,updatedMs:NOW-5000,timestampMs:NOW,imageUrl:leaf},
 {id:'b',cropId:'plant-b',crop:'Ketapang (Tropical Almond)',condition:'Sehat',severity:'Healthy',createdMs:NOW-4000,updatedMs:NOW,timestampMs:NOW,imageUrl:leaf},
 {id:'c',cropId:'plant-c',crop:'Pisang (Banana)',condition:'Sigatoka Kuning',severity:'Moderate',createdMs:YESTERDAY,updatedMs:NOW,timestampMs:YESTERDAY,imageUrl:leaf},
 {id:'d',cropId:'plant-d',crop:'Cabai',condition:'Bercak daun',severity:'Severe',createdMs:NOW-3000,timestampMs:NOW,imageUrl:leaf}];}

(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'id-ID',timezoneId:'Asia/Jakarta',serviceWorkers:'block'});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('about:blank');
 const photo=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=900;const g=c.getContext('2d');g.fillStyle='#afcf99';g.fillRect(0,0,c.width,c.height);g.fillStyle='#458951';g.beginPath();g.ellipse(600,400,290,160,-.5,0,Math.PI*2);g.fill();return c.toDataURL('image/jpeg',.95);});
 const record={id:'record_import',cropId:'tree',crop:'Ketapang (Sea Almond)',condition:'Sehat',severity:'Healthy',createdMs:NOW,uploadedMs:NOW,updatedMs:NOW,timestampMs:NOW,photoTimestampMs:null,captureTimeKnown:false,imageUrl:'/api/photos/imported',lat:null,lng:null};
 await context.route(url=>url.protocol==='https:',r=>r.abort());
 await context.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;let body=[];
  if(p==='/api/photos/imported')return route.fulfill({status:200,contentType:'image/jpeg',body:Buffer.from(photo.split(',')[1],'base64')});
  if(p==='/api/auth/me')body={ok:true,account:{id:'stamp-fixture',name:'Data contoh',role:'user'},csrf:'fixture'};
  if(p==='/api/auth/google/config')body={enabled:false};if(p==='/api/records')body={items:[record],next:null};
  if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.3.5',capabilities:{recordsPaging:true}};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>JagaAppAccount()&&loadedOnce);await page.evaluate(()=>JagaOfflineSync.stop());
 await page.evaluate(()=>{window.__stampText=[];window.__stampStyles=[];window.__stampLogos=0;const fill=CanvasRenderingContext2D.prototype.fillText,draw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.fillText=function(text,...a){window.__stampText.push(String(text));window.__stampStyles.push({text:String(text),font:this.font,maxWidth:a[2]??null});return fill.call(this,text,...a);};CanvasRenderingContext2D.prototype.drawImage=function(img,...a){if(img.currentSrc?.includes('logo-256.png?v=3'))window.__stampLogos++;return draw.call(this,img,...a);};});
 const result=await page.evaluate(async photo=>{window.__stampText=[];window.__stampStyles=[];window.__stampLogos=0;const output=await bakeStampIntoCanvas(photo,{photoTimestampMs:Date.parse('2020-01-02T03:04:00Z'),lat:0,lng:0,accuracy:0,photoDate:'EXIF; zona waktu tidak diketahui'},{crop:'Ketapang (Sea Almond)',condition:'Sehat',severity:'Healthy'});return {output,text:window.__stampText,styles:window.__stampStyles,logos:window.__stampLogos};},photo);
 check('Stamp draws the actual supplied logo, without a JK placeholder',result.logos===1&&!result.text.includes('JK'),{text:result.text,logos:result.logos});
 check('Burned-in crop name is consistent with the record list',result.text.join(' ').includes('Tropical Almond')&&!result.text.join(' ').includes('Sea Almond'),result.text);
 check('Original EXIF capture year and zero GPS are preserved',result.text.join(' ').includes('2020')&&result.text.join(' ').includes('0.000000')&&result.text.join(' ').includes('EXIF'),result.text);
 const timestamp=result.styles.find(row=>/2020/.test(row.text));const coordinates=result.styles.find(row=>/0\.000000/.test(row.text));const fontSize=row=>Number((String(row?.font||'').match(/(\d+(?:\.\d+)?)px/)||[])[1]);check('Timestamp uses the one-size-smaller font and remains on one line',!!timestamp&&!!coordinates&&fontSize(timestamp)<fontSize(coordinates)&&result.text.filter(row=>/2020/.test(row)).length===1,{timestamp,coordinates,sizes:[fontSize(timestamp),fontSize(coordinates)],text:result.text});
 await page.evaluate(()=>{navigateToMenu('scan');window.exifr={parse:async()=>null};});
 await page.locator('input[type=file]').first().setInputFiles({name:'imported.jpg',mimeType:'image/jpeg',buffer:Buffer.from(photo.split(',')[1],'base64')});
 await page.waitForFunction(()=>selectedPhotoMetadata?.source==='gallery-exif');
 const imported=await page.evaluate(async()=>{window.__stampText=[];const meta=selectedPhotoMetadata;const image=await bakeStampIntoCanvas(capturePhotoSnapshot,meta);return {meta,text:window.__stampText,image};});
 check('Gallery without EXIF does not substitute current GPS or pretend a capture time',imported.meta.captureTimeMs===null&&imported.meta.lat===null&&imported.meta.lng===null,imported.meta);
 check('Gallery without EXIF still gets a branded timestamp with an honest added-time label',!!imported.image&&imported.text.some(t=>t.includes('Waktu foto tidak diketahui'))&&imported.text.some(t=>t.includes('Ditambahkan')),imported.text);
 await page.evaluate(()=>{window.__stampText=[];});
 await page.evaluate(()=>openViewerForRecord('record_import'));
 const viewer=await page.locator('#photo-viewer-image').getAttribute('src');
 check('History import with only a server original is visibly stamped',viewer?.startsWith('data:image/jpeg;base64,')&&(await page.evaluate(()=>window.__stampText)).some(t=>t.includes('Ditambahkan')));
 if(OUT)await page.screenshot({path:path.join(OUT,'imported-photo-viewer.png')});
 const nativeExport=await page.evaluate(async()=>{window.__exports=[];window.Capacitor={Plugins:{JagaSync:{photoExport:async args=>{window.__exports.push(args);return {ok:true};}}}};const wasNative=JagaNative.isNative;JagaNative.isNative=()=>true;try{await exportPrivatePhoto('record_import');}finally{JagaNative.isNative=wasNative;}return window.__exports;});
 check('Native gallery export receives the rendered JPEG and faithful metadata without replacing originals',nativeExport.length===1&&nativeExport[0].imageBase64&&nativeExport[0].metadata.photoTimestampMs===null&&nativeExport[0].metadata.lat===null,nativeExport.map(x=>({id:x.photoId,metadata:x.metadata})));
 const original=await page.evaluate(async photo=>{const realGet=JagaMedia.get;JagaMedia.get=async()=>({imageBase64:photo.split(',')[1],metadata:{stampState:'original',photoTimestampMs:0,locationSource:'gallery-exif'}});try{renderedPhotoCache.clear();const row=farmRecords[0];row.photoTimestampMs=0;row.captureTimeKnown=true;row.timestampMs=0;const rendered=await renderRecordPhoto(row);return {stamped:rendered.stamped,text:window.__stampText};}finally{JagaMedia.get=realGet;}},photo);
 check('Private original works offline and epoch capture time is not replaced with today',original.stamped&&original.text.join(' ').includes('1970'),original);
 const cleared=await page.evaluate(async()=>{const before=renderedPhotoCache.size;await JagaMedia.delete({accountId:currentAccount.id,photoId:'record_import'});return before>0&&renderedPhotoCache.size===0;});
 check('Deleting a photo clears rendered private copies',cleared);
 const guard=await page.evaluate(async()=>{renderedPhotoCache.clear();const realGet=JagaMedia.get;JagaMedia.get=async()=>{accountGeneration++;return {};};try{return await renderRecordPhoto(farmRecords[0]);}finally{JagaMedia.get=realGet;}});
 check('Account changes prevent a stale private render',guard===null);
 check('No application errors',errors.length===0,errors);
 await context.close();
}finally{await browser.close();await new Promise(r=>server.close(r));}
const failed=checks.filter(c=>!c.ok);console.log(`stamp-0235: ${checks.length-failed.length}/${checks.length} checks passed`);process.exitCode=failed.length?1:0;
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
