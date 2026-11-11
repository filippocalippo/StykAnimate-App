import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {createStartupDocument} from '../src/startup-document.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {ikChain} from '../src/ik.mjs';
import {pivotDocument} from './support/engine-export.mjs';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-3,`${a} != ${b}`);
const named=(editor,name)=>editor.figure.segments.find(s=>s.name===name);
const select=(editor,name)=>editor.select(1,editor.figure.segments.indexOf(named(editor,name)));
function assertHold(e){
  assert.equal(e.totalTicks,10);assert.equal(e.report.keyframes.length,1);
  const sheet=e.report._styk.layerSheet;
  assert.deepEqual(Object.keys(sheet.tracks).sort(),['camera','layer-1','scene']);
  assert.equal(sheet.duration,10);
  for(const track of Object.values(sheet.tracks)){
    assert.equal(track.end,10);assert.equal(track.keys.length,1);
    assert.equal(track.keys[0].tick,0);assert.equal(track.keys[0].interpolation,'constant');
  }
}

test('New creates a clean Blue scene with one ten-frame key on every layer',()=>{
  for(const layerTimeline of [false,true]){
    const e=newOwnedEditor({layerTimeline}).newDocument();
    assert.equal(e.name,'Untitled animation');assertHold(e);
    assert.equal(e.frame.objects.length,1);assert.equal(e.report.figure_types.length,1);
    assert.equal(e.figure.name,'Blue');assert.equal(e.dirty,false);assert.equal(e.canUndo,false);
    assert.equal(Object.keys(e.object._stykIK).length,4);
    assert.ok(Object.values(e.object._stykIK).every(c=>c.enabled&&!c.pinned));
    assert.ok(!e.figure._styk?.spatialMesh,'startup uses ordinary 2D artwork');
    assert.ok(e.figure.segments.every(s=>!s._stykRig?.spatial));
    const baseline=e.geometry.objects.get(0).joints;
    for(let tick=0;tick<10;tick++){
      e.seek(tick);assert.equal(e.evaluatedFrame.objects.length,1);
      assert.deepEqual(e.geometry.objects.get(0).joints,baseline);
    }
    assertHold(e);assert.equal(e.dirty,false);
  }
});

test('The default is an ordinary editable stick figure and owns independent data',()=>{
  const a=createStartupDocument(),b=createStartupDocument();
  const figure=a.figure_types[0],original=structuredClone(b);
  assert.equal(figure.segments.length,10);
  assert.ok(figure.segments.every(s=>s.visible&&!s.is_static&&s.length>0));
  assert.equal(figure.segments.filter(s=>s.segment_type==='line').length,9);
  assert.equal(figure.segments.filter(s=>s.segment_kind==='circleFill').length,1);
  assert.equal(figure.polyfills.length,0);assert.equal(figure.image_assets.length,0);
  const chains=Object.keys(a.keyframes[0].objects[0]._stykIK).map(id=>ikChain(figure,id,2));
  assert.ok(chains.every(chain=>chain.length===2));
  assert.equal(new Set(chains.flat()).size,8,'limbs have independent two-bone IK chains');
  assert.equal(a.keyframes[0].objects[0].root_x,480);assert.equal(a.keyframes[0].objects[0].root_y,280);
  a.figure_types[0].segments[0].name='Changed';
  a.figure_types[0].segments[0].color_rgb[0]=255;
  a.keyframes[0].objects[0]._stykIK[4].pinned=true;
  a.keyframes[0].objects[0]._stykIK[4].target.x+=100;
  a._styk.layerSheet.tracks.scene.end=2;
  assert.deepEqual(b,original);
});

test('Blue has balanced limbs and a slightly bent, accessible resting pose',()=>{
  const e=newOwnedEditor({demo:false,layerTimeline:true}).newDocument();
  for(const part of ['upper arm','forearm','thigh','lower leg']){
    const a=e.geometry.objects.get(0).joints.get(named(e,'Left '+part).segment_id);
    const b=e.geometry.objects.get(0).joints.get(named(e,'Right '+part).segment_id);
    near(a.y,b.y);near(a.x+b.x,960);
  }
  const joints=[...e.geometry.objects.get(0).joints.values()];
  for(let i=0;i<joints.length;i++)for(let j=i+1;j<joints.length;j++)
    assert.ok(Math.hypot(joints[i].x-joints[j].x,joints[i].y-joints[j].y)>20,'handles stay separated');
  for(const chain of Object.keys(e.object._stykIK).map(id=>ikChain(e.figure,id,2))){
    const [a,b]=chain.map(i=>e.object.angles[i]);
    assert.ok(Math.abs(a-b)>.1&&Math.abs(a-b)<.6,'a slight bend establishes the elbow/knee direction');
  }
});

test('All four 2D limbs pose without stretching or disturbing other branches, with undo and redo',()=>{
  for(const layerTimeline of [false,true])for(const name of ['Left forearm','Right forearm','Left lower leg','Right lower leg']){
    const e=newOwnedEditor({demo:false,layerTimeline}).newDocument();select(e,name);
    const id=named(e,name).segment_id,chain=ikChain(e.figure,id,2),before=e.serialize();
    const initial=e.geometry.objects.get(0),target={x:initial.joints.get(id).x,y:initial.joints.get(id).y-25};
    e.beginDrag();e.poseJoint(target.x,target.y);e.commitDrag();
    const posed=e.geometry.objects.get(0),after=e.serialize();
    near(posed.joints.get(id).x,target.x);near(posed.joints.get(id).y,target.y);
    for(const [i,s]of posed.segments.entries()){
      near(s.length,initial.segments[i].length);
      if(!chain.includes(i))assert.deepEqual(posed.joints.get(s.seg.segment_id),initial.joints.get(s.seg.segment_id));
    }
    assert.notDeepEqual(after,before);assert.equal(e.undo(),true);assert.deepEqual(e.serialize(),before);
    assert.equal(e.redo(),true);assert.deepEqual(e.serialize(),after);
  }
});

test('Pinned 2D feet stay planted when the body moves',()=>{
  const e=newOwnedEditor({demo:false,layerTimeline:true}).newDocument();
  for(const name of ['Left lower leg','Right lower leg']){select(e,name);e.setNodeIK({pinned:true});}
  const positions=['Left lower leg','Right lower leg'].map(name=>[named(e,name).segment_id,e.geometry.objects.get(0).joints.get(named(e,name).segment_id)]);
  e.select(1);e.moveSelection(0,15);
  for(const [id,p]of positions){near(e.geometry.objects.get(0).joints.get(id).x,p.x);near(e.geometry.objects.get(0).joints.get(id).y,p.y);}
});

test('Native saving and reopening preserve Blue and all three ten-frame holds',async()=>{
  const e=newOwnedEditor({demo:false,layerTimeline:true}).newDocument();
  const bytes=await buildContainerV2(e.serialize(),'styk');
  const saved=(await decodeDocument(bytes,'styk')).document;
  const reopened=newOwnedEditor({demo:false,layerTimeline:true});reopened.load(saved);
  assertHold(reopened);assert.equal(reopened.figure.name,'Blue');
  assert.deepEqual(reopened.object._stykIK,e.object._stykIK);
  // Decode fills derived flag aliases; authored topology, style and pose stay intact.
  assert.partialDeepStrictEqual(reopened.figure.segments,e.figure.segments);
  assert.deepEqual(reopened.geometry.objects.get(0).joints,e.geometry.objects.get(0).joints);
  assert.equal(reopened.figure._styk?.spatialMesh,undefined);
  assert.equal(reopened.canUndo,false);assert.equal(reopened.dirty,false);
});

test('Pivot export keeps the 2D startup artwork and ten-frame timing',()=>{
  const e=newOwnedEditor({demo:false,layerTimeline:true}).newDocument();
  select(e,'Left forearm');e.poseJoint(515,265);
  const before=e.serialize(),joints=e.geometry.objects.get(0).joints;
  const reopened=newOwnedEditor({demo:false}).load(pivotDocument(e.report));
  assert.equal(reopened.totalTicks,10);assert.equal(reopened.figure.segments.length,10);
  for(const [id,p]of joints){near(reopened.geometry.objects.get(0).joints.get(id).x,p.x);near(reopened.geometry.objects.get(0).joints.get(id).y,p.y);}
  assert.deepEqual(e.serialize(),before);
});

test('New preserves camera and layer clipboards and pastes into the ten-frame scene with undo',()=>{
  const e=newOwnedEditor({demo:false,layerTimeline:true}).newDocument();
  e.setCameraValues({x:40});e.copyCamera();e.sheetCopyFrames(['layer-1'],0,9);
  e.newDocument();const before=e.serialize();assertHold(e);
  e.pasteCamera([0]);assert.equal(e.evaluatedFrame.camera.x,40);
  e.undo();assert.deepEqual(e.serialize(),before);
  e.sheetPasteFrames(['layer-1'],10);assert.equal(e.totalTicks,20);
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,10]);
  e.seek(19);assert.equal(e.evaluatedFrame.objects.length,1);
  e.undo();assert.deepEqual(e.serialize(),before);assertHold(e);
});
