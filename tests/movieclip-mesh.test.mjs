import test from 'node:test';import assert from 'node:assert/strict';
import {validateMovieclipMeshes} from '../src/movieclip-mesh.mjs';
import {movieclipFigure,snapshotFigureDefinition} from '../src/movieclips.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {buildGeometry,evaluatedFrame} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {Editor} from '../src/editor.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {createMovieclipMaterializer} from '../src/movieclip-materialize.mjs';
import {documentHasSurfaces} from '../src/pivot/surfaces.mjs';
const rad=d=>d*Math.PI/180;
// Visible faces of an evaluated mesh, in drawable order, as native-like records.
const faces=g=>g.drawables.flatMap(d=>d.type!=='mesh'?[d]:Array.from({length:d.count},(_,t)=>{const m=d.spatialMesh,ids=[0,1,2].map(k=>d.triangles[t*3+k]);
 return {rgb:m.colors[d.materials[t]],points:ids.map(v=>({x:m.positions[v*2],y:m.positions[v*2+1]})),depthValues:ids.map(v=>m.depth[v])};}));
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
 assert.equal(snapshotFigureDefinition(head)._styk.movieclip.spatialMeshes,asset.spatialMeshes);
});
for(const layerTimeline of [false,true])test('meshes use parent spatial controls, forms, undo and native saving '+layerTimeline,async()=>{
 const {d,h}=fixture(),e=new Editor({demo:false,layerTimeline});e.load(d);e.select(1,h-1);
 assert.ok(documentHasSurfaces(d));assert.throws(()=>e.enterMovieclip(2),/attached mesh/);assert.equal(e.report.figure_types.length,2);
 for(const pitch of [-90,-45,0,45,90])for(let yaw=0;yaw<=360;yaw+=15){
  e.setSpatialPose({turn:rad(yaw),pitch:rad(pitch),bend:.2});const g=e.geometry.objects.get(1);
  assert.ok(g.meshAttachment);assert.ok(faces(g).length>0);assert.equal(g.segments.length,1);
  assert.deepEqual(faces(g),faces(buildGeometry(e.report,e.evaluatedFrame).objects.get(1)));
  for(const p of faces(g).flatMap(d=>d.points))assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
 }
 e.setMovieclipDrawing(2,1,0);assert.deepEqual(faces(e.geometry.objects.get(1))[0].rgb,[0,80,240]);e.undo();assert.deepEqual(faces(e.geometry.objects.get(1))[0].rgb,[240,80,0]);e.redo();
 const saved=(await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk')).document;validateScene(saved);
 const actual=buildGeometry(saved,evaluatedFrame(saved,0,0,0)).objects.get(1);assert.deepEqual(faces(actual)[0].rgb,[0,80,240]);
 assert.equal(actual.segments.length,1);assert.equal(saved.figure_types[1]._styk.movieclip.spatialMeshes[0].positions.length,12);
});
test('reflection, perspective and flattening retain visible triangles and their depth',()=>{
 for(const flip of [0,1]){const {d,h}=fixture();d.keyframes[0].objects[0].image_text_flags=flip;
 const e=new Editor({demo:false});e.load(d);e.select(1,h-1);e.setSpatialPose({turn:.7,pitch:.3,bend:.2});e.setSpatialCamera({strength:1,distance:100});validateScene(e.serialize());
 const before=e.geometry.objects.get(1),m=createMovieclipMaterializer(e.report),frame=m.frame(e.evaluatedFrame),doc={...e.report,figure_types:m.figures,keyframes:[frame]};validateScene(doc);
 const after=buildGeometry(doc,frame).orderedObjects.at(-1);assert.equal(after.drawables.length,faces(before).length);
 // Flattened fills are painter-sorted; the mesh keeps definition order.
 const packed=g=>faces(g).map(d=>[d.rgb,...d.points.flatMap(p=>[p.x,p.y]),...d.depthValues]).sort((x,y)=>{for(let i=1;i<x.length;i++){const d=Math.round((x[i]-y[i])*100);if(d)return d;}return 0;});
 const a=packed(before),b=packed(after);for(let i=0;i<a.length;i++){assert.deepEqual(a[i][0],b[i][0]);for(let j=1;j<a[i].length;j++)assert.ok(Math.abs(a[i][j]-b[i][j])<.001,`${i}/${j}: ${a[i][j]} vs ${b[i][j]}`);}
 }
});
test('near-plane clipping and full turns are deterministic, with no retained pose history',()=>{
 const{d,h}=fixture(),e=new Editor({demo:false});e.load(d);e.select(1,h-1);e.setSpatialCamera({strength:1,distance:10});
 const sample=yaw=>{e.setSpatialPose({turn:rad(yaw)});return faces(e.geometry.objects.get(1)).map(d=>({points:d.points,depth:d.depthValues}));};
 const a=sample(25);sample(170);const b=sample(25);
 // Editor angle normalization can differ at machine epsilon after a roundtrip.
 const rounded=v=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='number'?Math.round(x*1e8)/1e8:x));
 assert.deepEqual(rounded(b),rounded(a));
 for(const p of a.flatMap(d=>d.points))assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
});
test('unchanged attachments retain projected arrays while appearance and transforms invalidate correctly',()=>{
 const {d,h}=fixture(),frame=d.keyframes[0],first=buildGeometry(d,frame),old=first.objects.get(1);
 const tinted={...frame,objects:frame.objects.map(o=>({...o}))};tinted.objects[1].color_override_raw=0xff00ff00;tinted.objects[1].field28=90;
 const incremental=buildGeometry(d,tinted,{previous:first,dirtySlots:new Set([1])}),next=incremental.objects.get(1);
 assert.equal(next.spatialMesh.positions,old.spatialMesh.positions);assert.notEqual(next.drawables,old.drawables);
 const fresh=buildGeometry(d,tinted).objects.get(1);assert.deepEqual(faces(next),faces(fresh));assert.equal(next.drawables[0].opacity,fresh.drawables[0].opacity);
 assert.notEqual(next.drawables[0].opacity,1);assert.equal(old.drawables[0].opacity,1);
 const moved=structuredClone(tinted);moved.objects[1].scale=1.3;
 const changed=buildGeometry(d,moved,{previous:incremental,dirtySlots:new Set([1])}).objects.get(1);
 assert.notEqual(changed.spatialMesh.positions,next.spatialMesh.positions);assert.deepEqual(faces(changed),faces(buildGeometry(d,moved).objects.get(1)));
 assert.ok(changed.meshPose.pose.every(v=>v===undefined||typeof v==='number'));assert.equal(changed.meshPose.mesh,d.figure_types[1]._styk.movieclip.spatialMeshes[0]);
});
test('view-corrected meshes reproduce each authored heading, blend smoothly and fade near vertical views',async()=>{
 const {d,h,head}=fixture(),mesh=head._styk.movieclip.spatialMeshes[0],views=Array.from({length:8},(_,k)=>mesh.positions.map((v,i)=>i%3===0?v+k*3:i%3===1?v-k:v));
 const variant=positions=>{const copy=structuredClone(d);copy.figure_types[1]._styk.movieclip.spatialMeshes=copy.figure_types[1]._styk.movieclip.spatialMeshes.map(m=>({...m,positions}));return copy;};
 const points=(document,turn,pitch=0)=>{const e=new Editor({demo:false});e.load(document);e.select(1,h-1);e.setSpatialPose({turn:rad(turn),pitch:rad(pitch)});return faces(e.geometry.objects.get(1)).flatMap(x=>x.points.flatMap(p=>[p.x,p.y]));};
 const close=(a,b)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-6,`${i}: ${v} vs ${b[i]}`));};
 const corrected=structuredClone(d);corrected.figure_types[1]._styk.movieclip.spatialMeshes[0].viewPositions=views;
 for(const change of [m=>m.viewPositions.pop(),m=>m.viewPositions[2].pop(),m=>m.viewPositions[0][0]=NaN,m=>m.viewPositions=[m.positions]]){const a=structuredClone(corrected.figure_types[1]._styk.movieclip);change(a.spatialMeshes[0]);assert.throws(()=>validateMovieclipMeshes(a),/four or eight/);}
 for(let k=0;k<8;k++)close(points(corrected,k*45),points(variant(views[k]),k*45));
 close(points(corrected,22.5),points(variant(views[0].map((v,i)=>(v+views[1][i])/2)),22.5));
 // Looking straight down, heading is undefined: the consensus shape is used.
 close(points(corrected,0,90),points(d,0,90));
 const saved=(await decodeDocument(await buildContainerV2(corrected,'styk'),'styk')).document;validateScene(saved);
 assert.deepEqual(saved.figure_types[1]._styk.movieclip.spatialMeshes[0].viewPositions,views);
});
test('per-view turns interpolate as rotations, so shapes keep their size between headings',()=>{
 const {d,h,head}=fixture(),mesh=head._styk.movieclip.spatialMeshes[0],pivot=[0,-10,0];
 const rotate=(p,t)=>p.map((v,i,a)=>i%3===0?pivot[0]+(v-pivot[0])*Math.cos(t)+(a[i+2]-pivot[2])*Math.sin(t):i%3===2?pivot[2]-(a[i-2]-pivot[0])*Math.sin(t)+(v-pivot[2])*Math.cos(t):v);
 const doc=m=>{const copy=structuredClone(d),asset=copy.figure_types[1]._styk.movieclip;asset.spatialMeshes=asset.spatialMeshes.map((x,i)=>i?x:{...x,...m});return copy;};
 const points=(document,turn)=>{const e=new Editor({demo:false});e.load(document);e.select(1,h-1);e.setSpatialPose({turn:rad(turn)});return faces(e.geometry.objects.get(1)).flatMap(x=>x.points.flatMap(p=>[p.x,p.y]));};
 const close=(a,b)=>{assert.equal(a.length,b.length);a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-6,`${i}: ${v} vs ${b[i]}`));};
 const turns=[0,Math.PI/2,0,0],corrected=doc({viewPositions:[0,1,2,3].map(()=>mesh.positions),viewTurns:turns,viewPivot:pivot});
 assert.throws(()=>validateMovieclipMeshes({...head._styk.movieclip,spatialMeshes:[{...mesh,viewTurns:turns},mesh]}),/one angle per view/);
 close(points(corrected,90),points(doc({positions:rotate(mesh.positions,Math.PI/2)}),90));
 // Halfway between 0 and 90 degrees the shape is turned 45 degrees, not averaged.
 close(points(corrected,45),points(doc({positions:rotate(mesh.positions,Math.PI/4)}),45));
 // Weighted vertices take their share of the turn; zero-weight vertices keep the bone's orientation.
 const weights=[1,0,1,0],weighted=doc({viewPositions:[0,1,2,3].map(()=>mesh.positions),viewTurns:turns,viewPivot:pivot,viewTurnWeights:weights}),turned=rotate(mesh.positions,Math.PI/2);
 close(points(weighted,90),points(doc({positions:mesh.positions.map((v,i)=>weights[Math.floor(i/3)]?turned[i]:v)}),90));
 assert.throws(()=>validateMovieclipMeshes({...head._styk.movieclip,spatialMeshes:[{...mesh,viewPositions:[0,1,2,3].map(()=>mesh.positions),viewTurns:turns,viewPivot:pivot,viewTurnWeights:[1,2,0,0]},mesh]}),/0 to 1 per vertex/);
});
test('bending the parent turns a bone-attached mesh once, keeping it on its joint',()=>{
 const {d,h}=fixture(),e=new Editor({demo:false});e.load(d);e.select(1,h-1);
 const base=()=>faces(e.geometry.objects.get(1)).flatMap(x=>x.points.map(p=>[p.x,p.y]));
 const joint=()=>e.geometry.objects.get(0).segments[h-1];
 // Rotating through the native bend also rotates the joined child's own angle (Pivot joins).
 e.select(1,h-1);e.rotateJoint(.6);assert.notEqual(e.frame.objects[1].angles[0],0);
 const bent=base(),reference=structuredClone(e.serialize());reference.keyframes[0].objects[1].angles=[0];
 const f=new Editor({demo:false});f.load(reference);
 assert.deepEqual(bent,faces(f.geometry.objects.get(1)).flatMap(x=>x.points.map(p=>[p.x,p.y])));
 assert.ok(Number.isFinite(joint().start.x));
});
