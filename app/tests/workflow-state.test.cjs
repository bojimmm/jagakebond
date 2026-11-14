const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../frontend/workflow-state.js');
test('accuracy boundaries use measured WGS84 GPS error only', () => {
 for (const [n, band] of [[49.9,'good'],[50,'fair'],[100,'fair'],[100.1,'poor'],[null,'unknown'],[-1,'unknown'],[NaN,'unknown']]) assert.equal(flow.accuracyBand(n),band);
 assert.equal(flow.accuracyBand(2,'manual'),'unknown');
});
test('terminal results and server receipts never double count pending', () => {
 const drafts=[{clientRequestId:'a',status:'submitted',jobId:'j1'},{clientRequestId:'b',status:'pending'},{clientRequestId:'c',status:'failed',jobId:'j2'}];
 const jobs=[{id:'j1',status:'done'},{id:'j2',status:'failed'},{id:'j3',status:'claimed'}];
 assert.deepEqual(flow.counts(drafts,jobs),{unsent:1,processing:1,failed:1,active:2});
 assert.deepEqual(flow.counts([{clientRequestId:'a',status:'submitted',jobId:'j1'}],[{id:'j1',status:'failed'}]),{unsent:0,processing:0,failed:1,active:0});
});
test('paired finite coordinates accept zero, reject missing and axis errors',()=>{
 assert.equal(flow.validPoint(0,0),true);assert.equal(flow.validPoint(null,0),false);assert.equal(flow.validPoint(-6,106),true);assert.equal(flow.validPoint(106,-6),false);
});
test('plot representative center stays inside a concave plot and WGS84 axis order',()=>{
 const ring=[[-6,106],[-6,106.04],[-5.96,106.04],[-5.96,106.03],[-5.99,106.03],[-5.99,106.01],[-5.96,106.01],[-5.96,106]];
 const point=flow.plotPoint(ring);assert.equal(flow.inside(point,ring),true);assert.ok(point[0]<0&&point[1]>100);
 assert.throws(()=>flow.plotPoint([[0,0],[0,0],[0,0]]));
});
