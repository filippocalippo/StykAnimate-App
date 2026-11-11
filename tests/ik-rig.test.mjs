import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
const near=(a,b,t=.002)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
function fixture(x=.5,y=.8){
 const q=construction();q.add(0,0,0,'Rotation');const driver=q.add(0,100*x,0,'Upper projection',{rig:{stretch:{restLength:100,min:0,max:1,width:'keep'}}}),second=q.add(0,100*y,0,'Lower projection',{rig:{stretch:{restLength:100,min:0,max:1,width:'keep'}}});
 const anchor=q.add(0,40,-Math.PI/2,'Body'),base=q.add(0,0,0,'Attachment',{rig:{weighted:{origin:0,anchors:[{joint:anchor,weight:.8}]}}});
 const follow=driver=>({orientation:'world',follow:{driver,mode:'stretch',influence:1},response:{mode:'stretch',multiplier:2}});
 const a=q.add(base,100,.6,'Upper bone',{control:true,rig:follow(driver)}),b=q.add(a,85,-.7,'Lower bone',{control:true,rig:follow(second)});
 const fig={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},doc={...emptyDocument(),figure_types:[fig],keyframes:[createFrame([createObject(fig,1,250,200)])]};
 return {doc,a,b,driver,second,base};
}
test('projected IK uses ordinary controls, stops at a derived anchor, and invalidates cached rig settings',()=>{
 const {doc,a,b,driver}=fixture(.7,.8),e=ownedEditorFor({demo:false, layerTimeline:true}, doc);e.select(1,b-1);
 assert.equal(e.getIKSettings().maxLength,2);e.setNodeIK({enabled:true});const before=e.serialize();
 const p=e.geometry.objects.get(0).joints.get(b);e.poseJoint(p.x-10,p.y+8);const target=e.geometry.objects.get(0).joints.get(b);near(target.x,p.x-10);near(target.y,p.y+8);
 e.undo();assert.deepEqual(e.serialize(),before);
 const knee=e.geometry.objects.get(0).joints.get(a);
 e.select(1,driver-1);e.setRigBehavior({stretch:{max:.1}});const after=e.geometry.objects.get(0).joints.get(b);assert.ok([after.x,after.y].every(Number.isFinite));
 near(after.x,p.x);near(after.y,p.y);assert.notDeepEqual(e.geometry.objects.get(0).joints.get(a),knee);
});
test('joined projected rigs preserve source scale, local constraints and pinned targets',()=>{
 for(const scale of [.4,1,2]){
  const {doc,b}=fixture(.7,.8),q=construction();q.add(0,40,0,'Body anchor',{control:true});
  const parent={figure_type_id:2,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};doc.figure_types.push(parent);
  const child=doc.keyframes[0].objects[0];child.scale=scale;child.join={target_object_slot:1,target_unique_id:2,target_handle_id:1};
  doc.keyframes[0].objects.push(createObject(parent,2,180,220));
  doc.keyframes[0]=createFrame(doc.keyframes[0].objects);
  const e=ownedEditorFor({demo:false, layerTimeline:true}, doc);e.select(1,b-1);const p=e.geometry.objects.get(0).joints.get(b);
  e.setNodeIK({enabled:true,chainLength:2});let at=e.geometry.objects.get(0).joints.get(b);near(at.x,p.x);near(at.y,p.y);
  e.poseJoint(p.x-5,p.y+8);at=e.geometry.objects.get(0).joints.get(b);near(at.x,p.x-5);near(at.y,p.y+8);
  e.select(2,-1);e.moveSelection(3,-2);at=e.geometry.objects.get(0).joints.get(b);near(at.x,p.x-5);near(at.y,p.y+8);
 }
});
