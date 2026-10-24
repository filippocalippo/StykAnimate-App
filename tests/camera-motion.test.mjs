import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeLayerSheet} from '../src/editor-layer-sheet.mjs';
import {Editor} from '../src/editor.mjs';
import {createCameraMotion,sampleCameraMotion,validateCameraMotion,cameraAtTime} from '../src/camera-motion.mjs';
import {cameraSamplingReport} from '../src/camera-motion-bake.mjs';
import {packMotionLanes} from '../src/camera-motion-timeline.mjs';
import {motionRowSize,motionLaneBox,sheetRowLayout} from '../src/timeline-rows.mjs';
import {parallaxResolver} from '../src/layer-parallax.mjs';
import {evaluatedFrame,buildGeometry} from '../src/pivot/geometry.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {snapshotPoseFrame} from '../src/pose-snapshot.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<.002,`${a} != ${b}`);
function fixture(){const e=new Editor({demo:false});e.addFigure();initializeLayerSheet(e.report);e._invalidate({timing:true});return e;}
function at(e,tick){const rows=e.timeline,index=rows.findLastIndex(r=>r.start<=tick),row=rows[Math.max(0,index)];return evaluatedFrame(e.report,Math.max(0,index),row.count?(tick-row.start)/row.count:0,tick);}
test('motions that never play together share a timeline lane; overlapping ones stack',()=>{
  const clip=(id,start,duration)=>({id,start,duration}),lanes=clips=>packMotionLanes(clips).map(lane=>lane.map(c=>c.id));
  assert.deepEqual(lanes([]),[]);
  assert.deepEqual(lanes(Array.from({length:10},(_,i)=>clip(`m${i}`,i*20,12))),[['m0','m1','m2','m3','m4','m5','m6','m7','m8','m9']]);
  // A clip may start on the frame the one before it ends; clips come in start order whatever their saved order.
  assert.deepEqual(lanes([clip('late',12,4),clip('early',0,12),clip('long',6,40),clip('third',10,3)]),[['early','late'],['long'],['third']]);
});
test('the Motion row is a content row for one lane and grows a 14px sub-lane per overlapping motion',()=>{
  assert.equal(motionRowSize(1),32);assert.equal(motionRowSize(1,{row:28}),28);assert.equal(motionRowSize(3),50);assert.equal(motionRowSize(2,{touch:true}),60);
  // Sub-lanes split the row between 4px margins with a 2px gap; one lane keeps today's inset pill.
  assert.deepEqual(motionLaneBox(100,50,0,3),{top:104,height:12});assert.deepEqual(motionLaneBox(100,50,2,3),{top:132,height:12});
  assert.deepEqual(motionLaneBox(0,32,0,1),{top:5,height:22});assert.deepEqual(motionLaneBox(0,48,0,1),{top:8,height:32});
  const layout=sheetRowLayout([{kind:'camera'},{kind:'motion',laneCount:3},{kind:'scene'},{kind:'layer'}],{viewport:400});
  assert.equal(layout.size(1),50);assert.equal(layout.top(2),74);assert.equal(layout.at(30),1);assert.equal(layout.pinned,true);
});
test('seeded motion seeks identically, overlaps add, and boundaries return neutral',()=>{
  const clip=createCameraMotion('shake','a',10,48),state={version:1,clips:[clip]};validateCameraMotion(state);
  const a=sampleCameraMotion(state,24);for(const t of [57,10,35,13,0])sampleCameraMotion(state,t);assert.deepEqual(a,sampleCameraMotion(state,24));
  assert.deepEqual(sampleCameraMotion(state,58),{x:0,y:0,rotation:0,zoom:1});
  const both=sampleCameraMotion({clips:[clip,{...clip,id:'b'}]},24);near(both.x,a.x*2);near(both.rotation,a.rotation*2);
  assert.notDeepEqual(a,sampleCameraMotion({clips:[{...clip,params:{...clip.params,seed:4}}]},24));
});
test('motion rejects invalid input atomically and only retains camera metadata in history',()=>{
  const e=fixture(),objects=e.report.keyframes.map(f=>f.objects),before=e.serialize(),history=e._undo.length;
  const id=e.addCameraMotion('impact',{start:5,duration:12});assert.equal(e._undo.length,history+1);assert.ok(e.totalTicks>=17);assert.ok(e._undo.at(-1).bytes<12000);
  assert.deepEqual(e.report.keyframes.map(f=>f.objects),objects);
  const state=e.report._styk.cameraMotion;assert.throws(()=>e.setCameraMotion(id,{params:{zoom:-1}}));assert.equal(e.report._styk.cameraMotion,state);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.getCameraMotions()[0].id,id);
});
test('motion changes output camera but never authored pose; hidden camera bypasses it',()=>{
  const e=fixture();e.addCameraMotion('impact',{start:0,duration:12});const f=at(e,0),base={...f.camera},matrix=cameraMatrix({report:e.report,frame:f});
  assert.notDeepEqual(matrix,[1,0,0,1,0,0]);assert.deepEqual(f.camera,base);
  e.setLayerVisible('camera',false);assert.deepEqual(cameraMatrix({report:e.report,frame:f}),[1,0,0,1,0,0]);
});
test('parallax reference holds composition, disabled camera bypasses depth, and joins inherit root response',()=>{
  const e=fixture(),uid=e.selectedUid;const layer=e.activeLayerId;e.setCameraValues({x:50});e.setLayerParallax(layer,{enabled:true,x:.25});
  let f=at(e,0);assert.deepEqual(parallaxResolver(e.report,f)(uid),{x:0,y:0});
  e.setCameraValues({x:150});f=at(e,0);near(parallaxResolver(e.report,f)(uid).x,75);assert.deepEqual(parallaxResolver(e.report,f,false)(uid),{x:0,y:0});
  const synthetic={camera:{x:150},objects:[{unique_id:uid},{unique_id:999,join:{target_object_slot:0}}]};
  const report={...e.report,_styk:{...e.report._styk,layers:{...e.report._styk.layers,assignments:{...e.report._styk.layers.assignments,999:'other'},byId:{...e.report._styk.layers.byId,other:{parallax:{enabled:true,x:2,y:2,reference:{x:0,y:0}}}},order:[...e.report._styk.layers.order,'other']}}};
  assert.deepEqual(parallaxResolver(report,synthetic)(999),parallaxResolver(report,synthetic)(uid));
});
test('Pivot materialization bakes motion and parallax once without changing editable project',()=>{
  const e=fixture();e.setLayerParallax(e.activeLayerId,{enabled:true,x:.5});e.setCameraValues({x:60});e.addCameraMotion('impact',{start:0,duration:12});
  const before=e.serialize(),frame=at(e,0),out=materializePivotDocument(e.report);near(out.keyframes[0].objects[0].root_x,frame.objects[0].root_x+30);
  near(out.keyframes[0].camera.x,cameraAtTime(e.report,frame).x);assert.equal(out._styk.cameraMotion,undefined);assert.deepEqual(e.serialize(),before);
});
test('baking retains camera output and parallax at every output tick and undoes as one action',async()=>{
  const e=fixture(),layer=e.activeLayerId,uid=e.selectedUid;e.setLayerParallax(layer,{enabled:true,x:.3});e.setCameraValues({x:70});e.addCameraMotion('impact',{duration:12});e.addCameraMotion('wobble',{duration:24});
  const before=e.serialize(),history=e._undo.length,samples=Array.from({length:e.totalTicks},(_,t)=>{const f=at(e,t);return {camera:cameraAtTime(e.report,f),depth:parallaxResolver(e.report,f)(uid)};});
  await e.bakeCameraMotion();assert.equal(e._undo.length,history+1);assert.ok(e.getCameraMotions().every(c=>!c.enabled));
  samples.forEach((sample,t)=>{const f=at(e,t),camera=cameraAtTime(e.report,f),depth=parallaxResolver(e.report,f)(uid);for(const k of ['x','y','scale','angle_rad'])near(camera[k],sample.camera[k]);near(depth.x,sample.depth.x);near(depth.y,sample.depth.y);});
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();validateAnimationDocument(e.report);
});
test('camera-only baking projection contains no scene geometry or assets',()=>{
  const e=fixture();e.addCameraMotion('shake');const source=cameraSamplingReport(e.report);assert.deepEqual(source.figure_types,[]);assert.deepEqual(source.backgrounds,[]);assert.ok(source.keyframes.every(f=>f.objects.length===0));
  Object.defineProperty(e.report,'_stykSource',{enumerable:true,get(){throw new Error('Read original media');}});
  Object.defineProperty(e.report._styk,'audio',{enumerable:true,get(){throw new Error('Read audio media');}});
  Object.defineProperty(e.report._styk.frameSources??={},'unrelated',{enumerable:true,get(){throw new Error('Read unrelated pose');}});
  assert.doesNotThrow(()=>cameraSamplingReport(e.report));
});
test('pose snapshots omit the derived motion clock and retain the authored camera',()=>{
  const e=fixture();e.addCameraMotion('impact');const frame=at(e,3),saved=snapshotPoseFrame(frame);assert.equal(saved._cameraMotionTick,undefined);assert.deepEqual(saved.camera,frame.camera);
});
for(const interpolation of ['constant','linear','bezier','auto'])test(`partial bake preserves all output ticks across ${interpolation} camera spans`,async()=>{
  const e=fixture(),uid=e.selectedUid;e.addCameraMotion('handheld',{duration:60});e.addCameraMotion('impact',{start:5,duration:30});
  e.setLayerParallax(e.activeLayerId,{enabled:true,x:.2});
  for(const [tick,x] of [[0,0],[20,100],[40,240]]){e.sheetInsertKey(['camera'],tick);e.seek(tick);e.setCameraValues({x});}
  e.sheetSetEasing(['camera'],0,40,{interpolation,...(interpolation==='bezier'?{bezier:[.3,0,.8,1]}:{})});
  const sample=()=>Array.from({length:e.totalTicks},(_,tick)=>{const f=at(e,tick);return {c:cameraAtTime(e.report,f),p:parallaxResolver(e.report,f)(uid)};});
  const before=e.serialize(),expected=sample();await e.bakeCameraMotion({start:8,end:14});validateAnimationDocument(e.report);
  const actual=sample();expected.forEach((s,t)=>{for(const k of ['x','y','scale','angle_rad'])near(s.c[k],actual[t].c[k]);near(s.p.x,actual[t].p.x);near(s.p.y,actual[t].p.y);});
  await e.bakeCameraMotion({start:45,end:49});sample().forEach((s,t)=>{for(const k of ['x','y','scale','angle_rad'])near(s.c[k],expected[t].c[k]);near(s.p.x,expected[t].p.x);});
  e.undo();e.undo();assert.deepEqual(e.serialize(),before);
});
test('cancelled bake leaves saved state and history untouched',async()=>{
  const e=fixture();e.addCameraMotion('shake');const before=e.serialize(),history=e._undo.length;
  await assert.rejects(e.bakeCameraMotion({signal:AbortSignal.abort()}),{name:'AbortError'});assert.deepEqual(e.serialize(),before);assert.equal(e._undo.length,history);
});
test('camera and layer locks reject motion, baking and parallax changes atomically',async()=>{
  const e=fixture(),id=e.addCameraMotion('shake');e.setLayerLocked('camera',true);e.setLayerLocked(e.activeLayerId,true);const before=e.serialize();
  assert.throws(()=>e.setCameraMotion(id,{enabled:false}),/Unlock/);assert.throws(()=>e.addCameraMotion('impact'),/Unlock/);
  assert.throws(()=>e.setLayerParallax(e.activeLayerId,{enabled:true}),/Unlock/);await assert.rejects(e.bakeCameraMotion(),/Unlock/);assert.deepEqual(e.serialize(),before);
});
