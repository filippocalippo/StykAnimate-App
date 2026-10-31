// The inspector's native-field gestures on an editor the engine owns: each is a session call or a gesture of the session's, and what the
// session has no command for is refused, never written into the document by the inspector.
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit, cancelNativePropertyEdit, getNativePropertyValue} from '../src/native-property-edit.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';

const sheet = {demo: false, layerTimeline: true, propertyChannels: true};
function twoFigures(options = sheet) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 10].map(x => createFrame([createObject(figure, 1, 150 + x, 200), createObject(figure, 2, 350 + x, 200)], 10));
  const {editor, owner} = ownedEditorSync(options, report, {recorded: false});
  return {editor, owner};
}
const notSupported = error => error.messageKey === 'errors.engineOwner.notSupported';

test('the project fields are one command of the session when the edit ends', {skip: !engineBuilt}, () => {
  const {editor} = twoFigures();
  for (const [key, read, value] of [['fps', () => editor.report.fps, 30], ['canvas_width', () => editor.report.canvas_width, 800]]) {
    const before = read(), entries = editor._undo.length;
    const token = beginNativePropertyEdit(editor, key);
    previewNativePropertyEdit(token, value + 1); previewNativePropertyEdit(token, value);
    assert.equal(read(), before, 'nothing shows in the document until the edit ends');
    assert.equal(editor._undo.length, entries);
    assert.equal(commitNativePropertyEdit(token) !== false, true);
    assert.equal(read(), value);
    assert.equal(editor._undo.length, entries + 1, 'one entry');
    editor.undo();
    assert.equal(read(), before);
  }
  const token = beginNativePropertyEdit(editor, 'fps');
  previewNativePropertyEdit(token, 12);
  cancelNativePropertyEdit(token);
  assert.equal(editor.report.fps, 24, 'a cancelled edit changes nothing');
  assert.equal(editor.canUndo, false);
  assert.throws(() => { const next = beginNativePropertyEdit(editor, 'fps'); previewNativePropertyEdit(next, 0); }, /from 1 to 1000/);
});

test('a selection size is scaled once when the edit ends, and the opacity of several figures follows the slider', {skip: !engineBuilt}, () => {
  const {editor} = twoFigures();
  editor.selectMany([1, 2]);
  const start = getNativePropertyValue(editor, 'group_width'), objects = () => editor.evaluatedFrame.objects.map(object => object.scale);
  const token = beginNativePropertyEdit(editor, 'group_width');
  for (let n = 0; n < 40; n++) previewNativePropertyEdit(token, start + n);
  previewNativePropertyEdit(token, start * 2);
  assert.deepEqual(objects(), [1, 1], 'the size shows when the edit ends');
  const entries = editor._undo.length;
  commitNativePropertyEdit(token);
  assert.equal(editor._undo.length, entries + 1);
  assert.ok(objects().every(scale => Math.abs(scale - 2) < 1e-9), `doubled: ${objects()}`);
  editor.undo();
  assert.deepEqual(objects(), [1, 1]);

  const opacity = beginNativePropertyEdit(editor, 'figure_opacity');
  previewNativePropertyEdit(opacity, 40);
  assert.ok(editor.evaluatedFrame.objects.every(object => object.field28 === Math.round(0.6 * 255)), 'the preview shows on every selected figure');
  assert.equal(editor.canUndo, false, 'a preview is no entry');
  commitNativePropertyEdit(opacity);
  assert.equal(editor.undoLabel, 'Figure opacity');
  editor.undo();
  assert.ok(editor.evaluatedFrame.objects.every(object => object.field28 === 0));
});

/** Both keys of the layer sheet, as the timeline hands them over when two keys are chosen ("Edit together"). */
const both = editor => { const frames = [editor.frameIndex]; frames.sheetTicks = [0, 10]; return frames; };
const at = (editor, tick, uid = 1) => { editor.seek(tick); return editor.evaluatedFrame.objects.find(object => object.unique_id === uid); };

test('a pose typed with several keys chosen is set in every chosen key, from where each stands, as one entry', {skip: !engineBuilt}, () => {
  const {editor, owner} = twoFigures();
  editor.select(1, -1);
  // The keys are not alike: 150 at the first, 160 at the second.
  assert.deepEqual([at(editor, 0).root_x, at(editor, 10).root_x], [150, 160]);
  editor.seek(0);
  const original = JSON.stringify(editor.report), entries = editor._undo.length;
  const token = beginNativePropertyEdit(editor, 'root_x', {indices: both(editor)});
  previewNativePropertyEdit(token, 400);
  // (Moving the playhead would end the gesture: the frame on show is read as it is.)
  assert.equal(editor.evaluatedFrame.objects[0].root_x, 400, 'the frame on show shows the value while it is typed');
  assert.equal(editor._undo.length, entries, 'a preview is no entry');
  assert.equal(commitNativePropertyEdit(token), true);
  assert.deepEqual([at(editor, 0).root_x, at(editor, 10).root_x], [400, 400]);
  assert.equal(editor._undo.length, entries + 1, 'one entry');
  assert.equal(editor.undoLabel, 'root x in 2 frames');
  assert.equal(editor.dragging, false, 'no gesture was left open');
  editor.undo();
  assert.deepEqual([at(editor, 0).root_x, at(editor, 10).root_x], [150, 160]);
  assert.equal(JSON.stringify(editor.report), original, 'one undo takes both keys back');
  editor.redo();
  assert.deepEqual([at(editor, 0).root_x, at(editor, 10).root_x], [400, 400]);
  editor.undo();
  // Cancelled, nothing is left in either key.
  editor.seek(0);
  const cancelled = beginNativePropertyEdit(editor, 'root_x', {indices: both(editor)});
  previewNativePropertyEdit(cancelled, 9);
  cancelNativePropertyEdit(cancelled);
  assert.equal(JSON.stringify(editor.report), original);
  assert.equal(editor.dragging, false);
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('the size, the rotation and a joint typed with several keys chosen follow the same rule', {skip: !engineBuilt}, () => {
  const {editor, owner} = twoFigures();
  editor.select(1, -1);
  // The size the inspector shows is the one the engine measured for the app (`selectionBounds` in app.mjs).
  const bounds = () => {
    const box = {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity};
    for (const group of editor.geometry.objects.values()) {
      if (!editor.selectedUids.has(group.obj.unique_id)) continue;
      box.minX = Math.min(box.minX, group.bounds.minX); box.minY = Math.min(box.minY, group.bounds.minY);
      box.maxX = Math.max(box.maxX, group.bounds.maxX); box.maxY = Math.max(box.maxY, group.bounds.maxY);
    }
    return box;
  };
  const width = tick => { editor.seek(tick); return getNativePropertyValue(editor, 'group_width', {bounds}); };
  const token = beginNativePropertyEdit(editor, 'group_width', {indices: both(editor), bounds});
  previewNativePropertyEdit(token, 200);
  commitNativePropertyEdit(token);
  assert.equal(editor.undoLabel, 'Selection width in 2 frames');
  // Each key is scaled by the factor that brings its own selection to the number (the stroke widths do not scale with it).
  const widths = [0, 10].map(width);
  assert.ok(widths.every(value => Math.abs(value - 200) < 15), `the width of the selection in each key: ${widths}`);
  assert.ok(Math.abs(widths[0] - widths[1]) < 1e-6, 'the keys are alike');
  editor.undo();
  assert.ok(Math.abs(width(0) - widths[0]) > 15, 'undone');

  editor.seek(0);
  const turn = beginNativePropertyEdit(editor, 'rotation', {indices: both(editor)});
  previewNativePropertyEdit(turn, 30);
  commitNativePropertyEdit(turn);
  for (const tick of [0, 10]) { editor.seek(tick); assert.ok(Math.abs(getNativePropertyValue(editor, 'rotation') - 30) < 1e-9, `the turn at ${tick}`); }
  assert.equal(editor.undoLabel, 'rotation in 2 frames');

  editor.select(1, 2);
  editor.seek(0);
  const joint = beginNativePropertyEdit(editor, 'joint_angle', {indices: both(editor)});
  previewNativePropertyEdit(joint, 45);
  commitNativePropertyEdit(joint);
  for (const tick of [0, 10]) { editor.seek(tick); assert.ok(Math.abs(getNativePropertyValue(editor, 'joint_angle') - 45) < 1e-9, `the joint at ${tick}`); }
  assert.equal(editor.undoLabel, 'Joint angle in 2 frames');
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('a stacking number typed for several figures is set on each, in one entry, also across keys', {skip: !engineBuilt}, () => {
  const {editor, owner} = twoFigures();
  editor.selectMany([1, 2]);
  const order = tick => [at(editor, tick, 1), at(editor, tick, 2)].map(object => object._stykZIndex);
  // (Moving the playhead would end a gesture: the frame on show is read as it is while one is open.)
  const shown = () => editor.evaluatedFrame.objects.map(object => object._stykZIndex);
  editor.seek(0);
  const token = beginNativePropertyEdit(editor, 'figure_z_order');
  previewNativePropertyEdit(token, 4);
  assert.deepEqual(shown(), [4, 4], 'the preview shows on every selected figure');
  assert.equal(editor.canUndo, false);
  commitNativePropertyEdit(token);
  assert.equal(editor.undoLabel, 'Z-index');
  assert.deepEqual(order(0), [4, 4]);
  // Zero is no stacking number at all.
  const clear = beginNativePropertyEdit(editor, 'figure_z_order');
  previewNativePropertyEdit(clear, 0);
  commitNativePropertyEdit(clear);
  assert.deepEqual(order(0), [undefined, undefined]);
  assert.ok(!JSON.stringify(editor.report).includes('@undefined'), 'the marker of a missing member is not stored');
  editor.undo(); editor.undo();
  assert.deepEqual(order(0), [undefined, undefined], 'both entries undone');
  // Across the keys.
  editor.seek(0);
  const ranged = beginNativePropertyEdit(editor, 'figure_z_order', {indices: both(editor)});
  previewNativePropertyEdit(ranged, 7);
  commitNativePropertyEdit(ranged);
  assert.deepEqual([order(0), order(10)], [[7, 7], [7, 7]]);
  assert.equal(editor.undoLabel, 'Z-index in 2 frames');
  assert.deepEqual(owner.refused, {});
});

test('the stacking number of a movieclip is set through the pose, as a figure of several is', {skip: !engineBuilt}, () => {
  const {editor, owner} = twoFigures();
  editor.select(1, -1);
  editor.seek(0);
  editor.createMovieclip({start: 0, end: 6});
  assert.ok(editor.object?._stykMovieclip, 'the clip is selected');
  const token = beginNativePropertyEdit(editor, 'figure_z_order');
  previewNativePropertyEdit(token, 3);
  assert.equal(editor.object._stykZIndex, 3, 'shown while it is typed');
  commitNativePropertyEdit(token);
  assert.equal(editor.undoLabel, 'Z-index');
  assert.equal(editor.object._stykZIndex, 3);
  editor.undo();
  assert.equal(editor.object._stykZIndex, undefined);
  assert.deepEqual(owner.refused, {});
});

test('the project fields and the size of the selection keep the names their entries had', {skip: !engineBuilt}, () => {
  const {editor} = twoFigures();
  for (const [key, value, label] of [['fps', 30, 'Frame rate'], ['canvas_width', 800, 'Canvas width'], ['canvas_height', 600, 'Canvas height']]) {
    const token = beginNativePropertyEdit(editor, key);
    previewNativePropertyEdit(token, value);
    commitNativePropertyEdit(token);
    assert.equal(editor.undoLabel, label);
  }
  editor.selectMany([1, 2]);
  const size = beginNativePropertyEdit(editor, 'group_height');
  previewNativePropertyEdit(size, getNativePropertyValue(editor, 'group_height') * 2);
  commitNativePropertyEdit(size);
  assert.equal(editor.undoLabel, 'Selection height');
});

test('the definition of a figure is refused when the edit begins, and changes nothing', {skip: !engineBuilt}, () => {
  // Written by the commands of the engine, never in place.
  const native = twoFigures({demo: false});
  native.editor.select(1, 0);
  const before = JSON.stringify(native.editor.report);
  assert.throws(() => beginNativePropertyEdit(native.editor, 'outline_width'), notSupported);
  assert.throws(() => beginNativePropertyEdit(native.editor, 'thickness'), notSupported);
  assert.equal(JSON.stringify(native.editor.report), before);
});
