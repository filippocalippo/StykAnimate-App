import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLayerState} from '../src/layers.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();
const setOf = values => new Set(values);

test('native imports start with one user layer containing all project figure identities', () => {
  const editor = open();
  assert.deepEqual(editor.layers.map(({id, kind, permanent}) => ({id, kind, permanent})), [
    {id: 'scene', kind: 'scene', permanent: true}, {id: 'camera', kind: 'camera', permanent: true},
    {id: 'layer-1', kind: 'layer', permanent: false},
  ]);
  const nativeUids = new Set(editor.report.keyframes.flatMap(frame => frame.objects.map(object => object.unique_id)));
  assert.deepEqual(setOf(editor.getLayerFigureUids('layer-1')), nativeUids);
  assert.equal(editor.activeLayerId, 'layer-1');
  assert.deepEqual(editor.report._styk.layers.assignments, {});
  for (const uid of nativeUids) assert.equal(editor.layerForUid(uid), 'layer-1');
  assert.deepEqual(editor.getLayerFigureUids('scene'), []);
});

test('optional permanent track metadata supplies editable defaults for missing tracks', () => {
  const editor = open(), document = editor.serialize();
  document._styk.layers.fixed = {scene: {visible: false, locked: false}};
  editor.load(document);
  assert.equal(editor.getLayer('camera').visible, true); assert.equal(editor.getLayer('camera').locked, false);
  editor.setLayerLocked('camera', true); assert.equal(editor.getLayer('camera').locked, true);
  editor.undo(); assert.equal(editor.getLayer('camera').locked, false);
  editor.redo(); assert.equal(editor.getLayer('camera').locked, true);
  assert.doesNotThrow(() => validateLayerState(editor.serialize()._styk.layers));
});

