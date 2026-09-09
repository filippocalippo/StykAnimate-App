import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {editorHandleCommandMethods,screenVectorToWorld,formatSegmentValues,parseSegmentValues} from '../src/editor-handle-commands.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {worldToScreen} from '../src/renderer-geometry.mjs';
Object.assign(Editor.prototype,editorHandleCommandMethods);
const near=(a,b,tolerance=2e-4)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const pointNear=(a,b)=>{near(a.x,b.x);near(a.y,b.y);};
function fixture({joined=false,curved=false}={}){
  const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
  figure.segments=[{...base,segment_id:11,parent_id:0,length:100,angle_rad:.2,bend_rad:curved?.7:0},
    {...base,segment_id:22,parent_id:11,length:55,angle_rad:1,bend_rad:curved?-.3:0},
    {...base,segment_id:33,parent_id:0,length:60,angle_rad:2.5}];figure.segment_count=3;
  const objects=[createObject(figure,1,300,220)];
  if(joined){objects.push(createObject(figure,2,0,0,{join:{target_object_slot:0,target_handle_id:11}}));
    objects.push(createObject(figure,3,0,0,{join:{target_object_slot:1,target_handle_id:0}}));}
  report.keyframes=[createFrame(objects),createFrame([createObject(figure,1,320,200)])];
  const editor=new Editor({demo:false}).load(report);editor.select(1,0);return editor;
}

test('one screen-pixel origin nudge respects rotated and magnified native cameras',()=>{
  const editor=fixture();editor.frame.camera={is_default:false,x:20,y:-12,scale:.4,angle_rad:.73};editor._invalidate();editor.select(1,-1);
  const view={scale:3,x:40,y:30},options={report:editor.report,frame:editor.frame,view};
  const before=worldToScreen(editor.geometry.objects.get(0).root,options);
  editor.nudgeHandle(1,-1,{view});const after=worldToScreen(editor.geometry.objects.get(0).root,options);
  near(after.x-before.x,1);near(after.y-before.y,-1);assert.equal(editor._undo.length,1);
  const delta=screenVectorToWorld(1,0,{...options,cameraEnabled:false});near(delta.x,1/3);near(delta.y,0);
});

test('ordinary joint nudge poses a branch while Handle Edit nudges only the shared vertex',()=>{
  for(const editMode of [false,true]){
    const editor=fixture({joined:true}),before=editor.geometry;
    editor.nudgeHandle(1,0,{view:{scale:4},editMode});const after=editor.geometry;
    pointNear(after.objects.get(0).root,before.objects.get(0).root);
    if(editMode){near(after.objects.get(0).joints.get(11).x-before.objects.get(0).joints.get(11).x,.25);
      for(const [slot,g]of before.objects)for(const[id,p]of g.joints){if(slot===0&&id===11||slot>0&&id===0)continue;pointNear(after.objects.get(slot).joints.get(id),p);}}
    else assert.notDeepEqual(after.objects.get(0).joints.get(22),before.objects.get(0).joints.get(22));
  }
});

test('cardinal and diagonal alignment supports branch, isolated and local Edit modes',()=>{
  for(const options of [{},{isolate:true},{editMode:true}]){
    const editor=fixture(),before=editor.geometry.objects.get(0),childAngle=editor.object.angles[1];
    editor.alignHandle(1,1,options);const after=editor.geometry.objects.get(0),shape=after.segments[0];
    near(Math.atan2(shape.end.y-shape.start.y,shape.end.x-shape.start.x),Math.PI/4);
    if(options.editMode)pointNear(after.joints.get(22),before.joints.get(22));
    if(options.isolate)near(editor.object.angles[1],childAngle);
    assert.equal(editor._undo.length,1);
  }
});

test('Handle Edit Locate matches sparse native IDs across reordered definitions and hidden adjacent keys',()=>{
  const editor=fixture(),report=editor.report,figure=report.figure_types[0];
  const reordered={...structuredClone(figure),figure_type_id:2,segments:[structuredClone(figure.segments[1]),structuredClone(figure.segments[0]),structuredClone(figure.segments[2])]};
  report.figure_types.push(reordered);report.keyframes.unshift(createFrame([createObject(reordered,1,275,204)],0));editor.load(report);editor.selectFrame(1);editor.select(1,0);
  const before=editor.geometry.objects.get(0),other=structuredClone(report.keyframes[0]),definition=structuredClone(report.figure_types);
  const target={x:275+Math.cos(.2)*100,y:204+Math.sin(.2)*100};
  editor.locateEditedHandle(-1);const after=editor.geometry.objects.get(0);
  pointNear(after.joints.get(11),target);for(const id of[0,22,33])pointNear(after.joints.get(id),before.joints.get(id));
  assert.deepEqual(report.keyframes[0],other);assert.deepEqual(report.figure_types,definition);assert.equal(editor._undo.length,1);
  editor.undo();for(const[id,p]of before.joints)pointNear(editor.geometry.objects.get(0).joints.get(id),p);
});

test('relative angles use the nearest incoming end tangent through joined origin ancestors',()=>{
  const editor=fixture({joined:true,curved:true});
  editor.select(3,0);near(editor.segmentValues({relative:true}).angle,(.2-(.2+.7))*180/Math.PI);
  const parent=structuredClone(editor.frame.objects[0]);editor.setSegmentValues({angle:0},{relative:true});
  near(editor.object.angles[0],.9);assert.deepEqual(editor.frame.objects[0],parent);
  editor.select(1,1);near(editor.segmentValues({relative:true}).angle,(1-.9)*180/Math.PI);
});

test('native colon clipboard uses degrees, unscaled length and visible-field numeric compaction',()=>{
  assert.equal(formatSegmentValues({angle:30,bend:-15,length:42.5}),'30:-15:42.5');
  assert.deepEqual(parseSegmentValues('30,5:-15,25:42,5'),{angle:30.5,bend:-15.25,length:42.5});
  assert.deepEqual(parseSegmentValues('1:2'),{angle:1,bend:2});
  assert.deepEqual(parseSegmentValues('ignored:30:bad:-15:42.5:99'),{angle:30,bend:-15,length:42.5});
  assert.deepEqual(parseSegmentValues('1:2:Infinity'),{angle:1,bend:2});
  assert.deepEqual(parseSegmentValues('bad'),{});
  for(const text of['1:2:0','1'.repeat(101)])assert.throws(()=>parseSegmentValues(text));
  const editor=fixture();editor.object.scale=3;editor._invalidate();const copy=editor.copySegmentValues();near(parseSegmentValues(copy).length,100);
  editor.select(1,1);editor.pasteSegmentValues(copy);const values=editor.segmentValues();near(values.angle,.2*180/Math.PI);near(values.length,100);
  editor.pasteSegmentValues('90');near(editor.segmentValues().angle,90);near(editor.segmentValues().length,100);
  const history=editor._undo.length;assert.equal(editor.pasteSegmentValues('bad'),false);assert.equal(editor._undo.length,history);
});

test('value input Edit Mode changes only its endpoint and honors explicit bend/length with one cancelable preview',()=>{
  const editor=fixture({curved:true,joined:true}),before=structuredClone(editor.report),geometry=editor.geometry;
  editor.beginSegmentValueEdit({editMode:true});editor.setSegmentValues({angle:45,bend:30,length:120});
  const after=editor.geometry;for(const[slot,g]of geometry.objects)for(const[id,p]of g.joints){if(slot===0&&id===11||slot>0&&id===0)continue;pointNear(after.objects.get(slot).joints.get(id),p);}
  near(editor.segmentValues().angle,45);near(editor.segmentValues().bend,30);near(editor.segmentValues().length,120);
  assert.equal(editor._undo.length,0);editor.cancelDrag();assert.deepEqual(editor.report,before);
  editor.setSegmentValues({angle:45,bend:30,length:120},{editMode:true});assert.equal(editor._undo.length,1);editor.undo();assert.deepEqual(editor.report.keyframes,before.keyframes);
});

test('same values and rejected zero length create no history; authored values preserve imported frames',()=>{
  const editor=fixture();assert.equal(editor.setSegmentValues(editor.segmentValues()),false);assert.equal(editor._undo.length,0);
  assert.throws(()=>editor.setSegmentValues({length:0}),/greater than zero/);assert.equal(editor._undo.length,0);
  editor.adoptNativePoseTrack({kind:'layer',id:'layer-1'});editor.seek(0);editor.select(1,0);
  const frames=structuredClone(editor.report.keyframes),history=editor._undo.length;
  editor.setSegmentValues({angle:60,length:130},{editMode:true});assert.deepEqual(editor.report.keyframes,frames);assert.equal(editor._undo.length,history+1);
  near(editor.segmentValues().angle,60);near(editor.segmentValues().length,130);editor.undo();near(editor.segmentValues().length,100);
});
