import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {rigConstraintPlan,remapRigReferences} from '../src/rig-constraints.mjs';
import {Editor} from '../src/editor.mjs';
import {evaluateSpatial,quatMultiply,quatRotate,spatialQuaternion,spatialPoint} from '../src/rig-spatial.mjs';
const near=(a,b,t=.002)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
export function spatialFixture(){
 const q=construction();q.add(0,0,0,'Figure rotation');
 const bone=(parent,origin,tip,name)=>{const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]),id=q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});return{id,turn,pitch};};
 const a=bone(0,[0,0,0],[0,100,0],'Upper'),b=bone(a.id,[0,100,0],[0,180,0],'Lower');
 const skin=q.add(0,0,0,'Skin',{rig:{spatial:{point:[10,100,0],bindings:[{joint:a.id,weight:.5},{joint:b.id,weight:.5}]}}});
 const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},object=createObject(figure,1,200,200),doc={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([object])]};
 return{doc,figure,object,a,b,skin};
}
test('spatial hierarchy retains every joint through compound turns and native branch rotations',()=>{
 const{doc,object,a,b}=spatialFixture();
 let g=buildGeometry(doc,doc.keyframes[0]).objects.get(0);near(g.joints.get(b.id).y,380);
 object.angles[a.pitch-1]=Math.PI/2;g=buildGeometry(doc,doc.keyframes[0]).objects.get(0);
 near(g.joints.get(b.id).y,200);near(g.joints.get(b.id).depthOffset.x,180);
 object.angles[b.pitch-1]=-Math.PI/2;g=buildGeometry(doc,doc.keyframes[0]).objects.get(0);
 near(g.joints.get(b.id).y,280);near(g.joints.get(b.id).depthOffset.x,100);
 const e=new Editor({demo:false});e.load(doc);e.select(1,a.id-1);e.rotateJoint(Math.PI/2);
 g=e.geometry.objects.get(0);near(g.joints.get(b.id).x,120);near(g.joints.get(b.id).y,200);near(g.joints.get(b.id).depthOffset.x,100);
 e.undo();near(e.geometry.objects.get(0).joints.get(b.id).y,280);
});
test('dual quaternion skin retains radius at a half-weight 180 degree twist',()=>{
 const{doc,object,b,skin}=spatialFixture();object.angles[b.turn-1]=Math.PI;
 const p=buildGeometry(doc,doc.keyframes[0]).objects.get(0).joints.get(skin);
 near(p.x,200);near(p.y,300);near(Math.abs(p.depthOffset.x),10);
});

test('skin projection agrees with dual-quaternion reference blending across rotations, reflection and stretch',()=>{
 let seed=417;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32),dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
 for(let sample=0;sample<400;sample++){
  const count=1+sample%4,frames=Array.from({length:count},()=>{
   const sign=random()<.5?-1:1,q=spatialQuaternion(random()*6,random()*6,random()*6).map(v=>v*sign),t=[random()*30,random()*40,random()*50];
   return{q,t,dual:quatMultiply([...t,0],q).map(v=>v/2),axis:[0,1,0],origin:[0,20,0],stretch:sample%11===0?1.4:1};
  }),weights=frames.map(()=>.01+random()),total=weights.reduce((a,b)=>a+b),bindings=weights.map((w,i)=>({joint:i+1,weight:w/total})),point=[random()*70,random()*80,random()*90];
  let expected;
  if(count===1)expected=spatialPoint(frames[0],point);
  else if(frames.some(f=>f.stretch!==1))expected=bindings.reduce((p,b)=>{const v=spatialPoint(frames[b.joint-1],point);return p.map((n,i)=>n+v[i]*b.weight);},[0,0,0]);
  else{
   const sum=Array(8).fill(0);for(const b of bindings){const f=frames[b.joint-1],w=b.weight*(dot(f.q,frames[0].q)<0?-1:1);[...f.q,...f.dual].forEach((v,i)=>sum[i]+=v*w);}
   const norm=Math.hypot(...sum.slice(0,4)),q=sum.slice(0,4).map(v=>v/norm),d=sum.slice(4).map(v=>v/norm),translation=quatMultiply(d,[-q[0],-q[1],-q[2],q[3]]);
   expected=quatRotate(q,point).map((v,i)=>v+2*translation[i]);
  }
  const mirror=sample%2===0,sign=mirror?-1:1,angle=.7,scale=1.5,cs=Math.cos(angle),sn=Math.sin(angle);
  const result=evaluateSpatial({point,bindings},{segment:{angle_rad:0},input:{start:{x:0,y:0},angle:0},get:id=>({spatial:frames[id-1]}),root:{x:30,y:50},scale,figureAngle:angle,mirror});
  near(result.handle.x,30+(expected[0]*cs-expected[1]*sign*sn)*scale,1e-9);near(result.handle.y,50+(expected[0]*sn+expected[1]*sign*cs)*scale,1e-9);near(result.depthOffset.x,expected[2]*scale*cs,1e-9);
 }
});
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
  const{doc,a,b}=spatialFixture(),e=new Editor({demo:false});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn,pitch:.2});
  e.select(1,b.id-1);e.setSpatialPose({bend:.5,pitch:.15});
  const p=e.geometry.objects.get(0).joints.get(b.id);e.setNodeIK({enabled:true,chainLength:2,pinned:false});
  e.poseIKTarget(p.x+15,p.y-20);let g=e.geometry.objects.get(0),point=g.joints.get(b.id);near(point.x,p.x+15,.01);near(point.y,p.y-20,.01);
  e.setNodeIK({enabled:false});e.select(1,a.id-1);const old=e.serialize();e.setSpatialPose({turn:turn+.5,pitch:.4,bend:.3});
  assert.ok(e.geometry.objects.get(0).segments.every(s=>Number.isFinite(s.end.x)&&Number.isFinite(s.end.y)));
  e.undo();assert.deepEqual(e.serialize(),old);
 }
});
test('whole-figure reflection preserves spatial projection and pose controls',()=>{
 const{doc,a,b,skin}=spatialFixture(),e=new Editor({demo:false});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn:.5,pitch:.3,bend:.2});e.select(1,b.id-1);e.setSpatialPose({bend:.7,turn:-.4});
 const pose=e.getSpatialPose(),p=e.geometry.objects.get(0).joints.get(skin);e.select(1,-1);e.mirrorFigure();
 let mirrored=e.geometry.objects.get(0).joints.get(skin);near(mirrored.x,400-p.x);near(mirrored.y,p.y);
 e.select(1,b.id-1);for(const k of Object.keys(pose))near(e.getSpatialPose()[k],pose[k]);
 e.setSpatialPose({bend:.9});near(e.getSpatialPose().bend,.9);e.undo();
 e.select(1,-1);e.mirrorFigure();const original=e.geometry.objects.get(0).joints.get(skin);near(original.x,p.x);near(original.y,p.y);
});
test('a completely straight spatial limb can shorten through native IK without stretching',()=>{
 for(const turn of [0,Math.PI/2,Math.PI]){
  const{doc,a,b}=spatialFixture(),e=new Editor({demo:false});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn});
  e.select(1,b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:false});e.poseIKTarget(200,330);
  const p=e.geometry.objects.get(0).joints.get(b.id);near(p.x,200,.01);near(p.y,330,.01);assert.equal(e.object.len_flag,0);
 }
});

test('spatial IK respects an explicit elbow side and uses physical reach before stretching',()=>{
 for(const direction of [-1,1]){
  const{doc,a,b}=spatialFixture(),e=new Editor({demo:false});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({pitch:1.15});
  e.select(1,b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:false,allowStretch:true,bendDirection:direction});e.poseIKTarget(230,330);
  const g=e.geometry.objects.get(0),m=g.joints.get(a.id),p=g.joints.get(b.id);near(p.x,230,.02);near(p.y,330,.02);
  assert.ok(((p.x-200)*(m.y-200)-(p.y-200)*(m.x-200))*direction>0);assert.equal(e.object.len_flag,0);
 }
});

test('spatial pins survive reachable root movement and saving; negative scale stays finite',async()=>{
 const{doc,a,b,skin}=spatialFixture(),e=new Editor({demo:false,layerTimeline:true});e.load(doc);e.select(1,a.id-1);e.setSpatialPose({turn:.7,pitch:.2,bend:.3});
 e.select(1,b.id-1);e.setNodeIK({enabled:true,chainLength:2,pinned:true});const before=e.geometry.objects.get(0).joints.get(b.id);
 e.select(1,-1);e.moveSelection(0,15);const p=e.geometry.objects.get(0).joints.get(b.id);near(p.x,before.x,.02);near(p.y,before.y,.02);
 const{buildContainerV2,decodeDocument}=await import('./support/native-files.mjs');const reopened=await decodeDocument(await buildContainerV2(e.serialize(),'styk'),'styk');
 const second=new Editor({demo:false,layerTimeline:true});second.load(reopened.document);second.select(1,-1);
 near(second.geometry.objects.get(0).joints.get(skin).x,e.geometry.objects.get(0).joints.get(skin).x);
 const plain=spatialFixture();plain.object.scale=-2;assert.ok([...buildGeometry(plain.doc,plain.doc.keyframes[0]).objects.get(0).joints.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
});

test('bound spatial setup rejects unsupported rest-space edits without changing the document',()=>{
 const{doc,a}=spatialFixture(),e=new Editor({demo:false});e.load(doc);e.select(1,a.id-1);const before=e.serialize();
 assert.throws(()=>e.beginRigDrag(),/spatial skin/);assert.throws(()=>e.mirrorSegmentBranch(),/complete spatial figure/);
 assert.throws(()=>e.moveBuilderSegment(a.id,{parentId:1}),/bound parent/);assert.deepEqual(e.serialize(),before);assert.equal(e.dragging,false);
});
