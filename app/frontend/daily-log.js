(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.JagaDailyLog=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
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
  function parseKey(key){const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(key||''));return m?{y:+m[1],m:+m[2],d:+m[3]}:null;}
  // "Senin, 20 Okt" (or with the year). Pure calendar maths, so it never depends on a time zone.
  function labelDate(key,withYear){const p=parseKey(key);if(!p)return String(key||'');const dow=new Date(Date.UTC(p.y,p.m-1,p.d)).getUTCDay();return `${DAYS[dow]}, ${p.d} ${MONTHS[p.m-1]}${withYear?' '+p.y:''}`;}
  function shortDate(key){const p=parseKey(key);return p?`${p.d} ${MONTHS[p.m-1]}`:'';}
  // Structured, plain summary: what was uploaded today, the active cases, and safe next steps.
  // It never claims a trend (better/worse/recovered): upload time is not observation time.
  function narrative(draft,customHeading=null){
    const crops=draft.crops||[],labels={Healthy:'Sehat',Moderate:'Waspada',Severe:'Kritis'};
    const when=customHeading||`Hari ini (${labelDate(draft.date)})`,lines=[when,''];
    if(!crops.length){
      lines.push('• Belum ada foto tanaman yang diunggah hari ini.','• Tidak adanya foto bukan berarti semua tanaman sehat.');
      lines.push('','Saran:','• Foto tanaman yang ingin dicatat untuk mulai mengisi ringkasan hari ini.');
    }else{
      lines.push(`• ${draft.photoCount??crops.length} foto dari ${crops.length} tanaman.`);
      const rank={Severe:0,Moderate:1,Healthy:2};
      const ordered=[...crops].sort((a,b)=>(rank[a.severity]??3)-(rank[b.severity]??3));
      // "Teh: Sehat — sehat" said the same thing twice; a healthy condition name adds nothing to the status.
      const extra=crop=>crop.condition&&!/^(tanaman )?sehat$/i.test(String(crop.condition).trim())?' — '+crop.condition:'';
      for(const crop of ordered.slice(0,2))lines.push(`• ${crop.crop}: ${labels[crop.severity]||'Belum dinilai'}${extra(crop)}.`);
      if(crops.length>2)lines.push(`• ${crops.length-2} tanaman lain tercatat hari ini.`);
      lines.push('','Saran:');
      if(crops.some(c=>c.severity==='Severe'||c.severity==='Moderate')){
        const first=ordered.find(c=>c.severity==='Severe'||c.severity==='Moderate');
        lines.push('• Periksa '+first.crop+' terlebih dahulu. Buka hasilnya untuk langkah pemeriksaan.','• Foto ulang bagian yang sama dengan sudut dan cahaya yang sebanding.');
      }else if(crops.some(c=>!['Healthy','Moderate','Severe'].includes(c.severity))){
        lines.push('• Lengkapi foto tanaman yang belum dapat dinilai.','• Periksa langsung; hasil yang belum jelas tidak berarti tanaman sehat.');
      }else{
        lines.push('• Lanjutkan pemantauan rutin.','• Foto ulang bila terlihat perubahan pada tanaman.');
      }
    }
    if(draft.unknownUpdateTimes)lines.push('','Catatan:','• Beberapa catatan lama tidak dihitung karena waktu unggahnya tidak diketahui.');
    return lines.join('\n');
  }
  return {dateKey,previousDateKey,build,narrative,labelDate,shortDate};
});



