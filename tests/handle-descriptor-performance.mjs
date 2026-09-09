/** Native Akane exposed-handle preparation, separating geometry construction. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {getPivotHandles, invalidatePivotHandleTopology} from '../src/canvas-interactions.mjs';
const filename=process.argv[2]||'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const response=await fetch('http://127.0.0.1:47831/api/import?filename='+encodeURIComponent(filename.split('/').at(-1)),{
  method:'POST',headers:{'content-type':'application/octet-stream'},body:await fs.readFile(filename)});
assert.equal(response.status,200);const {document:report}=await response.json();
const frameIndex=report.keyframes.length-1,frame=report.keyframes[frameIndex],times=[];
invalidatePivotHandleTopology();let expected,segmentCount=0,coldMs;
for(let i=0;i<31;i++){
  const geometry=buildGeometry(report,frame),started=performance.now();
  const handles=getPivotHandles(geometry,{frame,selectedUid:460616,viewScale:1.49});
  const elapsed=performance.now()-started;
  const snapshot=handles.map(h=>[h.uid,h.id,h.joint,h.color,h.screenRadius,h.point.x,h.point.y]);
  if(!i){expected=snapshot;coldMs=elapsed;segmentCount=[...geometry.objects.values()].reduce((n,g)=>n+g.segments.length,0);}
  else{assert.deepEqual(snapshot,expected);times.push(elapsed);}
}
times.sort((a,b)=>a-b);
const result={filename,frameIndex,objectCount:frame.objects.length,segmentCount,handleCount:expected.length,
  coldTopologyAndDescriptorsMs:coldMs,freshPoseDescriptorsMs:{p50:times[15],p95:times[28],max:times.at(-1)},
  samples:times.length,allDescriptorsExactAcrossFreshPoses:true,
  note:'Each sample uses newly built geometry sharing the same immutable definitions; geometry construction and assertion are excluded from descriptor timing.'};
await fs.writeFile(new URL('../artifacts/handle-descriptor-performance.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
