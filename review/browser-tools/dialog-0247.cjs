/* 0.2.4.7: "Lihat analisis dan pencegahan" header - the crop species title is centred with an X close control. */
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../../app/frontend'),checks=[];
const arg=process.argv.indexOf('--shots'),OUT=arg<0?null:path.resolve(process.argv[arg+1]);if(OUT)fs.mkdirSync(OUT,{recursive:true});
const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff'};
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://fixture'),p=path.resolve(ROOT,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!p.startsWith(ROOT+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':mime[path.extname(p)]||'application/octet-stream'});res.end(fs.readFileSync(p));});
const a={findings:['Bercak kecoklatan pada beberapa daun.'],possible_causes:['Dugaan antraknosa pada daun.'],actions:['Pangkas bagian yang terserang.'],prevention:['Jaga sirkulasi udara antar tanaman.'],monitoring:['Periksa daun baru setiap dua hari.'],escalation:['Hubungi penyuluh bila bercak meluas.'],nutrition:['Dugaan kekurangan kalium ringan.'],missing_information:['Usia tanaman dan pola pemupukan terakhir.']};
function check(name,ok,detail){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name+(ok?'':' '+JSON.stringify(detail)));}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
for(const viewport of [{width:320,height:700},{width:390,height:844},{width:1366,height:900}]){
 const key=viewport.width+'x'+viewport.height,context=await browser.newContext({viewport,serviceWorkers:'block'});const errors=[];
 await context.route(url=>url.protocol==='https:',route=>route.abort());
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;let body={};
  if(p==='/api/auth/me')body={ok:true,account:{id:'dialog-fixture-account',name:'Data contoh',role:'user'},csrf:'fixture'};
  if(p==='/api/auth/google/config')body={enabled:false};
  if(p==='/api/health')body={ok:true,version:'2.1.0',release:'0.2.4.7',capabilities:{recordsPaging:true,treeContinuity:true}};
  if(p==='/api/records')body={items:[{id:'dialog-fixture',crop:'Cabai (Chili)',cropId:'plant-fixture',condition:'Dugaan antraknosa',severity:'Moderate',confidence:.8,createdMs:1793318400000,timestampMs:1793318400000,assessment:a}],next:null};
  if(p==='/api/telemetry')body={};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
 await page.waitForFunction(()=>typeof JagaAppAccount==='function'&&JagaAppAccount()&&typeof loadedOnce!=='undefined'&&loadedOnce);
 await page.evaluate(()=>{JagaOfflineSync.stop();JagaAssessment.open('dialog-fixture');});
 await page.waitForFunction(()=>{const m=document.getElementById('assessment-dialog');return m&&!m.classList.contains('hidden');});
 const geo=await page.evaluate(()=>{const q=s=>document.querySelector(s);
  const btn=q('#assessment-dialog .assessment-dialog-actions button[aria-label="Tutup analisis"]'),title=q('#assessment-dialog .assessment-dialog-head h3');
  if(!btn||!title)return null;const b=btn.getBoundingClientRect(),t=title.getBoundingClientRect();
  return{w:b.width,h:b.height,btnCenter:(b.top+b.bottom)/2,titleCenter:(t.top+t.bottom)/2,titleRight:t.right,btnLeft:b.left,
   txt:title.textContent.trim(),btnText:btn.textContent.trim(),disabled:btn.disabled,
   svg:btn.querySelectorAll('svg').length,svgClass:(btn.querySelector('svg')&&btn.querySelector('svg').getAttribute('class'))||'',
   headAlign:getComputedStyle(q('#assessment-dialog .assessment-dialog-head')).alignItems};});
 check(key+': analysis header shows the crop species',!!geo&&geo.txt==='Cabai (Chili)',geo);
 check(key+': close control is an icon with no visible "Tutup" text',!!geo&&geo.svg===1&&/\blucide-x\b/.test(geo.svgClass)&&geo.btnText==='',geo);
 check(key+': close control keeps the accessible name "Tutup analisis"',await page.getByRole('button',{name:'Tutup analisis'}).count()===1);
 check(key+': close control is at least 44x44 px',!!geo&&geo.w>=43.5&&geo.h>=43.5,geo);
 check(key+': crop species and X share one vertical centre',!!geo&&Math.abs(geo.btnCenter-geo.titleCenter)<=2,geo);
 check(key+': header keeps title and X on one row',!!geo&&geo.headAlign==='center'&&geo.titleRight<=geo.btnLeft+0.5,geo);
 if(OUT)await page.screenshot({path:path.join(OUT,'dialog-'+key+'.png')});
 await page.getByRole('button',{name:'Tutup analisis'}).click();
 check(key+': X closes the analysis dialog',await page.locator('#assessment-dialog').evaluate(el=>el.classList.contains('hidden')));
 await page.evaluate(()=>JagaAssessment.open('dialog-fixture'));
 await page.waitForFunction(()=>!document.getElementById('assessment-dialog').classList.contains('hidden'));
 await page.keyboard.press('Escape');
 check(key+': Escape still closes the analysis dialog',await page.locator('#assessment-dialog').evaluate(el=>el.classList.contains('hidden')));
 await page.evaluate(()=>JagaAssessment.open('dialog-fixture'));
 await page.waitForFunction(()=>!document.getElementById('assessment-dialog').classList.contains('hidden'));
 const closeBtn=page.locator('#assessment-dialog .assessment-dialog-actions button[aria-label="Tutup analisis"]');
 await closeBtn.focus();
 await page.keyboard.press('Enter');
 check(key+': keyboard activation closes from the X control',await page.locator('#assessment-dialog').evaluate(el=>el.classList.contains('hidden')));
 check(key+': no uncaught page errors',errors.length===0,errors);
 await context.close();
}
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
const bad=checks.filter(c=>!c.ok);console.log(`dialog-0247: ${checks.length-bad.length}/${checks.length} checks passed`);process.exitCode=bad.length?1:0;
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
