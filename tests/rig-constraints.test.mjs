import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {RIG_EXAMPLES,rigExampleDocument} from '../src/rig-examples.mjs';
import {geometryOfDocument,evaluatedAt} from './support/engine-geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {getPivotHandles} from '../src/canvas-interactions.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';
import {rigSections,rigControlChange} from '../src/rig-controls.mjs';
import {renderInspector} from '../src/inspector-kit.mjs';
import {pivotDocument, figureDocument} from './support/engine-export.mjs';
const rigView=e=>renderInspector({kind:'joint',sections:rigSections(e)});

const near=(a,b,t=1e-4)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const point=(a,b)=>{near(a.x,b.x);near(a.y,b.y);};
const editorFor=(id,options={})=>{const e=newOwnedEditor({demo:false,...options});e.load(typeof id==='string'?rigExampleDocument(id):id);e.select(1);return e;};
const select=(e,id)=>e.select(e.selectedUid,e.figure.segments.findIndex(s=>s.segment_id===id));
const g=e=>e.geometry.objects.get(0);
/** Where a connector's slider sits along it, 0 to 1: its slide position in the pose (the engine's geometry has no field for it). */
const slide=(e,s)=>{const o=e.frame.objects[0];return Math.min(1,Math.max(0,o.len_flag?o.lengths[s.index]:s.seg.length));};
const poseSignature=scene=>[...scene.objects.values()].flatMap(o=>o.segments.map(s=>[s.start,s.end,s.handle,s.thickness]));

test('sliding connector is a real handle, supports attachments and one-gesture undo',()=>{
  const e=editorFor('sliding-carriage');select(e,3);const before=e.serialize();
  const left=g(e).joints.get(1),right=g(e).joints.get(2);
  e.beginDrag();for(let i=0;i<=10;i++)e.poseJoint(left.x+(right.x-left.x)*i/10,left.y);e.commitDrag();
  point(g(e).joints.get(3),right);point(g(e).segments[3].start,right);
  const handles=getPivotHandles(e.geometry,{tool:'rig',selectedUid:1});assert.ok(handles.some(h=>h.id===3&&Math.abs(h.point.x-right.x)<1e-4));
  assert.equal(e._undo.length,1);e.undo();assert.deepEqual(e.serialize(),before);e.redo();point(g(e).joints.get(3),right);
});
test('connector follows independent anchors and attached parts rotate with it',()=>{
  const e=editorFor('articulated-piston');select(e,2);e.rotateJoint(.9);
  const scene=g(e),c=scene.segments[2],sleeve=scene.segments[3];point(c.start,scene.joints.get(1));point(c.end,scene.joints.get(2));
  near(sleeve.angle,c.angle);near(sleeve.length,48);point(sleeve.start,scene.joints.get(3));
});
test('nested connectors evaluate in dependency order, independently of record order',()=>{
  const doc=rigExampleDocument('nested-curve-controls'),fig=doc.figure_types[0],o=doc.keyframes[0].objects[0];
  o.len_flag=1;o.lengths=fig.segments.map(s=>s.length);o.lengths[3]=.2;o.lengths[4]=.8;o.lengths[5]=.3;
  const sample=()=>geometryOfDocument(doc).objects.get(0),expected=sample(),old=fig.segments.slice();
  const indices=[6,5,4,3,2,1,0];fig.segments=indices.map(i=>old[i]);o.angles=indices.map(i=>o.angles[i]);o.lengths=indices.map(i=>o.lengths[i]);
  const scene=sample();for(const [id,p] of expected.joints)point(scene.joints.get(id),p);
  const a=scene.joints.get(4),b=scene.joints.get(5);point(scene.joints.get(6),{x:a.x*.7+b.x*.3,y:a.y*.7+b.y*.3});
});
test('collapsed and reversed connectors produce finite repeatable geometry',()=>{
  const e=editorFor('flexing-muscle');select(e,2);
  for(const angle of [Math.PI,Math.PI+1e-10,-Math.PI,0,Math.PI]){
    e.updateSegment({angle_rad:angle});for(const s of g(e).segments)for(const n of [s.angle,s.length,s.thickness,s.end.x,s.end.y])assert.ok(Number.isFinite(n));
    const scene=poseSignature(e.geometry);e._invalidate();assert.deepEqual(poseSignature(e.geometry),scene);
  }
});
test('smart stretch preserves panel widths, applies one axial deformation and clamps limits',()=>{
  const e=editorFor('telescoping-panels');select(e,1);e.setRigBehavior({stretch:{min:.25,max:2}});e.updateSegment({length:360});
  let scene=g(e);near(scene.segments[1].length,120);near(scene.segments[3].length,120);near(scene.segments[2].length,45);near(scene.segments[2].thickness,30);
  e.updateSegment({length:36000});scene=g(e);near(scene.segments[0].length,360);near(scene.segments[1].length,120);
  e.updateSegment({length:0});near(g(e).segments[0].length,45);
});
test('enabling Smart Stretch captures posed length without figure scale and supports undo',()=>{
  const e=editorFor('telescoping-panels');select(e,1);e.enableSmartStretch(false);
  e.updateSegment({length:270});e.updateObject({scale:2});
  assert.notEqual(e.figure.segments[0].length,270);
  const before=e.serialize();
  rigControlChange(e,{id:'rig-stretch-enabled',checked:true});
  near(e.figure.segments[0]._stykRig.stretch.restLength,270);
  e.undo();assert.deepEqual(e.serialize(),before);e.redo();
  near(e.figure.segments[0]._stykRig.stretch.restLength,270);
  e.setRigBehavior({stretch:{restLength:200}});e.enableSmartStretch(true);
  near(e.figure.segments[0]._stykRig.stretch.restLength,200);
  e.enableSmartStretch(false);e.updateSegment({length:315});e.enableSmartStretch(true);
  near(e.figure.segments[0]._stykRig.stretch.restLength,315);
});
test('enabling connector Smart Stretch captures current anchor distance even when curved',()=>{
  const e=editorFor('sliding-carriage');select(e,2);e.updateSegment({length:400});
  select(e,3);e.updateSegment({bend_rad:Math.PI/2});e.updateObject({scale:2});
  const shape=g(e).segments[2],span=Math.hypot(shape.end.x-shape.start.x,shape.end.y-shape.start.y)/2;
  assert.notEqual(span,e.figure.segments[2]._stykRig.connector.restLength);
  e.enableSmartStretch(true);near(e.figure.segments[2]._stykRig.stretch.restLength,span);
});
test('invalid rig changes and deleting referenced anchors fail atomically; disabling removes followers',()=>{
  const e=editorFor('nested-curve-controls');select(e,4);let before=e.serialize(),history=e._undo.length;
  for(const connector of [{end:6},{end:999},{start:1,end:1},{restLength:NaN}])assert.throws(()=>e.setRigBehavior({connector}),/itself|missing|different|between/);
  assert.deepEqual(e.serialize(),before);assert.equal(e._undo.length,history);
  select(e,2);before=e.serialize();assert.throws(()=>e.deleteSingleSegment(),/missing|relationship|itself/);assert.deepEqual(e.serialize(),before);
  const stretch=editorFor('telescoping-panels');select(stretch,1);stretch.setRigBehavior({stretch:null});assert.ok(stretch.figure.segments.every(s=>!s._stykRig?.follow));stretch.undo();assert.ok(stretch.figure.segments[1]._stykRig.follow);
});
test('relationship commands retain small history independent of media and pose count',()=>{
  const doc=rigExampleDocument('telescoping-panels');doc.figure_types[0].image_assets.push({data_url:'x'.repeat(2000000)});const e=editorFor(doc);select(e,1);
  e.setRigBehavior({stretch:{width:'inverse'}});assert.ok(JSON.stringify(e._undo.at(-1)).length<3000);
});
test('curved connectors retain endpoints and their sliding handle lies on the arc',()=>{
  const e=editorFor('sliding-carriage');select(e,3);e.updateSegment({bend_rad:Math.PI/2});e.setConnectorPosition(.5);
  const s=g(e).segments[2];point(s.start,g(e).joints.get(1));point(s.end,g(e).joints.get(2));assert.ok(Math.abs(s.handle.y-s.start.y)>10);
  e.poseJoint(s.points.at(-1).x,s.points.at(-1).y);point(g(e).joints.get(3),s.end);
});
test('slider channels tween and recompute dependent connectors at inbetween ticks',()=>{
  const doc=rigExampleDocument('sliding-carriage'),a=doc.keyframes[0],b=structuredClone(a);
  a.duration_raw=10;b.keyframe_index=1;doc.keyframes.push(b);
  for(const [frame,t] of [[a,0],[b,1]]){const o=frame.objects[0];o.len_flag=1;o.lengths=doc.figure_types[0].segments.map(s=>s.length);o.lengths[2]=t;}
  const scene=geometryOfDocument(doc,evaluatedAt(doc,2.5)).objects.get(0),left=scene.joints.get(1),right=scene.joints.get(2);
  point(scene.joints.get(3),{x:left.x*.75+right.x*.25,y:left.y});
});
test('duplicate branches remap internal anchors and preserve explicit external anchors',()=>{
  const e=editorFor('sliding-carriage');select(e,1);const copied=e.duplicateSegmentBranch();
  const connector=e.figure.segments.find(s=>copied.handleIds.includes(s.segment_id)&&s._stykRig?.connector);
  assert.equal(connector._stykRig.connector.start,copied.handleIds[0]);assert.equal(connector._stykRig.connector.end,2);
  const scene=g(e),s=scene.segments.find(s=>s.seg===connector);point(s.start,scene.joints.get(connector._stykRig.connector.start));
  e.undo();assert.equal(e.figure.segments.length,6);e.redo();assert.doesNotThrow(()=>validateScene(e.serialize()));
});
test('direct posing in stretched and connector-relative space reaches the cursor',()=>{
  const e=editorFor('telescoping-panels');select(e,1);e.updateSegment({length:270});select(e,2);
  const start=g(e).segments[1].start,target={x:start.x-110,y:start.y+30};e.poseJoint(target.x,target.y,{stretch:true,snap:false,isolate:true});point(g(e).segments[1].end,target);
  const p=editorFor('articulated-piston');select(p,2);p.rotateJoint(.9);select(p,4);const a=g(p).segments[3].start,b={x:a.x+25,y:a.y+45};p.poseJoint(b.x,b.y,{stretch:true,snap:false,isolate:true});point(g(p).segments[3].end,b);
});
test('joined figures follow sliding joints',()=>{
  const e=editorFor('articulated-piston',{layerTimeline:true});select(e,2);e.rotateJoint(.9);
  const extra=e.importFigure(rigExampleDocument('sliding-carriage'));e.select(extra.unique_id);e.joinFigure(1,3);
  const parent=e.geometry.objects.get(0),child=e.geometry.objects.get(e.selectedSlot);point(child.root,parent.joints.get(3));
  assert.doesNotThrow(()=>validateScene(e.serialize()));
});
test('IK drives ordinary anchors; derived controls reject conflicting IK and unsupported Pivot exports',()=>{
  const e=editorFor('flexing-muscle');select(e,2);e.setNodeIK({enabled:true});e.poseJoint(400,180);const c=g(e).segments[2];point(c.end,g(e).joints.get(2));
  select(e,3);assert.throws(()=>e.setNodeIK({enabled:true}),/derived|driving/);
  assert.throws(()=>pivotDocument(e.serialize()),/Pivot cannot preserve/);
});
test('deep dependency chains evaluate without recursive stack growth',()=>{
  const doc=rigExampleDocument('nested-curve-controls'),fig=doc.figure_types[0],template=fig.segments[3],count=5000;
  fig.segments=fig.segments.slice(0,3);
  for(let i=4;i<=count;i++)fig.segments.push({...template,segment_id:i,parent_id:0,_stykRig:{connector:{start:i===4?1:i-1,end:3,restLength:120}}});
  const o=doc.keyframes[0].objects[0];o.angles=fig.segments.map(s=>s.angle_rad);
  const scene=geometryOfDocument(doc);assert.equal(scene.objects.get(0).segments.length,count);assert.ok(Number.isFinite(scene.objects.get(0).joints.get(count).x));
});
test('polygon edges terminate at a curved connector’s sliding joint',()=>{
  const e=editorFor('sliding-carriage');select(e,3);e.updateSegment({bend_rad:1});e.addPolygon([1,3,4]);
  const scene=g(e),far=scene.joints.get(2),middle=scene.joints.get(3),points=scene.polys[0].points;
  assert.ok(points.some(p=>Math.hypot(p.x-middle.x,p.y-middle.y)<1e-4));assert.ok(!points.some(p=>Math.hypot(p.x-far.x,p.y-far.y)<1e-4));
});
test('repositioning a connector anchor in Build Figure keeps its slide channel intact',()=>{
  const e=editorFor('sliding-carriage');select(e,1);const a=g(e).joints.get(1);
  e.beginRigDrag();e.editRigJoint(a.x-20,a.y-30);e.commitRigDrag();const s=g(e).segments[2];
  near(e.figure.segments[2].length,.5);point(s.start,g(e).joints.get(1));point(s.handle,{x:(s.start.x+s.end.x)/2,y:(s.start.y+s.end.y)/2});
});
test('Smart Stretch activates attached parts in one undo and normal drag only rotates',()=>{
  const e=editorFor('telescoping-panels');select(e,1);e.setRigBehavior({stretch:null});const base=e._undo.length;
  const original=e.serialize();rigControlChange(e,{id:'rig-stretch-enabled',checked:true});
  assert.equal(e._undo.length,base+1);assert.equal(e.figure.segments.filter(s=>s._stykRig?.follow?.driver===1).length,6);
  e.undo();assert.deepEqual(e.serialize(),original);e.redo();
  // Mark a panel rigid through the simple inspector control.
  select(e,3);rigControlChange(e,{id:'rig-follow-rigid',checked:true});select(e,1);
  const driver=g(e).segments[0],root=driver.start;
  e.beginDrag();e.poseJoint(root.x,root.y+driver.length*1.7,{snap:false});e.commitDrag();
  near(g(e).segments[0].length,180);near(g(e).segments[1].length,60);near(g(e).segments[2].length,45);
  const before=e.serialize(),count=e._undo.length;
  e.beginDrag();for(const length of [200,220,260,300])e.poseJoint(root.x,root.y+length,{stretch:true,snap:false});e.commitDrag();
  near(g(e).segments[0].length,300);near(g(e).segments[1].length,100);near(g(e).segments[2].length,45);
  assert.equal(e._undo.length,count+1);e.undo();assert.deepEqual(e.serialize(),before);e.redo();near(g(e).segments[1].length,100);
  assert.match(rigView(e),/Hold Ctrl/);
});
test('automatic activation respects nested Smart Stretch controllers',()=>{
  const e=editorFor('telescoping-panels');select(e,1);e.setRigBehavior({stretch:null});select(e,4);e.enableSmartStretch(true);
  select(e,1);e.enableSmartStretch(true);
  assert.equal(e.figure.segments[1]._stykRig.follow.driver,1);
  assert.equal(e.figure.segments[3]._stykRig.follow,undefined);
  assert.equal(e.figure.segments[4]._stykRig.follow.driver,4);
  assert.equal(e.figure.segments[5]._stykRig.follow.driver,4);
});
test('building and repositioning parts beneath a rotated connector do not apply rotation twice',()=>{
  const e=editorFor('articulated-piston');select(e,2);e.rotateJoint(.9);select(e,3);
  const start=g(e).joints.get(3),added=e.addSegments([{length:40,angle:.3},{length:30,angle:-.2}]);
  const a=g(e).joints.get(added[0].segment_id),b=g(e).joints.get(added[1].segment_id);
  point(a,{x:start.x+40*Math.cos(.3),y:start.y+40*Math.sin(.3)});
  point(b,{x:a.x+30*Math.cos(-.2),y:a.y+30*Math.sin(-.2)});
  select(e,added[0].segment_id);const target={x:a.x+12,y:a.y-9};
  e.beginRigDrag();e.editRigJoint(target.x,target.y);point(g(e).joints.get(added[0].segment_id),target);point(g(e).joints.get(added[1].segment_id),b);
  const preview=poseSignature(e.geometry);e.commitDrag();assert.deepEqual(poseSignature(e.geometry),preview);
  e.undo();point(g(e).joints.get(added[0].segment_id),a);e.redo();point(g(e).joints.get(added[0].segment_id),target);
});
test('builder edits preserve Smart Stretch rest settings and the exact derived preview on commit',()=>{
  const e=editorFor('telescoping-panels');select(e,1);const before=e.serialize(),rest=e.figure.segments[0]._stykRig.stretch.restLength;
  const root=g(e).root;e.beginRigDrag();e.editRigJoint(root.x+240,root.y);const preview=poseSignature(e.geometry);
  e.commitDrag();assert.deepEqual(poseSignature(e.geometry),preview);near(e.figure.segments[0]._stykRig.stretch.restLength,rest);
  e.undo();assert.deepEqual(e.serialize(),before);
  select(e,1);e.updateSegment({length:260});select(e,2);const s=g(e).segments[1],target={x:s.end.x+18,y:s.end.y+22};
  e.beginRigDrag();e.editRigJoint(target.x,target.y);point(g(e).joints.get(2),target);const next=poseSignature(e.geometry);e.commitDrag();assert.deepEqual(poseSignature(e.geometry),next);
});
for(const id of ['glass-cube-3d','wire-globe-3d'])test(`${id}: full rotation and depth match an independent projection`,()=>{
  const e=editorFor(id),p=e.figure._styk.rigExample.projection;
  for(const depth of [0,.15,.42,1])for(let step=0;step<=32;step++){
    const yaw=step*Math.PI/16;select(e,p.depth);e.updateSegment({length:depth*100});select(e,p.turn);e.updateSegment({angle_rad:yaw});
    const scene=g(e),root=scene.root;
    p.vertices.forEach((id,i)=>{const angle=p.phase+i*Math.PI*2/p.vertices.length+yaw;
      point(scene.joints.get(id),{x:root.x+p.radius*Math.cos(angle),y:root.y+p.height+p.radius*Math.sin(angle)*depth});});
  }
});
for(const rig of RIG_EXAMPLES)test(`${rig.name}: connectors remain attached through rotation, collapse and arbitrary seeking`,()=>{
  const e=editorFor(rig.id),fig=e.figure;
  for(let sample=0;sample<48;sample++){
    // Nonsequential angles exercise reversal and exact repeated zero spans.
    select(e,rig.control);e.updateSegment({angle_rad:Math.sin(sample*7.3)*Math.PI*2});
    for(const s of fig.segments)if(s._stykRig?.stretch){select(e,s.segment_id);if(s._stykRig.connector)e.setConnectorPosition([0,.3,1,.7][sample%4]);else e.updateSegment({length:s._stykRig.stretch.restLength*[0,.3,1,2][sample%4]});}
    for(const id of fig._styk.rigExample.sliders??[]){select(e,id);e.setConnectorPosition([0,.4,1][sample%3]);}
    const scene=g(e);
    for(const s of scene.segments){for(const n of [s.angle,s.length,s.thickness,s.start.x,s.start.y,s.end.x,s.end.y])assert.ok(Number.isFinite(n));
      if(s.connector){point(s.start,scene.joints.get(s.seg._stykRig.connector.start));point(s.end,scene.joints.get(s.seg._stykRig.connector.end));
        point(s.handle,{x:s.start.x+(s.end.x-s.start.x)*slide(e,s),y:s.start.y+(s.end.y-s.start.y)*slide(e,s)});}}
    const expected=poseSignature(e.geometry);e._invalidate();assert.deepEqual(poseSignature(e.geometry),expected);
  }
});
for(const rig of RIG_EXAMPLES)test(`${rig.name}: native project and reusable figure round trips; async evaluation agrees`,async()=>{
  const e=editorFor(rig.id);select(e,rig.control);
  if(e.figure.segments[e.selectedJoint]._stykRig?.connector)e.setConnectorPosition(.7);else e.rotateJoint(.2);
  const report=e.serialize(),baseline=poseSignature(e.geometry),container=await buildContainerV2(report,'styk'),decoded=(await decodeDocument(container,'styk')).document;
  validateScene(decoded);point(geometryOfDocument(decoded).objects.get(0).root,g(e).root);
  assert.deepEqual(poseSignature(geometryOfDocument(decoded)),baseline);
  const reusable=figureDocument(report,{figureUid:1});const file=await buildContainerV2(reusable,'stkz'),saved=(await decodeDocument(file,'stkz')).document;
  assert.deepEqual(poseSignature(geometryOfDocument(saved)),baseline);
  });

