import test from 'node:test';import assert from 'node:assert/strict';
import {validateMovieclipMeshes} from '../src/movieclip-mesh.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
const rad=d=>d*Math.PI/180;
// What the mesh looks like is the engine's to draw (the interface's groups carry no mesh drawables: docs/engine/evaluation.md,
// "The interface's frame"); these tests state what a document stores of a mesh and what the interface does with it.
function fixture(){
 const q=construction();q.add(0,0,0,'Figure');const turn=q.add(0,0,0,'Turn'),pitch=q.add(0,0,0,'Tilt'),h=q.add(0,30,-Math.PI/2,'Head',{control:true,rig:{spatial:{parent:0,origin:[0,0,0],tip:[0,-30,0],turn,pitch}}});
 const f={figure_type_id:1,segments:q.segments,segment_count:q.segments.length,polyfills:[]};
 const head=movieclipFigure(2,'Forms',{...emptyDocument(),figure_types:[],keyframes:[createFrame([]),createFrame([])]},{duration:2,pivot:{x:0,y:0}});
 const mesh={positions:[-10,-20,0,10,-20,0,0,0,10,0,0,-10],indices:[0,1,2,1,0,3,0,2,3,2,1,3],colors:[[240,80,0]],materials:[0,0,0,0]};
 head._styk.movieclip.spatialMeshes=[mesh,{...mesh,colors:[[0,80,240]]}];
 head._styk.movieclip.drawingSets=[{name:'Orange',views:[{name:'Mesh',frame:0}]},{name:'Blue',views:[{name:'Mesh',frame:1}]}];
 const body=createObject(f,1,200,200),child=createObject(head,2,0,0,{join:{target_object_slot:0,target_unique_id:1,target_handle_id:h},_stykMovieclip:{mode:'single',offset:0}});
 return{d:{...emptyDocument(),figure_types:[f,head],keyframes:[createFrame([body,child])]},h,head};
}
test('mesh definitions reject malformed indices, colors, sizes and incompatible drawing rotation',()=>{
 const {head}=fixture(),asset=head._styk.movieclip;validateMovieclipMeshes(asset);
 for(const change of [m=>m.positions[0]=NaN,m=>m.indices[0]=100,m=>m.indices.push(0),m=>m.materials.pop(),m=>m.colors[0][0]=256]){const a=structuredClone(asset);change(a.spatialMeshes[0]);assert.throws(()=>validateMovieclipMeshes(a),/Invalid indexed/);}
 assert.throws(()=>validateMovieclipMeshes({...asset,duration:3}),/one mesh/);
 assert.throws(()=>validateMovieclipMeshes({...asset,drawingRotation:{steps:8}}),/without drawing/);
});
for(const layerTimeline of [false,true])test('meshes use parent spatial controls, forms, undo and native saving '+layerTimeline,async()=>{
 const {d,h}=fixture(),e=ownedEditorSync({demo:false,layerTimeline},d,{recorded:false}).editor;e.select(1,h-1);
 assert.throws(()=>e.enterMovieclip(2),/attached mesh/);assert.equal(e.report.figure_types.length,2);
 for(const pitch of [-90,-45,0,45,90])for(let yaw=0;yaw<=360;yaw+=15){
  e.setSpatialPose({turn:rad(yaw),pitch:rad(pitch),bend:.2});const shown=e.geometry.objects.get(1);
  // The attachment is the parent's joint handle; what it draws is the engine's.
  assert.equal(shown.segments.length,1);assert.ok(Object.values(shown.root).every(Number.isFinite));
 }
 // The second form of the head shows the clip's frame 1 (the blue mesh).
 const offset=()=>e.evaluatedFrame.objects.find(o=>o.unique_id===2)._stykMovieclip.offset;
 assert.equal(offset(),0);e.setMovieclipDrawing(2,1,0);assert.equal(offset(),1);e.undo();assert.equal(offset(),0);e.redo();assert.equal(offset(),1);
 const saved=(await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk')).document;validateScene(saved);
 assert.equal(saved.figure_types[1]._styk.movieclip.spatialMeshes[0].positions.length,12);
});
test('view-corrected meshes validate their headings and survive native saving',async()=>{
 const {d,head}=fixture(),mesh=head._styk.movieclip.spatialMeshes[0],views=Array.from({length:8},(_,k)=>mesh.positions.map((v,i)=>i%3===0?v+k*3:i%3===1?v-k:v));
 const corrected=structuredClone(d);corrected.figure_types[1]._styk.movieclip.spatialMeshes[0].viewPositions=views;
 for(const change of [m=>m.viewPositions.pop(),m=>m.viewPositions[2].pop(),m=>m.viewPositions[0][0]=NaN,m=>m.viewPositions=[m.positions]]){const a=structuredClone(corrected.figure_types[1]._styk.movieclip);change(a.spatialMeshes[0]);assert.throws(()=>validateMovieclipMeshes(a),/four or eight/);}
 const saved=(await decodeDocument(await buildContainerV2(corrected,'styk'),'styk')).document;validateScene(saved);
 assert.deepEqual(saved.figure_types[1]._styk.movieclip.spatialMeshes[0].viewPositions,views);
});
test('per-view turns validate one angle per view and weights from 0 to 1',()=>{
 const {head}=fixture(),mesh=head._styk.movieclip.spatialMeshes[0],pivot=[0,-10,0],turns=[0,Math.PI/2,0,0];
 const views=[0,1,2,3].map(()=>mesh.positions);
 validateMovieclipMeshes({...head._styk.movieclip,spatialMeshes:[{...mesh,viewPositions:views,viewTurns:turns,viewPivot:pivot,viewTurnWeights:[1,0,1,0]},mesh]});
 assert.throws(()=>validateMovieclipMeshes({...head._styk.movieclip,spatialMeshes:[{...mesh,viewTurns:turns},mesh]}),/one angle per view/);
 assert.throws(()=>validateMovieclipMeshes({...head._styk.movieclip,spatialMeshes:[{...mesh,viewPositions:views,viewTurns:turns,viewPivot:pivot,viewTurnWeights:[1,2,0,0]},mesh]}),/0 to 1 per vertex/);
});
