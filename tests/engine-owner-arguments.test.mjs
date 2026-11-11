// What JSON cannot say reaches the session encoded (`sessionPayload` in engine-owner.mjs, `styk-edit/src/args.rs`): a number that is
// not finite is refused with the editor's own validation error wherever it sits in the arguments, never read as missing, and a member
// set to `undefined` is absent for the commands that do not give it a meaning. (A rig patch gives it one: tests/rig-angle-path.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';

function figureEditor() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([createObject(figure, 1, 150, 200)], 10)];
  const {editor, owner} = ownedEditorSync({demo: false, layerTimeline: true, propertyChannels: true}, report, {recorded: false});
  editor.select(1, -1);
  return {editor, owner};
}

test('a number that is not finite is refused with the editor\'s own message, in an option object too', {skip: !engineBuilt}, () => {
  const {editor, owner} = figureEditor();
  const before = JSON.stringify(editor.report);
  for (const [call, label] of [
    [() => editor.updateObject({root_x: NaN}), 'root_x'],
    [() => editor.updateObject({scale: Infinity}), 'scale'],
    [() => editor.updateObject({root_y: -Infinity}), 'root_y'],
  ]) {
    assert.throws(call, error => error.messageKey === 'errors.editorCamera.mustBeFinite' && error.messageParams.label === label, label);
  }
  assert.throws(() => editor.setCameraValues({x: NaN}), error => error.messageKey === 'errors.editorCamera.mustBeFinite');
  assert.throws(() => editor.moveSelection(NaN, 1), error => error.messageKey === 'errors.editorCamera.mustBeFinite');
  assert.throws(() => editor.setCanvasSize(NaN, 100), error => error.messageKey === 'errors.editor.canvasDimensionsMustBe1100000Pixels');
  assert.equal(JSON.stringify(editor.report), before, 'a refused call changes nothing');
  assert.deepEqual(owner.refused, {}, 'they are the session\'s validation, not refusals of the owner');
});

test('a member set to undefined is absent for a command that does not read it', {skip: !engineBuilt}, () => {
  const {editor} = figureEditor();
  assert.equal(editor.updateObject({scale: undefined, root_x: 222}), true);
  assert.equal(editor.object.root_x, 222);
  assert.equal(editor.object.scale, 1, 'the scale was not touched');
  assert.equal(editor.moveSelection(5, 0, {fromStart: undefined, center: undefined}), true);
  assert.equal(editor.object.root_x, 227);
});
