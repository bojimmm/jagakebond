const test=require('node:test');const assert=require('node:assert/strict');const daily=require('../../app/frontend/daily-log');
const now=Date.parse('2026-10-16T12:00:00Z'),saved=Date.parse('2026-10-16T11:00:00Z');
test('natural daily paragraph explains observations and limits without invented trends',()=>{
 const d=daily.build([{id:'a',cropId:'a',crop:'Mangga',condition:'Daun sehat',severity:'Healthy',createdMs:saved},{id:'b',cropId:'b',crop:'Pisang',condition:'Bercak daun',severity:'Moderate',createdMs:saved}],now,'Asia/Jakarta');
 // 0.2.2.0 (UX brief B5): short and plain (max ~3 lines), same observations and advice, still no invented trend.
 const text=daily.narrative(d);assert.ok(text.length<=600,text);assert.ok(text.includes('Mangga'));assert.match(text,/bercak daun/i);assert.match(text,/waspada/i);assert.ok(!text.includes(';'));assert.doesNotMatch(text,/membaik|memburuk|pulih/i);assert.match(text,/\nSaran:\n/);assert.match(text,/\n• /);assert.doesNotMatch(text,/• [^\n]+ • /);
});
test('empty period does not imply a healthy garden or invent treatment',()=>{const text=daily.narrative(daily.build([],now,'UTC'));assert.match(text,/belum ada foto|tidak ada pembaruan/i);assert.match(text,/(belum|bukan) berarti semua tanaman sehat/i);assert.doesNotMatch(text.replace(/(belum|bukan) berarti semua tanaman sehat/i,''),/semua tanaman sehat/i);});
test('unknown timestamps and manual state remain transparent',()=>{const d=daily.build([{id:'a',crop:'Mangga',severity:'Severe',observedSeverity:'Healthy',createdMs:saved},{id:'b',crop:'Pisang'}],now,'UTC');const text=daily.narrative(d);assert.ok(text.includes('waktu'));assert.match(text,/sehat/i);assert.doesNotMatch(text,/kritis/i);});

