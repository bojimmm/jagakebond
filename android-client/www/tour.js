/* 0.2.4.12: an in-place guide. Each step dims the app around one real control and explains it in a card
   beside it; on the Riwayat and Peta steps the farmer can tap the highlighted button itself to open that
   screen. Versioned and account-scoped. No photos, camera, permissions or API writes. */
(function(root){
 'use strict';
 const VERSION='2',seen=new Set(),PAD=6,GAP=12,EDGE=12;
 let owner=null,generation=null,step=0,modal=null,pending=null,plan=[],startMenu=null,startScroll=0,target=null,frame=0,roomTried=false,roomMade=false,spacer=null;
 const els={};
 const visible=el=>!!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
 const first=selectors=>{for(const s of selectors){const el=[...document.querySelectorAll(s)].find(visible);if(el)return el;}return null;};
 const go=menu=>{if(typeof navigateToMenu==='function'&&currentMenuName!==menu)navigateToMenu(menu);};
 const STEPS=[
  {id:'welcome',title:'Selamat Datang di JagaKebond',
   body:'Lima langkah untuk mengenal Foto Tanaman, Riwayat, dan Peta.',
   tip:'Bisa dilewati dan dibuka kembali dari Akun → Panduan Penggunaan.',next:'Mulai'},
  {id:'camera',include:['.nav-fab'],targets:['#nav-btn-scan','[data-view="scan"]'],title:'Foto Tanaman',
   body:'Ambil foto atau pilih dari galeri, pastikan lokasi dan tanggalnya, lalu ketuk Analisis. Tidak ada kamera atau izin yang dibuka oleh panduan ini.',
   tip:'Foto dekat, terang, dan fokus. Hasilnya merupakan dugaan awal yang perlu diperiksa di lapangan.'},
  {id:'history',targets:['#nav-btn-log','[data-view="log"]'],title:'Riwayat',
   body:'Cari tanaman dan saring statusnya. Buka tanaman untuk membaca dugaan, pemeriksaan dan pencegahan. Foto lagi lewat ikon kamera; koreksi atau analisis ulang lewat Lainnya. Tab Petak menampilkan ringkasan tiap kebun.',
   action:'Ketuk Riwayat',open:'log'},
  {id:'map',targets:['#nav-btn-map','[data-view="map"]'],title:'Peta',
   body:'Titik menunjukkan lokasi tanaman. Gambar batas petak untuk mengelompokkan tanaman; ketuk petak untuk membuka daftar tanaman dan ringkasannya.',
   tip:'Ringkasan memakai catatan yang tersedia, bukan pemeriksaan seluruh kebun.',action:'Ketuk Peta',open:'map'},
  {id:'done',title:'Siap Mencatat',
   body:'Mulai dengan satu tanaman. Foto yang menunggu sambungan disimpan di perangkat dan dikirim kembali saat tersambung.',
   tip:'Akun menyimpan sisa jatah analisis dan Panduan Penggunaan. Lokasi serta cuaca bisa diperbarui dari Beranda.',next:'Selesai',extra:'Foto Tanaman'}
 ];
 function key(id){return 'jk-tour-'+VERSION+':'+encodeURIComponent(id);}
 function finished(id){if(seen.has(id))return true;try{return ['done','skipped'].includes(localStorage.getItem(key(id)));}catch(_){return false;}}
 function valid(){return owner&&String(root.JagaAppAccount?.()?.id||'')===owner&&root.JagaAppGeneration?.()===generation;}
 function text(tag,value,cls){const el=document.createElement(tag);if(value)el.textContent=value;if(cls)el.className=cls;return el;}
 function button(id,label,cls,fn){const el=text('button',label,cls);if(id)el.id=id;el.type='button';el.onclick=fn;return el;}
 const tr=(s,v)=>(root.JagaI18n&&typeof root.JagaI18n.t==='function')?root.JagaI18n.t(s,v):s;
 const isEn=()=>!!(root.JagaI18n&&typeof root.JagaI18n.isEn==='function'&&root.JagaI18n.isEn());
 function build(){
  modal=text('div',null,'tour-coach hidden');modal.id='feature-tour';
  for(const side of ['top','right','bottom','left'])modal.append(els[side]=text('div',null,'tour-shade'));
  els.ring=text('div',null,'tour-ring');els.ring.setAttribute('aria-hidden','true');
  els.proxy=button('tour-try','', 'tour-proxy',()=>tryTarget());
  const card=els.card=text('section',null,'tour-card');card.setAttribute('aria-labelledby','tour-title');
  const head=text('header',null,'tour-head');
  els.progress=text('p',null,'tour-progress');
  els.skip=button('tour-skip',tr('Lewati'),'btn btn-quiet btn-sm',()=>dismiss('skipped'));
  head.append(els.progress,els.skip);
  const content=text('div',null,'tour-content');content.id='tour-content';content.setAttribute('aria-live','polite');content.setAttribute('aria-atomic','true');
  els.content=content;
  const controls=text('div',null,'tour-controls');
  els.back=button('tour-back',tr('Kembali'),'btn btn-secondary',()=>move(-1));
  els.next=button('tour-next',tr('Lanjut'),'btn btn-primary',()=>next());
  els.extra=button('tour-extra','','btn btn-secondary tour-extra',()=>{const camera=typeof openCamera==='function';dismiss('done',true);if(camera)openCamera();});
  controls.append(els.back,els.next);
  card.append(head,content,els.extra,controls);
  modal.append(els.ring,els.proxy,card);document.body.append(modal);dialogNames['feature-tour']=tr('Panduan penggunaan');
  root.addEventListener('resize',schedule,{passive:true});
  root.visualViewport?.addEventListener('resize',schedule,{passive:true});
  document.addEventListener('scroll',schedule,{passive:true,capture:true});
  root.addEventListener('jk:langchange',()=>{dialogNames['feature-tour']=tr('Panduan penggunaan');if(modal&&!modal.classList.contains('hidden')){render();layout();}});
 }
 function current(){return plan[step];}
 function render(){
  const s=current(),body=s.targets&&s.bodyEmpty&&target&&target.id==='home-empty'?s.bodyEmpty:s.body;
  els.progress.textContent=isEn()?`Step ${step+1} of ${plan.length}`:'Langkah '+(step+1)+' dari '+plan.length;
  if(els.skip)els.skip.textContent=tr('Lewati');
  if(els.back)els.back.textContent=tr('Kembali');
  const dots=text('div',null,'tour-dots');dots.setAttribute('aria-hidden','true');
  plan.forEach((_,i)=>dots.append(text('span',null,i===step?'is-current':i<step?'is-done':'')));
  const title=text('h2',tr(s.title));title.id='tour-title';title.tabIndex=-1;
  const nodes=[dots,title,text('p',tr(body),'tour-body')];
  if(s.action&&target)nodes.push(text('p',isEn()?`${tr(s.action)}, or tap Next.`:s.action+', atau ketuk Lanjut.','tour-action'));
  if(s.tip)nodes.push(text('p',tr(s.tip),'tour-tip'));
  els.content.replaceChildren(...nodes);
  els.back.disabled=step===0;
  els.next.textContent=tr(s.next||'Lanjut');
  els.extra.textContent=s.extra?tr(s.extra):'';els.extra.hidden=!s.extra;
  els.proxy.hidden=!(s.open&&target);
  els.ring.classList.toggle('is-tap',!!(s.open&&target));
  if(s.open&&target)els.proxy.setAttribute('aria-label',tr(s.action||s.title)+(isEn()?' (part of guide)':' (bagian dari panduan)'));
  return title;
 }
 /* Show the step's screen, find its control, then lay out the hole, ring and card around it. */
 function enter(){
  const s=current();
  roomTried=false;roomMade=false;clearSpacer();
  if(s.view)go(s.view);
  target=s.targets?first(s.targets):null;
  if(target)reveal(target);
  const title=render();layout();
  // Views, maps and lists settle a moment after navigation; measure again once they have.
  for(const wait of [320,900])setTimeout(()=>{if(modal&&!modal.classList.contains('hidden')&&current()===s){if(!visible(target))target=s.targets?first(s.targets):null;if(!roomMade)roomTried=false;layout();}},wait);
  return title;
 }
 /* Bring an off-screen control into view by scrolling its real scroll container only. scrollIntoView() would
    also scroll overflow:hidden views such as #view-map and leave the app shifted after the guide closes. */
 function clearSpacer(){if(spacer){spacer.remove();spacer=null;}}
 function scroller(el){
  for(let p=el.parentElement;p&&p!==document.body;p=p.parentElement){
   // Overflowing or not: a list that fits today can still take a spacer and scroll.
   if(/(auto|scroll)/.test(getComputedStyle(p).overflowY)&&p.clientHeight>0)return {el:p,top:p.getBoundingClientRect().top,height:p.clientHeight};
  }
  // A phone held sideways scrolls the page itself (the app shell keeps a 500 px minimum height).
  const page=document.scrollingElement;return page&&page.scrollHeight>page.clientHeight?{el:page,top:0,height:page.clientHeight}:null;
 }
 function reveal(el){
  const r=el.getBoundingClientRect();if(r.top>=72&&r.bottom<=root.innerHeight-72)return;
  const box=scroller(el);if(box)box.el.scrollTop+=(r.top+r.height/2)-(box.top+box.height/2);
 }
 /* No side has room for the card: scroll the control up (or down) within its own scroller, never past that
    scroller's top edge, so the larger gap grows. Tried once per step; layout() runs again afterwards. */
 // Once a step has made room it keeps it: trying again later could scroll the control straight back.
 function makeRoom(need,up){roomMade=shift(need,up)||shift(need,!up);return roomMade;}
 function shift(need,up){
  const box=target&&scroller(target);if(!box)return false;
  const r=target.getBoundingClientRect(),el=box.el,before=el.scrollTop;
  if(up){
   const want=Math.max(0,Math.min(need,r.top-PAD-(box.top+4))),left=el.scrollHeight-el.clientHeight-el.scrollTop;
   // A short list cannot scroll that far: a temporary spacer at its end gives it the room (removed on the next step).
   if(left<want&&el!==document.scrollingElement){spacer=document.createElement('div');spacer.className='tour-spacer';spacer.style.height=Math.ceil(want-left)+'px';el.append(spacer);}
   el.scrollTop+=want;
  }
  else el.scrollTop-=Math.max(0,Math.min(need,box.top+box.height-4-(r.bottom+PAD)));
  return el.scrollTop!==before;
 }
 /* The control's box, grown to cover parts drawn outside it: the raised Kamera circle sits above its nav button. */
 function bounds(el,include){
  const r=el.getBoundingClientRect(),box={left:r.left,top:r.top,right:r.right,bottom:r.bottom};
  for(const s of include||[])for(const part of el.querySelectorAll(s)){if(!visible(part))continue;const p=part.getBoundingClientRect();
   box.left=Math.min(box.left,p.left);box.top=Math.min(box.top,p.top);box.right=Math.max(box.right,p.right);box.bottom=Math.max(box.bottom,p.bottom);}
  return box;
 }
 function schedule(){if(!modal||modal.classList.contains('hidden')||frame)return;frame=requestAnimationFrame(()=>{frame=0;layout();});}
 function layout(){
  if(!modal||modal.classList.contains('hidden'))return;
  const W=document.documentElement.clientWidth,H=root.innerHeight,card=els.card;
  const r=target&&visible(target)?bounds(target,current().include):null;
  // Whole pixels: fractional shade edges leave a visible light seam between the four shades.
  const hx=r&&Math.max(0,Math.floor(r.left-PAD)),hy=r&&Math.max(0,Math.floor(r.top-PAD));
  const hole=r?{x:hx,y:hy,w:Math.min(W,Math.ceil(r.right+PAD))-hx,h:Math.min(H,Math.ceil(r.bottom+PAD))-hy}:null;
  const box=(el,x,y,w,h)=>{el.style.cssText='left:'+x+'px;top:'+y+'px;width:'+Math.max(0,w)+'px;height:'+Math.max(0,h)+'px';};
  if(hole){
   box(els.top,0,0,W,hole.y);box(els.bottom,0,hole.y+hole.h,W,H-hole.y-hole.h);
   box(els.left,0,hole.y,hole.x,hole.h);box(els.right,hole.x+hole.w,hole.y,W-hole.x-hole.w,hole.h);
   els.ring.hidden=false;els.ring.style.width=hole.w+'px';els.ring.style.height=hole.h+'px';els.ring.style.transform='translate('+hole.x+'px,'+hole.y+'px)';
   box(els.proxy,hole.x,hole.y,hole.w,hole.h);
  }else{
   box(els.top,0,0,W,H);for(const s of ['bottom','left','right'])box(els[s],0,0,0,0);els.ring.hidden=true;
  }
  const width=Math.min(W-2*EDGE,400);card.style.width=width+'px';card.style.maxHeight='';
  const ch=card.offsetHeight;let x,y;
  if(!hole){card.style.maxHeight=(H-2*EDGE)+'px';x=(W-width)/2;y=Math.max(EDGE,(H-card.offsetHeight)/2);}
  else{
   // Below, else above, else beside the control (desktop rail, phone held sideways), else the larger gap.
   const below=H-(hole.y+hole.h)-GAP-EDGE,above=hole.y-GAP-EDGE,right=W-(hole.x+hole.w)-GAP-EDGE,left=hole.x-GAP-EDGE;
   const fit=room=>{card.style.maxHeight=Math.max(160,room)+'px';return card.offsetHeight;};
   x=Math.min(Math.max(EDGE,hole.x+hole.w/2-width/2),W-width-EDGE);
   if(below>=ch){y=hole.y+hole.h+GAP;}
   else if(above>=ch){y=hole.y-GAP-ch;}
   else if(right>=width||left>=width){
    x=right>=width?hole.x+hole.w+GAP:hole.x-GAP-width;
    const h=fit(H-2*EDGE);y=Math.min(Math.max(EDGE,hole.y+hole.h/2-h/2),H-EDGE-h);
   }
   else if(!roomTried&&(roomTried=true)&&makeRoom(ch-Math.max(below,above),below>=above)){layout();return;}
   else if(below>=above){y=hole.y+hole.h+GAP;fit(below);}
   else{y=hole.y-GAP-fit(above);}
   y=Math.max(EDGE,Math.min(y,H-EDGE-card.offsetHeight));
  }
  card.style.transform='translate('+Math.round(x)+'px,'+Math.round(y)+'px)';
 }
 function next(){if(step===plan.length-1)dismiss('done');else move(1);}
 function move(delta){
  if(!valid()){reset();return;}
  step=Math.max(0,Math.min(plan.length-1,step+delta));
  enter().focus({preventScroll:true});
 }
 /* The highlighted Riwayat/Peta button does what it says, then the guide moves on with that screen open. */
 function tryTarget(){const s=current();if(!s.open)return;go(s.open);move(1);}
 function open(){
  const account=root.JagaAppAccount?.();if(!account?.id)return;
  if(pending){clearTimeout(pending);pending=null;}
  owner=String(account.id);generation=root.JagaAppGeneration?.();step=0;
  // Replayed from Akun: close that sheet first (it would cover every step) and start on Beranda.
  let replay=false;
  for(let i=0;i<5&&activeDialog&&activeDialog.id!=='feature-tour';i++){replay=true;closeDialogById(activeDialog.id);}
  if(replay)go('home');
  startMenu=typeof currentMenuName!=='undefined'?currentMenuName:'home';startScroll=document.scrollingElement?.scrollTop||0;
  plan=STEPS.filter(s=>!s.when||s.when());
  if(!modal)build();
  setDialogOpen('feature-tour');
  enter().focus({preventScroll:true});
 }
 function dismiss(result='skipped',keepScreen=false){
  if(valid()){seen.add(owner);try{localStorage.setItem(key(owner),result);}catch(_){/* Session memory still prevents repeat prompts. */}}
  if(modal&&!modal.classList.contains('hidden')){
   // Leave the farmer where the guide found them, unless they chose to start a photo.
   if(!keepScreen&&startMenu&&startMenu!=='scan')go(startMenu);
   if(!keepScreen&&document.scrollingElement)document.scrollingElement.scrollTop=startScroll;
   closeDialog('feature-tour');
  }
  clearSpacer();owner=null;generation=null;target=null;startMenu=null;
 }
 function reset(){clearSpacer();if(pending)clearTimeout(pending);pending=null;if(modal){closeDialog('feature-tour');modal.remove();modal=null;}owner=null;generation=null;target=null;startMenu=null;}
 function onSignedIn(){
  const id=String(root.JagaAppAccount?.()?.id||''),gen=root.JagaAppGeneration?.();if(!id||finished(id))return;
  if(pending)clearTimeout(pending);
  const attempt=()=>{
   pending=null;if(String(root.JagaAppAccount?.()?.id||'')!==id||root.JagaAppGeneration?.()!==gen)return;
   if(finished(id))return;
   // Wait until the person is back on a quiet screen; never cover an in-progress photo or dialog.
   if(document.hidden||activeDialog||currentMenuName==='scan'||hasUnsentPhoto()){pending=setTimeout(attempt,1500);return;}
   open();
  };
  pending=setTimeout(attempt,500);
 }
 root.JagaTour={open,dismiss,reset,onSignedIn,steps:()=>plan.map(s=>s.id)};
})(window);
