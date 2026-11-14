const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../app/frontend/app.js'), 'utf8');
const start = source.indexOf('    function weatherNote(rh) {');
const end = source.indexOf('    function showToast(message) {', start);
const region = source.slice(start, end);
function harness(apiImpl) {
  let now = 1000000, calls = [], updates = 0, nodes = {};
  class TestDate extends Date { static now() { return now; } }
  const ctx = {
    Date: TestDate, Math, Number, isFinite, console, setTimeout,
    document: { getElementById: id => nodes[id] || (nodes[id] = { innerText: '', textContent:'',value:'',dataset:{},setAttribute(name,value){this[name]=value;},getAttribute(name){return this[name];}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }) },
    navigator: { geolocation: { getCurrentPosition(success) { success({ coords: { latitude: -6, longitude: 106, accuracy: 7 } }); } } },
    currentAccount: { id: 'a' }, accountGeneration: 1,
    currentCoords: { lat: null, lng: null, elevation: null, accuracy: null, locationName: null, weather: null, tempC: null, rh: null },
    farmRecords: [], mapInstance: null, mapCenteredOnFix: false,
    validCoordinates: (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180,
    api: url => { calls.push(url); return apiImpl ? apiImpl(url) : Promise.resolve({ elevation: 12, locationName: 'First', weather: 'Clear', tempC: 30, rh: 65 }); },
    updateDashboardTelemetry: () => { updates++; }, showToast: () => {},
    JagaHooks: { on() {}, run() {}, async runAsync() {} }   // 0.2.4.16: actions.js registry, loaded before app.js
  };
  vm.createContext(ctx);
  vm.runInContext(region + '\nthis.apply=applyLiveGpsReading; this.request=requestLiveLocation; this.search=submitPlaceSearch; this.draw=updateDashboardTelemetry; this.readSnapshot=()=>telemetrySnapshot;', ctx);
  return { ctx, get calls() { return calls; }, get updates() { return updates; }, get now() { return now; }, set now(v) { now = v; }, get nodes() { return nodes; } };
}
test('first GPS fix fetches one telemetry snapshot', async () => { const h = harness(); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); assert.equal(h.calls.length, 1); });
// 0.2.2.0 (audit: place/weather went blank for an hour after walking): moving > 50 m refreshes after 1 minute;
// staying put keeps the hourly gate.
test('movement does not trigger an automatic fetch within one minute', async () => { const h = harness(); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); h.now += 59999; h.ctx.apply(-6.1, 106.1, 8); assert.equal(h.calls.length, 1); });
test('movement refreshes telemetry after one minute instead of one hour', async () => { const h = harness(); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); h.now += 60000; h.ctx.apply(-6.1, 106.1, 8); assert.equal(h.calls.length, 2); });
test('staying within 50 m keeps the hourly gate', async () => { const h = harness(); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); h.now += 3599999; h.ctx.apply(-6.0001, 106.0001, 8); assert.equal(h.calls.length, 1); });
test('automatic fetch is eligible at one hour, regardless of movement', async () => { const h = harness(); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); h.now += 3600000; h.ctx.apply(-6.1, 106.1, 8); assert.equal(h.calls.length, 2); });
test('manual refresh bypasses the hourly gate', async () => { const h = harness(); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); h.ctx.request(true); await new Promise(r => setImmediate(r)); assert.equal(h.calls.length, 2); });
test('movement keeps prior snapshot internally but does not display it as current weather', async () => { const h = harness(); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); h.ctx.apply(-6.1, 106.1, 7); h.ctx.draw(); assert.equal(h.ctx.currentCoords.lat, -6.1); assert.equal(h.nodes['home-temp-val'].innerText, '—'); assert.equal(h.ctx.readSnapshot().tempC,30); assert.equal(h.ctx.currentCoords.weather, null); });
test('failed telemetry attempts remain rate-limited', async () => { const h = harness(() => Promise.reject(new Error('offline'))); h.ctx.apply(-6, 106, 8); await new Promise(r => setImmediate(r)); for (let i = 1; i <= 20; i++) { h.now += 2000; h.ctx.apply(-6 - i * 0.001, 106, 8); await new Promise(r => setImmediate(r)); } assert.equal(h.calls.length, 1); h.now += 60000; h.ctx.apply(-6.1, 106.1, 8); h.ctx.apply(-6.1001, 106.1, 8); assert.equal(h.calls.length, 2); });
test('late response from old account cannot populate current snapshot', async () => { let resolve; const h = harness(() => new Promise(r => { resolve = r; })); h.ctx.apply(-6, 106, 8); h.ctx.accountGeneration++; h.ctx.currentAccount = { id: 'b' }; resolve({ elevation: 10, locationName: 'wrong account', tempC: 42 }); await new Promise(r => setImmediate(r)); assert.equal(h.ctx.readSnapshot(), null); });
test('camera and current-location elevation never claim a moved stale snapshot', async () => { const h=harness();h.ctx.apply(-6,106,8);await new Promise(r=>setImmediate(r));h.ctx.apply(-6.1,106.1,7);assert.equal(h.nodes['live-msl-stamp'].innerText,'— m dpl');assert.equal(h.nodes['home-elev-val'].innerText,'—'); });
test('GPS dot uses new fix accuracy, not hourly snapshot accuracy', async () => { const h=harness();h.ctx.apply(-6,106,8);await new Promise(r=>setImmediate(r));h.ctx.apply(-6.1,106.1,142);assert.equal(h.nodes['home-accuracy-tag'].dataset.accuracy,'poor');assert.equal(h.nodes['home-accuracy-tag'].textContent,''); });
test('manual GPS callback issued by previous account is ignored',async()=>{const h=harness();let callback;h.ctx.navigator.geolocation.getCurrentPosition=success=>callback=success;h.ctx.request(true);h.ctx.accountGeneration++;h.ctx.currentAccount={id:'b'};callback({coords:{latitude:-6,longitude:106,accuracy:7}});assert.equal(h.calls.length,0);assert.equal(h.ctx.currentCoords.lat,null);});
test('name search during active telemetry issues exactly one follow-up carrying the hint',async()=>{let release;const h=harness(()=>new Promise(resolve=>release=resolve));h.ctx.apply(-6,106,8);h.nodes['home-place-search']={value:'Kota & Barat'};h.ctx.search();assert.equal(h.calls.length,1);release({locationName:'Initial'});await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,2);assert.equal(new URL(h.calls[1],'https://fixture.invalid').searchParams.get('placeHint'),'Kota & Barat');release({locationName:'Named place'});await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,2);});
test('queued place search is not dispatched for another account',async()=>{let release;const h=harness(()=>new Promise(resolve=>release=resolve));h.ctx.apply(-6,106,8);h.nodes['home-place-search']={value:'Old owner place'};h.ctx.search();h.ctx.accountGeneration++;h.ctx.currentAccount={id:'b'};release({locationName:'Old owner'});await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1);assert.equal(h.ctx.readSnapshot(),null);});
test('queued place search is discarded after movement away from requested fix',async()=>{let release;const h=harness(()=>new Promise(resolve=>release=resolve));h.ctx.apply(-6,106,8);h.nodes['home-place-search']={value:'Previous location'};h.ctx.search();h.ctx.apply(-7,107,8);release({locationName:'Old area'});await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1);});
