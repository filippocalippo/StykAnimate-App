import test from 'node:test';
import assert from 'node:assert/strict';
import {engineEditor} from './support/owned-editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {keepsStoredFrames} from './support/engine-export.mjs';

test('untouched native documents retain the exact original export path', () => {
  const native = emptyDocument();
  // Native exposures have no authored per-frame easing metadata.
  native.keyframes = [createFrame([createObject(native.figure_types[0], 1, 40, 200)], 4)];
  const editor = engineEditor({demo: false}, native);
  assert.equal(keepsStoredFrames(editor), true);
});

