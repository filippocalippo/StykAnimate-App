// The inspector's branch opacity gesture on an editor the engine owns: one session animation edit of the branch's segments (and enclosed
// polygons), previewed on the frame the gesture began on, keyed at the playhead as one entry when it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit, cancelNativePropertyEdit} from '../src/native-property-edit.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

/** Two figures of one definition keyed at ticks 0 and 6; figure 1's segment 3 is selected, its branch holds segments 3 and 4 and the polygon over 1, 3 and 4. */
function fixture(style) {
  const report = emptyDocument(), figure = report.figure_types[0];
  figure.segments[2].secondary = {rgb: [250, 30, 40], a: 80};
  figure.segments[3].secondary = {rgb: [20, 240, 50], a: 120};
  figure.polyfills = [{polyfill_id: 1, segment_ids: [1, 3, 4], color_rgb: [10, 20, 30], alpha_raw: 35, color_alpha: 1 - 35 / 255, z_order: .5}];
  report.keyframes = [0, 1].map(() => createFrame([createObject(figure, 1, 200, 200), createObject(figure, 2, 400, 200)], 6));
  if (style) for (const frame of report.keyframes) frame.objects[0]._stykStyle = style;
  const editor = ownedEditorFor({demo: false, layerTimeline: true, propertyChannels: true}, report);
  editor.select(1, 2);
  return editor;
}
const segment = (uid, handleId) => ({kind: 'segment', uid, handleId, figureTypeId: 1});
const polygon = {kind: 'polygon', uid: 1, polygonId: 1, figureTypeId: 1};
const value = (editor, target, property, tick = editor.tick) => editor.animationValue(target, property, tick);
const edit = (editor, key, number, options = {branch: true}) => {
  const token = beginNativePropertyEdit(editor, key, options);
  previewNativePropertyEdit(token, number);
  return commitNativePropertyEdit(token);
};

test('a cancelled branch edit leaves the document as it was, and the same value still sets the children that differ', {skip: !engineBuilt}, () => {
  const editor = fixture({segments: {3: {gradientOpacity: .25}}});
  const source = JSON.stringify(editor.report);
  const cancel = beginNativePropertyEdit(editor, 'segment_gradient_opacity', {branch: true});
  previewNativePropertyEdit(cancel, 60);
  assert.equal(value(editor, segment(1, 4), 'gradientOpacity'), .6, 'the preview is what shows');
  cancelNativePropertyEdit(cancel);
  assert.equal(value(editor, segment(1, 4), 'gradientOpacity'), 1 - 120 / 255, 'and is gone when it is cancelled');
  assert.equal(JSON.stringify(editor.report), source);
  assert.equal(editor.canUndo, false, 'a cancelled edit is no entry');
  assert.equal(editor._animationEdit, null);
  // Segment 3 is at 25 already: typing 25 still brings segment 4 (at 53) to it.
  const token = beginNativePropertyEdit(editor, 'segment_gradient_opacity', {branch: true});
  assert.equal(token.initialValue, 25);
  previewNativePropertyEdit(token, 25);
  assert.ok(commitNativePropertyEdit(token));
  assert.equal(value(editor, segment(1, 3), 'gradientOpacity'), .25);
  assert.equal(value(editor, segment(1, 4), 'gradientOpacity'), .25);
  assert.equal(JSON.stringify(editor.report.figure_types), JSON.stringify(JSON.parse(source).figure_types), 'the shared definition is untouched');
});

test('a branch opacity edit keys the branch and its polygon at the playhead as one entry and no other figure', {skip: !engineBuilt}, () => {
  const editor = fixture();
  editor.seek(6);
  const source = JSON.stringify(editor.report), entries = editor._undo.length;
  const token = beginNativePropertyEdit(editor, 'segment_opacity', {branch: true});
  assert.ok(editor._animationEdit.targets.length >= 3, 'the segments of the branch and the polygon it encloses are one edit');
  previewNativePropertyEdit(token, 60);
  assert.equal(editor._animationEdit.changed, true);
  assert.ok(editor._sheetPropertyPreview, 'the stage shows the preview');
  assert.equal(JSON.stringify(editor.report), source, 'a preview writes nothing');
  assert.ok(commitNativePropertyEdit(token));
  assert.equal(editor._sheetPropertyPreview, null);
  assert.equal(editor._undo.length, entries + 1, 'one entry');
  for (const target of [segment(1, 3), segment(1, 4), polygon]) assert.equal(value(editor, target, 'opacity'), .6, `${target.kind} ${target.handleId ?? target.polygonId}`);
  assert.equal(value(editor, segment(1, 2), 'opacity'), 1, 'a segment outside the branch');
  assert.equal(value(editor, segment(2, 3), 'opacity'), 1, 'another figure of the definition');
  assert.equal(value(editor, segment(1, 3), 'opacity', 0), 1, 'the other key');
  editor.undo();
  assert.equal(JSON.stringify(editor.report), source);
});

test('a branch edit with two keys chosen sets both, and the playhead moving ends the gesture', {skip: !engineBuilt}, () => {
  const editor = fixture();
  const keys = [editor.frameIndex]; keys.sheetTicks = [0, 6];
  const entries = editor._undo.length;
  assert.ok(edit(editor, 'segment_opacity', 40, {branch: true, indices: keys}));
  assert.equal(editor._undo.length, entries + 1, 'one entry');
  for (const tick of [0, 6]) assert.equal(value(editor, segment(1, 4), 'opacity', tick), .4, `at ${tick}`);
  const token = beginNativePropertyEdit(editor, 'segment_opacity', {branch: true});
  editor.seek(3);
  assert.throws(() => previewNativePropertyEdit(token, 10), error => error.messageKey === 'errors.editorBranchStyle.theBranchEditTargetChanged');
  assert.equal(editor._animationEdit, null, 'the gesture ended with nothing written');
});

test('a branch edit whose playhead moves before it ends is keyed at the tick it began on', {skip: !engineBuilt}, () => {
  const editor = fixture();
  editor.seek(3);
  const token = beginNativePropertyEdit(editor, 'segment_opacity', {branch: true});
  previewNativePropertyEdit(token, 55);
  editor.seek(5);
  assert.throws(() => previewNativePropertyEdit(token, 40), /./, 'a preview after the playhead moved is refused');
  const quiet = beginNativePropertyEdit(editor, 'segment_opacity', {branch: true});
  editor.seek(4);
  assert.equal(commitNativePropertyEdit(quiet), false, 'an edit that previewed nothing ends quietly');
  editor.seek(3);
  const again = beginNativePropertyEdit(editor, 'segment_opacity', {branch: true});
  previewNativePropertyEdit(again, 55);
  editor.seek(5);
  assert.ok(commitNativePropertyEdit(again), 'the value typed is kept');
  assert.equal(editor.undoLabel !== null, true);
  assert.equal(value(editor, segment(1, 3), 'opacity', 3), .55, 'at the tick the edit began on');
  editor.undo();
  assert.notEqual(value(editor, segment(1, 3), 'opacity', 3), .55);
});
