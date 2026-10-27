import test from 'node:test';
import assert from 'node:assert/strict';
import {engineEditor} from './support/owned-editor.mjs';
import {emptyDocument,defaultFigure,createObject,createFrame} from '../src/demo.mjs';
import {movieclipFigure,validateMovieclipGraph} from '../src/movieclips.mjs';
import {drawingSelection} from '../src/movieclip-drawings.mjs';
import {drawingSetsView,joinedDrawingSetsView} from '../src/movieclip-drawings-view.mjs';
import {interfaceLocalization} from '../src/localization.mjs';
function fixture(){
 const f=defaultFigure(1),inner={...emptyDocument(),figure_types:[f],keyframes:[createFrame([createObject(f,1,0,0)]),createFrame([createObject(f,1,10,0)])]};
 const head=movieclipFigure(2,'Head <drawings>',inner,{duration:2});head._styk.movieclip.drawingSets=[{name:'Normal',views:[{name:'Front',frame:0}]},{name:'Alternate',views:[{name:'Side',frame:1}]}];
 const root=createObject(f,1,200,200),child=createObject(head,2,200,200,{join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}});
 return{...emptyDocument(),figure_types:[f,head],keyframes:[createFrame([root,child])]};
}
for(const layerTimeline of [false,true])test(`drawing substitutions retain selection and undo with layer timeline ${layerTimeline}`,()=>{
 const e=engineEditor({demo:false,layerTimeline}, fixture());e.select(1,0);const before=e.serialize();
 e.setMovieclipDrawing(2,1,0);assert.equal(e.selectedUid,1);assert.equal(e.selectionFrame.objects[1]._stykMovieclip.offset,1);assert.equal(e.selectionFrame.objects[1]._stykMovieclip.mode,'single');
 assert.deepEqual(drawingSelection(e.report.figure_types[1]._styk.movieclip,e.selectionFrame.objects[1]),{group:1,view:0});
 assert.match(drawingSetsView(e.report.figure_types[1],e.selectionFrame.objects[1]),/Head &lt;drawings&gt;/);
 e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.equal(e.selectionFrame.objects[1]._stykMovieclip.offset,1);
 const current=e.serialize();assert.throws(()=>e.setMovieclipDrawing(2,3,0),/existing drawing/);assert.deepEqual(e.serialize(),current);
});
test('drawing-bank validation rejects out-of-range frames and oversized groups',()=>{
 const d=fixture(),asset=d.figure_types[1]._styk.movieclip;assert.doesNotThrow(()=>validateMovieclipGraph(d));
 asset.drawingSets[0].views[0].frame=2;assert.throws(()=>validateMovieclipGraph(d),/existing clip frames/);
 asset.drawingSets=Array(129).fill({});assert.throws(()=>validateMovieclipGraph(d),/1–128/);
});

test('drawing-bank views translate controls and preserve authored names, selections and joined ownership',()=>{
 const report=fixture(),figure=report.figure_types[1],object=report.keyframes[0].objects[1],previous=interfaceLocalization.locale;
 figure._styk.movieclip.drawingSets[0].views[0].name='Front <authored>';
 const before=JSON.stringify(report);
 try{
  interfaceLocalization.setLocale('it');
  const html=drawingSetsView(figure,object);
  for(const key of ['movieclipDrawings.form','movieclipDrawings.view']){
   assert.ok(html.includes(`data-i18n="${key}"`));
   assert.ok(html.includes(`>${interfaceLocalization.t(key)}</span>`));
  }
  assert.match(html,/Head &lt;drawings&gt;/);assert.match(html,/Front &lt;authored&gt;/);
  assert.match(html,/value="0" selected/);assert.match(html,/data-drawing-uid="2"/);
  assert.equal(joinedDrawingSetsView({report,selectionFrame:report.keyframes[0],selectedUid:1}),html);
  assert.equal(joinedDrawingSetsView({report,selectionFrame:report.keyframes[0],selectedUid:2}),'');
  assert.equal(JSON.stringify(report),before);
 }finally{interfaceLocalization.setLocale(previous);}
});
