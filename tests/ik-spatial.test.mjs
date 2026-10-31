import test from 'node:test';
import assert from 'node:assert/strict';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject,createFrame,emptyDocument} from '../src/demo.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

import {spatialPoint,quatRotate,quatMultiply,spatialQuaternion} from '../src/rig-spatial.mjs';
import {animationRotation} from '../src/animation-origin.mjs';
import {validateIK} from '../src/ik.mjs';
import {spatialControlsView} from './support/control-views.mjs';
const inverseQuaternion=q=>[-q[0],-q[1],-q[2],q[3]];
/** A figure-space vector in the world, under the figure's turn and mirror. */
function spatialWorldVector(v,figure,object,inverse=false){
 const a=animationRotation(figure,object),c=Math.cos(a),s=Math.sin(a),m=object.image_text_flags?-1:1;
 return inverse?[v[0]*c+v[1]*s,(-v[0]*s+v[1]*c)*m,v[2]]:[v[0]*c-v[1]*m*s,v[0]*s+v[1]*m*c,v[2]];
}
/** A figure-space orientation in the world, under the figure's turn and mirror. */
function spatialWorldQuaternion(q,figure,object,inverse=false){
 const a=animationRotation(figure,object),reflect=v=>object.image_text_flags?[-v[0],v[1],-v[2],v[3]]:v;
 return inverse?reflect(quatMultiply(spatialQuaternion(-a,0,0),q)):quatMultiply(spatialQuaternion(a,0,0),reflect(q));
}
/** `setup(editor, ids)` edits the document through an editor the engine owns: the editor the test uses opens the document it leaves. */
function fixture(setup){
 const q=construction();q.add(0,0,0,'Figure rotation');
 const bone=(parent,origin,tip,name)=>{const turn=q.add(0,0,0,name+' turn'),pitch=q.add(0,0,0,name+' tilt'),v=tip.map((n,i)=>n-origin[i]);return q.add(parent,Math.hypot(...v),Math.atan2(v[1],v[0]),name,{control:true,rig:{spatial:{parent,origin,tip,turn,pitch}}});};
 const body=bone(0,[0,0,0],[0,0,0],'Body'),upper=bone(body,[0,0,0],[0,90,15],'Thigh'),lower=bone(upper,[0,90,15],[0,170,0],'Shin'),foot=bone(lower,[0,170,0],[0,185,35],'Foot'),toe=bone(foot,[0,185,35],[0,185,50],'Toe');
 const f={figure_type_id:1,segments:q.segments,polyfills:[],image_assets:[],text_assets:[]},document={...emptyDocument(),figure_types:[f],keyframes:[createFrame([createObject(f,1,200,100)])]},ids={body,upper,lower,foot,toe};
 if(setup){const plain=ownedEditorFor({demo:false, layerTimeline:true},document);setup(plain,ids);return{e:ownedEditorFor({demo:false, layerTimeline:true},plain.serialize()),...ids};}
 return{e:ownedEditorFor({demo:false, layerTimeline:true},document),...ids};
}
const near=(a,b,t=.003)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
function state(e,id){const g=e.geometry.objects.get(0),s=g.segments[id-1];return {q:spatialWorldQuaternion(s.spatialFrame.q,e.figure,e.object),p:spatialPoint(s.spatialFrame,s.seg._stykRig.spatial.tip),end:s.end};}
function sameOrientation(a,b){near(Math.abs(a.reduce((n,v,i)=>n+v*b[i],0)),1,1e-6);}
test('carrying a spatial pin preserves depth, orientation and the displayed limb',()=>{
 for(const mirror of [false,true]){
  const{e,lower,foot,toe}=fixture();e.select(1);if(mirror)e.mirrorFigure();
  e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});
  e.poseJoint(215,245);e.select(1);const before=[lower,foot,toe].map(id=>state(e,id));
  const spatial=structuredClone(e.object._stykIK[lower].spatialTarget);
  e.beginTranslationDrag();e.moveSelection(35,-22,{fromStart:true,movePins:true});e.commitDrag();
  [lower,foot,toe].forEach((id,i)=>{const next=state(e,id);near(next.end.x,before[i].end.x+35);near(next.end.y,before[i].end.y-22);near(next.p[2],before[i].p[2]);sameOrientation(next.q,before[i].q);});
  assert.deepEqual(e.object._stykIK[lower].spatialTarget,spatial);assert.equal(e.object._stykIK[lower].pinned,true);
 }
});
test('planted feet retain depth and all three orientation axes through hip movement and body turns',()=>{
 for(const mirror of [false,true]){
  const{e,body,lower,foot,toe}=fixture();e.select(1,-1);if(mirror)e.mirrorFigure();
  e.select(1,foot-1);e.setSpatialPose({turn:.4,pitch:-.25,bend:.1});e.select(1,toe-1);e.setSpatialPose({pitch:.2});
  e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0,chainLength:2});
  const ankle=state(e,lower),before=state(e,foot),toeBefore=state(e,toe),saved=e.serialize();
  e.select(1,-1);e.moveSelection(18,20);e.select(1,body-1);e.setSpatialPose({turn:1.4,pitch:.25,bend:.2});
  const next=state(e,foot),target=state(e,lower);near(target.end.x,ankle.end.x);near(target.end.y,ankle.end.y);near(target.p[2],ankle.p[2]);sameOrientation(next.q,before.q);sameOrientation(state(e,toe).q,toeBefore.q);
  e.undo();e.undo();assert.deepEqual(e.serialize(),saved);
 }
});
test('a pinned foot can still be rotated directly; unpinning and repinning do not jump',()=>{
 const{e,lower,foot}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});e.select(1,-1);e.moveSelection(0,20);
 e.select(1,foot-1);const p=e.getSpatialPose();e.setSpatialPose({pitch:p.pitch+.6,turn:p.turn+.7});near(e.getSpatialPose().pitch,p.pitch+.6,1e-6);near(e.getSpatialPose().turn,p.turn+.7,1e-6);
 const before=state(e,foot);e.select(1,lower-1);e.setNodeIK({pinned:false});sameOrientation(state(e,foot).q,before.q);e.setNodeIK({pinned:true});sameOrientation(state(e,foot).q,before.q);
 const copy=ownedEditorFor({demo:false},e.serialize());copy.select(1,lower-1);sameOrientation(state(copy,foot).q,before.q);
});
test('knee swivel changes the bend plane while keeping foot position and orientation',()=>{
 const{e,lower,upper,foot}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});e.poseJoint(215,245);
 const knee=state(e,upper),before=state(e,foot),ankle=state(e,lower);e.setNodeIK({swivel:1.2});assert.ok(Math.hypot(...state(e,upper).p.map((v,i)=>v-knee.p[i]))>10);
 near(state(e,lower).end.x,ankle.end.x);near(state(e,lower).end.y,ankle.end.y);sameOrientation(state(e,foot).q,before.q);
});
test('spatial targets reject invalid orientations',()=>{
 const{e,lower}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});const b=structuredClone(e.object),c=b._stykIK[lower];
 c.spatialTarget.depth=Infinity;assert.throws(()=>validateIK(b),/spatial IK/);c.spatialTarget.depth=0;c.spatialFollowers[99]=[0,0,0,2];assert.throws(()=>validateIK(b),/spatial IK/);
});
test('planting both feet is one undoable edit and retains selection',()=>{
 const{e,lower,foot}=fixture((plain,{foot})=>{plain.figure.segments[foot-1].name='Left foot ankle';});e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:false,bendDirection:0});e.select(1,-1);
 const count=e._undo.length,old=e.serialize();assert.equal(e.setSpatialFeetPinned(true),true);assert.equal(e.selectedJoint,-1);assert.equal(e._undo.length,count+1);assert.equal(e.object._stykIK[lower].pinned,true);e.undo();assert.deepEqual(e.serialize(),old);
});

test('direct shin rotation releases that limb and carries the ankle and toes without a pose jump',()=>{
 for(const mirror of [false,true]){
  const{e,lower,foot,toe}=fixture();e.select(1,-1);if(mirror)e.mirrorFigure();
  e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});
  const target=state(e,lower).end;e.poseJoint(target.x+20,target.y+(mirror?25:-25));
  const shin=state(e,lower),boot=state(e,foot),tip=state(e,toe),pose=e.getSpatialPose(),saved=e.serialize();
  e.setSpatialPose({turn:pose.turn+.6,pitch:pose.pitch+.35});
  assert.equal(e.object._stykIK[lower].pinned,false);
  const delta=quatMultiply(state(e,lower).q,inverseQuaternion(shin.q));
  sameOrientation(state(e,foot).q,quatMultiply(delta,boot.q));sameOrientation(state(e,toe).q,quatMultiply(delta,tip.q));
  e.undo();assert.deepEqual(e.serialize(),saved);
 }
});

test('native angle edits carry the foot, while a no-op spatial edit leaves its pin intact',()=>{
 const{e,lower,foot}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});e.poseJoint(220,245);
 const old=e.serialize(),count=e._undo.length,shin=state(e,lower),boot=state(e,foot);
 assert.equal(e.setSpatialPose(e.getSpatialPose()),false);assert.equal(e.object._stykIK[lower].pinned,true);assert.equal(e._undo.length,count);
 e.rotateJoint(.35);assert.equal(e.object._stykIK[lower].pinned,false);
 const delta=quatMultiply(state(e,lower).q,inverseQuaternion(shin.q));sameOrientation(state(e,foot).q,quatMultiply(delta,boot.q));
 e.undo();assert.deepEqual(e.serialize(),old);
});

test('target depth and full knee orbits preserve planted orientation or the free ankle articulation',()=>{
 for(const pinned of [false,true]){
  const{e,lower,foot}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned,bendDirection:0});e.poseJoint(215,235);
  const boot=state(e,foot),shin=state(e,lower);e.setSpatialIKTarget({depth:35});near(state(e,lower).p[2],35);near(state(e,lower).end.x,215);near(state(e,lower).end.y,235);
  sameOrientation(state(e,foot).q,pinned?boot.q:quatMultiply(quatMultiply(state(e,lower).q,inverseQuaternion(shin.q)),boot.q));const before=state(e,lower),footBefore=state(e,foot);
  // Separate edits and a single continuous gesture must agree. Neither can
  // repeatedly add the previously displayed swivel to the new value.
  for(const angle of [Math.PI/2,Math.PI,Math.PI*1.5,Math.PI*2])e.setNodeIK({swivel:angle});
  sameOrientation(state(e,lower).q,before.q);sameOrientation(state(e,foot).q,footBefore.q);
  e.beginDrag('Orbit knee');for(let i=0;i<=72;i++)e.setSpatialIKTarget({swivel:i*Math.PI/36});e.commitDrag();
  sameOrientation(state(e,lower).q,before.q);assert.equal(e.object._stykIK[lower].pinned,pinned);
  const saved=e.serialize();e.beginDrag('Depth');e.setSpatialIKTarget({depth:-30});e.cancelDrag();assert.deepEqual(e.serialize(),saved);
 }
});

test('dragging a planted knee steers the existing pole and retains the foot',()=>{
 const{e,upper,lower,foot}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});e.poseJoint(215,245);
 const before=e.serialize(),ankle=state(e,lower),boot=state(e,foot),knee=state(e,upper);e.select(1,upper-1);
 e.beginDrag('Pose knee');e.poseJoint(knee.end.x+60,knee.end.y-20);
 assert.equal(e.selectedJoint,upper-1);assert.equal(e.object._stykIK[lower].pinned,true);
 assert.ok(Math.hypot(...state(e,upper).p.map((v,i)=>v-knee.p[i]))>5);
 near(state(e,lower).end.x,ankle.end.x);near(state(e,lower).end.y,ankle.end.y);sameOrientation(state(e,foot).q,boot.q);
 e.cancelDrag();assert.deepEqual(e.serialize(),before);
});

test('whole-figure orientation rigidly carries planted ankles, poles and boots with undo and cancellation',()=>{
 for(const mirror of [false,true])for(const scale of [1.4,.8]){
  const{e,body,upper,lower,foot,toe}=fixture(plain=>{plain.select(1,-1);plain.updateObject({scale});if(mirror)plain.mirrorFigure();});
  e.select(1,-1);
  e.select(1,foot-1);e.setSpatialPose({turn:.3,pitch:.2});
  e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});
  e.rotateIKTarget(.25);const p=state(e,lower).end;e.poseJoint(p.x+12,p.y-15*scale);
  const position=id=>{const g=e.geometry.objects.get(0),p=spatialWorldVector(state(e,id).p,e.figure,e.object);return[p[0]*scale+g.root.x,p[1]*scale+g.root.y,p[2]*scale];};
  const ids=[upper,lower,foot,toe],before=ids.map(id=>({p:position(id),q:state(e,id).q})),saved=e.serialize(),base=state(e,body).q,root=e.geometry.objects.get(0).root;
  e.select(1,body-1);e.beginDrag('Orient figure');
  for(const turn of [.4,1.1,-.6]){
   e.setSpatialPose({turn,pitch:.3,bend:.2},{wholeFigure:true});const delta=quatMultiply(state(e,body).q,inverseQuaternion(base));
   ids.forEach((id,i)=>{const expected=quatRotate(delta,[before[i].p[0]-root.x,before[i].p[1]-root.y,before[i].p[2]]),actual=position(id);expected[0]+=root.x;expected[1]+=root.y;actual.forEach((v,j)=>near(v,expected[j],.005));sameOrientation(state(e,id).q,quatMultiply(delta,before[i].q));});
   assert.equal(e.object._stykIK[lower].pinned,true);validateIK(e.object);
  }
  e.cancelDrag();assert.deepEqual(e.serialize(),saved);
  e.setSpatialPose({turn:.8},{wholeFigure:true});const reopened=ownedEditorFor({demo:false},e.serialize());sameOrientation(state(reopened,foot).q,state(e,foot).q);
  e.undo();assert.deepEqual(e.serialize(),saved);
 }
});

test('depth drags swing a spatial bone in 3D at constant length; Shift mirrors its depth side',()=>{
 for(const mirror of [false,true]){
  const{e,body,upper,foot}=fixture();e.select(1,-1);if(mirror)e.mirrorFigure();
  e.select(1,body-1);e.setSpatialPose({turn:.3});e.select(1,upper-1);
  const start={...e.geometry.objects.get(0).segments[upper-1].start},saved=e.serialize(),before=state(e,upper),boot=state(e,foot);
  const bone=()=>{const s=e.geometry.objects.get(0).segments[upper-1],f=s.spatialFrame,r=s.seg._stykRig.spatial;return spatialWorldVector(spatialPoint(f,r.tip).map((v,i)=>v-spatialPoint(f,r.origin)[i]),e.figure,e.object).map(v=>v*e.object.scale);};
  const full=Math.hypot(...bone());
  e.beginDrag('Pose thigh');
  // Pulled toward its base the thigh leaves the view plane toward the front.
  const inside={x:start.x+full*.35,y:start.y+full*.3};e.poseJoint(inside.x,inside.y,{depth:true});
  let s=e.geometry.objects.get(0).segments[upper-1];near(s.end.x,inside.x,1e-3);near(s.end.y,inside.y,1e-3);near(Math.hypot(...bone()),full,1e-6);
  const front=bone()[2];assert.ok(Math.abs(front)>full*.5);
  e.poseJoint(inside.x,inside.y,{depth:true,alternate:true});s=e.geometry.objects.get(0).segments[upper-1];
  near(s.end.x,inside.x,1e-3);near(s.end.y,inside.y,1e-3);near(bone()[2],-front,1e-6);
  // Beyond its reach the bone lies in the view plane and points at the cursor.
  e.poseJoint(start.x-full*3,start.y,{depth:true});near(bone()[2],0,1e-6);near(Math.hypot(...bone()),full,1e-6);
  // Returning to the grab point restores every axis, including twist.
  e.poseJoint(before.end.x,before.end.y,{depth:true});sameOrientation(state(e,upper).q,before.q);sameOrientation(state(e,foot).q,boot.q);
  e.cancelDrag();assert.deepEqual(e.serialize(),saved);
 }
});

test('pose drags turn a spatial bone flat on screen, keeping its depth lean and twist',()=>{
 for(const mirror of [false,true]){
  const{e,body,upper,foot}=fixture();e.select(1,-1);if(mirror)e.mirrorFigure();
  e.select(1,body-1);e.setSpatialPose({turn:.3});e.select(1,upper-1);e.setSpatialPose({turn:.5,pitch:.4});
  const s0=e.geometry.objects.get(0).segments[upper-1],start={...s0.start},saved=e.serialize(),before=state(e,upper),boot=state(e,foot);
  const bone=()=>{const s=e.geometry.objects.get(0).segments[upper-1],f=s.spatialFrame,r=s.seg._stykRig.spatial;return spatialWorldVector(spatialPoint(f,r.tip).map((v,i)=>v-spatialPoint(f,r.origin)[i]),e.figure,e.object).map(v=>v*e.object.scale);};
  const lean=bone()[2],radius=Math.hypot(before.end.x-start.x,before.end.y-start.y);assert.ok(Math.abs(lean)>5,'the thigh leans out of the view plane');
  e.beginDrag('Pose thigh');
  // The end follows the pointer around the joint's base at its projected length.
  for(const angle of [.6,-1.3,2.4]){
   const a=Math.atan2(before.end.y-start.y,before.end.x-start.x)+angle,to={x:start.x+Math.cos(a)*radius*1.7,y:start.y+Math.sin(a)*radius*1.7};
   e.poseJoint(to.x,to.y);const s=e.geometry.objects.get(0).segments[upper-1];
   near(s.end.x,start.x+Math.cos(a)*radius,1e-3);near(s.end.y,start.y+Math.sin(a)*radius,1e-3);near(bone()[2],lean,1e-6);
   // Only a view-axis rotation is applied, and the child turns rigidly with the thigh.
   const turn=quatMultiply(state(e,upper).q,inverseQuaternion(before.q));near(Math.abs(turn[0])+Math.abs(turn[1]),0,1e-6);
   sameOrientation(state(e,foot).q,quatMultiply(turn,boot.q));
  }
  e.poseJoint(before.end.x,before.end.y);sameOrientation(state(e,upper).q,before.q);sameOrientation(state(e,foot).q,boot.q);
  e.cancelDrag();assert.deepEqual(e.serialize(),saved);
 }
});

test('flat pose drags never jump on grab; Ctrl stretches; the depth key switches mid-drag without a jump',()=>{
 const{e,upper}=fixture();e.select(1,upper-1);e.setSpatialPose({turn:.4});
 const before=state(e,upper),start={...e.geometry.objects.get(0).segments[upper-1].start},grab={x:before.end.x+6,y:before.end.y-4},saved=e.serialize();
 const length=()=>e.object.len_flag?e.object.lengths[upper-1]:e.figure.segments[upper-1].length,rest=length();
 e.beginDrag('Pose thigh');e.poseJoint(grab.x,grab.y,{anchor:grab,pixel:1});sameOrientation(state(e,upper).q,before.q);
 // Stretching keeps the end under a pointer grabbed at the end.
 e.cancelDrag();e.beginDrag('Stretch thigh');
 e.poseJoint(start.x+(before.end.x-start.x)*1.5,start.y+(before.end.y-start.y)*1.5,{stretch:true});near(length(),rest*1.5,1e-6);sameOrientation(state(e,upper).q,before.q);
 e.cancelDrag();assert.deepEqual(e.serialize(),saved);
 e.beginDrag('Pose thigh');const p={x:before.end.x+20,y:before.end.y+10};e.poseJoint(p.x,p.y,{anchor:before.end});
 const flat=state(e,upper);e.poseJoint(p.x,p.y,{anchor:before.end,depth:true});sameOrientation(state(e,upper).q,flat.q);
 e.poseJoint(p.x+15,p.y-25,{anchor:before.end,depth:true});const deep=state(e,upper);assert.ok(Math.abs(Math.abs(quatMultiply(deep.q,inverseQuaternion(flat.q))[3])-1)>1e-4);
 e.poseJoint(p.x+15,p.y-25,{anchor:before.end});sameOrientation(state(e,upper).q,deep.q);
 e.cancelDrag();assert.deepEqual(e.serialize(),saved);
});

test('right-drag twists a spatial bone about its own axis without moving its end',()=>{
 const{e,upper,foot}=fixture();e.select(1,upper-1);e.setSpatialPose({turn:.2,pitch:.3});
 const saved=e.serialize(),before=state(e,upper),boot=state(e,foot);
 e.beginDrag('Twist thigh');e.bendJoint(100,100,{pixel:1});e.bendJoint(220,140,{pixel:1});
 near(state(e,upper).p[0],before.p[0],1e-6);near(state(e,upper).p[1],before.p[1],1e-6);near(state(e,upper).p[2],before.p[2],1e-6);
 const turned=state(e,foot).q;assert.ok(Math.abs(Math.abs(turned.reduce((n,v,i)=>n+v*boot.q[i],0))-1)>1e-3);
 // A quarter turn per 120 pixels; returning restores the pose exactly.
 e.bendJoint(100,60,{pixel:1});sameOrientation(state(e,foot).q,boot.q);
 e.cancelDrag();assert.deepEqual(e.serialize(),saved);
});

test('Shift-drag on a spatial IK target pushes its depth while it stays under the pointer',()=>{
 const{e,lower}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:true,bendDirection:0});e.poseJoint(215,245);
 const saved=e.serialize(),screen={...state(e,lower).end},depth=e.object._stykIK[lower].spatialTarget.depth;
 e.beginDrag('Depth');e.poseJoint(screen.x,screen.y,{alternate:true,pixel:1});e.poseJoint(screen.x+30,screen.y+20,{alternate:true,pixel:1});
 assert.ok(e.object._stykIK[lower].spatialTarget.depth>depth+1);near(state(e,lower).end.x,screen.x,1e-3);near(state(e,lower).end.y,screen.y,1e-3);
 e.cancelDrag();assert.deepEqual(e.serialize(),saved);
});

test('anchored depth drags never jump on grab and short bones use a longer virtual lever',()=>{
 const{e,foot}=fixture();e.select(1,foot-1);
 const saved=e.serialize(),before=state(e,foot),grab={x:before.end.x+4,y:before.end.y-3};
 e.beginDrag('Pose foot');e.poseJoint(grab.x,grab.y,{anchor:grab,depth:true,pixel:1});sameOrientation(state(e,foot).q,before.q);
 // The foot is ~38 units long; with a 70-unit lever its end moves less than the pointer.
 e.poseJoint(grab.x,grab.y+20,{anchor:grab,depth:true,pixel:1});const moved=Math.hypot(state(e,foot).end.x-before.end.x,state(e,foot).end.y-before.end.y);
 assert.ok(moved>2&&moved<20,`${moved}`);
 e.poseJoint(grab.x,grab.y,{anchor:grab,depth:true,pixel:1});sameOrientation(state(e,foot).q,before.q);
 e.cancelDrag();assert.deepEqual(e.serialize(),saved);
});

test('limb IK can be switched off and on from the rig panel; off, the end drag swings only its bone',()=>{
 const{e,upper,lower}=fixture();e.select(1,lower-1);e.setNodeIK({enabled:true,pinned:false,bendDirection:0,chainLength:2});
 assert.match(spatialControlsView(e),/id="spatial-ik"[^>]*checked/);
 e.setNodeIK({enabled:false});const view=spatialControlsView(e);
 assert.match(view,/id="spatial-ik"/);assert.doesNotMatch(view,/id="spatial-ik"[^>]*checked/);assert.doesNotMatch(view,/spatial-pin/);
 const thigh=state(e,upper),shin=e.geometry.objects.get(0).segments[lower-1];
 e.beginDrag('Pose shin');e.poseJoint(shin.end.x+25,shin.end.y-10);e.commitDrag();
 sameOrientation(state(e,upper).q,thigh.q);assert.ok(Math.hypot(state(e,lower).end.x-shin.end.x,state(e,lower).end.y-shin.end.y)>5);
 e.setNodeIK({enabled:true,pinned:false});assert.equal(e.object._stykIK[lower].pinned,false);assert.match(spatialControlsView(e),/id="spatial-ik"[^>]*checked/);
});

function turnedLeg(pinned){
 const{e,body,upper,lower,foot}=fixture();e.select(1,body-1);e.setSpatialPose({turn:1.2},{wholeFigure:true});
 e.select(1,lower-1);e.setNodeIK({enabled:true,pinned,bendDirection:0});return{e,upper,lower,foot};
}
const leg=(e,upper,lower)=>{const g=e.geometry.objects.get(0),t=g.segments[upper-1],s=g.segments[lower-1];return{hip:t.start,knee:t.end,ankle:s.end,lean:state(e,upper).p[2]-spatialPoint(t.spatialFrame,t.seg._stykRig.spatial.origin)[2]};};

test('hand and foot drags bend the limb flat on screen, each bone keeping its lean, free or planted',()=>{
 for(const pinned of [false,true]){
  const{e,upper,lower}=turnedLeg(pinned),before=leg(e,upper,lower),saved=e.serialize();
  const thigh=l=>Math.hypot(l.knee.x-l.hip.x,l.knee.y-l.hip.y),reach=thigh(before);
  e.beginDrag('Move foot');
  for(const[dx,dy]of[[0,-40],[25,-70],[-30,-20]]){
   const p={x:before.ankle.x+dx,y:before.ankle.y+dy};e.poseJoint(p.x,p.y,{pixel:1});const now=leg(e,upper,lower);
   near(now.ankle.x,p.x,1e-3);near(now.ankle.y,p.y,1e-3);
   // The knee moves across the screen: the thigh keeps its screen length and its lean.
   near(thigh(now),reach,1e-3);near(now.lean,before.lean,1e-6);assert.equal(e.object._stykIK[lower].pinned,pinned);
  }
  e.poseJoint(before.ankle.x,before.ankle.y,{pixel:1});const back=leg(e,upper,lower);near(back.knee.x,before.knee.x,1e-3);near(back.knee.y,before.knee.y,1e-3);
  e.cancelDrag();assert.deepEqual(e.serialize(),saved);
 }
});

test('right-drag turns a planted foot at its ankle and swings a planted knee without releasing the plant',()=>{
 const{e,upper,lower,foot}=turnedLeg(true),rest=leg(e,upper,lower).ankle;
 // Bend the knee first so swinging it moves it visibly.
 e.beginDrag('Lift foot');e.poseJoint(rest.x+10,rest.y-30,{pixel:1});e.commitDrag();
 const before=leg(e,upper,lower),boot=state(e,foot),saved=e.serialize(),swivel=e.object._stykIK[lower].spatialTarget.swivel;
 e.beginDrag('Turn foot');e.bendJoint(100,100,{pixel:1});e.bendJoint(220,100,{pixel:1});
 let now=leg(e,upper,lower);near(now.ankle.x,before.ankle.x,1e-3);near(now.ankle.y,before.ankle.y,1e-3);near(now.knee.x,before.knee.x,1e-3);
 assert.ok(1-Math.abs(state(e,foot).q.reduce((n,v,i)=>n+v*boot.q[i],0))>.05,'the foot turns');assert.equal(e.object._stykIK[lower].pinned,true);
 e.commitDrag();const turned=state(e,foot);
 // The turn is stored with the plant, so it survives moving the hips.
 e.select(1,-1);e.moveSelection(12,6);sameOrientation(state(e,foot).q,turned.q);assert.equal(e.object._stykIK[lower].pinned,true);
 e.undo();e.undo();assert.deepEqual(e.serialize(),saved);
 e.select(1,upper-1);e.beginDrag('Swing knee');e.bendJoint(100,100,{pixel:1});e.bendJoint(160,100,{pixel:1});
 now=leg(e,upper,lower);near(now.ankle.x,before.ankle.x,1e-3);near(now.ankle.y,before.ankle.y,1e-3);sameOrientation(state(e,foot).q,boot.q);
 near(Math.abs(e.object._stykIK[lower].spatialTarget.swivel-swivel),Math.PI/4,1e-9);assert.ok(Math.hypot(now.knee.x-before.knee.x,now.knee.y-before.knee.y)>1,'the knee swings');
 assert.equal(e.object._stykIK[lower].pinned,true);e.cancelDrag();assert.deepEqual(e.serialize(),saved);
});

test('after a depth push, a plain foot drag continues from the foot instead of jumping to the pointer',()=>{
 const{e,upper,lower}=turnedLeg(false),start=leg(e,upper,lower).ankle;
 e.beginDrag('Move foot');e.poseJoint(start.x,start.y,{pixel:1,depth:true});e.poseJoint(start.x,start.y+40,{pixel:1,depth:true});
 const pushed=leg(e,upper,lower);e.poseJoint(start.x,start.y+40,{pixel:1});const resumed=leg(e,upper,lower);
 near(resumed.ankle.x,pushed.ankle.x,1e-3);near(resumed.ankle.y,pushed.ankle.y,1e-3);near(resumed.knee.x,pushed.knee.x,1e-3);
 e.poseJoint(start.x+15,start.y+30,{pixel:1});near(leg(e,upper,lower).ankle.x,pushed.ankle.x+15,1e-3);near(leg(e,upper,lower).ankle.y,pushed.ankle.y-10,1e-3);
 e.cancelDrag();
});
