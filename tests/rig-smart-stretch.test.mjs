import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry,buildGeometryAsync} from '../src/pivot/geometry.mjs';
import {rigConstraintPlan} from '../src/rig-constraints.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`);
const at=(e,id)=>{e.select(1,e.figure.segments.findIndex(s=>s.segment_id===id));return e;};
const geometry=e=>e.geometry.objects.get(0);
const shape=(e,id)=>geometry(e).segments.find(s=>s.seg.segment_id===id);
const length=(e,n)=>at(e,1).updateSegment({length:n});
function fixture(){
  const segments=[[1,0,100,0],[2,1,50,Math.PI/4],[3,2,30,Math.PI/2],[4,0,240,0]].map(([id,parent,len,angle])=>({segment_id:id,parent_id:parent,length:len,angle_rad:angle,bend_rad:0,thickness:6,primitive_code:0,aux_code:0,flags:0,segment_type:'line',segment_kind:'line',color_rgb:[13,153,255],transparency:0,visible:true,z_order:id}));
  const f={figure_type_id:1,name:'Impulse fixture',segments,segment_count:4,polyfills:[],image_assets:[],text_assets:[]};
  const e=new Editor({demo:false});e.load({version:5,canvas_width:640,canvas_height:460,fps:24,auto_easing:false,auto_easing_disabled_raw:1,figure_types:[f],backgrounds:[],keyframes:[createFrame([createObject(f,1,100,100)],1)]});
  at(e,1).enableSmartStretch(true);return e;
}

test('signed linear multipliers deform axial components, with continuous zero crossing',()=>{
  const e=fixture();at(e,2).setRigBehavior({response:{multiplier:2}});
  for(const ratio of [1,.5,.500001,.499999,0,2]){
    length(e,100*ratio);const s=shape(e,2),x=50/Math.sqrt(2)*(2*ratio-1),y=50/Math.sqrt(2);
    near(s.end.x-s.start.x,x);near(s.end.y-s.start.y,y);near(s.length,Math.hypot(x,y));
  }
  at(e,2).setRigBehavior({response:{multiplier:-1}});length(e,50);
  near(shape(e,2).end.x-shape(e,2).start.x,75/Math.sqrt(2));
});
test('reset impulse restarts the axis at this joint and propagates it to descendants',()=>{
  const e=fixture();at(e,2).setRigBehavior({response:{reset:true}});length(e,50);
  near(shape(e,2).length,25);near(shape(e,2).angle,Math.PI/4);
  // A vertical vector projected in a 45-degree reset space becomes (-7.5,22.5).
  near(shape(e,3).end.x-shape(e,3).start.x,-7.5);near(shape(e,3).end.y-shape(e,3).start.y,22.5);
});
test('rigid exceptions pass impulses while stop removes deformation from the whole branch',()=>{
  const e=fixture();at(e,3).setRigBehavior({response:{reset:true}});at(e,2).setRigBehavior({response:{mode:'rigid'}});length(e,50);
  near(shape(e,2).length,50);near(shape(e,3).length,15);
  at(e,2).setRigBehavior({response:{mode:'stop'}});near(shape(e,2).length,50);near(shape(e,3).length,30);
  e.undo();near(shape(e,3).length,15);e.redo();near(shape(e,3).length,30);
});
test('newly drawn chains inherit stretching and retain the exact drawn dimensions',()=>{
  const e=fixture();length(e,50);at(e,2);
  const added=e.addSegments([{length:40,angle:.4},{length:20,angle:.8}]);
  near(shape(e,added[0].segment_id).length,40);near(shape(e,added[1].segment_id).length,20);
  assert.equal(rigConstraintPlan(e.figure).inputs.at(-1).driver,0);
  length(e,100);assert.ok(Math.abs(shape(e,added[0].segment_id).length-40)>20);
});
test('a new independent driver restarts its own scope without doubling the parent stretch',()=>{
  const e=fixture();at(e,2).enableSmartStretch(true);length(e,50);near(shape(e,2).length,50);near(shape(e,3).length,30);
});
test('connector distance, slider and combined sources keep both anchors connected',()=>{
  const e=fixture();const c=e.addConnector(1,4);at(e,c.segment_id).enableSmartStretch(true);
  e.addSegment({parentId:c.segment_id,length:20,angle:0});const detail=e.figure.segments.at(-1).segment_id;
  at(e,c.segment_id).setRigBehavior({stretch:{source:'slide',restPosition:.5}});
  at(e,c.segment_id).setConnectorPosition(.25);near(shape(e,detail).length,10);
  length(e,50);near(shape(e,detail).length,5); // incoming .5 × slide .5
  const span=shape(e,c.segment_id);near(span.start.x,shape(e,1).end.x);near(span.end.x,shape(e,4).end.x);
  at(e,c.segment_id).setRigBehavior({stretch:{source:'combined'}});
  near(shape(e,detail).length,20*.5*.5*(190/140));
  at(e,c.segment_id).setRigBehavior({response:{mode:'rigid'}});
  near(shape(e,detail).length,20*.5*(190/140));
});
test('world angle lock survives ancestor rotations and does not bake into editable pose',()=>{
  const e=fixture();at(e,2).setAngleLock('world');const angle=shape(e,2).angle,childAngle=shape(e,3).angle;
  const before=e.serialize();at(e,1).rotateJoint(.8);near(shape(e,2).angle,angle);near(shape(e,3).angle,childAngle);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();near(shape(e,2).angle,angle);
  at(e,2);const s=shape(e,2);e.beginDrag();e.poseJoint(s.start.x+20,s.start.y+90);e.commitDrag();near(shape(e,2).angle,angle);
});
test('bending a connector does not invent an anchor-distance stretch impulse',()=>{
  const e=fixture(),c=e.addConnector(1,4);at(e,c.segment_id).enableSmartStretch(true);
  const detail=e.addSegment({parentId:c.segment_id,length:20,angle:0});at(e,c.segment_id).updateSegment({bend_rad:Math.PI});
  near(shape(e,detail.segment_id).length,20);
});
test('relative lock skips static parents and follows whole-figure rotation',()=>{
  const e=fixture();e.figure.segments[1].aux_code=1;at(e,3).setAngleLock('parent');
  assert.equal(e.figure.segments[2]._stykRig.angleLock.reference,1);
  at(e,3).setRigBehavior({angleLock:{multiplier:-1}});at(e,1).rotateJoint(.3);near(shape(e,3).angle,Math.PI/2+.3);
});
test('parent counter-rotation stays relative to the figure after posing and whole-figure turns',()=>{
  const e=fixture();at(e,3).setAngleLock('parent');at(e,3).setRigBehavior({angleLock:{multiplier:-1}});
  const initial=shape(e,3).angle;at(e,2).rotateJoint(.3);near(shape(e,3).angle,initial-.3);
  const before=e.serialize();e.rotateFigure(.7);near(shape(e,3).angle,initial-.3+.7);
  e.undo();assert.deepEqual(e.serialize(),before);near(shape(e,3).angle,initial-.3);
  e.redo();near(shape(e,3).angle,initial-.3+.7);
});
test('figure angle lock follows the existing figure rotation channel',()=>{
  const e=fixture();at(e,2).setAngleLock('figure');e.rotateFigure(.6);near(shape(e,2).angle,Math.PI/4+.6);
  at(e,3).setAngleLock('world');const angle=shape(e,3).angle;e.rotateFigure(.2);near(shape(e,3).angle,angle);
});
test('resetting an older explicit rig also redirects its descendants without losing legacy influence',()=>{
  const e=fixture();delete e.figure.segments[0]._stykRig.stretch.branch;
  for(const s of e.figure.segments)if(s._stykRig?.follow)delete s._stykRig.follow.automatic;
  at(e,2).setRigBehavior({response:{reset:true}});length(e,50);
  near(shape(e,2).length,25);near(shape(e,3).end.x-shape(e,3).start.x,-7.5);
});
test('angle-locked stretchy handles project onto the locked axis with one gesture undo',()=>{
  const e=fixture();at(e,2).setRigBehavior({response:{mode:'rigid'}});at(e,2).setAngleLock('world');
  const s=shape(e,2),before=e.serialize();e.beginDrag();e.poseJoint(s.start.x+80/Math.sqrt(2),s.start.y+80/Math.sqrt(2),{stretch:true});e.commitDrag();
  near(shape(e,2).length,80);near(shape(e,2).angle,Math.PI/4);e.undo();assert.deepEqual(e.serialize(),before);
});
test('negative stretch direct posing inverts the signed deformation',()=>{
  const e=fixture();at(e,2).setRigBehavior({response:{multiplier:3}});length(e,10);at(e,2);
  const s=shape(e,2),target={x:s.start.x-25,y:s.start.y+70};e.beginDrag();e.poseJoint(target.x,target.y,{stretch:true,snap:false,isolate:true});e.commitDrag();
  near(shape(e,2).end.x,target.x);near(shape(e,2).end.y,target.y);
});
test('builder gestures stretch locked joints along their axis and retain exact undo',()=>{
  const e=fixture();at(e,2).setRigBehavior({response:{mode:'rigid'}});at(e,2).setAngleLock('world');
  const s=shape(e,2),before=e.serialize();e.beginRigDrag({reposition:true});e.editRigJoint(s.start.x+80/Math.sqrt(2),s.start.y+80/Math.sqrt(2));e.commitRigDrag();
  near(shape(e,2).length,80);near(shape(e,2).angle,Math.PI/4);e.undo();assert.deepEqual(e.serialize(),before);
});
test('invalid locks and impulse values reject atomically, including dependency cycles',()=>{
  const e=fixture();at(e,2);const before=e.serialize(),history=e._undo.length;
  for(const patch of [{response:{multiplier:NaN}},{response:{multiplier:11}},{response:{reset:1}},{angleLock:{mode:'parent',reference:3,restAngle:0,angle:0,multiplier:1}},{angleLock:{mode:'world',angle:Infinity,multiplier:1}}])assert.throws(()=>e.setRigBehavior(patch));
  assert.deepEqual(e.serialize(),before);assert.equal(e._undo.length,history);
});
test('new rig metadata survives native round trips, async geometry and arbitrary poses',async()=>{
  const e=fixture();at(e,2).setRigBehavior({response:{multiplier:-2,reset:true}});at(e,3).setAngleLock('parent');
  const doc=e.serialize(),container=await buildContainerV2(doc,'styk'),decoded=await decodeDocument(container,'styk');
  assert.deepEqual(decoded.document??decoded,doc);
  for(const ratio of [0,1.4,.2,1,0]){
    length(e,ratio*100);const expected=geometry(e),asyncResult=(await buildGeometryAsync(e.report,e.frame)).objects.get(0);
    for(let i=0;i<expected.segments.length;i++){near(expected.segments[i].end.x,asyncResult.segments[i].end.x);near(expected.segments[i].end.y,asyncResult.segments[i].end.y);}
    const repeat=buildGeometry(e.report,e.frame).objects.get(0);assert.deepEqual(repeat.segments.map(s=>s.end),expected.segments.map(s=>s.end));
  }
});
test('duplicated relative locks remap references to the copied driver',()=>{
  const e=fixture();at(e,3).setAngleLock('parent');at(e,1);const result=e.duplicateSegmentBranch();
  const copy=e.figure.segments.find(s=>result.handleIds.includes(s.segment_id)&&s._stykRig?.angleLock);
  assert.ok(result.handleIds.includes(copy._stykRig.angleLock.reference));
});
