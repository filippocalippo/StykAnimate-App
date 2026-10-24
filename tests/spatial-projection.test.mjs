import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {buildGeometry,evaluatedNativeFrame} from '../src/pivot/geometry.mjs';
import {Editor} from '../src/editor.mjs';
import {projection,projectSpatial,unprojectSpatial,projectSpatialFace,validateSpatialPose,interpolateSpatialPose} from '../src/spatial-projection.mjs';
import {spatialPoint} from '../src/rig-spatial.mjs';
import {depthSurface} from '../src/surface-raster.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {spatialControlsView} from '../src/spatial-controls.mjs';
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
const editor=doc=>{const e=new Editor({demo:false});e.load(doc);e.select(1,-1);return e;};

test('perspective has an exact neutral default and invertible projection at any scale',()=>{
 for(const scale of [.3,1,3]){
  const o={scale,root_x:200,root_y:100,_stykSpatial:{camera:{strength:1,distance:400,centerX:200,centerY:100}}},root={x:250,y:120},c=projection(o,root);
  for(const z of [-200,0,150]){const p=[280,190,z*scale],screen=projectSpatial(p,c),raw=unprojectSpatial(screen,p[2],o,root);near(raw.x,p[0]);near(raw.y,p[1]);}
  near(projectSpatial([300,100,200*scale],c).x,400);
 }
 const f=fixture(),before=buildGeometry(f.doc,f.doc.keyframes[0]);f.object._stykSpatial={camera:{strength:0,distance:400},shape:{[f.b.id]:{width:1,taper:0}}};
 const after=buildGeometry(f.doc,f.doc.keyframes[0]);
 assert.deepEqual([...after.objects.get(0).joints],[...before.objects.get(0).joints]);
});

test('perspective IK drags reach the displayed point, depth drags keep the cursor ray, pins remain in world space',()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.a.id-1);e.setSpatialPose({pitch:.5});e.select(1,f.b.id-1);e.setSpatialPose({bend:.65});
 e.setNodeIK({enabled:true,chainLength:2,pinned:false});e.setSpatialCamera({strength:.85,distance:400});
 let p=e.geometry.objects.get(0).joints.get(f.b.id);e.poseIKTarget(p.x+8,p.y-20);let next=e.geometry.objects.get(0).joints.get(f.b.id);near(next.x,p.x+8);near(next.y,p.y-20);
 p=next;e.setSpatialIKTarget({depth:p.rawPoint[2]+15});next=e.geometry.objects.get(0).joints.get(f.b.id);near(next.x,p.x);near(next.y,p.y);near(next.rawPoint[2],p.rawPoint[2]+15);
 e.setNodeIK({pinned:true});p=e.geometry.objects.get(0).joints.get(f.b.id);e.select(1,-1);e.moveSelection(0,8);next=e.geometry.objects.get(0).joints.get(f.b.id);near(next.x,p.x);near(next.y,p.y);
 e.select(1,f.b.id-1);e.setSpatialIKTarget({swivel:.5});next=e.geometry.objects.get(0).joints.get(f.b.id);near(next.x,p.x);near(next.y,p.y);
});

test('perspective FK dragging uses pre-projection geometry and whole-figure movement invalidates artwork',()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.a.id-1);e.setSpatialPose({pitch:.6,bend:.3});e.setSpatialCamera({strength:1,distance:400});
 const g=e.geometry.objects.get(0),s=g.segments[f.a.id-1],raw=s.end.rawPoint,start=s.start.rawPoint,angle=.2,c=projection(e.object,g.root);
 const dx=raw[0]-start[0],dy=raw[1]-start[1],p=projectSpatial([start[0]+dx*Math.cos(angle)-dy*Math.sin(angle),start[1]+dx*Math.sin(angle)+dy*Math.cos(angle),raw[2]],c);
 e.poseSpatialJoint(p.x,p.y);const next=e.geometry.objects.get(0).segments[f.a.id-1].end;near(next.x,p.x);near(next.y,p.y);
 e.select(1,-1);e.moveSelection(30,0);
 assert.deepEqual(e.geometry.objects.get(0),buildGeometry(e.report,e.evaluatedFrame).objects.get(0));
});

test('local width and taper change the intended radius and child sizes remain connected',()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);const initial=e.serialize(),other=e.geometry.objects.get(0).joints.get(f.other.id);
 e.setSpatialProportions({width:2,taper:.5});let g=e.geometry.objects.get(0);near(g.joints.get(f.skin).x,230);assert.deepEqual(g.joints.get(f.other.id),other);
 near(g.segments[f.foot.id-1].start.x,g.segments[f.b.id-1].end.x);near(g.segments[f.foot.id-1].start.y,g.segments[f.b.id-1].end.y);
 e.undo();assert.deepEqual(e.serialize(),initial);
 e.select(1,f.foot.id-1);e.setSpatialProportions({size:2});g=e.geometry.objects.get(0);
 near(g.joints.get(f.foot.id).x,260);near(g.joints.get(f.toe.id).x,280);near(g.joints.get(f.footSkin).y,400);
 e.setSpatialProportions({size:1});g=e.geometry.objects.get(0);near(g.joints.get(f.toe.id).x,240);near(g.joints.get(f.footSkin).y,390);
});

test('incremental shape edits reuse unrelated branches and match a fresh evaluation',()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);e.setSpatialCamera({strength:1,distance:500});let prior=e.geometry.objects.get(0);
 e.beginDrag('Width');
 for(const width of [1.2,2,.7,1]){
  e.setSpatialProportions({width,taper:.2});const next=e.geometry.objects.get(0);
  assert.equal(next.segments[f.other.id-1],prior.segments[f.other.id-1]);
  assert.deepEqual(next,buildGeometry(e.report,e.evaluatedFrame).objects.get(0));prior=next;
 }
 e.cancelDrag();near(e.getSpatialProportions().width,1);near(e.getSpatialProportions().taper,0);
});

test('spatial settings tween, round-trip native saving, and restore one complete undo gesture',async()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);const before=e.serialize();
 e.beginDrag('Perspective kick');e.setSpatialCamera({strength:.8,distance:450});e.setSpatialProportions({width:2,taper:.4});e.commitDrag();const after=e.serialize();
 e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
 const reopened=(await decodeDocument(await buildContainerV2(after,'styk'),'styk')).document;
 assert.deepEqual(reopened.keyframes[0].objects[0]._stykSpatial,e.object._stykSpatial);
 const a=structuredClone(before.keyframes[0].objects[0]),b=structuredClone(e.object);const doc={...f.doc,keyframes:[createFrame([a],12),createFrame([b],12)]};
 const halfway=evaluatedNativeFrame(doc,0,.5).objects[0]._stykSpatial;near(halfway.camera.strength,.4);near(halfway.shape[f.b.id].width,1.5);near(halfway.shape[f.b.id].taper,.2);
 validateSpatialPose({...b,_stykSpatial:interpolateSpatialPose(a,b,-10)},f.figure);
});

test('near-plane clipping retains finite convex depth polygons and removes hidden faces',()=>{
 const o={scale:1,_stykSpatial:{camera:{strength:1,distance:100}}},c=projection(o,{x:0,y:0});
 const face=raw=>projectSpatialFace(raw.map(p=>projectSpatial(p,c)),c);
 const quad=face([[-10,0,0],[10,0,0],[0,10,110]]);assert.equal(quad.points.length,4);assert.ok(quad.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.rawPoint[2]<=95));assert.equal(quad.depthValues.length,4);
 assert.ok(depthSurface({type:'poly',poly:{_stykSurface:{depthTest:true}},alpha:1,...quad}));
 assert.equal(face([[0,0,110],[10,0,120],[0,10,130]]).points.length,0);
 const p=face([[0,0,0],[20,0,50],[0,20,0]]);near(p.depthValues[1],100);
});

test('invalid camera and shape settings fail before changing the document or history',()=>{
 const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);const original=e.serialize();
 for(const patch of [{strength:NaN},{distance:0},{unknown:1}])assert.throws(()=>e.setSpatialCamera(patch));
 for(const patch of [{width:0},{taper:-1},{size:Infinity},{other:3}])assert.throws(()=>e.setSpatialProportions(patch));
 assert.deepEqual(e.serialize(),original);assert.equal(e.dragging,false);
 assert.throws(()=>validateSpatialPose({_stykSpatial:{shape:{999:{width:1,taper:0}}}},f.figure));
});

test('artist width retains radius at a weighted half-turn instead of collapsing',()=>{
 const f=fixture(),s=f.figure.segments[f.skin-1];s._stykRig.spatial={point:[10,100,0],bindings:[{joint:f.a.id,weight:.5},{joint:f.b.id,weight:.5}]};
 f.object.angles[f.b.turn-1]=Math.PI;f.object._stykSpatial={shape:{[f.a.id]:{width:2,taper:0},[f.b.id]:{width:2,taper:0}}};
 const p=buildGeometry(f.doc,f.doc.keyframes[0]).objects.get(0).joints.get(f.skin);near(p.x,200);near(Math.abs(p.depthOffset.x),20);
});

test('unsupported joined perspective is rejected atomically and does not alter existing joins',()=>{
 const f=fixture(),child=createObject(f.figure,2,200,200);child.object_slot=1;child.join={target_object_slot:0,target_handle_id:f.b.id};f.doc.keyframes[0]=createFrame([f.object,child]);
 const e=editor(f.doc),before=e.serialize();assert.throws(()=>e.setSpatialCamera({strength:1}),/single spatial figure/);assert.deepEqual(e.serialize(),before);
 const invalid=structuredClone(before);invalid.keyframes[0].objects[0]._stykSpatial={camera:{strength:1,distance:500}};assert.throws(()=>validateScene(invalid),/single spatial figure/);
});

test('changing depth retains an unreachable planted target rather than adopting the clamped endpoint',()=>{
 for(const strength of [0,1]){
  const f=fixture(),e=editor(f.doc);e.select(1,f.b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:true});e.setSpatialCamera({strength,distance:400});
  e.poseIKTarget(1000,1000);e.setSpatialIKTarget({depth:20});const c=e.object._stykIK[f.b.id];near(c.target.x,strength?960:1000);near(c.target.y,strength?960:1000);
 }
});

test('the depth slider spans the limb reach around its shoulder or hip depth',()=>{
 const f=fixture();for(const bone of [f.a,f.b]){const r=f.figure.segments[bone.id-1]._stykRig.spatial;r.origin[2]=r.tip[2]=80;}
 const e=editor(f.doc);e.select(1,f.b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:false});
 assert.match(spatialControlsView(e),/min="-100" max="260"[^>]+data-spatial-reach="depth"/);
});
