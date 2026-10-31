import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor, ownedEditorSync} from './support/owned-editor.mjs';
import {ownerReferences} from './support/owner-references.mjs';
import {emptyDocument,createFrame,createObject,defaultFigure} from '../src/demo.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {presencePlayback} from './support/movieclip-playback.mjs';
import {frameOrder,setOrder} from './support/frame-order.mjs';
import {applyLayerOrder} from '../src/layers.mjs';
const refs=ownerReferences(import.meta.url);
function fixtureReport(){
 const figure=defaultFigure(),child=emptyDocument();
 child.keyframes=[createFrame([createObject(figure,1,50,60)],20)];
 const clip=movieclipFigure(2,'Test clip',child,{duration:20,pivot:{x:50,y:60}}),report=emptyDocument();
 report.figure_types=[figure,clip];
 report.keyframes=[0,1,2,3,4].map((n)=>createFrame([createObject(figure,1,100+n*20,200),...(n===0?[createObject(clip,7,330,240,{scale:1.3,_stykMovieclip:presencePlayback()})]:[])],3));
 return report;
}
/** On a layer sheet the engine session extends the clip (`addMovieclipToNextKeyframes`). */
export function fixture(report=fixtureReport()){
 const e=ownedEditorSync({demo:false,layerTimeline:true},report,{recorded:false}).editor;e.select(7);return e;
}
const shape=e=>Object.fromEntries(Object.entries(e.report._styk.layerSheet.tracks).map(([id,t])=>[id,{end:t.end,keys:t.keys.map(k=>[k.id,k.tick,k.interpolation])}]));
const poses=e=>Array.from({length:e.totalTicks},(_,tick)=>{e.seek(tick);return structuredClone(e.evaluatedFrame.objects.find(o=>o.unique_id===1));});
test('adds only to next existing sparse keys, preserving all other poses and boundaries; undo/redo and reopen',()=>{
 const e=fixture(),before=poses(e),structure=shape(e),native=structuredClone(e.report.keyframes);e.seek(0);e.select(7);
 const selection=e._selectionState(),history=e._undo.length;
 assert.equal(e.addMovieclipToNextKeyframes(2),2);
 assert.deepEqual(e._selectionState(),selection);assert.equal(e._undo.length,history+1);
 assert.deepEqual(shape(e),structure);assert.deepEqual(e.report.keyframes,native);assert.deepEqual(poses(e),before);
 for(let tick=0;tick<15;tick++){e.seek(tick);const o=e.evaluatedFrame.objects.find(o=>o.unique_id===7);assert.equal(Boolean(o),tick<9);if(o){assert.equal(o.root_x,330);assert.equal(o.root_y,240);assert.equal(o.scale,1.3);assert.equal(o._movieclipSample,tick);}}
 const saved=JSON.stringify(e.report);e.undo();e.seek(3);assert.ok(!e.evaluatedFrame.objects.some(o=>o.unique_id===7));e.redo();assert.equal(JSON.stringify(e.report),saved);
 const reopened=newOwnedEditor({demo:false,layerTimeline:true});reopened.load(JSON.parse(saved));reopened.seek(6);assert.equal(reopened.evaluatedFrame.objects.find(o=>o.unique_id===7)._movieclipSample,6);
});
test('existing instances are unchanged, repeated action is a no-op, count clamps at end',()=>{
 const e=fixture(),duration=e.totalTicks;e.addMovieclipToNextKeyframes(2);const before=JSON.stringify(e.report),history=e._undo.length;
 assert.equal(e.addMovieclipToNextKeyframes(2),0);assert.equal(JSON.stringify(e.report),before);assert.equal(e._undo.length,history);
 assert.equal(e.addMovieclipToNextKeyframes(100),2);assert.equal(e.totalTicks,duration);e.seek(12);e.select(7);assert.equal(e.addMovieclipToNextKeyframes(1),0);
});
test('rejects invalid counts and locked layers without changing the document',()=>{
 const e=fixture(),before=JSON.stringify(e.report);for(const count of [0,-1,1.5,NaN,Infinity])assert.throws(()=>e.addMovieclipToNextKeyframes(count),/positive whole/);
 assert.equal(JSON.stringify(e.report),before);e.setLayerLocked(e.layerForUid(7),true);assert.throws(()=>e.addMovieclipToNextKeyframes(2),/Unlock/);
});

refs.test('counts keys after an inbetween and preserves a pre-existing instance at its own position',take=>{
 // The document with a figure drawn at the sixth frame is the plain editor's (its reference).
 const {drawn,other}=take('drawn');
 const e=fixture(JSON.parse(drawn));
 e.seek(0);e.select(7);e.addMovieclipToNextKeyframes(2);
 e.seek(3);e.select(7);e.moveSelection(25,0);e.seek(1);e.select(7);
 const before=shape(e);assert.equal(e.addMovieclipToNextKeyframes(3),1);assert.deepEqual(shape(e),before);
 e.seek(3);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===7).root_x,355);
 e.seek(6);assert.ok(e.evaluatedFrame.objects.some(o=>o.unique_id===other));
 e.seek(9);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===7).root_x,330);
});

test('extension retains back, middle and front stacking with tied and explicit z-index, across frames',()=>{
 for(const position of [0,1,2])for(const depth of [0,12]){
  const base=fixture(),report=structuredClone(base.report);delete report._styk.layerSheet;
  const figure=report.figure_types[0],clip=report.figure_types[1],order=[11,3];order.splice(position,0,7);
  report.keyframes=[0,1,2].map(n=>{
   const objects=[createObject(figure,11,80,100,{_stykZIndex:depth}),createObject(figure,3,80,100,{_stykZIndex:depth})];
   if(!n)objects.push(createObject(clip,7,80,100,{_stykZIndex:depth,_stykMovieclip:presencePlayback()}));
   const frame=createFrame(objects,3);setOrder(frame,order.filter(uid=>!n||uid!==7));return frame;
  });
  const e=ownedEditorSync({demo:false,layerTimeline:true},report,{recorded:false}).editor;e.select(7);const before=e.serialize();
  assert.equal(e.addMovieclipToNextKeyframes(2),2);
  const verify=editor=>{for(const tick of [0,3,4,6,7]){editor.seek(tick);const frame=editor.evaluatedFrame;
   assert.equal(frame.objects.find(o=>o.unique_id===7)._stykZIndex,depth);
   assert.deepEqual(frameOrder(applyLayerOrder(editor.report,frame)),order,`${position}/${depth} at ${tick}`);
  }};
  verify(e);const saved=e.serialize();verify(newOwnedEditor({demo:false,layerTimeline:true}).load(saved));
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();verify(e);
 }
});
