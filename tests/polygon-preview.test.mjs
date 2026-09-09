import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {polygonPreviewPoints} from '../src/polygon-preview.mjs';
import {polygonConstructionFixture} from './polygon-construction-fixture.mjs';

for(const ids of [[0,11,33,77],[77,33,11,0],[11,33,99,0],[0,33,123]]) {
  test(`preview exactly matches committed polygon boundary ${ids.join(',')}`,()=>{
    const editor=new Editor({demo:false});editor.load(polygonConstructionFixture());editor.select(1);
    const geometry=editor.geometry.objects.get(editor.selectedSlot),before=structuredClone(editor.report);
    const preview=polygonPreviewPoints(geometry,ids);
    assert.deepEqual(editor.report,before);
    editor.addPolygon(ids);
    assert.deepEqual(preview,editor.geometry.objects.get(editor.selectedSlot).polys[0].points);
    if(ids.includes(0)&&ids.includes(11))assert.ok(preview.length>ids.length);
  });
}
test('an open two-handle draft traces its bend once without closing or mutating samples',()=>{
  const editor=new Editor({demo:false});editor.load(polygonConstructionFixture());editor.select(1);
  const geometry=editor.geometry.objects.get(editor.selectedSlot),segment=geometry.segments[0],before=structuredClone(segment.points);
  assert.deepEqual(polygonPreviewPoints(geometry,[0,11],{closed:false}),segment.points);
  assert.deepEqual(polygonPreviewPoints(geometry,[11,0],{closed:false}),[...segment.points].reverse());
  assert.deepEqual(segment.points,before);
  assert.deepEqual(polygonPreviewPoints(geometry,[],{closed:false}),[]);
  assert.deepEqual(polygonPreviewPoints(geometry,[0],{closed:false}),[geometry.joints.get(0)]);
});
