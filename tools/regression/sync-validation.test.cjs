'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const frontend=process.env.JK_FRONTEND||path.resolve(__dirname,'../../app/frontend');
const source=fs.readFileSync(path.join(frontend,'offline-sync.js'),'utf8');
function install(receipt){
 const row={accountId:'A',clientRequestId:'request_fixture',imageBase64:'YQ==',fields:{},status:'pending'};
 const window={JagaAppAccount:()=>({id:'A'}),JagaNative:{isNative:()=>false},JagaOfflineStore:{
  pendingForSync:async()=>[row],update:async(a,k,patch)=>Object.assign(row,patch),markFailure:async()=>{},lock:async()=>{}
 }};
 const context={window,globalThis:window,module:{exports:{}},Date,navigator:{onLine:true},document:{cookie:''},Uint8Array,atob,Blob,FormData,setInterval,clearInterval,
 fetch:async url=>({ok:true,status:200,json:async()=>url==='/api/health'?{version:'2.1.0'}:receipt})};
 vm.runInNewContext(source,context);return {sync:window.JagaOfflineSync,row,policy:context.module.exports};
}
test('HTTP-date Retry-After delays until the supplied instant',()=>{
 const {policy}=install({});const now=Date.UTC(2026,9,21,2,0,0);
 assert.equal(policy.retryAfterDelayMs(new Date(now+180000).toUTCString(),now),180000);
 assert.equal(policy.retryAfterDelayMs(new Date(now+172800000).toUTCString(),now),86400000);
 assert.equal(policy.retryAfterDelayMs('3',now),3000);
 assert.equal(policy.retryAfterDelayMs('tomorrow',now),60000);
});
test('malformed successful receipts retain drafts for retry',async()=>{
 for(const receipt of [{},{error:{job_id:'hidden'}},{job_id:''},{job_id:123},{job_id:'bad/id'}]){
  const h=install(receipt);await h.sync.run();assert.equal(h.row.status,'pending',JSON.stringify(receipt));assert.equal(h.row.jobId,undefined);
 }
});
test('valid successful receipts mark one submitted draft',async()=>{
 const h=install({job_id:'job_fixture'});await h.sync.run();assert.equal(h.row.status,'submitted');assert.equal(h.row.jobId,'job_fixture');
});
