import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {rigConstraintPlan,remapRigReferences} from '../src/rig-constraints.mjs';
import {remapSpatial,sameSpatial} from '../src/rig-spatial.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {newOwnedEditor} from './support/owned-editor.mjs';
const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const views=[[10,25,4],[22,30,6],[-8,28,5],[-20,32,3]];
function fixture(targets=views){
 const q=construction();q.add(0,0,0,'Figure rotation');
 function bone(parent,origin,tip,name){const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]),id=q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});return {id,turn,pitch};}
 const a=bone(0,[0,0,0],[0,100,0],'Parent'),b=bone(a.id,[0,100,0],[0,150,0],'Head');
 const skin=q.add(0,0,0,'Skin',{rig:{spatial:{point:[10,125,4],bindings:[{joint:b.id,weight:1}],viewPoints:structuredClone(targets)}}});
 const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},object=createObject(figure,1,200,200),doc={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([object])]};
 return {doc,figure,object,a,b,skin};
}
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
for(const count of [4,8])test(`${count}-view corrected rigs survive pose undo/redo, reflection, and native round trips`,async()=>{
 const {doc,b,skin}=fixture(count===4?views:[...views,...views]),e=newOwnedEditor({demo:false});e.load(doc);e.select(1,b.id-1);
 const before=e.serialize();e.setSpatialPose({turn:1.2,pitch:.3,bend:.2});const after=e.serialize(),p=e.geometry.objects.get(0).joints.get(skin);
 e.undo();assert.deepEqual(e.serialize(),before);e.redo();assert.deepEqual(e.serialize(),after);
 e.select(1,-1);e.mirrorFigure();const mirrored=e.geometry.objects.get(0).joints.get(skin);near(mirrored.x,400-p.x);near(mirrored.y,p.y);
 for(const kind of ['styk','stkz']){
  const d=(await decodeDocument(await buildContainerV2(e.serialize(),kind),kind)).document;
  assert.deepEqual(d.figure_types,e.serialize().figure_types);const reopened=newOwnedEditor({demo:false});reopened.load(d);
  const point=reopened.geometry.objects.get(0).joints.get(skin);near(point.x,mirrored.x);near(point.y,mirrored.y);
 }
});
