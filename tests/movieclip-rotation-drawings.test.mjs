import test from 'node:test';import assert from 'node:assert/strict';
import {validateDrawingSets} from '../src/movieclip-drawings.mjs';
import {drawingSetsView} from '../src/movieclip-drawings-view.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {emptyDocument,defaultFigure,createObject,createFrame} from '../src/demo.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
const rad=d=>d*Math.PI/180;
// Which drawing a head shows is the engine's to work out (the interface's groups carry only the movieclip's handle: docs/engine/evaluation.md);
// these tests state the forms a head's drawings come in, where the head sits and what is saved.
const sets=Array.from({length:2},(_,g)=>({name:'Form '+g,views:Array.from({length:24},(_,i)=>({name:'View '+i,frame:g*24+i}))}));
const asset={drawingSets:sets,drawingRotation:{steps:8,tiltThreshold:rad(20)},duration:48};
test('rotating drawing sets validate their views and show no view picker for a rotating set',()=>{
 assert.doesNotThrow(()=>validateDrawingSets(asset));
 assert.throws(()=>validateDrawingSets({...asset,drawingRotation:{steps:8,tiltThreshold:NaN}}),/threshold/);
 assert.throws(()=>validateDrawingSets({...asset,drawingSets:[{name:'Bad',views:sets[0].views.slice(1)}]}),/level, up and down/);
 assert.doesNotMatch(drawingSetsView({_styk:{movieclip:asset}},{unique_id:2}),/data-drawing-view/);
});
function fixture(){
 const q=construction();q.add(0,0,0,'Figure');const turn=q.add(0,0,0,'Turn'),pitch=q.add(0,0,0,'Tilt'),h=q.add(0,30,-Math.PI/2,'Head',{control:true,rig:{spatial:{parent:0,origin:[0,0,0],tip:[0,-30,0],turn,pitch}}});
 const f={figure_type_id:1,segments:q.segments,segment_count:q.segments.length,polyfills:[]},ink=defaultFigure(1),inner={...emptyDocument(),figure_types:[ink],keyframes:Array.from({length:48},(_,i)=>createFrame([createObject(ink,1,i,0)]))};
 const head=movieclipFigure(2,'Head forms',inner,{duration:48,pivot:{x:0,y:0}});Object.assign(head._styk.movieclip,{drawingSets:structuredClone(sets),drawingRotation:asset.drawingRotation});
 const body=createObject(f,1,200,200),child=createObject(head,2,0,0,{join:{target_object_slot:0,target_unique_id:1,target_handle_id:h},_stykMovieclip:{mode:'single',offset:0}});
 const d={...emptyDocument(),figure_types:[f,head],keyframes:[createFrame([body,child])]};return {d,h,turn,pitch};
}
for(const layerTimeline of [false,true])test('joined drawings sit on the head bone, keep their form through undo and save with their playback '+layerTimeline,async()=>{
 const {d,h}=fixture(),e=ownedEditorSync({demo:false,layerTimeline},d,{recorded:false}).editor;e.select(1,h-1);
 for(const pitch of [-35,0,35])for(let yaw=0;yaw<360;yaw+=45){
  e.setSpatialPose({turn:rad(yaw),pitch:rad(pitch)});
  // The engine's group of the head is where the head's bone puts it.
  assert.deepEqual(e.geometry.objects.get(1).root,e.geometry.objects.get(0).segments[h-1].start);
 }
 // The second form starts at frame 24 of the clip.
 const frameOf=()=>e.evaluatedFrame.objects.find(o=>o.unique_id===2)._stykMovieclip.offset;
 assert.equal(frameOf(),0);e.setMovieclipDrawing(2,1,0);assert.equal(frameOf(),24);e.undo();assert.equal(frameOf(),0);e.redo();assert.equal(frameOf(),24);
 const decoded=(await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk')).document;
 const reopened=ownedEditorSync({demo:false,layerTimeline},decoded,{recorded:false}).editor;
 assert.equal(reopened.evaluatedFrame.objects.find(o=>o.unique_id===2)._stykMovieclip.offset,24);
});
