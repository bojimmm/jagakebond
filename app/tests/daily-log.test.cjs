const test=require('node:test'),assert=require('node:assert/strict');
const {build,dateKey,previousDateKey,narrative}=require('../frontend/daily-log');
test('today follows the local calendar across DST, midnight and year rollover',()=>{
 for(const [now,tz,day] of [
  ['2026-03-09T07:10:00Z','America/Los_Angeles','2026-03-09'],
  ['2026-11-02T07:59:59Z','America/Los_Angeles','2026-11-01'],
  ['2026-01-01T01:00:00Z','Asia/Jakarta','2026-01-01'],
  ['2026-01-01T01:00:00Z','America/Los_Angeles','2025-12-31'],
  ['2026-10-29T16:59:59Z','Asia/Jakarta','2026-10-29'],
  ['2026-10-29T17:00:00Z','Asia/Jakarta','2026-10-30']]) assert.equal(build([],Date.parse(now),tz).date,day);
 assert.equal(previousDateKey(Date.parse('2026-01-01T01:00:00Z'),'Asia/Jakarta'),'2025-12-31');
});
test('all today uploads count, latest upload per plant supplies its current observation',()=>{
 const now=Date.parse('2026-03-09T12:00:00Z'),tz='America/Los_Angeles';
 const rows=[{id:'old',cropId:'a',crop:'Tomat',uploadedMs:now-3000,severity:'Severe'},
  {id:'new',cropId:'a',crop:'Tomat',uploadedMs:now-1000,severity:'Healthy'},
  {id:'b',cropId:'b',createdMs:now-500},
  {id:'yesterday',createdMs:now-86400000},{id:'tomorrow',createdMs:now+86400000}];
 const result=build(rows,now,tz);assert.equal(result.date,'2026-03-09');assert.equal(result.updates,2);
 assert.equal(result.photoCount,3);assert.deepEqual(result.sourceRecordIds,['new','b']);
 assert.equal(result.crops[0].severity,'Healthy');assert.match(narrative(result),/3 foto dari 2 tanaman/);
});
test('EXIF capture dates, edits and delayed analysis cannot change upload day',()=>{
 const now=Date.parse('2026-10-29T12:00:00Z'),yesterday=now-86400000;
 const rows=[{id:'historical-photo',uploadedMs:now,createdMs:now,timestampMs:0},
 {id:'delayed-analysis',uploadedMs:yesterday,createdMs:now,updatedMs:now,timestampMs:now},
 {id:'edited-old',createdMs:yesterday,updatedMs:now},
 {id:'capture-only',timestampMs:now},{id:'edit-only',updatedMs:now}];
 const d=build(rows,now,'UTC');assert.deepEqual(d.sourceRecordIds,['historical-photo']);
 assert.equal(d.unknownUpdateTimes,2);
});
test('status override applies to the latest photo without moving an old photo into today',()=>{
 const now=Date.parse('2026-10-29T12:00:00Z');
 const d=build([{id:'a',createdMs:now,severity:'Severe',observedSeverity:'Healthy'}],now,'UTC');
 assert.equal(d.crops[0].severity,'Healthy');
});
test('invalid times and manual notes without photos do not invent uploaded photos',()=>{
 const now=Date.parse('2026-10-29T12:00:00Z');
 const d=build([{id:'a',createdMs:'bad'},{id:'b',createdMs:1e100},{id:'c',createdMs:'',updatedMs:now},
 {id:'note',source:'manual',createdMs:now}],now,'UTC');
 assert.equal(d.photoCount,0);assert.deepEqual(d.crops,[]);assert.equal(d.unknownUpdateTimes,3);
});
test('new photo updates today immediately; yesterday disappears at midnight',()=>{
 const today=Date.parse('2026-10-29T16:59:00Z'),tomorrow=today+120000;
 const rows=[{id:'a',cropId:'plant',createdMs:today,severity:'Severe'}];
 assert.equal(build(rows,today,'Asia/Jakarta').photoCount,1);
 rows.push({id:'b',cropId:'plant',createdMs:today+1000,severity:'Healthy'});
 assert.equal(build(rows,today+1000,'Asia/Jakarta').photoCount,2);
 assert.equal(build(rows,tomorrow,'Asia/Jakarta').photoCount,0);
 assert.match(narrative(build(rows,tomorrow,'Asia/Jakarta')),/Hari ini/);
});
test('daily suggestion uses a structured summary with bullets and separate advice',()=>{
 const text=narrative({date:'2026-10-30',photoCount:3,crops:[
  {crop:'Cabai',severity:'Severe',condition:'Antraknosa'},
  {crop:'Tomat',severity:'Moderate',condition:'Busuk daun'},
  {crop:'Padi',severity:'Healthy',condition:null}
 ],unknownUpdateTimes:1});
 assert.match(text,/^Hari ini \(Jumat, 30 Okt\)\n\n• 3 foto dari 3 tanaman\./);
 assert.match(text,/• Cabai: Kritis — Antraknosa\./);
 assert.match(text,/• Tomat: Waspada — Busuk daun\./);
 assert.match(text,/• 1 tanaman lain tercatat hari ini\./);
 assert.match(text,/\n\nSaran:\n• Periksa Cabai terlebih dahulu[^\n]+\n• Foto ulang bagian yang sama/);
 assert.match(text,/\n\nCatatan:\n• Beberapa catatan lama tidak dihitung/);
 assert.doesNotMatch(text,/• [^\n]+ • /);
});


