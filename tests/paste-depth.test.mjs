import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';

test('paste depth defaults safely and persists either supported choice',()=>{
  assert.equal(normalizeEditorSettings({}).pasteDepth,'same');
  assert.equal(normalizeEditorSettings({pasteDepth:'unknown'}).pasteDepth,'same');
  assert.equal(normalizeEditorSettings({pasteDepth:'front'}).pasteDepth,'front');
});
for(const range of [false,true])for(const pasteDepth of ['same','front'])
test(`${range?'range':'single'} paste at ${pasteDepth} depth preserves joins, order, and one undo`,()=>{
  const report=emptyDocument(),f=report.figure_types[0];
  report.keyframes=[30,70,100].map(depth=>createFrame([
    createObject(f,1,100,100,{_stykZIndex:-5}),
    createObject(f,2,200,100,{_stykZIndex:2,join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}}),
    createObject(f,3,300,100,{_stykZIndex:depth}),
  ],5));
  const e=ownedEditorFor({demo:false,layerTimeline:true}, report);
  e.selectConnected(1);e.copySelection();
  const before=e.serialize(),count=e._undo.length,clipboard=structuredClone(e._selectionClipboard.objects);
  const ids=e.pasteSelection({pasteDepth,offset:0}).map(o=>o.unique_id);
  assert.equal(ids.length,2);assert.equal(e._undo.length,count+1);
  for(const tick of [0]){
    e.seek(tick);const objects=e.evaluatedFrame.objects,copies=ids.map(uid=>objects.find(o=>o.unique_id===uid));
    assert.deepEqual(copies.map(o=>o._stykZIndex),pasteDepth==='same'?[-5,2]:[tick?71:31,tick?71:31]);
    assert.equal(objects[copies[1].join.target_object_slot].unique_id,copies[0].unique_id);
    const order=e.geometry.orderedObjects.map(g=>g.obj.unique_id);
    if(pasteDepth==='front')assert.deepEqual(order.slice(-2),ids);
    assert.equal(objects.find(o=>o.unique_id===3)._stykZIndex,tick?70:30);
  }
  assert.deepEqual(e._selectionClipboard.objects,clipboard);
  const after=e.serialize();e.undo();const undone=e.serialize();
  assert.deepEqual(undone,before);e.redo();assert.deepEqual(e.serialize(),after);
  const reopened=ownedEditorFor({demo:false,layerTimeline:true}, after);reopened.seek(0);
  e.seek(0);assert.deepEqual(reopened.geometry.orderedObjects.map(g=>g.obj.unique_id),e.geometry.orderedObjects.map(g=>g.obj.unique_id));
});
