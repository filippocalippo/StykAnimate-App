import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';

test('drawing at identity capacity preserves the library, pose, history and identity counter', () => {
  for (const pending of [false, true]) {
    const document = emptyDocument(), figure = document.figure_types[0], uid = 0x7ffffffe;
    document.keyframes = [createFrame([createObject(figure, uid, 123, 234)], 1)];
    const editor = new Editor({demo: false}).load(document);
    if (pending) { editor.select(uid, 1); editor.beginDrag('Pose figure'); editor.rotateJoint(.13); }
    editor.select(null);
    const snapshot = () => ({document: JSON.stringify(editor.report), nextUid: editor._nextUid,
      undo: editor._undo.length, redo: editor._redo.length, revision: editor.revision,
      layerRevision: editor.layerRevision, dragging: editor.dragging, dirty: editor.dirty});
    const before = snapshot();
    assert.throws(() => editor.addSegment({length: 5}), error => error.messageKey === 'errors.editorLayerSheet.objectIdentityCapacityReached');
    assert.deepEqual(snapshot(), before, pending ? 'open pose gesture' : 'ordinary creation');
    if (pending) { assert.equal(editor.cancelDrag(), true); assert.equal(editor.canUndo, false); }
  }
});
