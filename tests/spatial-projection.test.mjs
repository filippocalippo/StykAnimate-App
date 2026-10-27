import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {evaluatedAt} from './support/engine-geometry.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import {validateSpatialPose} from '../src/spatial-projection.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {spatialControlsView} from './support/control-views.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
const near=(a,b,t=1e-3)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
function fixture(){
 const q=construction();q.add(0,0,0,'Figure');
 const basis=[0,q.add(0,1,0,'X'),q.add(0,1,Math.PI/2,'Y')];
 const bone=(parent,origin,tip,name)=>{const turn=q.add(0,0,0,'Turn'),pitch=q.add(0,0,0,'Pitch'),v=tip.map((n,i)=>n-origin[i]),id=q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});return{id,turn,pitch};};
 const a=bone(0,[0,0,0],[0,100,0],'Upper'),b=bone(a.id,[0,100,0],[0,180,0],'Lower'),foot=bone(b.id,[0,180,0],[30,180,0],'Foot'),toe=bone(foot.id,[30,180,0],[40,180,0],'Toe'),other=bone(0,[60,0,0],[60,100,0],'Other');
 const vertex=(point,joint)=>q.add(0,0,0,'Skin',{rig:{spatial:{point,bindings:[{joint,weight:1}]}}});
 const vertices=[[10,110,0],[-10,110,0],[0,170,10]].map(p=>vertex(p,b.id));
 q.polyfills.push({segment_ids:vertices,color_rgb:[255,100,0],color_alpha:1,z_order:0,_stykSurface:{basis,side:'back',depthTest:true,depth:vertices}});
 const skin=vertex([10,180,0],b.id),footSkin=vertex([30,190,0],foot.id);
 const figure={figure_type_id:1,segments:q.segments,polyfills:q.polyfills,image_assets:[],text_assets:[]},object=createObject(figure,1,200,200),doc={...emptyDocument(),auto_easing:false,figure_types:[figure],keyframes:[createFrame([object])]};
 return{doc,figure,object,a,b,foot,toe,other,skin,footSkin,vertices};
}
const editor=doc=>{const {editor:e}=ownedEditorSync({demo:false},doc,{recorded:false});e.select(1,-1);return e;};

test('local width and taper change the intended radius and child sizes remain connected',()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);const initial=e.serialize(),other=e.geometry.objects.get(0).joints.get(f.other.id);
 e.setSpatialProportions({width:2,taper:.5});let g=e.geometry.objects.get(0);near(g.joints.get(f.skin).x,230);assert.deepEqual(g.joints.get(f.other.id),other);
 near(g.segments[f.foot.id-1].start.x,g.segments[f.b.id-1].end.x);near(g.segments[f.foot.id-1].start.y,g.segments[f.b.id-1].end.y);
 e.undo();assert.deepEqual(e.serialize(),initial);
 e.select(1,f.foot.id-1);e.setSpatialProportions({size:2});g=e.geometry.objects.get(0);
 near(g.joints.get(f.foot.id).x,260);near(g.joints.get(f.toe.id).x,280);near(g.joints.get(f.footSkin).y,400);
 e.setSpatialProportions({size:1});g=e.geometry.objects.get(0);near(g.joints.get(f.toe.id).x,240);near(g.joints.get(f.footSkin).y,390);
});

test('spatial settings tween, round-trip native saving, and restore one complete undo gesture',async()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);const before=e.serialize();
 e.beginDrag('Perspective kick');e.setSpatialCamera({strength:.8,distance:450});e.setSpatialProportions({width:2,taper:.4});e.commitDrag();const after=e.serialize();
 e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
 const reopened=(await decodeDocument(await buildContainerV2(after,'styk'),'styk')).document;
 assert.deepEqual(reopened.keyframes[0].objects[0]._stykSpatial,e.object._stykSpatial);
 const a=structuredClone(before.keyframes[0].objects[0]),b=structuredClone(e.object);const doc={...f.doc,keyframes:[createFrame([a],12),createFrame([b],12)]};
 const halfway=evaluatedAt(doc,6).objects[0]._stykSpatial;near(halfway.camera.strength,.4);near(halfway.shape[f.b.id].width,1.5);near(halfway.shape[f.b.id].taper,.2);
});

test('invalid camera and shape settings fail before changing the document or history',()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);const original=e.serialize();
 for(const patch of [{strength:NaN},{distance:0},{unknown:1}])assert.throws(()=>e.setSpatialCamera(patch));
 for(const patch of [{width:0},{taper:-1},{size:Infinity},{other:3}])assert.throws(()=>e.setSpatialProportions(patch));
 assert.deepEqual(e.serialize(),original);assert.equal(e.dragging,false);
 assert.throws(()=>validateSpatialPose({_stykSpatial:{shape:{999:{width:1,taper:0}}}},f.figure));
});

test('unsupported joined perspective is rejected atomically and does not alter existing joins',()=>{
 const f=fixture(),child=createObject(f.figure,2,200,200);child.object_slot=1;child.join={target_object_slot:0,target_handle_id:f.b.id};f.doc.keyframes[0]=createFrame([f.object,child]);
 const e=editor(f.doc),before=e.serialize();assert.throws(()=>e.setSpatialCamera({strength:1}),/single spatial figure/);assert.deepEqual(e.serialize(),before);
 const invalid=structuredClone(before);invalid.keyframes[0].objects[0]._stykSpatial={camera:{strength:1,distance:500}};assert.throws(()=>validateScene(invalid),/single spatial figure/);
});

test('the depth slider spans the limb reach around its shoulder or hip depth',()=>{
 const f=fixture();for(const bone of [f.a,f.b]){const r=f.figure.segments[bone.id-1]._stykRig.spatial;r.origin[2]=r.tip[2]=80;}
 const e=editor(f.doc);e.select(1,f.b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:false});
 assert.match(spatialControlsView(e),/min="-100" max="260"[^>]+data-spatial-reach="depth"/);
});
