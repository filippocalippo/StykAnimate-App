import test from 'node:test';import assert from 'node:assert/strict';
import {rotatedDrawing,validateDrawingSets} from '../src/movieclip-drawings.mjs';
import {drawingSetsView} from '../src/movieclip-drawings-view.mjs';
import {spatialQuaternion} from '../src/rig-spatial.mjs';
import {movieclipFigure} from '../src/movieclips.mjs';
import {construction} from '../src/rig-examples-3d.mjs';
import {emptyDocument,defaultFigure,createObject,createFrame} from '../src/demo.mjs';
import {buildGeometry,evaluatedFrame} from '../src/pivot/geometry.mjs';
import {Editor} from '../src/editor.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
const rad=d=>d*Math.PI/180;
const sets=Array.from({length:2},(_,g)=>({name:'Form '+g,views:Array.from({length:24},(_,i)=>({name:'View '+i,frame:g*24+i}))}));
const asset={drawingSets:sets,drawingRotation:{steps:8,tiltThreshold:rad(20)},duration:48};
const pick=(yaw,pitch=0,roll=0,group=0)=>rotatedDrawing(asset,{_stykMovieclip:{offset:24*group}},spatialQuaternion(rad(roll),rad(yaw),rad(pitch)));
test('eight drawings hold within sectors, step at boundaries and wrap both ways',()=>{
 for(let d=0;d<8;d++)for(const delta of [-22.49,0,22.49])for(const wrap of [-720,0,720])assert.equal(pick(d*45+delta+wrap).view,d);
 assert.equal(pick(22.51).view,1);assert.equal(pick(-22.51).view,7);
 for(const roll of [-70,0,60])for(let d=0;d<8;d++)assert.equal(pick(d*45,0,roll).view,d);
});
test('tilt switches drawings without blends and form retains its own frame range',()=>{
 assert.equal(pick(0,-19).view,0);assert.equal(pick(0,-21).view,8);assert.equal(pick(0,21).view,16);
 assert.equal(pick(0,21,0,1).frame,40);
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
for(const layerTimeline of [false,true])test('joined drawings follow live head rotation, undo, form selection and saved playback '+layerTimeline,async()=>{
 const {d,h}=fixture(),e=new Editor({demo:false,layerTimeline});e.load(d);e.select(1,h-1);
 e.setSpatialPose({turn:rad(90)});assert.equal(e.geometry.objects.get(1).drawingView.frame,2);
 const fresh=buildGeometry(e.report,e.evaluatedFrame);assert.deepEqual(e.geometry.objects.get(1).drawables,fresh.objects.get(1).drawables);
 assert.deepEqual(e.geometry.objects.get(1).root,e.geometry.objects.get(0).segments[h-1].start);
 e.setMovieclipDrawing(2,1,0);assert.equal(e.geometry.objects.get(1).drawingView.frame,26);e.undo();assert.equal(e.geometry.objects.get(1).drawingView.frame,2);e.redo();assert.equal(e.geometry.objects.get(1).drawingView.frame,26);
 for(const pitch of [-35,0,35])for(let yaw=0;yaw<360;yaw+=45){e.setSpatialPose({turn:rad(yaw),pitch:rad(pitch)});assert.equal(e.geometry.objects.get(1).drawingView.view,(pitch<0?8:pitch>0?16:0)+yaw/45);}
 e.setSpatialPose({turn:rad(90),pitch:0});
 const decoded=(await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk')).document;
 assert.equal(buildGeometry(decoded,evaluatedFrame(decoded,0,0,0)).objects.get(1).drawingView.frame,26);
});
import {createMovieclipMaterializer} from '../src/movieclip-materialize.mjs';
test('materialization preserves the selected drawing and inherited roll',()=>{
 const {d,h}=fixture(),e=new Editor({demo:false});e.load(d);e.select(1,h-1);e.setSpatialPose({turn:rad(135),pitch:rad(-35),bend:rad(25)});e.setMovieclipDrawing(2,1,0);
 const before=e.geometry.objects.get(1),materializer=createMovieclipMaterializer(e.report),frame=materializer.frame(e.evaluatedFrame),g=buildGeometry({...e.report,figure_types:materializer.figures},frame),after=g.orderedObjects.at(-1);
 assert.equal(before.drawables.length,after.drawables.length);
 for(let i=0;i<before.drawables.length;i++)for(const key of ['start','end'])for(const axis of ['x','y'])assert.ok(Math.abs(before.drawables[i][key][axis]-after.drawables[i][key][axis])<.0001);
});
import {validateScene} from '../src/pivot/model.mjs';
test('rotation-driven heads retain perspective at their attachment depth',()=>{
 const {d,h}=fixture();d.figure_types[0].segments[h-1]._stykRig.spatial.origin[2]=50;d.figure_types[0].segments[h-1]._stykRig.spatial.tip[2]=50;
 const e=new Editor({demo:false});e.load(d);e.select(1,h-1);e.setSpatialCamera({strength:.8,distance:600});validateScene(e.serialize());
 const g=e.geometry.objects.get(1);assert.ok(Math.abs(g.drawingTransform.scale-1/(1-.8*50/600))<1e-9);assert.deepEqual(g.root,e.geometry.objects.get(0).segments[h-1].start);
 const plain=fixture();delete plain.d.figure_types[1]._styk.movieclip.drawingRotation;const other=new Editor({demo:false});other.load(plain.d);other.select(1,plain.h-1);assert.throws(()=>other.setSpatialCamera({strength:1}),/single spatial figure/);
});
