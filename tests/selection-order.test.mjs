import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {builderDrawables} from '../src/editor-builder-style.mjs';
import {resolveInstanceFigure} from '../src/animation-style.mjs';
import {validateLayerSheet} from '../src/layer-sheet.mjs';

/** `prepare(figure)` changes the figure definition before the document opens. */
function fixture({propertyChannels = true, joined = false, prepare = null} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segments = figure.segments.slice(0, 4).map((s, i) => ({...s, segment_id: i + 1,
    parent_id: [0, 1, 0, 0][i], z_order: i + 1}));
  figure.segment_count = 4;
  prepare?.(figure);
  report.keyframes = [0, 1, 2].map(() => createFrame([1, 2, 3, 4].map(uid => createObject(figure, uid, 200, 200)), 10));
  if (joined) for (const frame of report.keyframes) frame.objects[1].join = {target_object_slot: 0, target_handle_id: 2};
  const editor = newOwnedEditor({demo: false, layerTimeline: true, propertyChannels}).load(report);
  editor.seek(5); editor.select(1);
  return editor;
}
const order = e => e.evaluatedFrame.object_draw_order_unique_ids;
const internal = e => builderDrawables(resolveInstanceFigure(e.figure,e.object)).map(d => `${d.kind}:${d.index}`);
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
  const reopened = newOwnedEditor({demo: false, layerTimeline: true}).load(e.serialize());
  reopened.seek(5);
  reopened.select(1, joint); assert.deepEqual(segments(reopened), expected);
  reopened.seek(0);assert.deepEqual(segments(reopened),[1,2,3,4]);
  assert.deepEqual(e.figure,original);
});

test('internal branch ordering includes descendant segments and contained polygons', () => {
  const e = fixture({prepare: figure => { figure.polyfills = [{polyfill_id: 1, segment_ids: [0, 1, 2], z_order: 1.5, color_rgb: [200, 10, 20], color_alpha: 1}]; }});
  e.selectBranch(1, 0); assert.deepEqual([...e.selectedUids], [1]);
  const original = internal(e);
  e.orderSelection('front');
  assert.deepEqual(internal(e), ['segment:2', 'segment:3', 'segment:0', 'polygon:0', 'segment:1']);
  assert.deepEqual(order(e), [1, 2, 3, 4]); assert.equal(e.branchSelected, true);
  const history = e._undo.length; e.orderSelection('front'); e.orderSelection(1);
  assert.equal(e._undo.length, history);
  e.undo(); assert.deepEqual(internal(e), original); assert.equal(e.branchSelected, true);
});

test('a branch with attached figures orders the complete selection without changing internal artwork', () => {
  const e = fixture({joined: true});
  e.selectBranch(1, 0);
  const original = internal(e), selection = e._selectionState(), history = e._undo.length;
  e.orderSelection('front');
  assert.deepEqual(order(e), [3, 4, 1, 2]);
  assert.deepEqual(internal(e), original);
  assert.deepEqual(e._selectionState(), selection);
  assert.equal(e._undo.length, history + 1);
  e.undo(); assert.deepEqual(order(e), [1, 2, 3, 4]);
  e.redo(); assert.deepEqual(order(e), [3, 4, 1, 2]);
});

for (const propertyChannels of [false, true])
test(`single-segment joints and joined branches move in scene order (properties=${propertyChannels})`, () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segments = [figure.segments[0]]; figure.segment_count = 1;
  const ids = [70, 10, 80, 30, 50, 20], before = [30, 70, 20, 10, 50, 80];
  report.keyframes = [0, 1].map(() => {
    const frame = createFrame(ids.map(uid => createObject(figure, uid, 200, 200)), 10);
    frame.objects[3].join = {target_object_slot: 1, target_unique_id: 10, target_handle_id: 1};
    frame.objects[5].join = {target_object_slot: 3, target_unique_id: 30, target_handle_id: 1};
    frame.object_draw_order_unique_ids = [...before]; frame.object_draw_order = before.map(uid => ids.indexOf(uid));
    return frame;
  });
  const e = newOwnedEditor({demo: false, layerTimeline: true, propertyChannels}).load(report);
  e.select(70, 0);
  e.orderSelection('front'); assert.deepEqual(order(e), [30, 20, 10, 50, 80, 70]);
  e.undo(); assert.deepEqual(order(e), before);
  e.selectBranch(10, 0);
  const attachments = () => e.evaluatedFrame.objects.map(o => [o.unique_id, o.join?.target_unique_id ?? null]).sort((a,b) => a[0]-b[0]);
  const selection = e._selectionState(), joints = attachments(), history = e._undo.length;
  const poses = () => [...e.geometry.objects.values()].map(g => [g.obj.unique_id, g.root, g.segments.map(s => s.end)]).sort((a,b) => a[0]-b[0]);
  const originalPoses = poses();
  for (const [direction, expected] of [
    ['front', [70, 50, 80, 30, 20, 10]],
    [-1, [70, 50, 30, 20, 10, 80]],
    [-1, [70, 30, 20, 10, 50, 80]],
    ['back', [30, 20, 10, 70, 50, 80]],
    [1, [70, 30, 20, 10, 50, 80]],
    ['front', [70, 50, 80, 30, 20, 10]],
  ]) {
    e.orderSelection(direction); assert.deepEqual(order(e), expected);
    assert.deepEqual(e._selectionState(), selection);
    assert.deepEqual(attachments(), joints);
    assert.deepEqual(poses(), originalPoses);
  }
  const after = order(e), endHistory = e._undo.length;
  e.orderSelection('front'); e.orderSelection(1); assert.equal(e._undo.length, endHistory);
  while (e._undo.length > history) e.undo(); assert.deepEqual(order(e), before);
  while (e._redo.length) e.redo(); assert.deepEqual(order(e), after);
  const restored = newOwnedEditor({demo: false, layerTimeline: true, propertyChannels}).load(e.serialize());
  assert.deepEqual(order(restored), after);
  restored.seek(10); assert.deepEqual(order(restored), before);
});

test('a branch containing the whole figure moves the instance while partial branches stay internal', () => {
  const e = fixture({prepare: figure => figure.segments.forEach((segment, index) => { segment.parent_id = index ? 1 : 0; })});
  e.selectBranch(1, 0);
  const original = internal(e);
  e.orderSelection('front'); assert.deepEqual(order(e), [2, 3, 4, 1]);
  assert.deepEqual(internal(e), original);
});

test('figure multiselection and explicit frame ranges remain supported', () => {
  const e = fixture(), indices = [e.frameIndex]; indices.sheetTicks = [5, 10];
  e.selectMany([1, 3]); e.orderSelection('front', {frameIndices: indices});
  for (const tick of [5, 10]) { e.seek(tick); assert.deepEqual(order(e), [2, 4, 1, 3]); }
  e.seek(20); assert.deepEqual(order(e), [1, 2, 3, 4]);
  e.selectMany([]); const history = e._undo.length;
  assert.equal(e.orderSelection('front'), false); assert.equal(e._undo.length, history);
});
