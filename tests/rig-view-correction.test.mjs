import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {rigConstraintPlan,remapRigReferences} from '../src/rig-constraints.mjs';
import {evaluateSpatial,spatialQuaternion,spatialPoint,remapSpatial,sameSpatial} from '../src/rig-spatial.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {Editor} from '../src/editor.mjs';
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const views=[[10,25,4],[22,30,6],[-8,28,5],[-20,32,3]];
function sample(yaw,pitch=0,options={}){
 const origin=[3,7,2],f={q:spatialQuaternion(0,yaw,pitch),t:[0,0,0],origin,axis:[0,1,0],stretch:1,...options};
 const s={point:views[0].map((v,i)=>v+origin[i]),bindings:[{joint:1,weight:1}],viewPoints:options.views??views};
 const r=evaluateSpatial(s,{segment:{angle_rad:0},input:{start:{x:0,y:0},angle:0},get:()=>({spatial:f}),root:{x:0,y:0},scale:1,figureAngle:0});
 return [r.handle.x,r.handle.y,r.depthOffset.x];
}
function fixture(targets=views){
 const q=construction();q.add(0,0,0,'Figure rotation');
 function bone(parent,origin,tip,name){const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]),id=q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});return {id,turn,pitch};}
 const a=bone(0,[0,0,0],[0,100,0],'Parent'),b=bone(a.id,[0,100,0],[0,150,0],'Head');
 const skin=q.add(0,0,0,'Skin',{rig:{spatial:{point:[10,125,4],bindings:[{joint:b.id,weight:1}],viewPoints:structuredClone(targets)}}});
 const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},object=createObject(figure,1,200,200),doc={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([object])]};
 return {doc,figure,object,a,b,skin};
}
test('view-corrected skin reaches its cardinal contours and wraps continuously',()=>{
 for(let i=0;i<4;i++){
  const yaw=i*Math.PI/2,p=sample(yaw),o=spatialPoint({q:spatialQuaternion(0,yaw,0),t:[0,0,0],stretch:1},[3,7,2]);
  p.forEach((n,k)=>near(n,views[i][k]+o[k]));
  for(const edge of [yaw,yaw+Math.PI*2]){
   const before=sample(edge-1e-6),after=sample(edge+1e-6);before.forEach((n,k)=>near(n,after[k],.0001));
  }
 }
 const mid=sample(Math.PI/4),o=spatialPoint({q:spatialQuaternion(0,Math.PI/4,0),t:[0,0,0],stretch:1},[3,7,2]);
 mid.forEach((n,k)=>near(n,(views[0][k]+views[1][k])/2+o[k]));
});
test('vertical views remain finite and continuous instead of jumping at undefined heading',()=>{
 for(const yaw of [0,.5,1.6,3.1,4.8])for(const pitch of [-Math.PI/2,Math.PI/2]){
  const a=sample(yaw,pitch-1e-7),b=sample(yaw,pitch+1e-7);
  a.forEach((n,k)=>{assert.ok(Number.isFinite(n));near(n,b[k],.0001);});
 }
 for(let i=0;i<720;i++)assert.ok(sample(i*.019,i*.031).every(Number.isFinite));
});
test('view corrections preserve stretch and radial shaping at the bind origin',()=>{
 const p=sample(0,0,{stretch:1.5,shape:{width:2,taper:0},restLength:100});
 const expected=spatialPoint({q:[0,0,0,1],t:[0,0,0],origin:[3,7,2],axis:[0,1,0],stretch:1.5,shape:{width:2,taper:0},restLength:100},[13,32,6]);
 p.forEach((n,i)=>near(n,expected[i]));
});
test('view targets validate, remap without aliasing, and invalidate changed definitions',()=>{
 const {figure,b,skin}=fixture(),s=figure.segments[skin-1]._stykRig.spatial,plan=rigConstraintPlan(figure),before=structuredClone(s);
 s.viewPoints[1][0]+=2;assert.equal(sameSpatial(s,before),false);assert.notEqual(rigConstraintPlan(figure),plan);
 const mapped=remapSpatial(s,new Map([[b.id,100]]));assert.equal(mapped.bindings[0].joint,100);mapped.viewPoints[0][0]+=5;assert.notEqual(mapped.viewPoints[0][0],s.viewPoints[0][0]);
 const clone=structuredClone(figure),map=new Map(figure.segments.map(s=>[s.segment_id,s.segment_id+100]));
 for(const node of clone.segments){remapRigReferences(node,map);node.segment_id=map.get(node.segment_id);node.parent_id=map.get(node.parent_id)??0;}assert.doesNotThrow(()=>rigConstraintPlan(clone));
 for(const bad of [[],views.slice(0,3),[...views,[0,0,0]],[[NaN,0,0],...views.slice(1)],Array(4),Array(8),Array(7).fill([0,0,0]),Array(9).fill([0,0,0]),[Array(3),...views.slice(1)]]){
  s.viewPoints=bad;assert.throws(()=>rigConstraintPlan(figure),/four cardinal/);
 }
 s.viewPoints=views;s.bindings=[{joint:b.id,weight:.5},{joint:fixture().a.id,weight:.5}];assert.throws(()=>rigConstraintPlan(figure),/one joint/);
});
test('parent and local turns share correction targets; incremental poses equal fresh geometry',()=>{
 const {doc,object,a,b,skin}=fixture(),frame=doc.keyframes[0];let previous=buildGeometry(doc,frame);
 for(let i=0;i<40;i++){
  object.angles[a.turn-1]=i*.06;object.angles[b.turn-1]=i*.09;object.angles[b.pitch-1]=Math.sin(i)*.4;
  const next=buildGeometry(doc,frame,{previous,dirtySlots:new Set([0]),poseSlots:new Set([0])}),fresh=buildGeometry(doc,frame);
  assert.deepEqual(next.objects.get(0).joints.get(skin),fresh.objects.get(0).joints.get(skin));previous=next;
 }
 object.angles[a.turn-1]=Math.PI/4;object.angles[b.turn-1]=Math.PI/4;object.angles[b.pitch-1]=0;
 const p=buildGeometry(doc,frame).objects.get(0).joints.get(skin);near(p.x,222);near(p.y,330);near(p.depthOffset.x,6);
});
for(const count of [4,8])test(`${count}-view corrected rigs survive pose undo/redo, reflection, and native round trips`,async()=>{
 const {doc,b,skin}=fixture(count===4?views:[...views,...views]),e=new Editor({demo:false});e.load(doc);e.select(1,b.id-1);
 const before=e.serialize();e.setSpatialPose({turn:1.2,pitch:.3,bend:.2});const after=e.serialize(),p=e.geometry.objects.get(0).joints.get(skin);
 e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
 e.select(1,-1);e.mirrorFigure();const mirrored=e.geometry.objects.get(0).joints.get(skin);near(mirrored.x,400-p.x);near(mirrored.y,p.y);
 for(const kind of ['styk','stkz']){
  const d=(await decodeDocument(await buildContainerV2(e.serialize(),kind),kind)).document;
  assert.deepEqual(d.figure_types,e.serialize().figure_types);const reopened=new Editor({demo:false});reopened.load(d);
  const point=reopened.geometry.objects.get(0).joints.get(skin);near(point.x,mirrored.x);near(point.y,mirrored.y);
 }
});


test('eight-view corrections reach every mirrored quarter view and wrap smoothly',()=>{
 const targets=[[0,25,4],[15,26,6],[24,27,5],[12,29,3],[0,30,2],[-12,29,3],[-24,27,5],[-15,26,6]];
 for(let i=0;i<8;i++){
  const yaw=i*Math.PI/4,p=sample(yaw,0,{views:targets}),o=spatialPoint({q:spatialQuaternion(0,yaw,0),t:[0,0,0],stretch:1},[3,7,2]);
  p.forEach((n,k)=>near(n,targets[i][k]+o[k]));
  for(const pitch of [-Math.PI/3,0,Math.PI/3]){
   const a=sample(yaw-1e-6,pitch,{views:targets}),b=sample(yaw+1e-6,pitch,{views:targets});a.forEach((n,k)=>near(n,b[k],.0002));
  }
 }
 const {doc,object,a,b,skin,figure}=fixture(targets);let previous=buildGeometry(doc,doc.keyframes[0]);
 for(let i=0;i<24;i++){
  object.angles[a.turn-1]=i*.12;object.angles[b.turn-1]=i*.07;object.angles[b.pitch-1]=Math.sin(i)*.8;
  const next=buildGeometry(doc,doc.keyframes[0],{previous,dirtySlots:new Set([0]),poseSlots:new Set([0])}),fresh=buildGeometry(doc,doc.keyframes[0]);
  assert.deepEqual(next.objects.get(0).joints.get(skin),fresh.objects.get(0).joints.get(skin));previous=next;
 }
 const s=figure.segments[skin-1]._stykRig.spatial,old=structuredClone(s),plan=rigConstraintPlan(figure);s.viewPoints[7][0]++;
 assert.equal(sameSpatial(old,s),false);assert.notEqual(rigConstraintPlan(figure),plan);
});

test('four and eight target skins share a bone without reusing the wrong interval',()=>{
 const frame={q:spatialQuaternion(0,Math.PI/4,0),t:[0,0,0],origin:[0,0,0],axis:[0,1,0],stretch:1};
 const targets=Array.from({length:8},(_,i)=>[i*3,10,0]);
 const evaluate=points=>evaluateSpatial({point:points[0],bindings:[{joint:1,weight:1}],viewPoints:points},{segment:{angle_rad:0},input:{start:{x:0,y:0},angle:0},get:()=>({spatial:frame}),root:{x:0,y:0},scale:1,figureAngle:0}).handle.x;
 for(let i=0;i<4;i++){near(evaluate(views),16);near(evaluate(targets),3);}
});
