(function(root){
 'use strict';
 const plugin=()=>root.Capacitor?.Plugins?.JagaSync;
 function owner(args){const id=String(root.JagaAppAccount?.()?.id||'');if(!id||id!==String(args.accountId))throw Error('Masuk dengan akun pemilik foto.');return id;}
 function checkpoint(id,generation){if(String(root.JagaAppAccount?.()?.id||'')!==id||(generation!==undefined&&root.JagaAppGeneration?.()!==generation))throw Error('Akun berubah; foto tetap terkunci.');}
 async function invoke(method,args){
  const id=owner(args),generation=root.JagaAppGeneration?.();let result;
  if(root.JagaNative?.isNative()){
   if(typeof plugin()?.[method]!=='function'){
    // An older APK has no photoDelete: deleting is best effort there, everything else needs the new APK.
    if(method==='photoDelete')return {deleted:false,unsupported:true};
    throw Error('Perbarui APK untuk penyimpanan foto pribadi.');
   }
   result=await plugin()[method](args);
  } else if(['draftGet','draftEdit','draftResume','draftMark'].includes(method))result=await root.JagaOfflineStore[method](args);
  else if(method==='photoPut')result=await root.JagaOfflineStore.photoPut({accountId:id,photoId:args.photoId,imageBase64:args.imageBase64,metadata:args.metadata});
  else if(method==='photoGet')result=await root.JagaOfflineStore.photoGet({accountId:id,photoId:args.photoId});
  else if(method==='photoDelete')result=await root.JagaOfflineStore.photoDelete({accountId:id,photoId:args.photoId});
  checkpoint(id,generation);return result;
 }
 function exifJpeg(dataUrl,metadata){
  if(!root.piexif)throw Error('Cap lokasi belum tersedia di aplikasi ini.');
  const gps={};const p=root.piexif;
  if(root.JagaWorkflow.validPoint(metadata.lat,metadata.lng)){
   const deg=value=>{const total=Math.round(Math.abs(value)*3600*1000000),d=Math.floor(total/3600000000),rest=total-d*3600000000,m=Math.floor(rest/60000000);return [[d,1],[m,1],[rest-m*60000000,1000000]];};
   gps[p.GPSIFD.GPSLatitudeRef]=metadata.lat<0?'S':'N';gps[p.GPSIFD.GPSLatitude]=deg(metadata.lat);
   gps[p.GPSIFD.GPSLongitudeRef]=metadata.lng<0?'W':'E';gps[p.GPSIFD.GPSLongitude]=deg(metadata.lng);
   gps[p.GPSIFD.GPSVersionID]=[2,3,0,0];
  }
  const provenance=metadata.locationSource||metadata.source||'unknown';
  const exif={};exif[p.ExifIFD.UserComment]='ASCII\x00\x00\x00JagaKebond location source: '+provenance;
  return p.insert(p.dump({'0th':{},Exif:exif,GPS:gps}),dataUrl);
 }
 const api={
  async preview(dataUrl,maxPx=640,quality=0.8){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const scale=Math.min(1,maxPx/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',quality));};image.onerror=()=>reject(Error('Foto lokal tidak dapat dibaca.'));image.src=dataUrl;});},
  put:args=>invoke('photoPut',args),get:args=>invoke('photoGet',args),
  /* Contract 5.6: removes the private original (browser: IndexedDB entry; Android: encrypted file + Keystore alias). Idempotent. */
  delete:async args=>{const result=await invoke('photoDelete',{accountId:String(root.JagaAppAccount?.()?.id||''),...args});root.clearRenderedPhotoCache?.(args.photoId);return result;},
  /* Saving the original is a convenience, never a reason to refuse a capture: quota and storage errors are reported, not thrown. */
  async tryPut(args){
   try{await invoke('photoPut',args);return {ok:true};}
   catch(error){return {ok:false,quota:!!(error&&(error.reason==='quota'||error.quota)),message:error&&error.message?error.message:'Foto asli tidak dapat disimpan.'};}
  },
  async deleteQuietly(args){try{return await api.delete(args);}catch(_){return {deleted:false};}},
  draftGet:args=>invoke('draftGet',args),draftEdit:args=>invoke('draftEdit',args),draftResume:args=>invoke('draftResume',args),draftMark:args=>invoke('draftMark',args),
  async saveGallery(args){
   const id=owner(args);
   if(root.JagaNative?.isNative())return invoke('photoExport',args);
   await root.JagaFeatures.load('photoExport');checkpoint(id);
   const photo=args.imageBase64?{imageBase64:args.imageBase64,metadata:args.metadata||{}}:await api.get(args);checkpoint(id);if(!photo.imageBase64)throw Error('Foto kualitas asli tidak ada di perangkat ini.');
   const url=exifJpeg('data:image/jpeg;base64,'+photo.imageBase64,photo.metadata||{});
   const a=document.createElement('a');a.download='JagaKebond_'+args.photoId+'.jpg';a.href=url;a.click();return {ok:true};
  },
  async dataUrl(photoId){const accountId=String(root.JagaAppAccount?.()?.id||'');if(!accountId)return null;const p=await api.get({accountId,photoId});return p&&p.imageBase64?'data:image/jpeg;base64,'+p.imageBase64:null;},
  /* Small preview (<= 480 px). Browser: persisted in the thumbs store so the history grid never decodes full photos again. */
  async thumb(photoId){
   const accountId=String(root.JagaAppAccount?.()?.id||'');if(!accountId)return null;
   const store=root.JagaOfflineStore,native=!!root.JagaNative?.isNative();
   if(!native&&store?.thumbGet){const cached=await store.thumbGet({accountId,photoId});if(cached)return cached;}
   const full=await api.dataUrl(photoId);if(!full)return null;
   const small=await api.preview(full,480,0.72);
   if(!native&&store?.thumbPut)store.thumbPut({accountId,photoId,dataUrl:small}).catch(()=>undefined);
   return small;
  },
  exifJpeg
 };
 root.JagaMedia=api;
})(window);
