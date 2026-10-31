import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {rigConstraintPlan,remapRigReferences} from '../src/rig-constraints.mjs';
import {newOwnedEditor} from './support/owned-editor.mjs';
const near=(a,b,t=.002)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
export function spatialFixture(){
 const q=construction();q.add(0,0,0,'Figure rotation');
 const bone=(parent,origin,tip,name)=>{const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]),id=q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});return{id,turn,pitch};};
 const a=bone(0,[0,0,0],[0,100,0],'Upper'),b=bone(a.id,[0,100,0],[0,180,0],'Lower');
 const skin=q.add(0,0,0,'Skin',{rig:{spatial:{point:[10,100,0],bindings:[{joint:a.id,weight:.5},{joint:b.id,weight:.5}]}}});
 const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},object=createObject(figure,1,200,200),doc={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([object])]};
 return{doc,figure,object,a,b,skin};
}

test('spatial dependencies remap, invalidate and reject invalid bindings and cycles',()=>{
 const{figure,a,b,skin}=spatialFixture(),plan=rigConstraintPlan(figure);
 figure.segments[a.id-1]._stykRig.spatial.tip[0]=5;assert.notEqual(rigConstraintPlan(figure),plan);
 const clone=structuredClone(figure),map=new Map(figure.segments.map(s=>[s.segment_id,s.segment_id+100]));
 for(const s of clone.segments){remapRigReferences(s,map);s.segment_id=map.get(s.segment_id);s.parent_id=map.get(s.parent_id)??0;}assert.doesNotThrow(()=>rigConstraintPlan(clone));
 clone.segments[skin-1]._stykRig.spatial.bindings[0].weight=.7;assert.throws(()=>rigConstraintPlan(clone),/add up/);
 figure.segments[a.id-1]._stykRig.spatial.parent=b.id;assert.throws(()=>rigConstraintPlan(figure),/depend on itself/);
});
test('spatial posing and native IK remain reachable at front, edge-on and reversed turns',()=>{
 for(const turn of [0,Math.PI/2,Math.PI,Math.PI*1.5]){
  const{doc,a,b}=spatialFixture(),e=newOwnedEditor({demo:false,layerTimeline:true});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn,pitch:.2});
  e.select(1,b.id-1);e.setSpatialPose({bend:.5,pitch:.15});
  const p=e.geometry.objects.get(0).joints.get(b.id);e.setNodeIK({enabled:true,chainLength:2,pinned:false});
  e.poseJoint(p.x+15,p.y-20);let g=e.geometry.objects.get(0),point=g.joints.get(b.id);near(point.x,p.x+15,.01);near(point.y,p.y-20,.01);
  e.setNodeIK({enabled:false});e.select(1,a.id-1);const old=e.serialize();e.setSpatialPose({turn:turn+.5,pitch:.4,bend:.3});
  assert.ok(e.geometry.objects.get(0).segments.every(s=>Number.isFinite(s.end.x)&&Number.isFinite(s.end.y)));
  e.undo();assert.deepEqual(e.serialize(),old);
 }
});
test('whole-figure reflection preserves spatial projection and pose controls',()=>{
 const{doc,a,b,skin}=spatialFixture(),e=newOwnedEditor({demo:false});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn:.5,pitch:.3,bend:.2});e.select(1,b.id-1);e.setSpatialPose({bend:.7,turn:-.4});
 const pose=e.getSpatialPose(),p=e.geometry.objects.get(0).joints.get(skin);e.select(1,-1);e.mirrorFigure();
 let mirrored=e.geometry.objects.get(0).joints.get(skin);near(mirrored.x,400-p.x);near(mirrored.y,p.y);
 e.select(1,b.id-1);for(const k of Object.keys(pose))near(e.getSpatialPose()[k],pose[k]);
 e.setSpatialPose({bend:.9});near(e.getSpatialPose().bend,.9);e.undo();
 e.select(1,-1);e.mirrorFigure();const original=e.geometry.objects.get(0).joints.get(skin);near(original.x,p.x);near(original.y,p.y);
});
test('a completely straight spatial limb can shorten through native IK without stretching',()=>{
 for(const turn of [0,Math.PI/2,Math.PI]){
  const{doc,a,b}=spatialFixture(),e=newOwnedEditor({demo:false,layerTimeline:true});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn});
  e.select(1,b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:false});e.poseJoint(200,330);
  const p=e.geometry.objects.get(0).joints.get(b.id);near(p.x,200,.01);near(p.y,330,.01);assert.equal(e.object.len_flag,0);
 }
});

test('spatial IK respects an explicit elbow side and uses physical reach before stretching',()=>{
 for(const direction of [-1,1]){
  const{doc,a,b}=spatialFixture(),e=newOwnedEditor({demo:false,layerTimeline:true});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({pitch:1.15});
  e.select(1,b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:false,allowStretch:true,bendDirection:direction});e.poseJoint(230,330);
  const g=e.geometry.objects.get(0),m=g.joints.get(a.id),p=g.joints.get(b.id);near(p.x,230,.02);near(p.y,330,.02);
  assert.ok(((p.x-200)*(m.y-200)-(p.y-200)*(m.x-200))*direction>0);assert.equal(e.object.len_flag,0);
 }
});

test('spatial pins survive reachable root movement and saving',async()=>{
 const{doc,a,b,skin}=spatialFixture(),e=newOwnedEditor({demo:false,layerTimeline:true});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn:.7,pitch:.2,bend:.3});
 e.select(1,b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:true});const before=e.geometry.objects.get(0).joints.get(b.id);
 e.select(1,-1);e.moveSelection(0,15);const p=e.geometry.objects.get(0).joints.get(b.id);near(p.x,before.x,.02);near(p.y,before.y,.02);
 const{buildContainerV2,decodeDocument}=await import('./support/native-files.mjs');const reopened=await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk');
 const second=newOwnedEditor({demo:false,layerTimeline:true});second.load(reopened.document);second.select(1,-1);
 near(second.geometry.objects.get(0).joints.get(skin).x,e.geometry.objects.get(0).joints.get(skin).x);
});

test('bound spatial setup rejects unsupported rest-space edits without changing the document',()=>{
 const{doc,a}=spatialFixture(),e=newOwnedEditor({demo:false});e.load(doc);e.select(1,a.id-1);const before=e.serialize();
 assert.throws(()=>e.beginRigDrag(),/spatial skin/);assert.throws(()=>e.mirrorSegmentBranch(),/complete spatial figure/);
 assert.throws(()=>e.moveBuilderSegment(a.id,{parentId:1}),/bound parent/);assert.deepEqual(e.serialize(),before);assert.equal(e.dragging,false);
});
