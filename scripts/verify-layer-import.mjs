import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';

const report=JSON.parse(readFileSync(process.argv[2]??'artifacts/timeline-source.json','utf8'));
const start=performance.now(),e=new Editor({demo:false,propertyChannels:true,layerTimeline:true}).load(report);
console.log({loadMs:performance.now()-start,keys:e.report.keyframes.length,uids:e._layerUidCounts.size,ticks:e.totalTicks});
const original=e.serialize(),tick=Math.min(10,e.totalTicks-1);
e.seek(tick);
const layer=e.activeLayerId;
const ids=()=>e.evaluatedFrame.objects.filter(o=>e.layerForUid(o.unique_id)===layer).map(o=>o.unique_id).sort((a,b)=>a-b);
const drawOrder=()=>e.evaluatedFrame.object_draw_order.map(slot=>e.evaluatedFrame.objects[slot]).filter(o=>e.layerForUid(o.unique_id)===layer).map(o=>o.unique_id);
const appearance=()=>buildGeometry(e.report,e.evaluatedFrame).drawables.filter(d=>e.layerForUid(d.obj.unique_id)===layer).map(d=>({
  uid:d.obj.unique_id,type:d.type,rgb:d.rgb,alpha:d.alpha,points:d.points.map(p=>[p.x,p.y]),
}));
const expectedIds=ids(),expectedOrder=drawOrder(),expectedAppearance=appearance(),t=performance.now();
e.sheetInsertKey([layer],tick);
console.log({insertMs:performance.now()-t,sources:Object.keys(e.report._styk.frameSources??{}).length,history:e._undo.at(-1).bytes});
const destination=tick+e.totalTicks,t2=performance.now();
e.sheetMoveFrames([layer],tick,tick,e.totalTicks);
console.log({moveMs:performance.now()-t2});
for(let t=0;t<e.totalTicks;t++){
  e.seek(t);const objects=e.evaluatedFrame.objects;
  assert.equal(new Set(objects.map(o=>o.unique_id)).size,objects.length,`Duplicate identity at frame ${t+1}`);
  buildGeometry(e.report,e.evaluatedFrame);
}
e.seek(destination);
// Native and composed poses may store objects in different slot orders.
// Figure identities, rendered stacking and connected geometry must all survive.
assert.deepEqual(ids(),expectedIds);
assert.deepEqual(drawOrder(),expectedOrder);
const actual=appearance();assert.equal(actual.length,expectedAppearance.length);
for(let i=0;i<actual.length;i++){
  const {points,...style}=actual[i],{points:expectedPoints,...expectedStyle}=expectedAppearance[i];
  assert.deepEqual(style,expectedStyle);assert.equal(points.length,expectedPoints.length);
  for(let p=0;p<points.length;p++)for(let axis=0;axis<2;axis++)assert.ok(Math.abs(points[p][axis]-expectedPoints[p][axis])<1e-6,`Geometry changed for figure ${style.uid}`);
}
e.undo();e.undo();assert.deepEqual(e.serialize(),original);
console.log({identitiesExact:true,stackingExact:true,geometryPreserved:true,undoExact:true});
