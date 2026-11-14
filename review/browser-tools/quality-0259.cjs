/* Commercial-quality interaction checks. Synthetic records, blocked external services. */
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../../app/frontend'), checks = [];
const OUT = process.argv.includes('--shots') ? path.resolve(process.argv[process.argv.indexOf('--shots') + 1]) : null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const mime = { '.js':'application/javascript', '.css':'text/css', '.html':'text/html', '.png':'image/png', '.svg':'image/svg+xml', '.webp':'image/webp', '.woff':'font/woff', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture'), file = path.resolve(ROOT, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
});
function check(name, ok, detail) { checks.push({ name, ok:!!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(detail))); }
const leaf = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#dcead4"/><ellipse cx="80" cy="82" rx="40" ry="65" fill="#438254"/><path d="M80 150V20" stroke="#c3dd95" stroke-width="4"/></svg>').toString('base64');
const report = { version:1, active_conditions:['Bulai', 'Kutu Daun'], findings:['Perubahan terlihat pada kedua permukaan daun.'], possible_causes:['Antraknosa tidak didukung foto ini.'], actions:['Periksa permukaan atas dan bawah daun.'], prevention:['Catat perawatan terakhir sebelum memilih penanganan.'], nutrition:['Foto belum cukup untuk menilai kebutuhan unsur hara.'], monitoring:['Bandingkan bagian tanaman yang sama.'], escalation:['Hubungi penyuluh bila perubahan meluas.'], guidance_scope:'inspection-only' };
const now = Date.now(), records = ['Cabai','Padi','Tomat'].map((crop,i) => ({ id:'quality-'+i, cropId:'quality-plant-'+i, farmId:'quality-plot', crop, cropName:crop, condition:i ? (i===1?'Tanaman Sehat':'Antraknosa'):'Bulai', severity:i===1?'Healthy':'Moderate', source:'ai', confidence:.8, timestampMs:now, createdMs:now, lat:-6.2, lng:106.8, imageUrl:leaf, assessment:i?{...report,active_conditions:i===1?[]:['Antraknosa']}:report, previousCondition:'Dugaan lama', analysisProvenance:{diagnosis:{resolvedModel:'synthetic-model'}} }));
const farm={id:'quality-plot',name:'Petak Contoh',ring:[[-6.201,106.799],[-6.201,106.801],[-6.199,106.801],[-6.199,106.799]],areaM2:1000};
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox'] });
  try {
    for (const viewport of [{ width:390,height:844 }, { width:720,height:900 }, { width:1440,height:900 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers:'block' }), requests = [], errors = [];
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'geolocation', { value:{ getCurrentPosition(ok,fail){ setTimeout(()=>fail({code:1,message:'synthetic denial'}),0); }, watchPosition(ok,fail){ setTimeout(()=>fail({code:1,message:'synthetic denial'}),0); return 1; }, clearWatch(){} } });
      });
      await context.route(url => url.protocol === 'https:', route => route.abort());
      await context.route('**/api/**', async route => {
        const req = route.request(), p = new URL(req.url()).pathname; let body = {}, status = 200;
        if (p === '/api/auth/me') body = { ok:true, account:{ id:'quality-synthetic', name:'Kebun Contoh', role:'user' }, csrf:'fixture' };
        if (p === '/api/auth/google/config') body = { enabled:false };
        if (p === '/api/health') body = { ok:true, version:'2.1.0', release:'0.2.4.28', capabilities:{ recordsPaging:true, treeContinuity:true } };
        if (p === '/api/records') body = { items:records, next:null };
        if (p === '/api/daily' || p === '/api/farms' || p === '/api/queue/pending') body = [];
        if (p === '/api/farms') body = [farm];
        if (p === '/api/daily' && req.method() === 'POST') { await new Promise(r => setTimeout(r,500)); status=503; body={detail:'Uji penyimpanan gagal.'}; }
        await route.fulfill({ status, contentType:'application/json', body:JSON.stringify(body) });
      });
      const page = await context.newPage(); page.on('request', r => requests.push(new URL(r.url()).pathname)); page.on('pageerror', e => errors.push(e.message));
      await page.goto('about:blank');
      const photo=await page.evaluate(()=>{
        const c=document.createElement('canvas');c.width=240;c.height=320;const g=c.getContext('2d');
        g.fillStyle='#dcead4';g.fillRect(0,0,240,320);g.fillStyle='#438254';g.beginPath();g.ellipse(120,155,70,132,.2,0,Math.PI*2);g.fill();
        g.strokeStyle='#b6d693';g.lineWidth=4;g.beginPath();g.moveTo(96,295);g.lineTo(145,30);g.stroke();return c.toDataURL('image/jpeg',.9);
      });
      records.forEach(record=>{record.imageUrl=photo;});
      await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil:'networkidle' });
      await page.waitForFunction(() => loadedOnce && JagaAppAccount());
      await page.evaluate(() => { JagaTour.dismiss(); JagaOfflineSync.stop(); });
      const prefix = viewport.width + ': ';
      check(prefix+'launch does not fetch map, EXIF or export libraries', !requests.some(p => /leaflet.*\.js|turf\.min\.js|exifr.*\.js|piexif\.js/.test(p)), requests);
      check(prefix+'classic scripts defer parsing in dependency order', await page.locator('script[src]:not([defer]):not([async])').count() === 0);
      check(prefix+'GPS denial replaces indefinite waiting with a recovery path', await page.locator('#home-telemetry-status').innerText().then(s => s.includes('Izin lokasi ditolak') && s.includes('Perbarui')));
      if(viewport.width===390){
        await page.evaluate(async()=>{await JagaFeatures.load('photoMetadata');exifr.parse=()=>new Promise(resolve=>window.__finishMetadata=resolve);navigateToMenu('scan');});
        await page.locator('input[type=file]').first().setInputFiles({name:'synthetic.jpg',mimeType:'image/jpeg',buffer:Buffer.from(photo.split(',')[1],'base64')});
        await page.waitForFunction(()=>scanState==='preparing'&&typeof window.__finishMetadata==='function');
        check(prefix+'gallery preparation cannot send a new image with old metadata',await page.evaluate(()=>selectedImageBase64===null&&selectedPhotoMetadata===null)&&await page.locator('#photo-preparing').isVisible()&&await page.locator('#photo-review-controls').isHidden());
        await page.evaluate(()=>{resetToLiveCamera();window.__finishMetadata({latitude:-6,longitude:106,DateTimeOriginal:new Date()});});
        await page.waitForTimeout(100);
        check(prefix+'cancelled metadata read cannot restore a discarded photo',await page.evaluate(()=>scanState==='live'&&selectedImageBase64===null&&selectedPhotoMetadata===null));
      }
      await page.evaluate(() => { navigateToMenu('log'); JagaAssessment.open('quality-0'); });
      const dialog = page.locator('#assessment-dialog');
      check(prefix+'coexisting active labels are shared, alternatives are not promoted', await dialog.locator('.assessment-summary-current').innerText() === 'Bulai · Kutu Daun');
      check(prefix+'uncertain cause preserves urgency while avoiding a false healthy label',await page.evaluate(()=>{
        const severe={severity:'Severe',confidence:.2,needs_review:true,assessment:{uncertain:true}};
        return recSeverity(severe)==='Severe'&&JagaAssessment.label(severe)==='Belum Dapat Dipastikan'&&recSeverity({...severe,severity:'Healthy'})==='Unknown';
      }));
      if (OUT) await page.screenshot({path:path.join(OUT,'analysis-top-'+viewport.width+'.png')});
      check(prefix+'specific next steps lead the report', await dialog.locator('.assessment-section h4').first().innerText() === 'Rekomendasi Tindakan');
      check(prefix+'report has copy and selectable text without old hypothesis or probability', await dialog.innerText().then(s => !s.includes('Dugaan sebelum') && !s.includes('80%')) && await dialog.locator('.assessment-copy').isVisible() && await dialog.locator('.assessment-content').evaluate(el => getComputedStyle(el).userSelect === 'text'));
      await dialog.getByRole('button', { name:'Tutup analisis' }).focus();
      let contained = true, summarySeen = false;
      for (let i=0;i<12;i++) { await page.keyboard.press('Tab'); const state=await page.evaluate(()=>({inside:!!document.activeElement.closest('#assessment-dialog'),summary:document.activeElement.tagName==='SUMMARY',hiddenInput:!!document.activeElement.closest('details:not([open])')&&document.activeElement.tagName!=='SUMMARY'})); contained &&= state.inside&&!state.hiddenInput; summarySeen ||= state.summary; }
      check(prefix+'keyboard loop stays inside the dialog and includes closed summaries', contained && summarySeen);
      await dialog.locator('.input-options summary').click();
      check(prefix+'product form stays gated until consent', await dialog.locator('.input-options-form').isHidden() && await dialog.locator('.input-terms').isVisible());
      await dialog.locator('input[name="accepted"]').check();
      check(prefix+'product targets use active labels and need no manual selector', await dialog.locator('.assessment-target').innerText().then(s=>s.includes('Bulai · Kutu Daun')) && await dialog.locator('select[name="problem"]').count()===0 && await dialog.locator('.input-options-form').isVisible());
      if (OUT) await page.screenshot({path:path.join(OUT,'analysis-'+viewport.width+'.png')});
      await dialog.getByRole('button',{name:'Tutup analisis'}).click();
      await page.evaluate(()=>JagaPlotSummary.open('quality-plot'));
      check(prefix+'plot summary renders shared labels and separates observations from spread', await page.locator('#plot-summary-body').innerText().then(t=>t.includes('Bulai')&&t.includes('Kutu Daun')&&!t.includes('rawan jamur')));
      await page.evaluate(()=>JagaPlotSummary.close());
      if (OUT) { const box=await page.locator('#view-log').boundingBox(); await page.screenshot({path:path.join(OUT,'history-'+viewport.width+'.png'),clip:{x:Math.max(0,box.x),y:box.y,width:box.width,height:Math.min(box.height,620)}}); }
      await page.evaluate(() => openDailyModal());
      await page.locator('#daily-summary-input').fill('Teks contoh yang harus tetap tersimpan di formulir.');
      await page.locator('#daily-save').click();
      check(prefix+'daily save exposes a pending state', await page.locator('#daily-save').isDisabled() && await page.locator('#daily-save').getAttribute('aria-busy')==='true');
      await page.locator('#daily-save-error:not([hidden])').waitFor();
      check(prefix+'failed daily save keeps content and exposes its error inside the modal', await page.locator('#daily-summary-input').inputValue()==='Teks contoh yang harus tetap tersimpan di formulir.' && await page.locator('#modal-daily #daily-save-error').isVisible() && !await page.locator('#daily-save').isDisabled());
      let failFirstMapLoad=true;
      await page.route('**/vendor/leaflet/leaflet-1.9.4.js',route=>{if(failFirstMapLoad){failFirstMapLoad=false;return route.abort();}return route.continue();});
      await page.evaluate(()=>{closeDailyModal();navigateToMenu('map');});
      await page.locator('#map-load-retry').waitFor({state:'visible'});
      check(prefix+'map loading failure leaves a persistent retry action',await page.locator('#map-load-message').innerText().then(t=>t.includes('belum dapat dimuat')));
      await page.locator('#map-load-retry').click();
      await page.waitForFunction(()=>!!mapInstance);
      check(prefix+'map loads on demand and closed plant sheet is inert', requests.some(p=>p.includes('leaflet-1.9.4.js')) && await page.locator('#map-bottom-sheet').evaluate(el=>el.inert && el.getAttribute('aria-hidden')==='true'));
      await page.evaluate(()=>openLocationEditor('record','quality-0'));
      await page.waitForFunction(()=>!!workflowLocationMap);
      check(prefix+'location component owns one GPS recenter control and a coordinate fold', await page.locator('#modal-location .location-locate-btn').count()===1 && await page.locator('#modal-location details summary').innerText()==='Atur Koordinat Manual');
      check(prefix+'no uncaught errors or page overflow', errors.length===0 && await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), errors);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
  const failed=checks.filter(c=>!c.ok); console.log(`quality-0259: ${checks.length-failed.length}/${checks.length} checks passed`); process.exitCode=failed.length?1:0;
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
