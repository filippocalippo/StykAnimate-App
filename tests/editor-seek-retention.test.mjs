import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createDemo} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
const fixture=()=>{
  const report=createDemo(),a=report.keyframes[0];a.duration_raw=8;
  const b=structuredClone(a);b.objects[0].root_x+=40;
  b.objects.forEach(o=>{o.record_offset=400;o.record_end=800;});report.keyframes=[a,b];
  return new Editor({demo:false}).load(report);
};
const drawing=value=>JSON.parse(JSON.stringify(value,(key,value)=>key==='record_offset'||key==='record_end'?undefined:value));
const exact=e=>assert.deepEqual(drawing(e.geometry.drawables),drawing(buildGeometry(e.report,e.evaluatedFrame).drawables));
test('native key navigation retains unchanged figures and matches fresh interpolation',()=>{
  const e=fixture(),first=e.geometry;
  e.selectFrame(1);const second=e.geometry;assert.equal(second.objects.get(1),first.objects.get(1));assert.notEqual(second.objects.get(0),first.objects.get(0));exact(e);
  for(const tick of [0,1,3,7,8,0,8,2]){e.seek(tick);exact(e);}
  assert.ok(e._seekGeometry.alternates.size<=1024);assert.ok(e._seekGeometry.alternateDrawables<=250000);
  e.selectFrame(1);e.select(e.frame.objects[1].unique_id);const original=e.report.keyframes[0].objects[1].root_x;
  e.updateObject({root_x:original+7});assert.equal(e.report.keyframes[0].objects[1].root_x,original);assert.equal(e.object.root_x,original+7);exact(e);
});
test('live edits, cancellation, history and definition changes cannot reuse stale seek poses',()=>{
  const e=fixture();e.geometry;e.selectFrame(1);e.geometry;e.selectFrame(0);e.select(e.frame.objects[0].unique_id);
  e.beginDrag();e.object.angles[0]+=.3;e.touch();exact(e);e.cancelDrag();exact(e);
  e.updateObject({root_x:e.object.root_x+17});exact(e);e.selectFrame(1);exact(e);e.selectFrame(0);exact(e);
  e.undo();exact(e);e.redo();exact(e);
  e.figure.segments[0].thickness+=4;e._invalidate();exact(e);e.selectFrame(1);exact(e);
  const replacement=structuredClone(e.report);replacement.figure_types[0].segments[0].length+=10;e.load(replacement);exact(e);
});
test('joined descendants follow a changing parent while unrelated geometry remains retained',()=>{
  const e=fixture();for(const frame of e.report.keyframes)frame.objects[2].join={target_object_slot:0,target_handle_id:1};e._invalidate();
  const a=e.geometry;e.selectFrame(1);const b=e.geometry;
  assert.equal(a.objects.get(1),b.objects.get(1));assert.notEqual(a.objects.get(2),b.objects.get(2));exact(e);
  e.selectFrame(0);exact(e);
});
