import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';

test('polygon duplicates compare cyclic connections in either direction, independently of style', () => {
  const editor = new Editor({demo: false}); editor.addFigure(); editor.select(editor.selectedUid);
  const ids = [0, ...editor.figure.segments.slice(0, 3).map(segment => segment.segment_id)];
  editor.addPolygon(ids); const before = editor.serialize(), history = editor._undo.length;
  for (const cycle of [ids, [...ids.slice(1), ids[0]], [...ids].reverse(), [...ids, ids[0]]]) {
    assert.throws(() => editor.addPolygon(cycle, {color: '#ff0000', opacity: .3}), /already.*connection cycle/i);
    assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
  }
  const different = [ids[0], ids[2], ids[1], ids[3]]; editor.addPolygon(different);
  assert.equal(editor.figure.polyfills.length, 2);
  const after = editor.serialize(); assert.throws(() => editor.updatePolygon(1, {handleIds: [...ids].reverse()}), /connection cycle/i);
  assert.deepEqual(editor.serialize(), after); editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(editor.serialize(), after);
});

test('new polygon connections require unique vertices while closing at the first vertex is accepted', () => {
  const editor = new Editor({demo: false}); editor.addFigure(); editor.select(editor.selectedUid);
  const [a, b, c] = editor.figure.segments.map(segment => segment.segment_id);
  assert.throws(() => editor.addPolygon([0, a, b, a, c]), /distinct/i);
  editor.addPolygon([0, a, b, 0]); assert.deepEqual(editor.figure.polyfills[0].segment_ids, [0, a, b]);
});
