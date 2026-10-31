import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCameraMotion} from '../src/camera-motion.mjs';
import {ownedEditorSync, ownedEditorFor} from './support/owned-editor.mjs';
import {ownerReferences} from './support/owner-references.mjs';
import {packMotionLanes} from '../src/camera-motion-timeline.mjs';
import {motionRowSize,motionLaneBox,sheetRowLayout} from '../src/timeline-rows.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {pivotDocument} from './support/engine-export.mjs';
const refs=ownerReferences(import.meta.url);
const near=(a,b,tolerance=.002)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
function fixture(){const e=ownedEditorFor({demo:false,layerTimeline:true});e.addFigure();return e;}
/** The same document (built by a plain editor, once: its reference) with the engine owning the editor: baking the camera's motion is a command of the engine session. */
function ownedFixture(take){return ownedEditorSync({demo:false},JSON.parse(take('fixture')),{recorded:false}).editor;}
function at(e,tick){e.seek(tick);return e.evaluatedFrame;}
/** The camera the engine shoots the frame at `tick` with: the authored camera, follow travel, then the presets' impulses. */
function shot(e,tick){e.seek(tick);return e._shown.shot()??e.evaluatedFrame.camera;}
/** How far a layer's parallax shifts its figures when the camera travels as `camera` (the authored camera, with no follow clip in
 * these documents): (1 - depth) × the travel beyond the impulse a bake kept in it, from the layer's reference point. */
function depthShift(e,camera,layer=e.activeLayerId){
  const p=e.getLayer(layer).parallax,impulse=camera?._parallaxMotionOffset??{x:0,y:0};
  return {x:(1-p.x)*((camera?.x??0)-impulse.x-p.reference.x),y:(1-p.y)*((camera?.y??0)-impulse.y-p.reference.y)};
}
/** What the shot looks like at every tick: its camera, and the shift it gives the active layer. */
const shots=e=>Array.from({length:e.totalTicks},(_,tick)=>{const camera=shot(e,tick);return {camera,depth:depthShift(e,e.evaluatedFrame.camera)};});
const sameShots=(a,b)=>a.forEach((s,t)=>{for(const k of ['x','y','scale','angle_rad'])near(s.camera?.[k]??(k==='scale'?1:0),b[t].camera?.[k]??(k==='scale'?1:0));near(s.depth.x,b[t].depth.x);near(s.depth.y,b[t].depth.y);});
const shotAt=shot;
/** What a Pivot export stores per frame once the camera's motion and the layers' parallax are baked into it (the engine's export). */
const stored=e=>pivotDocument(e).keyframes.map(f=>({camera:{x:f.camera?.x??0,y:f.camera?.y??0,scale:f.camera?.scale??1,angle_rad:f.camera?.angle_rad??0},roots:f.objects.map(o=>[o.root_x,o.root_y])}));
function sameStored(actual,expected){
  assert.equal(actual.length,expected.length);
  actual.forEach((frame,i)=>{for(const k of ['x','y','scale','angle_rad'])near(frame.camera[k],expected[i].camera[k]);frame.roots.forEach((root,j)=>{near(root[0],expected[i].roots[j][0]);near(root[1],expected[i].roots[j][1]);});});
}
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
  const e=fixture(),id=e.addCameraMotion('shake',{start:10,duration:48}),clip=e.getCameraMotions().find(c=>c.id===id);validateCameraMotion({version:1,clips:[clip]});
  const sample=(c,tick)=>e._shown.cameraSamples(c,[tick]);
  const a=sample(clip,24);for(const t of [57,10,35,13,0])sample(clip,t);assert.deepEqual(sample(clip,24),a);
  assert.deepEqual(sample(clip,58),[0,0,0,1]);
  assert.notDeepEqual(a,sample({...clip,params:{...clip.params,seed:4}},24));
  // Two clips add: their offsets and rolls sum and their zooms multiply, and the shot is the authored camera moved by that through its
  // final scale. Each clip's own part is the engine's sample of it alone.
  const second=e.addCameraMotion('shake',{start:10,duration:48});
  e.setCameraMotion(second,{params:{seed:clip.params.seed}});
  const [dx,dy,roll,zoom]=e.getCameraMotions().map(c=>sample(c,24)).reduce((sum,part)=>[sum[0]+part[0],sum[1]+part[1],sum[2]+part[2],sum[3]*part[3]],[0,0,0,1]);
  const camera=shot(e,24),authored=e.evaluatedFrame.camera,base=authored?.is_default?{}:authored??{};
  const scale=(base.scale??1)/zoom,angle=(base.angle_rad??0)+roll;
  assert.ok(Math.abs(dx)>.01);
  near(camera.x,(base.x??0)+scale*(Math.cos(angle)*dx-Math.sin(angle)*dy),1e-9);near(camera.y,(base.y??0)+scale*(Math.sin(angle)*dx+Math.cos(angle)*dy),1e-9);
  near(camera.scale,scale,1e-9);near(camera.angle_rad,angle,1e-9);
});
test('motion rejects invalid input atomically and only retains camera metadata in history',()=>{
  const e=fixture(),objects=e.report.keyframes.map(f=>f.objects),before=e.serialize(),history=e._undo.length;
  const id=e.addCameraMotion('impact',{start:5,duration:12});assert.equal(e._undo.length,history+1);assert.ok(e.totalTicks>=17);assert.ok(e._undo.at(-1).bytes<12000);
  assert.deepEqual(e.report.keyframes.map(f=>f.objects),objects);
  const state=e.report._styk.cameraMotion;assert.throws(()=>e.setCameraMotion(id,{params:{zoom:-1}}));assert.equal(e.report._styk.cameraMotion,state);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.getCameraMotions()[0].id,id);
});
test('motion changes output camera but never authored pose; hidden camera bypasses it',()=>{
  const e=fixture();e.addCameraMotion('impact',{start:0,duration:12});const f=at(e,0),base={...f.camera},seen={...f,camera:shot(e,0)},matrix=cameraMatrix({report:e.report,frame:seen});
  assert.notDeepEqual(matrix,[1,0,0,1,0,0]);assert.deepEqual(f.camera,base);
  e.setLayerVisible('camera',false);assert.deepEqual(cameraMatrix({report:e.report,frame:seen}),[1,0,0,1,0,0]);
});
test('parallax reference holds composition, disabled camera bypasses depth, and joins inherit root response',()=>{
  // The shift a layer's parallax gives its figures is baked into the Pivot export (the engine's), where it reads as their roots moving.
  const e=fixture(),uid=e.selectedUid,layer=e.activeLayerId,rootX=id=>pivotDocument(e).keyframes[0].objects.find(o=>o.unique_id===id).root_x;
  const authored=rootX(uid);
  e.setCameraValues({x:50});e.setLayerParallax(layer,{enabled:true,x:.25});
  near(rootX(uid),authored);
  e.setCameraValues({x:150});near(rootX(uid),authored+75);
  // A figure on another layer that answers the camera more strongly moves by its own response...
  const other=e.createLayer('Other');e.setLayerParallax(other.id,{enabled:true,x:2,y:2,reference:{x:0,y:0}});
  e.selectSheetLayer(other.id);e.addFigure();const child=e.selectedUid;
  near(rootX(child),authored-150);
  // ...until it is joined to the first: a joined figure moves with the layer of the figure at the root of its chain.
  e.joinFigure(uid,0);near(rootX(child),authored+75);near(rootX(uid),authored+75);
  // A hidden camera track bypasses depth everywhere.
  e.setLayerVisible('camera',false);near(rootX(child),authored);near(rootX(uid),authored);
});
test('Pivot materialization bakes motion and parallax once without changing editable project',()=>{
  const e=fixture();e.setLayerParallax(e.activeLayerId,{enabled:true,x:.5});e.setCameraValues({x:60});e.addCameraMotion('impact',{start:0,duration:12});
  const before=e.serialize(),frame=at(e,0),out=pivotDocument(e.report);near(out.keyframes[0].objects[0].root_x,frame.objects[0].root_x+30);
  near(out.keyframes[0].camera.x,shot(e,0).x);assert.equal(out._styk.cameraMotion,undefined);assert.deepEqual(e.serialize(),before);
});
refs.test('baking retains camera output and parallax at every output tick and undoes as one action',take=>{
  const e=ownedFixture(take),layer=e.activeLayerId;e.setLayerParallax(layer,{enabled:true,x:.3});e.setCameraValues({x:70});e.addCameraMotion('impact',{duration:12});e.addCameraMotion('wobble',{duration:24});
  const before=e.serialize(),history=e._undo.length,samples=shots(e),exported=stored(e);
  e.bakeCameraMotion();assert.equal(e._undo.length,history+1);assert.ok(e.getCameraMotions().every(c=>!c.enabled));
  sameShots(samples,shots(e));sameStored(stored(e),exported);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();validateAnimationDocument(e.report);
});
for(const interpolation of ['constant','linear','bezier','auto'])refs.test(`partial bake preserves all output ticks across ${interpolation} camera spans`,take=>{
  const e=ownedFixture(take);e.addCameraMotion('handheld',{duration:60});e.addCameraMotion('impact',{start:5,duration:30});
  e.setLayerParallax(e.activeLayerId,{enabled:true,x:.2});
  for(const [tick,x] of [[0,0],[20,100],[40,240]]){e.sheetInsertKey(['camera'],tick);e.seek(tick);e.setCameraValues({x});}
  e.sheetSetEasing(['camera'],0,40,{interpolation,...(interpolation==='bezier'?{bezier:[.3,0,.8,1]}:{})});
  const before=e.serialize(),expected=shots(e),exported=stored(e);e.bakeCameraMotion({start:8,end:14});validateAnimationDocument(e.report);
  sameShots(expected,shots(e));sameStored(stored(e),exported);
  e.bakeCameraMotion({start:45,end:49});sameShots(expected,shots(e));sameStored(stored(e),exported);
  e.undo();e.undo();assert.deepEqual(e.serialize(),before);
});
refs.test('camera and layer locks reject motion, baking and parallax changes atomically',take=>{
  const e=ownedFixture(take),id=e.addCameraMotion('shake');e.setLayerLocked('camera',true);e.setLayerLocked(e.activeLayerId,true);const before=e.serialize();
  assert.throws(()=>e.setCameraMotion(id,{enabled:false}),/Unlock/);assert.throws(()=>e.addCameraMotion('impact'),/Unlock/);
  assert.throws(()=>e.setLayerParallax(e.activeLayerId,{enabled:true}),/Unlock/);assert.throws(()=>e.bakeCameraMotion(),/Unlock/);assert.deepEqual(e.serialize(),before);
});
