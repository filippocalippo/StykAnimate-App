import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';

test('failed import preserves the document, IDs, clipboard and history',()=>{
  const e=ownedEditorFor({demo:false,layerTimeline:true}),before=e.serialize(),uid=e._nextUid,history=e._undo.length;
  const source=emptyDocument();source.keyframes=[createFrame([createObject(source.figure_types[0],1,0,0)])];
  source.keyframes[0].objects[0].scale=-1;
  assert.throws(()=>e.importFigure(source),/Scale/i);
  assert.deepEqual(e.serialize(),before);assert.equal(e._nextUid,uid);assert.equal(e._undo.length,history);
});

