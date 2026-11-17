(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.JagaDailyLog=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  function dateKey(value,timeZone){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
    const part=type=>parts.find(item=>item.type===type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  function previousDateKey(now,timeZone){
    const today=dateKey(now,timeZone);const [year,month,day]=today.split('-').map(Number);
    return dateKey(Date.UTC(year,month-1,day-1,12), 'UTC');
  }
  function build(records,now=Date.now(),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone,targetKey=null){
    const today=targetKey||dateKey(now,timeZone),latest=new Map();let unknownUpdateTimes=0,photoCount=0;
    for(const row of records||[]){
      const id=row.cropId??row.id;if(id==null)continue;
      // Upload/creation is stable: changing a status or the EXIF capture date cannot move a photo into today.
      const saved=row.uploadedMs??row.createdMs,at=saved==null||saved===''?NaN:Number(saved);
      if(!Number.isFinite(at)||!Number.isFinite(new Date(at).getTime())){unknownUpdateTimes++;continue;}
      if(dateKey(at,timeZone)!==today || (row.source==='manual'&&!row.imageUrl))continue;
      photoCount++;
      const key=String(id),prior=latest.get(key);
      if(!prior||at>prior.at||(at===prior.at&&String(row.id)>String(prior.row.id)))latest.set(key,{row,at});
    }
    const rows=[...latest.values()].sort((a,b)=>a.at-b.at).map(entry=>entry.row);
    return {date:today,timeZone,updates:rows.length,photoCount,unknownUpdateTimes,crops:rows.map(row=>({cropId:row.cropId??row.id,crop:row.cropName||row.crop||row.plant||'Tanaman',condition:row.condition||null,severity:row.observedSeverity||row.severity||null})),sourceRecordIds:rows.map(row=>row.id).filter(id=>id!=null)};
  }
  const DAYS=['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'],MONTHS=['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const DAYS_EN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],MONTHS_EN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const isEn=(lang)=>lang==='id'?false:lang==='en'?true:!!(typeof root!=='undefined'&&root.JagaI18n&&typeof root.JagaI18n.isEn==='function'&&root.JagaI18n.isEn());
  const tr=(s,lang)=>isEn(lang)&&root.JagaI18n.t?root.JagaI18n.t(s):s;
  const trCrop=(s,lang)=>isEn(lang)&&root.JagaI18n.crop?root.JagaI18n.crop(s):s;
  const trCond=(s,lang)=>isEn(lang)&&root.JagaI18n.condition?root.JagaI18n.condition(s):s;
  function parseKey(key){const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(key||''));return m?{y:+m[1],m:+m[2],d:+m[3]}:null;}
  // "Senin, 20 Okt" (or with the year). Pure calendar maths, so it never depends on a time zone.
  function labelDate(key,withYear,lang=null){const p=parseKey(key);if(!p)return String(key||'');const dow=new Date(Date.UTC(p.y,p.m-1,p.d)).getUTCDay();const days=isEn(lang)?DAYS_EN:DAYS,months=isEn(lang)?MONTHS_EN:MONTHS;return `${days[dow]}, ${p.d} ${months[p.m-1]}${withYear?' '+p.y:''}`;}
  function shortDate(key,lang=null){const p=parseKey(key);if(!p)return '';const months=isEn(lang)?MONTHS_EN:MONTHS;return `${p.d} ${months[p.m-1]}`;}
  // Structured, plain summary: what was uploaded today, the active cases, and safe next steps.
  // It never claims a trend (better/worse/recovered): upload time is not observation time.
  function narrative(draft,customHeading=null,lang=null){
    const en=isEn(lang),crops=draft.crops||[],labels=en?{Healthy:'Healthy',Moderate:'Moderate',Severe:'Critical'}:{Healthy:'Sehat',Moderate:'Waspada',Severe:'Kritis'};
    const heading=customHeading?(en?(tr(customHeading,lang)||customHeading):customHeading):`${en?'Today':'Hari ini'} (${labelDate(draft.date,false,lang)})`,lines=[heading,''];
    if(!crops.length){
      lines.push(en?'• No crop photos uploaded today.':'• Belum ada foto tanaman yang diunggah hari ini.',en?'• No photos does not mean every crop is healthy.':'• Tidak adanya foto bukan berarti semua tanaman sehat.');
      lines.push('',en?'Suggestions:':'Saran:',en?'• Photograph crops you want to record to start filling today\'s summary.':'• Foto tanaman yang ingin dicatat untuk mulai mengisi ringkasan hari ini.');
    }else{
      const nPhotos=draft.photoCount??crops.length;
      lines.push(en?`• ${nPhotos} photo${nPhotos===1?'':'s'} from ${crops.length} crop${crops.length===1?'':'s'}.`:`• ${nPhotos} foto dari ${crops.length} tanaman.`);
      const rank={Severe:0,Moderate:1,Healthy:2};
      const ordered=[...crops].sort((a,b)=>(rank[a.severity]??3)-(rank[b.severity]??3));
      // "Teh: Sehat — sehat" said the same thing twice; a healthy condition name adds nothing to the status.
      const extra=crop=>crop.condition&&!/^(tanaman )?(sehat|healthy)$/i.test(String(crop.condition).trim())?' — '+trCond(crop.condition,lang):'';
      for(const crop of ordered.slice(0,2))lines.push(`• ${trCrop(crop.crop,lang)}: ${labels[crop.severity]||(en?'Not assessed':'Belum dinilai')}${extra(crop)}.`);
      if(crops.length>2){
        const more=crops.length-2;
        lines.push(en?`• ${more} more crop${more===1?'':'s'} recorded today.`:`• ${more} tanaman lain tercatat hari ini.`);
      }
      lines.push('',en?'Suggestions:':'Saran:');
      if(crops.some(c=>c.severity==='Severe'||c.severity==='Moderate')){
        const first=ordered.find(c=>c.severity==='Severe'||c.severity==='Moderate');
        lines.push(en?`• Inspect ${trCrop(first.crop,lang)} first. Open its result for check steps.`:'• Periksa '+first.crop+' terlebih dahulu. Buka hasilnya untuk langkah pemeriksaan.',en?'• Re-photograph the same area with matching angle and lighting.':'• Foto ulang bagian yang sama dengan sudut dan cahaya yang sebanding.');
      }else if(crops.some(c=>!['Healthy','Moderate','Severe'].includes(c.severity))){
        lines.push(en?'• Complete photos for crops that could not yet be assessed.':'• Lengkapi foto tanaman yang belum dapat dinilai.',en?'• Inspect in person; an unclear result does not mean healthy.':'• Periksa langsung; hasil yang belum jelas tidak berarti tanaman sehat.');
      }else{
        lines.push(en?'• Continue routine monitoring.':'• Lanjutkan pemantauan rutin.',en?'• Re-photograph if any changes appear on the crop.':'• Foto ulang bila terlihat perubahan pada tanaman.');
      }
    }
    if(draft.unknownUpdateTimes)lines.push('',en?'Notes:':'Catatan:',en?'• Some older logs were excluded because their upload time is unknown.':'• Beberapa catatan lama tidak dihitung karena waktu unggahnya tidak diketahui.');
    return lines.join('\n');
  }
  return {dateKey,previousDateKey,build,narrative,labelDate,shortDate};
});



