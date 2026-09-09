import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
const clone = value => structuredClone(value);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([createObject(figure, 1, 100, 200)], 10),
    createFrame([createObject(figure, 2, 300, 200)], 10), createFrame([createObject(figure, 1, 200, 200)], 1)];
  return new Editor({demo: false}).load(report);
}
test('composed-only figure selection and canvas movement create one pose key without changing native frames', () => {
  const editor = fixture(); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  const channel = editor.animationChannels[0]; editor.setAnimationKey(channel.id, channel.keys[1].id, {tick: 5});
  editor.seek(5); assert.equal(editor.frame.objects[0].unique_id, 1); assert.equal(editor.selectionFrame.objects[0].unique_id, 2);
  editor.select(2); assert.equal(editor.object.unique_id, 2); const frames = clone(editor.report.keyframes), history = editor._undo.length;
  editor.beginTranslationDrag(); const shared = editor._authoredPoseEdit.source;
  for (let dx = 1; dx <= 50; dx++) editor.moveSelection(dx, -10, {fromStart: true});
  near(editor.object.root_x, 350); assert.deepEqual(editor.report.keyframes, frames); assert.equal(editor._undo.length, history);
  editor.commitDrag(); near(editor.object.root_x, 350); near(editor.object.root_y, 190);
  assert.equal(editor.tick, 5); assert.equal(editor._undo.length, history + 1); assert.deepEqual(editor.report.keyframes, frames);
  assert.equal(shared.objects[0].root_x, 300);
  editor.undo(); near(editor.object.root_x, 300); editor.redo(); near(editor.object.root_x, 350);
  const reopened = new Editor({demo: false}).load(editor.serialize()); reopened.seek(5); reopened.select(2); near(reopened.object.root_x, 350);
});
test('authored limb rotation uses composed slots and updates attached descendants once', () => {
  const editor = fixture(), report = editor.report, fig = report.figure_types[0];
  const child = createObject(fig, 3, 0, 0); child.join = {target_object_slot: 1, target_handle_id: fig.segments[0].segment_id, target_unique_id: 2};
  const parent = createObject(fig, 2, 300, 200);
  report.keyframes[1] = createFrame([child, parent], 10); editor.load(report);
  editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.seek(10); editor.select(2, 0);
  const native = clone(report.keyframes), initial = editor.selectionFrame.objects.find(o => o.unique_id === 3).angles[0];
  editor.rotateJoint(.2); near(editor.selectionFrame.objects.find(o => o.unique_id === 3).angles[0], initial + .2);
  assert.deepEqual(report.keyframes, native); editor.undo(); near(editor.selectionFrame.objects.find(o => o.unique_id === 3).angles[0], initial);
});
test('existing absolute scalar curves retain an authored canvas movement instead of snapping back', () => {
  const editor = fixture(); editor.addAnimationKey({kind: 'figure', uid: 1}, 'x', 0, 150); editor.seek(2); editor.select(1);
  const frames = clone(editor.report.keyframes); editor.moveSelection(25, 8);
  near(editor.object.root_x, 175); near(editor.object.root_y, 208);
  assert.equal(editor.animationChannel({kind: 'figure', uid: 1}, 'x').keys.at(-1).tick, 2);
  assert.deepEqual(editor.report.keyframes, frames); editor.undo(); near(editor.object.root_x, 150); near(editor.object.root_y, 200);
});
test('cancel, motionless, and invalid authored gestures publish neither keys nor pose sources', () => {
  const editor = fixture(); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.seek(0); editor.select(1);
  const before = clone(editor.report), history = editor._undo.length;
  editor.beginDrag(); editor.moveSelection(50, 50); editor.cancelDrag(); assert.deepEqual(editor.report, before);
  editor.beginDrag(); assert.equal(editor.commitDrag(), false); assert.deepEqual(editor.report, before);
  editor.beginDrag(); editor.object.root_x = NaN; assert.throws(() => editor.commitDrag(), /finite/); assert.deepEqual(editor.report, before);
  assert.equal(editor._undo.length, history);
});

test('authored add, duplicate, join, ordering and deletion edit current layer poses with one undo each', () => {
  const editor = fixture(); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.seek(5);
  const native = clone(editor.report.keyframes), layer = editor.createLayer('New artwork'), count = editor._undo.length;
  const added = editor.addFigure(); assert.equal(editor.layerForUid(added.unique_id), layer.id);
  assert.equal(editor._undo.length, count + 1); assert.ok(editor.getLayerFigureUids(layer.id).includes(added.unique_id));
  assert.ok(editor.selectionFrame.objects.some(object => object.unique_id === added.unique_id)); assert.deepEqual(editor.report.keyframes, native);
  const duplicate = editor.duplicateFigure(); assert.equal(editor.layerForUid(duplicate.unique_id), layer.id);
  editor.joinTo(added.unique_id, 1); assert.ok(editor.object.join);
  editor.deleteFigure(); assert.ok(!editor.selectionFrame.objects.some(object => object.unique_id === duplicate.unique_id));
  editor.undo(); assert.ok(editor.selectionFrame.objects.find(object => object.unique_id === duplicate.unique_id).join);
  assert.deepEqual(editor.report.keyframes, native);
  const reopened = new Editor({demo: false}).load(editor.serialize()); reopened.seek(5);
  const newUid = reopened.addFigure().unique_id; assert.ok(newUid > duplicate.unique_id);
});

test('authored child-body movement spanning layers keys the whole joined component once', () => {
  const editor = fixture(); editor.selectFrame(0); editor.select(1);
  const child = editor.duplicateFigure(); editor.joinTo(1, 1); const layer = editor.createLayer('Attached'); editor.assignFiguresToLayer([child.unique_id], layer.id);
  editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.adoptNativePoseTrack({kind: 'layer', id: layer.id}); editor.seek(0); editor.select(child.unique_id);
  const before = new Map([...editor.geometry.objects.values()].map(g => [g.obj.unique_id, {...g.root}])), count = editor._undo.length;
  editor.moveSelection(20, 15); assert.equal(editor._undo.length, count + 1);
  for (const g of editor.geometry.objects.values()) { const root = before.get(g.obj.unique_id); near(g.root.x, root.x + 20); near(g.root.y, root.y + 15); }
  assert.ok(editor.object.join); editor.undo(); for (const g of editor.geometry.objects.values()) near(g.root.x, before.get(g.obj.unique_id).x);
});

test('multi-figure paste and fresh drawing preserve authored presence and library assets', () => {
  const editor = fixture(); editor.selectFrame(0); editor.select(1); editor.duplicateFigure(); editor.selectMany(editor.frame.objects.map(o => o.unique_id));
  editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.seek(0);
  const native = clone(editor.report.keyframes), count = editor._undo.length;
  editor.copySelection(); const pasted = editor.pasteSelection(); assert.equal(pasted.length, 2); assert.equal(editor._undo.length, count + 1);
  assert.ok(pasted.every(object => editor.selectionFrame.objects.some(value => value.unique_id === object.unique_id))); assert.deepEqual(editor.report.keyframes, native);
  editor.undo(); assert.equal(editor.selectionFrame.objects.length, 2); editor.redo(); assert.equal(editor.selectionFrame.objects.length, 4);
  editor.select(null); editor.addSegment({start: {x: 20, y: 30}, length: 75}); const drawn = editor.object;
  assert.ok(drawn); near(drawn.root_x, 20); assert.deepEqual(editor.report.keyframes, native);
  editor.undo(); assert.ok(!editor.selectionFrame.objects.some(value => value.unique_id === drawn.unique_id));
  editor.redo(); assert.ok(editor.selectionFrame.objects.some(value => value.unique_id === drawn.unique_id));
});

test('Rig mode keeps shared-definition semantics after authored pose captures and restores retained poses on undo', () => {
  const editor = fixture(); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.seek(0); editor.select(1); editor.moveSelection(12, 4);
  const before = clone(editor.report), sourceId = editor.animationChannels[0].keys[0].value.frameId;
  editor.select(1, 0); const shape = editor.geometry.objects.get(editor.selectedSlot).segments[0];
  editor.beginRigDrag(); editor.editRigJoint(shape.end.x + 15, shape.end.y + 6); editor.commitDrag();
  assert.equal(editor._undo.at(-1).kind, 'topology'); assert.equal(editor._authoredPoseEdit, null);
  assert.notDeepEqual(editor.report.figure_types[0], before.figure_types[0]);
  assert.notDeepEqual(editor.report._styk.frameSources[sourceId].objects[0], before._styk.frameSources[sourceId].objects[0]);
  editor.undo(); assert.deepEqual(editor.report, before); editor.redo(); assert.doesNotThrow(() => editor.serialize());
});

test('discarded history releases generated pose sources while preserving every undo/redo reference', () => {
  const editor = fixture(); editor.historyLimit = 2; editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'}); editor.seek(0); editor.select(1);
  for (let i = 0; i < 12; i++) editor.moveSelection(1, 0);
  near(editor.object.root_x, 112); assert.ok(Object.keys(editor.report._styk.frameSources).length <= 3);
  editor.undo(); near(editor.object.root_x, 111); editor.undo(); near(editor.object.root_x, 110);
  editor.redo(); near(editor.object.root_x, 111); editor.moveSelection(20, 0); near(editor.object.root_x, 131);
  assert.equal(editor.canRedo, false); assert.ok(Object.keys(editor.report._styk.frameSources).length <= 3);
  assert.doesNotThrow(() => editor.serialize()); editor.undo(); near(editor.object.root_x, 111); editor.redo(); near(editor.object.root_x, 131);
});
