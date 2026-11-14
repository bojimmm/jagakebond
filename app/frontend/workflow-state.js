(function(root) {
 'use strict';
 const terminal = new Set(['done','failed','cancelled','rejected']);
 function validPoint(lat,lng) { return Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180; }
 function accuracyBand(value,source) { return source==='manual'||source==='plot'||!Number.isFinite(value)||value<0?'unknown':value>100?'poor':value>=50?'fair':'good'; }
 function counts(drafts,jobs) {
  const known=new Map(jobs.map(j=>[j.id,j]));let unsent=0;const processing=new Set(),failed=new Set();
  for(const j of jobs) {if(['queued','claimed'].includes(j.status))processing.add(j.id);else if(['failed','rejected','cancelled'].includes(j.status))failed.add(j.id);}
  for(const d of drafts) {
   const j=known.get(d.jobId),status=j?.status||d.status,key=d.jobId||d.clientRequestId;
   if(['failed','rejected','cancelled','conflict'].includes(status))failed.add(key);
   else if(status==='submitted'||['queued','claimed'].includes(status))processing.add(key);
   else if(!terminal.has(status))unsent++;
  }
  return {unsent,processing:processing.size,failed:failed.size,active:unsent+processing.size};
 }
 function inside(point,ring) {
  let yes=false;const [y,x]=point;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
   const [yi,xi]=ring[i],[yj,xj]=ring[j];
   if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)yes=!yes;
  }
  return yes;
 }
 function plotPoint(ring) {
  if(!Array.isArray(ring)||ring.length<3||ring.some(p=>!Array.isArray(p)||!validPoint(p[0],p[1])))throw Error('Batas petak tidak valid.');
  const xs=ring.map(p=>p[1]);if(Math.max(...xs)-Math.min(...xs)>180)throw Error('Petak lintas antimeridian belum didukung.');
  let a=0,cx=0,cy=0;
  for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length],s=p[1]*q[0]-q[1]*p[0];a+=s;cx+=(p[1]+q[1])*s;cy+=(p[0]+q[0])*s;}
  if(Math.abs(a)<1e-12)throw Error('Luas petak tidak valid.');
  const center=[cy/(3*a),cx/(3*a)];if(inside(center,ring))return center;
  // Select an interior midpoint near the centre for concave parcels. Never put a
  // plant outside its assigned plot simply because the area centroid is outside.
  const ys=[...new Set(ring.map(p=>p[0]))].sort((a,b)=>a-b);let best=null;
  for(let k=0;k<ys.length-1;k++) {
   const y=(ys[k]+ys[k+1])/2,cross=[];
   for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];if((p[0]>y)!==(q[0]>y))cross.push(p[1]+(y-p[0])*(q[1]-p[1])/(q[0]-p[0]));}
   cross.sort((a,b)=>a-b);
   for(let i=0;i+1<cross.length;i+=2){const p=[y,(cross[i]+cross[i+1])/2],distance=(p[0]-center[0])**2+(p[1]-center[1])**2;if(!best||distance<best.distance)best={point:p,distance};}
  }
  if(!best||!inside(best.point,ring))throw Error('Titik tengah petak tidak tersedia.');return best.point;
 }
 const api={validPoint,accuracyBand,counts,inside,plotPoint,isTerminal:s=>terminal.has(s)};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.JagaWorkflow=api;
})(typeof window==='undefined'?globalThis:window);
