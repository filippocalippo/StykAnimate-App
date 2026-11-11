import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {validateFrameIdentities} from '../src/editor-frames.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

const clone = value => structuredClone(value);
function fixture() {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [3, 2, 4, 1].map((duration, index) => {
    const frame = createFrame([createObject(figure, 17, 90 + index * 20, 120)], duration);
    frame._styk = {custom: {note: `native-${index}`}};
    return frame;
  });
  const editor = open({demo: false}, document);
  return editor.load(editor.serialize());
}

test('malformed or duplicate persisted identities reject load without replacing the current document', () => {
  const editor = fixture(), current = editor.report, before = editor.serialize();
  const invalid = [
    document => { document.keyframes[0]._styk.frameId = '../outside'; },
    document => { document.keyframes[0]._styk.frameId = 12; },
    document => { document.keyframes[0]._styk.frameId = document.keyframes[1]._styk.frameId; },
    document => { document._styk.frameSources = []; },
    document => { document._styk.frameSources = {'other-id': clone(document.keyframes[0])}; },
    document => { const frame = clone(document.keyframes[0]); document._styk.frameSources = {[frame._styk.frameId]: frame}; },
  ];
  for (const corrupt of invalid) {
    const document = clone(before); corrupt(document);
    assert.throws(() => editor.load(document), /identit|frame source/i);
    assert.equal(editor.report, current); assert.deepEqual(editor.serialize(), before);
  }
  assert.doesNotThrow(() => validateFrameIdentities(editor.report));
});
