import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createDemo} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
const fresh=()=>new Editor({demo:false}).load(createDemo());
const exact=e=>assert.deepEqual(e.geometry.drawables,buildGeometry(e.report,e.evaluatedFrame).drawables);

test('duration history keeps figure arrays and native-key geometry, including undo/redo',()=>{
  const e=fresh();e.selectFrame(0);const report=structuredClone(e.report),g=e.geometry,objects=e.frame.objects,id=e.getFrameId();
  e.setFramesDuration([0],17);assert.equal(e.frame.objects,objects);assert.equal(e.geometry,g);assert.equal(e.getFrameById(id),e.frame);exact(e);
  const command=e._undo.at(-1);assert.equal(command.kind,'frame-timing');assert.ok(command.bytes<2000);
  e.undo();assert.deepEqual(e.report,report);assert.equal(e.geometry,g);exact(e);
  e.redo();assert.equal(e.frame.duration_raw,17);assert.equal(e.geometry,g);exact(e);
});

test('timing undo cannot overwrite subsequent figure edits and alternate key selection invalidates geometry',()=>{
  const e=fresh();e.selectFrame(0);e.setFramesDuration([0,1],13);e.select(e.frame.objects[0].unique_id);
  const old=e.object.root_x;e.updateObject({root_x:old+19});exact(e);e.undo();e.undo();exact(e);
  e.redo();e.redo();assert.equal(e.object.root_x,old+19);assert.equal(e.frame.duration_raw,13);exact(e);
  const g=e.geometry;e.setFramesDuration([1],5);assert.equal(e.frameIndex,1);assert.notEqual(e.geometry,g);exact(e);
});

test('extend-style timing edits preserve selection and validate the entire change before mutation',()=>{
  const e=fresh();e.selectFrame(1);e.select(e.frame.objects[0].unique_id);const selection=e._selectionState(),before=structuredClone(e.report);
  assert.throws(()=>e._setFrameDurations([{index:0,ticks:3},{index:1,ticks:65536}]),/duration/);assert.deepEqual(e.report,before);assert.equal(e._undo.length,0);
  e._setFrameDurations([{index:0,ticks:3},{index:1,ticks:9}],{retainSelection:true,label:'Extend frames'});
  assert.equal(e.selectedUid,selection.uid);assert.equal(e.frameIndex,selection.frameIndex);assert.equal(e.tick,selection.tick);exact(e);
  e.undo();assert.deepEqual(e.report,before);assert.deepEqual(e._selectionState(),selection);exact(e);
});

test('interpolated poses are reevaluated when timing changes',()=>{
  const e=fresh();e.setFramesDuration([0],10);e.seek(3);const g=e.geometry;
  e._setFrameDurations([{index:0,ticks:20}],{retainSelection:true});assert.notEqual(e.geometry,g);exact(e);
  e.undo();assert.equal(e.tick,3);exact(e);e.redo();exact(e);
});

test('Simple duration edits support discard and history with sparse timing fields',()=>{
  const e=fresh();e.enableFrameDrafts({mode:'update',index:0});const before=structuredClone(e.frame);
  e.setFramesDuration([0],12);assert.equal(e.frameDraft.dirty,true);e.undo();assert.deepEqual(e.frame,before);e.redo();assert.equal(e.frame.duration_raw,12);
  e.discardFrameDraft();assert.deepEqual(e.frame,before);e.undo();assert.equal(e.frame.duration_raw,12);e.redo();assert.deepEqual(e.frame,before);
});
