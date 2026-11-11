import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {strokeSegments} from '../src/builder-construction.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

function fixture() {
  const e = ownedEditorFor({demo:false, layerTimeline:true}); e.addFigure(); e.select(e.selectedUid, 2);
  e.updateSegmentStyle({color:'#e54283', thickness:19});
  return e;
}
test('line and chain inherit their actual parent style with atomic undo and saved values', () => {
  const e=fixture(), parent=e.figure.segments[2].segment_id;
  const before=JSON.stringify(e.serialize()), history=e._undo.length;
  const parts=e.addSegments(strokeSegments([{x:0,y:0},{x:20,y:0},{x:20,y:30}]));
  for(const s of parts) {assert.equal(s.thickness,19);assert.deepEqual(s.color_rgb,[229,66,131]);}
  assert.equal(parts[0].parent_id,parent);assert.equal(parts[1].parent_id,parts[0].segment_id);
  assert.equal(e._undo.length,history+1);
  const after=JSON.stringify(e.serialize());e.undo();assert.equal(JSON.stringify(e.serialize()),before);e.redo();assert.equal(JSON.stringify(e.serialize()),after);
  const restored=ownedEditorFor({demo:false},e.serialize());restored.select(e.selectedUid);
  assert.equal(restored.figure.segments.at(-1).thickness,19);
  assert.deepEqual(restored.figure.segments.at(-1).color_rgb,[229,66,131]);
});
test('explicit parents win over selection; zero and explicit thickness propagate down chains', () => {
  const e=fixture(), parent=e.figure.segments[2].segment_id;e.select(e.selectedUid,0);
  const parts=e.addSegments([{parentId:parent,thickness:0},{}, {parentId:parent,thickness:3},{}]);
  assert.deepEqual(parts.map(s=>s.thickness),[0,0,3,3]);
  for(const s of parts)assert.deepEqual(s.color_rgb,[229,66,131]);
  assert.equal(parts[0].visible,false);
  assert.equal(e.addSegment({parentId:0}).thickness,8);
});
test('per-instance colour and thickness are inherited without shared references', () => {
  const report=emptyDocument(), figure=report.figure_types[0], id=figure.segments[2].segment_id;
  report.keyframes=[createFrame([createObject(figure,1,200,200)],10)];
  report.keyframes[0].objects[0]._stykStyle={segments:{[id]:{color:0x123456,thickness:23}}};
  const e=ownedEditorFor({demo:false}, report); e.select(1, 2);
  const s=e.addSegment();assert.equal(s.thickness,23);assert.deepEqual(s.color_rgb,[18,52,86]);
  s.color_rgb[0]=99;assert.notEqual(e.figure.segments[2].color_rgb[0],99);
});
