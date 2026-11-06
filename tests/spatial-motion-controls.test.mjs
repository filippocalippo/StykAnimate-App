import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {geometryOfDocument} from './support/engine-geometry.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {rigConstraintPlan,remapRigReferences} from '../src/rig-constraints.mjs';
import {sameSpatial,spatialPoint,remapSpatial} from '../src/rig-spatial.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {createSpatialGizmo,ringPoint,startRotationGizmo,rotateGizmo} from '../src/spatial-gizmo.mjs';

const near=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const vectorNear=(a,b,t=1e-8)=>a.forEach((v,i)=>near(v,b[i],t));
function fixture(){
  const q=construction();q.add(0,0,0,'Figure rotation');
  const bone=(parent,origin,tip,name,motion)=>{
    const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]);
    const id=q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch,...(motion?{motion}:{})}}});
    return{id,turn,pitch};
  };
  const root=bone(0,[0,0,0],[0,20,0],'Wrist');
  const master=bone(root.id,[-35,0,0],[-35,-24,0],'Curl',{type:'hinge',min:0,max:1.7});
  const a=bone(root.id,[-10,20,0],[-10,40,0],'Finger base',{type:'hinge',min:0,max:1.2,axis:[-1,0,0],driver:{joint:master.id,multiplier:.8}});
  const b=bone(a.id,[-10,40,0],[-10,58,0],'Finger middle',{type:'hinge',min:0,max:1.5,axis:[-1,0,0],driver:{joint:master.id,multiplier:1.1}});
  const tip=bone(b.id,[-10,58,0],[-10,70,0],'Finger tip',{type:'hinge',min:0,max:1,axis:[-1,0,0],driver:{joint:master.id,multiplier:.7}});
  const lip=bone(root.id,[10,10,0],[10,20,0],'Mouth corner',{type:'slide',min:-4,max:4});
  const cheek=bone(root.id,[20,10,0],[20,16,0],'Cheek',{type:'slide',min:-2,max:2,driver:{joint:lip.id,multiplier:.3}});
  const figure={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]};
  const object=createObject(figure,1,200,200),doc={...emptyDocument(),figure_types:[figure],keyframes:[createFrame([object])]};
  const evaluate=()=>geometryOfDocument(doc).objects.get(0);
  const frame=(g,bone)=>g.segments[bone.id-1].spatialFrame;
  const setResidual=(bone,value)=>{
    const spatial=figure.segments[bone.id-1]._stykRig.spatial,parent=spatial.parent?figure.segments.findIndex(s=>s.segment_id===spatial.parent):-1;
    const parentBend=parent<0?0:object.angles[parent]-figure.segments[parent].angle_rad;
    const old=object.angles[bone.id-1],next=figure.segments[bone.id-1].angle_rad+parentBend+value,delta=next-old;
    const ids=new Set([bone.id]);for(const s of figure.segments)if(ids.has(s.parent_id))ids.add(s.segment_id);
    figure.segments.forEach((s,i)=>{if(ids.has(s.segment_id))object.angles[i]+=delta;});
  };
  return{q,doc,figure,object,root,master,a,b,tip,lip,cheek,evaluate,frame,setResidual};
}
// Independent Rodrigues reference, so axis tests do not compare the evaluator
// with the same quaternion helper used by its implementation.
function turn(p,axis,angle){const c=Math.cos(angle),s=Math.sin(angle),d=p.reduce((n,v,i)=>n+v*axis[i],0),cross=[axis[1]*p[2]-axis[2]*p[1],axis[2]*p[0]-axis[0]*p[2],axis[0]*p[1]-axis[1]*p[0]];return p.map((v,i)=>v*c+cross[i]*s+axis[i]*d*(1-c));}

test('hinges turn about unit local X, Y and oblique axes with anatomical end stops',()=>{
  for(const axis of [[-1,0,0],[0,1,0],[Math.SQRT1_2,0,Math.SQRT1_2]]){
    const f=fixture(),s=f.figure.segments[f.a.id-1]._stykRig.spatial;s.motion={type:'hinge',min:0,max:1.2,axis};
    for(const [raw,applied]of [[-.5,0],[.6,.6],[2,1.2]]){
      f.setResidual(f.a,raw);const frame=f.frame(f.evaluate(),f.a),v=s.tip.map((n,i)=>n-s.origin[i]);
      near(frame.motionValue,applied);vectorNear(spatialPoint(frame,s.tip),turn(v,axis,applied).map((n,i)=>n+s.origin[i]));near(frame.stretch,1);
    }
  }
});

test('a curl master adds to every nested hinge without cancelling the next joint',()=>{
  const f=fixture();f.setResidual(f.master,.9);f.setResidual(f.a,-.2);f.setResidual(f.b,.15);f.setResidual(f.tip,.1);
  let g=f.evaluate();for(const [bone,residual,multiplier]of [[f.a,-.2,.8],[f.b,.15,1.1],[f.tip,.1,.7]])near(f.frame(g,bone).motionValue,.9*multiplier+residual);
  // Editing one fine joint carries its child frame but does not change the
  // child's fine residual, even though all native angles are cumulative.
  f.setResidual(f.a,.3);g=f.evaluate();near(f.frame(g,f.a).motionValue,1.02);near(f.frame(g,f.b).motionValue,1.14);near(f.frame(g,f.tip).motionValue,.73);
  f.setResidual(f.master,8);g=f.evaluate();near(f.frame(g,f.master).motionValue,1.7);near(f.frame(g,f.a).motionValue,1.2);near(f.frame(g,f.b).motionValue,1.5);near(f.frame(g,f.tip).motionValue,1);
});

test('rigid artwork below a driven hinge follows its clamped transform without compensation',()=>{
  const f=fixture(),s=f.figure.segments[f.tip.id-1];delete s._stykRig.spatial.motion;
  f.setResidual(f.master,1.7);f.setResidual(f.b,.4);f.setResidual(f.tip,0);
  const g=f.evaluate(),parent=f.frame(g,f.b),child=f.frame(g,f.tip);vectorNear(child.q,parent.q);
  vectorNear(spatialPoint(child,s._stykRig.spatial.tip),spatialPoint(parent,s._stykRig.spatial.tip));
});

test('slide drivers add their applied travel and clamp cheeks independently',()=>{
  const f=fixture();f.object.len_flag=1;f.object.lengths=f.figure.segments.map(s=>s.length);
  f.object.lengths[f.lip.id-1]=12;f.object.lengths[f.cheek.id-1]=6.4;
  let g=f.evaluate();near(f.frame(g,f.lip).motionValue,2);near(f.frame(g,f.cheek).motionValue,1);vectorNear(spatialPoint(f.frame(g,f.cheek),[20,16,0]),[20,17,0]);
  f.object.lengths[f.lip.id-1]=500;f.object.lengths[f.cheek.id-1]=10;g=f.evaluate();near(f.frame(g,f.lip).motionValue,4);near(f.frame(g,f.cheek).motionValue,2);
});

test('negative and chained drivers consume final clamped values in dependency order',()=>{
  const f=fixture();f.figure.segments[f.a.id-1]._stykRig.spatial.motion.driver.multiplier=-.8;
  f.figure.segments[f.b.id-1]._stykRig.spatial.motion.driver={joint:f.a.id,multiplier:1.5};
  f.setResidual(f.master,.5);f.setResidual(f.a,.9);f.setResidual(f.b,.1);
  let g=f.evaluate();near(f.frame(g,f.a).motionValue,.5);near(f.frame(g,f.b).motionValue,.85);
  f.setResidual(f.master,1.7);g=f.evaluate();near(f.frame(g,f.a).motionValue,0);near(f.frame(g,f.b).motionValue,.1);
  // Native record order is irrelevant; only dependency order determines a pose.
  const unordered=structuredClone(f.doc),fig=unordered.figure_types[0],o=unordered.keyframes[0].objects[0];
  fig.segments.reverse();o.angles.reverse();const mixed=geometryOfDocument(unordered).objects.get(0);
  near(mixed.segments.find(s=>s.seg.segment_id===f.b.id).spatialFrame.motionValue,.1);
});

test('axis and motion-driver definitions validate, remap, invalidate and reject cycles',()=>{
  const f=fixture(),s=f.figure.segments[f.a.id-1]._stykRig.spatial,plan=rigConstraintPlan(f.figure);
  assert.ok(plan.dependencies[f.a.id-1].includes(f.master.id-1));
  s.motion.driver.multiplier=.9;assert.notEqual(rigConstraintPlan(f.figure),plan);
  const next=rigConstraintPlan(f.figure);s.motion.axis[0]=0;s.motion.axis[2]=1;assert.notEqual(rigConstraintPlan(f.figure),next);
  const remap=new Map(f.figure.segments.map(s=>[s.segment_id,s.segment_id+100])),copy=remapSpatial(s,remap);
  assert.equal(copy.motion.driver.joint,f.master.id+100);assert.notEqual(copy.motion.axis,s.motion.axis);assert.notEqual(copy.motion.driver,s.motion.driver);
  assert.equal(sameSpatial(s,remapSpatial(s,new Map())),true);assert.equal(sameSpatial(s,{...s,motion:{...s.motion,driver:{...s.motion.driver,multiplier:1}}}),false);
  const clone=structuredClone(f.figure);for(const s of clone.segments){remapRigReferences(s,remap);s.segment_id=remap.get(s.segment_id);s.parent_id=remap.get(s.parent_id)??0;}assert.doesNotThrow(()=>rigConstraintPlan(clone));
  for(const motion of [{type:'hinge',min:1,max:0},{type:'hinge',min:0,max:1,axis:[0,0,0]},{type:'hinge',min:0,max:1,axis:[2,0,0]},{type:'hinge',min:0,max:1,axis:[NaN,0,1]},{type:'slide',min:0,max:1,axis:[1,0,0]},
    {...s.motion,driver:{joint:0,multiplier:1}},{...s.motion,driver:{joint:f.master.id,multiplier:Infinity}},{...s.motion,driver:{joint:f.root.id,multiplier:1}}]){
    const bad=structuredClone(f.doc);bad.figure_types[0].segments[f.a.id-1]._stykRig.spatial.motion=motion;assert.throws(()=>validateScene(bad));
  }
  const cycle=structuredClone(f.doc);cycle.figure_types[0].segments[f.master.id-1]._stykRig.spatial.motion.driver={joint:f.a.id,multiplier:1};assert.throws(()=>validateScene(cycle),/depend on itself/);
});

test('fine motion fields edit residuals, allow uncurling, mirror and restore history',()=>{
  const f=fixture(),e=newOwnedEditor({demo:false});e.load(f.doc);const before=e.serialize();
  e.select(1,f.master.id-1);assert.equal(e.setSpatialMotion(.9),true);
  e.select(1,f.a.id-1);let m=e.getSpatialMotion();near(m.value,0);near(m.applied,.72);near(m.min,-.72);near(m.max,.48);
  assert.equal(e.setSpatialMotion(-.2),true);near(e.getSpatialPose().bend,-.2);near(e.getSpatialMotion().applied,.52);
  assert.equal(e.setSpatialPose({bend:-10}),true);near(e.getSpatialMotion().applied,0);near(e.getSpatialMotion().value,-.72);
  e.setSpatialMotion(.3);e.select(1,f.b.id-1);near(e.getSpatialMotion().value,0);near(e.getSpatialMotion().applied,.99);
  const pose=e.getSpatialPose();e.select(1,-1);e.mirrorFigure();e.select(1,f.b.id-1);near(e.getSpatialPose().bend,pose.bend);near(e.getSpatialMotion().applied,.99);
  e.setSpatialMotion(-.15);near(e.getSpatialMotion().value,-.15);near(e.getSpatialMotion().applied,.84);
  e.select(1,f.cheek.id-1);e.setSpatialMotion(1);near(e.getSpatialMotion().value,1);
  while(e._undo.length)e.undo();assert.deepEqual(e.serialize(),before);
});

test('arbitrary-axis fine drags follow their real track, respect limits and cancel exactly',()=>{
  for(const mirror of [false,true]){
    const f=fixture(),e=newOwnedEditor({demo:false});e.load(f.doc);
    e.select(1,f.root.id-1);e.setSpatialPose({turn:.55,pitch:.25,bend:.1});e.select(1,f.master.id-1);e.setSpatialMotion(.4);
    if(mirror){e.select(1,-1);e.mirrorFigure();}
    e.select(1,f.a.id-1);const before=e.serialize(),p=e.geometry.objects.get(0).joints.get(f.a.id);
    e.setSpatialMotion(.5);const target=e.geometry.objects.get(0).joints.get(f.a.id);e.undo();
    e.beginDrag('Fine joint');assert.equal(e.poseJoint(target.x,target.y,{anchor:p}),true);near(e.getSpatialMotion().value,.5,1e-5);
    e.poseJoint(p.x,p.y,{anchor:p});near(e.getSpatialMotion().value,0,1e-5);e.cancelDrag();assert.deepEqual(e.serialize(),before);
    e.beginDrag('Fine joint');e.poseJoint(target.x+1000,target.y+1000,{anchor:p});assert.ok(e.getSpatialMotion().applied>=0&&e.getSpatialMotion().applied<=1.2);e.commitDrag();e.undo();assert.deepEqual(e.serialize(),before);
  }
});

test('driver edits invalidate their spatial subtree and match fresh geometry after undo',()=>{
  const f=fixture(),e=newOwnedEditor({demo:false});e.load(f.doc);
  const initial=e.geometry.objects.get(0).segments[f.tip.id-1].spatialFrame;
  e.select(1,f.master.id-1);e.setSpatialMotion(.6);assert.notEqual(e.geometry.objects.get(0).segments[f.tip.id-1].spatialFrame,initial);
  for(const value of [1.4,.2,.9,0]){
    e.setSpatialMotion(value);const current=e.geometry.objects.get(0),doc=e.serialize(),fresh=geometryOfDocument(doc).objects.get(0);
    for(const bone of [f.master,f.a,f.b,f.tip,f.cheek])vectorNear(current.segments[bone.id-1].spatialFrame.q,fresh.segments[bone.id-1].spatialFrame.q);
  }
  e.undo();near(e.geometry.objects.get(0).segments[f.tip.id-1].spatialFrame.motionValue,.63);
});

test('a mechanical rotation gizmo exposes its actual axis and edits only the fine residual',()=>{
  for(const axis of [[-1,0,0],[0,1,0],[Math.SQRT1_2,0,Math.SQRT1_2]])for(const mirror of [false,true]){
    const f=fixture();f.figure.segments[f.a.id-1]._stykRig.spatial.motion.axis=axis;
    const e=newOwnedEditor({demo:false});e.load(f.doc);e.select(1,f.root.id-1);e.setSpatialPose({turn:.6,pitch:.3});e.select(1,f.master.id-1);e.setSpatialMotion(.5);
    if(mirror){e.select(1,-1);e.mirrorFigure();}e.select(1,f.a.id-1);
    const g=createSpatialGizmo(e,p=>p);assert.equal(g.rings.length,1);near(g.motion.applied,.4);
    assert.equal(startRotationGizmo(g,g.center),null);assert.equal(startRotationGizmo(g,{x:g.center.x+59,y:g.center.y}),null);
    const ring=g.rings[0],p=ringPoint(ring,0),point={x:g.center.x+p[0],y:g.center.y+p[1]};
    const drag={g,point,previous:g.pose,mode:'axis',ring,last:0,total:0,edge:false},t=.3,target=ringPoint(ring,t);
    const before=e.serialize();e.beginDrag('Hinge ring');e.setSpatialPose(rotateGizmo(drag,{x:g.center.x+target[0],y:g.center.y+target[1]}));near(e.getSpatialMotion().value,t);near(e.getSpatialMotion().applied,.7);
    e.setSpatialPose(rotateGizmo(drag,point));near(e.getSpatialMotion().value,0);e.cancelDrag();assert.deepEqual(e.serialize(),before);
    const normal=[ring.u[1]*ring.v[2]-ring.u[2]*ring.v[1],ring.u[2]*ring.v[0]-ring.u[0]*ring.v[2],ring.u[0]*ring.v[1]-ring.u[1]*ring.v[0]];
    near(Math.hypot(...normal),1);
  }
  const f=fixture(),e=newOwnedEditor({demo:false});e.load(f.doc);e.select(1,f.lip.id-1);assert.equal(createSpatialGizmo(e,p=>p),null);
});

test('driven hinges tween through ordinary angle channels without jumps or backward bends',()=>{
  const f=fixture(),start=structuredClone(f.doc.keyframes[0]);f.setResidual(f.master,1.7);f.setResidual(f.a,.2);f.setResidual(f.b,-.1);const end=structuredClone(f.doc.keyframes[0]);
  // The first pose lasts 120 ticks: the inbetweens are the ticks.
  start.duration_raw=120;
  const tweenDoc={...f.doc,keyframes:[start,end],auto_easing:false},tween=ownedEditorFor({demo:false},tweenDoc);let previous=null;
  for(let tick=0;tick<=120;tick++){
    tween.seek(tick);const g=tween.geometry.objects.get(0);
    const p=spatialPoint(f.frame(g,f.tip),[ -10,70,0]);
    for(const b of [f.a,f.b,f.tip]){const value=f.frame(g,b).motionValue,m=f.figure.segments[b.id-1]._stykRig.spatial.motion;assert.ok(value>=m.min-1e-9&&value<=m.max+1e-9);}
    if(previous)assert.ok(Math.hypot(...p.map((v,i)=>v-previous[i]))<2,'small uniform tween step');previous=p;
  }
});

test('axis and driven residuals survive a native round trip without another pose store',async()=>{
  const f=fixture();f.setResidual(f.master,.7);f.setResidual(f.b,-.1);const {document}=await decodeDocument(await buildContainerV2(f.doc,'styk'),'styk');
  assert.deepEqual(document.figure_types,f.doc.figure_types);assert.deepEqual(document.keyframes[0].objects[0].angles,f.object.angles);assert.equal(document.keyframes[0].objects[0]._stykMotion,undefined);
  const old=f.evaluate(),fresh=geometryOfDocument(document).objects.get(0);vectorNear(f.frame(fresh,f.tip).q,f.frame(old,f.tip).q);
});
