import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';

const exact=editor=>assert.deepEqual(editor.geometry.drawables,buildGeometry(editor.report,editor.evaluatedFrame).drawables);

test('rigid moves retain one render source while authoritative native geometry stays exact',()=>{
  const e=new Editor(),initial=e.geometry.objects.get(0);
  e.moveSelection(12.37,8.11);exact(e);const first=e.geometry.objects.get(0);
  assert.equal(first.renderSource,initial);
  e.moveSelection(5.19,-2.23);exact(e);assert.equal(e.geometry.objects.get(0).renderSource,initial);
  e.beginDrag();e.object.angles[0]+=.1;e.touch();e.commitDrag();exact(e);
  assert.equal(e.geometry.objects.get(0).renderSource,undefined);
});

test('a pending pose change cannot be mislabeled as a rigid translation',()=>{
  const e=new Editor();e.geometry;
  e.beginDrag();e.object.angles[0]+=.2;e.touch();e.commitDrag();
  e.moveSelection(10,0);exact(e);assert.equal(e.geometry.objects.get(0).renderSource,undefined);
});

test('cancel, undo and redo retain unaffected native geometry and match a fresh scene',()=>{
  const e=new Editor(),initial=e.geometry,unchanged=initial.objects.get(1);
  e.beginDrag();e.object.root_x+=20;e.touch();exact(e);
  e.cancelDrag();exact(e);assert.equal(e.geometry.objects.get(1),unchanged);
  e.moveSelection(10,15);exact(e);assert.equal(e.geometry.objects.get(1),unchanged);
  e.undo();exact(e);assert.equal(e.geometry.objects.get(1),unchanged);
  e.redo();exact(e);assert.equal(e.geometry.objects.get(1),unchanged);
});

test('several edits before a render accumulate dirty objects rather than discarding the retained scene',()=>{
  const e=new Editor(),initial=e.geometry,unchanged=initial.objects.get(2);
  e.select(e.frame.objects[0].unique_id);e.moveSelection(12,0);
  e.select(e.frame.objects[1].unique_id);e.moveSelection(0,17);
  exact(e);assert.equal(e.geometry.objects.get(2),unchanged);
  e.undo();e.undo();exact(e);assert.equal(e.geometry.objects.get(2),unchanged);
  e.redo();e.redo();exact(e);assert.equal(e.geometry.objects.get(2),unchanged);
});

test('joined descendants update on parent changes and cancellation/history',()=>{
  const e=new Editor({demo:false});e.addFigure();const parent=e.selectedUid;
  const child=e.duplicateFigure().unique_id;e.joinTo(parent,2);e.addFigure();
  const unrelated=e.selectedUid;e.select(parent);const initial=e.geometry;
  const other=[...initial.objects.values()].find(g=>g.obj.unique_id===unrelated);
  e.beginDrag();e.object.angles[1]+=.2;e.touch();exact(e);
  e.cancelDrag();exact(e);
  e.beginDrag();e.object.angles[1]+=.4;e.touch();e.commitDrag();exact(e);
  e.undo();exact(e);e.redo();exact(e);
  assert.equal([...e.geometry.objects.values()].find(g=>g.obj.unique_id===unrelated),other);
  assert.ok([...e.geometry.objects.values()].some(g=>g.obj.unique_id===child));
});

test('history across a frame seek never reuses geometry from a different frame',()=>{
  const e=new Editor();e.moveSelection(21,9);e.selectFrame(10);const other=e.geometry;
  e.undo();exact(e);assert.notEqual(e.geometry,other);
});
