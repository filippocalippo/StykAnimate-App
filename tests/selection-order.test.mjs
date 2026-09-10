import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {builderDrawables} from '../src/editor-builder-style.mjs';
import {validateLayerSheet} from '../src/layer-sheet.mjs';

function fixture({propertyChannels = true, joined = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segments = figure.segments.slice(0, 4).map((s, i) => ({...s, segment_id: i + 1,
    parent_id: [0, 1, 0, 0][i], z_order: i + 1}));
  figure.segment_count = 4;
  report.keyframes = [0, 1, 2].map(() => createFrame([1, 2, 3, 4].map(uid => createObject(figure, uid, 200, 200)), 10));
  if (joined) for (const frame of report.keyframes) frame.objects[1].join = {target_object_slot: 0, target_handle_id: 2};
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels}).load(report);
  editor.seek(5); editor.select(1);
  return editor;
}
const order = e => e.evaluatedFrame.object_draw_order_unique_ids;
const internal = e => builderDrawables(e.figure).map(d => `${d.kind}:${d.index}`);
const segments = e => e.geometry.objects.get(e.selectedSlot).drawables.filter(d => d.seg).map(d => d.seg.segment_id);

for (const propertyChannels of [false, true]) for (const [direction, selected, expected] of [
  [1, 1, [2, 1, 3, 4]], [-1, 4, [1, 2, 4, 3]],
  ['front', 1, [2, 3, 4, 1]], ['back', 4, [4, 1, 2, 3]],
]) test(`selection order ${direction} persists at the layer playhead (propertyChannels=${propertyChannels})`, () => {
  const e = fixture({propertyChannels}), source = structuredClone(e.report.keyframes);
  e.select(selected); const history = e._undo.length;
  e.orderSelection(direction);
  assert.deepEqual(order(e), expected); assert.equal(e._undo.length, history + 1);
  assert.deepEqual(e.report.keyframes, source); validateLayerSheet(e.report);
  e.seek(4); assert.deepEqual(order(e), [1, 2, 3, 4]);
  e.seek(5); e.undo(); assert.deepEqual(order(e), [1, 2, 3, 4]);
  e.redo(); assert.deepEqual(order(e), expected);
});

for (const [direction, joint, expected] of [
  [1, 0, [2, 1, 3, 4]], [-1, 3, [1, 2, 4, 3]],
  ['front', 0, [2, 3, 4, 1]], ['back', 3, [4, 1, 2, 3]],
]) test(`selection order ${direction} targets an internal segment and preserves figure stacking`, () => {
  const e = fixture(), original = structuredClone(e.figure);
  e.select(1, joint); const history = e._undo.length;
  e.orderSelection(direction);
  assert.deepEqual(segments(e), expected); assert.deepEqual(order(e), [1, 2, 3, 4]);
  assert.equal(e.selectedJoint, joint); assert.equal(e._undo.length, history + 1);
  e.undo(); assert.deepEqual(e.figure, original);
  e.redo(); assert.deepEqual(segments(e), expected);
  const reopened = new Editor({demo: false, layerTimeline: true}).load(e.serialize());
  reopened.select(1, joint); assert.deepEqual(segments(reopened), expected);
});

test('branch ordering includes descendant segments and contained polygons even with attached figures selected', () => {
  const e = fixture({joined: true});
  e.figure.polyfills = [{polyfill_id: 1, segment_ids: [0, 1, 2], z_order: 1.5, color_rgb: [200, 10, 20], color_alpha: 1}];
  e.selectBranch(1, 0); assert.deepEqual([...e.selectedUids], [1, 2]);
  const original = internal(e);
  e.orderSelection('front');
  assert.deepEqual(internal(e), ['segment:2', 'segment:3', 'segment:0', 'polygon:0', 'segment:1']);
  assert.deepEqual(order(e), [1, 2, 3, 4]); assert.equal(e.branchSelected, true);
  const history = e._undo.length; e.orderSelection('front'); e.orderSelection(1);
  assert.equal(e._undo.length, history);
  e.undo(); assert.deepEqual(internal(e), original); assert.equal(e.branchSelected, true);
});

test('figure multiselection and explicit frame ranges remain supported', () => {
  const e = fixture(), indices = [e.frameIndex]; indices.sheetTicks = [5, 10];
  e.selectMany([1, 3]); e.orderSelection('front', {frameIndices: indices});
  for (const tick of [5, 10]) { e.seek(tick); assert.deepEqual(order(e), [2, 4, 1, 3]); }
  e.seek(20); assert.deepEqual(order(e), [1, 2, 3, 4]);
  e.selectMany([]); const history = e._undo.length;
  assert.equal(e.orderSelection('front'), false); assert.equal(e._undo.length, history);
});
