import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {geometryOfFrame} from './support/engine-geometry.mjs';
const fixture=()=>{
  const report=createDemo(),a=report.keyframes[0];a.duration_raw=8;
  const b=structuredClone(a);b.objects[0].root_x+=40;
  report.keyframes=[a,b];
  for(const frame of report.keyframes)frame.objects[2].join={target_object_slot:0,target_handle_id:1};
  return ownedEditorFor({demo:false},report);
};
const drawing=value=>JSON.parse(JSON.stringify(value));
// What the geometry the interface keeps across seeks shows is what a fresh read of the same frame shows.
const exact=e=>assert.deepEqual(drawing(e.geometry.drawables),drawing(geometryOfFrame(e,e.evaluatedFrame).drawables));
test('joined descendants follow a changing parent while unrelated geometry remains retained',()=>{
  const e=fixture();
  const a=e.geometry;e.selectFrame(1);const b=e.geometry;
  assert.equal(a.objects.get(1),b.objects.get(1));assert.notEqual(a.objects.get(2),b.objects.get(2));exact(e);
  e.selectFrame(0);exact(e);
});
