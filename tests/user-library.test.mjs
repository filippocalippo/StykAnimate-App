import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {librarySnapshot} from '../src/library-files.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {frameOrder} from '../src/pivot/structure.mjs';

for (const layerTimeline of [false,true]) test(`figure sets preserve pose, order, distinct IDs and undo in ${layerTimeline?'layer':'native'} timeline`,()=>{
  const source=new Editor(); source.select(1); source.select(3,{add:true});
  const saved=librarySnapshot(source); assert.equal(saved.keyframes[0].objects.length,2); assert.equal(saved._styk.libraryKind,'set');
  const target=new Editor({propertyChannels:true,layerTimeline}), before=target.selectedObjects.length, count=target.selectionFrame.objects.length, history=target._undo.length;
  target.importFigure(saved); assert.equal(target.selectedObjects.length,2); assert.equal(target.selectionFrame.objects.length,count+2); assert.equal(target._undo.length,history+1);
  assert.equal(new Set(target.selectionFrame.objects.map(o=>o.unique_id)).size,count+2);
  const [a,b]=saved.keyframes[0].objects,[x,y]=target.selectedObjects;
  assert.equal(x.root_x-y.root_x,a.root_x-b.root_x); assert.equal(x.root_y-y.root_y,a.root_y-b.root_y); assert.deepEqual(x.angles,a.angles);
  assert.equal(frameOrder(target.selectionFrame).length,count+2); target.undo(); assert.equal(target.selectionFrame.objects.length,count); target.redo(); assert.equal(target.selectedObjects.length,2);
});
test('single selection saves the displayed pose without mutating scene or clipboard',()=>{
  const editor=new Editor({propertyChannels:true,layerTimeline:true}); editor.select(1); editor.seek(5); editor.moveSelection(45,20);
  const before=JSON.stringify(editor.report), saved=librarySnapshot(editor); assert.equal(saved.keyframes[0].objects[0].root_x,editor.object.root_x); assert.equal(JSON.stringify(editor.report),before);
  saved.keyframes[0].objects[0].root_x+=10; assert.equal(JSON.stringify(editor.report),before);
});
test('movieclip asset keeps nested animation and imports with playback at the destination',()=>{
  const source=new Editor({propertyChannels:true}); source.select(1); source.createMovieclip({start:0,end:12}); const saved=librarySnapshot(source);
  assert.equal(saved._styk.libraryKind,'movieclip'); assert.equal(saved.figure_types[0]._styk.movieclip.duration,12);
  const target=new Editor({propertyChannels:true,layerTimeline:true}); target.seek(5); target.importFigure(saved);
  assert.equal(target.figure._styk.movieclip.duration,12); assert.equal(target.object._stykMovieclip.start,5); assert.ok(buildGeometry(target.report,target.selectionFrame).drawables.length);
});
