import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject,defaultFigure} from '../src/demo.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {presencePlayback} from '../src/movieclip-presence.mjs';

for(const layerTimeline of [false,true])test(`imports own only new assets and replay atomically (sheet=${layerTimeline})`,()=>{
  const e=new Editor({demo:false,layerTimeline}),unrelated=e.report.figure_types[0];
  const frames=e.report.keyframes.slice(),oldClipboard={marker:true};e._selectionClipboard=oldClipboard;
  Object.defineProperty(unrelated,'unrelatedPayload',{enumerable:true,get(){throw new Error('Visited the destination library');}});
  const source=emptyDocument();source.keyframes=[createFrame([createObject(source.figure_types[0],1,50,60)])];
  const history=e._undo.length;e.importFigure(source,{position:{x:120,y:140}});
  assert.equal(e.object.root_x,120);assert.equal(e.object.root_y,140);
  assert.equal(e._undo.length,history+1);assert.ok(e.historySize<25000);
  assert.equal(e._selectionClipboard,oldClipboard);
  source.figure_types[0].name='External edit';assert.notEqual(e.figure.name,'External edit');
  e.undo();assert.equal(e.report.figure_types.length,1);assert.equal(e.report.figure_types[0],unrelated);
  e.redo();assert.equal(e.object.root_x,120);assert.equal(e.object.root_y,140);
  if(layerTimeline)assert.deepEqual(e.report.keyframes,frames,'Imported native frames remain untouched.');
});

test('failed import preserves the document, IDs, clipboard and history',()=>{
  const e=new Editor({demo:false,layerTimeline:true}),before=e.serialize(),uid=e._nextUid,history=e.historySize;
  const source=emptyDocument();source.keyframes=[createFrame([createObject(source.figure_types[0],1,0,0)])];
  source.keyframes[0].objects[0].scale=-1;
  assert.throws(()=>e.importFigure(source),/Scale/i);
  assert.deepEqual(e.serialize(),before);assert.equal(e._nextUid,uid);assert.equal(e.historySize,history);
});

test('copy retains immutable movie animation without reading it or building geometry',()=>{
  const source=emptyDocument();source.keyframes=[createFrame([createObject(source.figure_types[0],1,50,60)])];
  const clip=movieclipFigure(2,'Clip',source,{duration:1});
  const e=new Editor({demo:false,layerTimeline:true}).load({...emptyDocument(),figure_types:[defaultFigure(),clip],
    keyframes:[createFrame([createObject(clip,7,100,100,{_stykMovieclip:presencePlayback()})])]});
  // The engine opened the document: the movie's document is the one in the editor's report.
  const document=e.report.figure_types[1]._styk.movieclip.document;
  e.select(7);e.evaluatedFrame;
  const frames=document.keyframes;let reads=0;
  Object.defineProperty(document,'keyframes',{enumerable:true,configurable:true,get(){reads++;return frames;}});
  Object.defineProperty(e,'geometry',{configurable:true,get(){throw new Error('Copy built geometry');}});
  e.copySelection();e.copyFigure();assert.equal(reads,0);
  assert.equal(e._figureClipboard.figure._styk.movieclip.document,document);
  delete e.geometry;
  Object.defineProperty(document,'keyframes',{enumerable:true,configurable:true,writable:true,value:frames});
  const captured=e._figureClipboard.figure._styk.movieclip.document;
  e.enterMovieclip();e.select(e.selectionFrame.objects[0].unique_id);e.moveSelection(15,20);e.leaveMovieclip();
  assert.equal(e._figureClipboard.figure._styk.movieclip.document,captured);
  assert.notEqual(e.figure._styk.movieclip.document,captured,'Nested edits publish a fresh document.');
  const other=new Editor({demo:false,layerTimeline:true});other._figureClipboard=e._figureClipboard;other.pasteFigure();
  assert.equal(other.figure._styk.movieclip.document,captured,'Cross-document paste retains the captured version.');
});

test('committing a canvas translation retains its exact incremental preview',()=>{
  const e=new Editor({layerTimeline:true});e.select(1);e.geometry;e.beginTranslationDrag();
  e.moveSelection(20,30,{fromStart:true});const preview=e.geometry,frame=e.evaluatedFrame;
  e.commitDrag();assert.equal(e.geometry,preview);assert.equal(e.evaluatedFrame,frame);
  const position=[e.object.root_x,e.object.root_y];e.undo();e.redo();assert.deepEqual([e.object.root_x,e.object.root_y],position);
});
