import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {animationRotation,synchronizeAnimationOrigin} from '../src/animation-origin.mjs';
import {ownedScope} from './support/owned-scope.mjs';
import {geometryOfDocument,geometryOfFrame} from './support/engine-geometry.mjs';

const open = ownedScope();

const clone=structuredClone;
const near=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
function fixture({joined=false}={}) {
  const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
  figure.segments=[7,99,301,502].map((id,index)=>({...clone(base),segment_id:id,parent_id:[0,7,7,301][index],
    length:[78,43,31,26][index],angle_rad:[-.8,.5,-1.2,.2][index],bend_rad:[.2,-.3,.1,-.25][index],z_order:index}));
  figure.segment_count=4;
  report.keyframes=[0,1,2].map(index=>{
    const object=createObject(figure,1,170+index*17,200-index*11);
    object.angles=[[-2.8,2.3,.5,-.8],[2.7,-2.8,-.9,1.3],[-1.7,.8,2.4,-.7]][index];
    object.scale=[.8,1.7,1.2][index];object.len_flag=object.bend_flag=1;
    object.lengths=[78+index*7,43-index*3,31+index*2,26+index];
    object.bends=[[.2,-.3,.1,-.25],[-.9,.7,.2,.45],[1.1,-.5,-.6,.3]][index];
    return createFrame([object],index===2?1:5);
  });
  const editor=open({demo:false}, report);editor.select(1,0);editor.setOrigin(99);
  const reference=editor.figure._styk.animationOrigin.rotationHandleId;
  editor.select(1,editor.figure.segments.findIndex(segment=>segment.segment_id===reference));editor.deleteSingleSegment();
  const document=editor.serialize(),definition=document.figure_types[0];
  assert.equal(definition._styk.animationOrigin.support.bones[definition._styk.animationOrigin.support.rotation].handleId,null);
  if(joined)for(const frame of document.keyframes) {
    const objects=[frame.objects[0],...[2,3,4].map(uid=>createObject(definition,uid,300,200))];
    objects[1].join={target_object_slot:0,target_unique_id:1,target_handle_id:301};
    objects[2].join={target_object_slot:1,target_unique_id:2,target_handle_id:301};
    objects[3].join={target_object_slot:0,target_unique_id:1,target_handle_id:7};
    Object.assign(frame,createFrame(objects,frame.duration_raw));
    const geometry=geometryOfDocument(document,frame);
    for(const object of objects) {
      const root=geometry.objects.get(object.object_slot).root;object.root_x=root.x;object.root_y=root.y;
      synchronizeAnimationOrigin(definition,object);
    }
  }
  const retained=clone(document.keyframes[0]);retained._styk={...retained._styk,frameId:'retained-support-pose'};
  document._styk.frameSources={'retained-support-pose':retained};
  editor.load(document);editor.select(1,0);editor.markSaved();return editor;
}
const ghosts=object=>object._stykAnimationOrigin.ghosts;
function checkGhosts(actual,before,transform) {
  assert.deepEqual(Object.keys(actual),Object.keys(before));
  for(const [index,pose]of Object.entries(before)) {
    const expected=transform(pose,index);
    for(const field of ['angle_rad','bend_rad','length'])near(actual[index][field],expected[field]);
  }
}
function record(editor) {
  return {document:editor.serialize(),history:editor._undo.length,
    ghostMaps:editor.report.keyframes.map(frame=>frame.objects.map(ghosts)),
    retained:editor.report._styk.frameSources['retained-support-pose']};
}
function checkCow(editor,before,indices=[0]) {
  for(const index of indices)for(const [slot,old]of before.ghostMaps[index].entries()) {
    assert.deepEqual(old,ghosts(before.document.keyframes[index].objects[slot]),'A command must not mutate previously shared ghost records');
  }
  assert.equal(editor.report._styk.frameSources['retained-support-pose'],before.retained);
  assert.deepEqual(before.retained,before.document._styk.frameSources['retained-support-pose']);
}
function checkUndo(editor,before) {
  assert.equal(editor._undo.length,before.history+1);const after=editor.serialize();
  editor.undo();assert.deepEqual(editor.serialize(),before.document);editor.redo();assert.deepEqual(editor.serialize(),after);
}
/** Where the engine puts every joint at keyframe `index`: as it evaluates the frame on show there, or (`evaluated: false`) as the stored keyframe stands. */
function points(editor,index=0,{evaluated=true}={}) {
  let geometry;
  if(evaluated){editor.seek(editor.timeline[index].start);geometry=editor.geometry;}
  else geometry=geometryOfFrame(editor,editor.report.keyframes[index]);
  return [...geometry.objects.values()].flatMap(object=>[...object.joints].map(([handle,p])=>[object.obj.unique_id,handle,p.x,p.y]));
}
function closePoints(actual,expected) {
  assert.equal(actual.length,expected.length);
  for(let index=0;index<actual.length;index++) {
    assert.deepEqual(actual[index].slice(0,2),expected[index].slice(0,2));
    for(const axis of [2,3])near(actual[index][axis],expected[index][axis],.0002);
  }
}
const rotated=(pose,delta)=>({...pose,angle_rad:pose.angle_rad+delta});
const mirrored=(pose,axis)=>({...pose,angle_rad:axis==='vertical'?-pose.angle_rad:Math.PI-pose.angle_rad,bend_rad:-pose.bend_rad});
function resetExpected(editor,index) {
  const bone=editor.figure._styk.animationOrigin.support.bones[index];
  return {angle_rad:bone.angle_rad,bend_rad:bone.bend_rad,length:bone.length};
}

for(const [name,operation,transform,affine]of [
  ['rotate figure',e=>e.rotateFigure(.4),pose=>rotated(pose,.4),'rotate'],
  ['rotate selection',e=>e.rotateSelection(.4),pose=>rotated(pose,.4),'rotate'],
  ['horizontal mirror figure',e=>e.mirrorFigure('horizontal'),pose=>mirrored(pose,'horizontal'),'horizontal'],
  ['vertical mirror selection',e=>e.mirrorSelection('vertical'),pose=>mirrored(pose,'vertical'),'vertical'],
  ['reset pose',e=>e.resetPose(),null,null],
])test(`deleted reference support follows ${name} with COW ghosts and one exact undo`,()=>{
  const editor=fixture();editor.select(1,-1);
  const before=record(editor),initial=points(editor),root=editor.geometry.objects.get(0).root;
  operation(editor);
  checkGhosts(ghosts(editor.object),ghosts(before.document.keyframes[0].objects[0]),transform??((pose,index)=>resetExpected(editor,index)));
  assert.notEqual(ghosts(editor.object),before.ghostMaps[0][0]);checkCow(editor,before);
  closePoints(points(editor),points(editor,0,{evaluated:false}));
  if(affine)closePoints(points(editor),initial.map(([uid,handle,x,y])=> {
    const dx=x-root.x,dy=y-root.y;
    return [uid,handle,root.x+(affine==='rotate'?dx*Math.cos(.4)-dy*Math.sin(.4):affine==='horizontal'?-dx:dx),
      root.y+(affine==='rotate'?dx*Math.sin(.4)+dy*Math.cos(.4):affine==='vertical'?-dy:dy)];
  }));
  assert.deepEqual(editor.report.keyframes[1],before.document.keyframes[1]);checkUndo(editor,before);
});

for(const [name,operation,transform]of [
  ['rotation',e=>e.rotateFiguresInFrames(.3,[0,2]),pose=>rotated(pose,.3)],
  ['horizontal mirror',e=>e.mirrorFiguresInFrames('horizontal',[0,2]),pose=>mirrored(pose,'horizontal')],
  ['reset',e=>e.resetPoseInFrames([0,2]),null],
])test(`native ${name} ranges transform each source's deleted reference without touching other frames`,()=>{
  const editor=fixture();editor.select(1,-1);
  const before=record(editor),middle=editor.report.keyframes[1];operation(editor);
  for(const index of [0,2]) {
    checkGhosts(ghosts(editor.report.keyframes[index].objects[0]),ghosts(before.document.keyframes[index].objects[0]),transform??((pose,index)=>resetExpected(editor,index)));
    assert.notEqual(ghosts(editor.report.keyframes[index].objects[0]),before.ghostMaps[index][0]);
    closePoints(points(editor,index),points(editor,index,{evaluated:false}));
  }
  assert.equal(editor.report.keyframes[1],middle);assert.deepEqual(middle,before.document.keyframes[1]);checkCow(editor,before,[0,2]);checkUndo(editor,before);
});

test('Alt previews transform support from the original pointer pose without accumulating ghost rotation',()=>{
  const editor=fixture(),before=record(editor),initial=editor.geometry.objects.get(0),root=initial.root,start=initial.segments[0].end;
  const at=(angle,factor)=>({x:root.x+factor*((start.x-root.x)*Math.cos(angle)-(start.y-root.y)*Math.sin(angle)),
    y:root.y+factor*((start.x-root.x)*Math.sin(angle)+(start.y-root.y)*Math.cos(angle))});
  editor.beginFigureHandleDrag(start.x,start.y);
  for(const [angle,factor]of [[.1,1.1],[.4,.7],[-.2,1.6],[.3,1.2]]) {
    const point=at(angle,factor);editor.transformFigureHandle(point.x,point.y);
    checkGhosts(ghosts(editor.object),ghosts(before.document.keyframes[0].objects[0]),pose=>rotated(pose,angle));
    near(editor.object.scale,before.document.keyframes[0].objects[0].scale*factor);
    assert.equal(editor._undo.length,before.history);checkCow(editor,before);
  }
  editor.commitFigureHandleDrag();closePoints(points(editor),points(editor,0,{evaluated:false}));checkUndo(editor,before);
});

test('Alt pointer return and cancellation restore deleted reference ghosts, offsets and clean history exactly',()=>{
  for(const cancel of [false,true]) {
    const editor=fixture(),before=record(editor),initial=editor.geometry.objects.get(0),start=initial.segments[0].end;
    editor.beginFigureHandleDrag(start.x,start.y);editor.transformFigureHandle(start.x+30,start.y-20);
    if(cancel)editor.cancelFigureHandleDrag();
    else {editor.transformFigureHandle(start.x,start.y);assert.equal(editor.commitFigureHandleDrag(),false);}
    assert.deepEqual(editor.serialize(),before.document);assert.equal(editor._undo.length,before.history);assert.equal(editor.dirty,false);
    checkCow(editor,before);
  }
});

test('branch rotation changes each attached child ghost once while the selected parent and sibling ghosts stay fixed',()=>{
  const editor=fixture({joined:true});editor.select(1,editor.figure.segments.findIndex(segment=>segment.segment_id===301));
  const before=record(editor),initialRotation=editor.frame.objects.map(object=>animationRotation(editor.figure,object));
  editor.rotateJoint(.35);
  for(const slot of [0,3])assert.deepEqual(ghosts(editor.frame.objects[slot]),ghosts(before.document.keyframes[0].objects[slot]));
  for(const slot of [1,2]) {
    checkGhosts(ghosts(editor.frame.objects[slot]),ghosts(before.document.keyframes[0].objects[slot]),pose=>rotated(pose,.35));
    near(animationRotation(editor.figure,editor.frame.objects[slot]),initialRotation[slot]+.35);
    editor.frame.objects[slot].angles.forEach((angle,index)=>near(angle,before.document.keyframes[0].objects[slot].angles[index]+.35));
  }
  near(animationRotation(editor.figure,editor.frame.objects[0]),initialRotation[0]);checkCow(editor,before);checkUndo(editor,before);
});

