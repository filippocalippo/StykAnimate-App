import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';

/** `prepare(report)` changes the document before it opens. */
function fixture({hold=false, sheet=true, count=2, duration=10, prepare=null}={}) {
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=[100,360,500].map(x=>createFrame(Array.from({length:count},(_,i)=>createObject(figure,i+1,x+i*20,200)),duration));
  prepare?.(report);
  const e=ownedEditorFor({demo:false,layerTimeline:sheet}, report);
  if(hold)e.sheetSetEasing(['layer-1'],0,duration*2,{interpolation:'constant'});
  e.seek(duration);e.select(1);return e;
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);

test('preview is reversible, drift-free, scoped, and commits one undo step',()=>{
  const e=fixture(),before=e.serialize(),undo=e._undo.length,other=e.evaluatedFrame.objects[1];
  e.beginTween();e.updateTween(.25);near(e.object.root_x,200);
  e.updateTween(.9);e.updateTween(.25);near(e.object.root_x,200);
  assert.equal(e.evaluatedFrame.objects[1],other);assert.equal(e._undo.length,undo);
  e.cancelDrag();assert.deepEqual(e.serialize(),before);
  e.beginTween();e.updateTween(.25);e.commitDrag();assert.equal(e._undo.length,undo+1);
  near(e.object.root_x,200);e.undo();assert.deepEqual(e.serialize(),before);
  e.redo();near(e.object.root_x,200);
  const reopened=ownedEditorFor({demo:false,layerTimeline:true}, e.serialize());reopened.seek(10);reopened.select(1);near(reopened.object.root_x,200);
});
test('a held exposure gets a new key exactly at the playhead',()=>{
  const e=fixture({hold:true});e.seek(5);e.select(1);
  e.beginTween();e.updateTween(.5);e.commitDrag();
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,5,10,20]);
  near(e.object.root_x,230);e.seek(0);near(e.object.root_x,100);
});
test('applying an unchanged in-between still authors a key, cancellation does not',()=>{
  const e=fixture();e.seek(5);e.select(1);const before=e.serialize();
  e.beginTween();e.updateTween(0,'neighbor');e.cancelDrag();assert.deepEqual(e.serialize(),before);
  e.beginTween();e.updateTween(0,'neighbor');e.commitDrag();
  assert.deepEqual(e.layerFrameKeys('layer-1').map(k=>k.tick),[0,5,10,20]);
  e.undo();assert.deepEqual(e.serialize(),before);
});
test('neighbor, relax and push always use the original pose and timed breakdown',()=>{
  const e=fixture();e.beginTween();
  e.updateTween(-.5,'neighbor');near(e.object.root_x,230);
  e.updateTween(.5,'neighbor');near(e.object.root_x,430);
  e.updateTween(0,'neighbor');near(e.object.root_x,360);
  e.updateTween(.5,'relax');near(e.object.root_x,330);
  e.updateTween(1,'push');near(e.object.root_x,420);
  e.updateTween(0,'push');near(e.object.root_x,360);e.commitDrag();
  assert.equal(e._undo.length,0);
});
test('rotation takes the short arc and retains figure appearance',()=>{
  const e=fixture({prepare:report=>{
    const frames=report.keyframes;
    for(const frame of frames)frame.objects[0].angles=frame.objects[0].angles.map(()=>0);
    frames[0].objects[0].angles[0]=170*Math.PI/180;frames[2].objects[0].angles[0]=-170*Math.PI/180;
    frames[1].objects[0].color_override_raw=0xff112233;
  }});
  e.beginTween();e.updateTween(.5);
  near(Math.abs(e.object.angles[0]),Math.PI);assert.equal(e.object.color_override_raw,0xff112233);
  e.commitDrag();e.undo();near(e.object.angles[0],0);
});
test('missing neighbors, blank poses and locked figures reject without mutation',()=>{
  for(const kind of ['endpoint','blank','locked']) {
    const e=fixture();
    if(kind==='endpoint')e.seek(0);
    if(kind==='blank')e.sheetInsertKey(['layer-1'],20,{blank:true});
    if(kind==='locked')e.setLayerLocked('layer-1',true);
    const before=e.serialize();assert.throws(()=>e.beginTween());assert.equal(e._drag,null);assert.deepEqual(e.serialize(),before);
  }
});
test('invalid inputs do not mutate an active preview',()=>{
  const e=fixture();e.beginTween();e.updateTween(.25);
  for(const value of [NaN,Infinity,-1,2])assert.throws(()=>e.updateTween(value));
  assert.throws(()=>e.updateTween(.5,'unknown'));near(e.object.root_x,200);e.cancelDrag();
});
test('multi-layer selection uses each layer’s own strict neighbors',()=>{
  const e=fixture(),layer=e.createLayer('Other');e.assignFiguresToLayer([2],layer.id);
  e.sheetInsertKey([layer.id],5);e.seek(10);e.selectMany([1,2]);
  const info=e.beginTween();assert.equal(info.groups.length,2);e.updateTween(0);
  near(e.frame.objects.find(o=>o.unique_id===1).root_x,100);
  near(e.frame.objects.find(o=>o.unique_id===2).root_x,250);
  e.cancelDrag();
});
