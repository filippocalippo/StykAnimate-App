import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {evaluatedFrame,timeline,buildGeometry} from '../src/pivot/geometry.mjs';
import {animationPropertyValue} from '../src/animation-channels.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {materializePivotDocument,needsPivotMaterialization} from '../src/pivot-export-materialize.mjs';
import {animationOriginOffset,animationRotation} from '../src/animation-origin.mjs';
import backend from '../desktop/backend.cjs';
const clone=structuredClone;
function fixture({authored=true,easing=false,joined=true}={}){
  const report=emptyDocument(),figure=report.figure_types[0],base=figure.segments[0];
  figure.segments=[7,99,301].map((id,i)=>({...clone(base),segment_id:id,parent_id:i?7:0,length:[78,43,31][i],angle_rad:[-.8,.5,-1.2][i],bend_rad:[.2,-.3,.1][i]}));
  figure.segment_count=3;report.figure_types.push({...clone(figure),figure_type_id:2});report.auto_easing=easing;
  report.keyframes=[0,1,2,3].map(i=>{
    const object=createObject(figure,1,100+i*17,200-i*11);object.angles=[[-2.8,2.3,.5],[2.7,-2.8,-.9],[-1.7,.8,2.4],[.4,-.6,-2.2]][i];
    object.scale=[.8,1.7,1.2,.65][i];object.len_flag=object.bend_flag=1;object.lengths=[78+i*7,43-i*3,31+i*2];object.bends=[[.2,-.3,.1],[-.9,.7,.2],[1.1,-.5,-.6],[.1,.4,.8]][i];
    const child=createObject(report.figure_types[1],2,350+i*4,280);if(joined)child.join={target_object_slot:0,target_unique_id:1,target_handle_id:99};
    const frame=createFrame([object,child],i===3?1:[7,5,8][i]);frame.camera={is_default:false,x:i*3,y:-i*2,scale:1+i*.1,angle_rad:i*.15};return frame;
  });
  const editor=new Editor({demo:false}).load(report);
  if(authored)editor.addAnimationKeys([
    ...[['rotation',[-.5,.9,-1.7]],['scale',[.6,1.8,.95]],['x',[83,177,121]],['y',[230,168,249]]].flatMap(([property,values])=>[0,8,20].map((tick,i)=>({target:{kind:'figure',uid:1},property,tick,value:values[i]}))),
    {target:{kind:'camera'},property:'rotation',tick:0,value:.17},{target:{kind:'camera'},property:'rotation',tick:20,value:-.22},
  ]);
  editor.select(1,0);return editor;
}
function sample(report,tick){const rows=timeline(report);let index=0;while(index+1<rows.length&&rows[index+1].start<=tick)index++;return evaluatedFrame(report,index,rows[index].count?(tick-rows[index].start)/rows[index].count:0,tick);}
function shape(report,tick){const frame=sample(report,tick);return {frame,geometry:buildGeometry(report,frame)};}
function equalWorld(expected,actual,tolerance=.00015){
  assert.equal(actual.geometry.objects.size,expected.geometry.objects.size);
  for(const [slot,object]of expected.geometry.objects){
    const result=actual.geometry.objects.get(slot);assert.equal(result.segments.length,object.segments.length);
    const unmatched=new Set(result.segments);
    object.segments.forEach((segment,i)=>{
      let best,minimum=Infinity;
      for(const other of unmatched){
        if(other.points.length!==segment.points.length)continue;
        const error=reverse=>Math.max(...segment.points.map((point,j)=>Math.hypot(point.x-other.points[reverse?other.points.length-1-j:j].x,point.y-other.points[reverse?other.points.length-1-j:j].y)));
        const distance=Math.min(error(false),error(true));if(distance<minimum){minimum=distance;best=other;}
      }
      assert.ok(minimum<tolerance,`slot${slot} segment${i}: ${minimum}`);unmatched.delete(best);
    });
  }
  for(const key of ['x','y','scale','angle_rad'])assert.ok(Math.abs(actual.frame.camera[key]-expected.frame.camera[key])<1e-5);
}
for(const easing of [false,true])test(`Set Origin preserves dense curved native and scalar animation, repeated roots, joins and undo (easing=${easing})`,()=>{
  const editor=fixture({easing}),before=editor.serialize(),channels=clone(editor.animationChannels),expected=Array.from({length:201},(_,i)=>shape(before,i/10));
  const count=editor._undo.length;editor.setOrigin(99);assert.equal(editor._undo.length,count+1);assert.deepEqual(editor.animationChannels,channels);
  for(let i=0;i<expected.length;i++)equalWorld(expected[i],shape(editor.report,i/10));
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
  editor.select(1);editor.setOrigin(301);
  for(let i=0;i<expected.length;i++)equalWorld(expected[i],shape(editor.report,i/10));
  for(const property of ['x','y','scale','rotation'])assert.ok(Math.abs(animationPropertyValue(before,expected[87].frame,{kind:'figure',uid:1},property)-
    animationPropertyValue(editor.report,sample(editor.report,8.7),{kind:'figure',uid:1},property))<1e-6);
  editor.select(1);editor.setOrigin(editor.figure._styk.animationOrigin.handleId);
  assert.equal(editor.figure._styk.animationOrigin.handleId,0);
  for(let i=0;i<expected.length;i++)equalWorld(expected[i],shape(editor.report,i/10));
});
test('native-only reroot preserves nonlinear inbetweens without adding authored keys',()=>{
  const editor=fixture({authored:false}),before=editor.serialize();editor.setOrigin(99);assert.equal(editor.animationChannels.length,0);assert.ok(needsPivotMaterialization(editor.report));
  for(let i=0;i<=100;i++)equalWorld(shape(before,i/5),shape(editor.report,i/5));
});
function roundtrip(document,format){
  const script="import json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path('backend').resolve()))\nimport server\nrequest=json.loads(sys.stdin.buffer.read().decode('utf-8'));store=server.ProjectStore(server.WORKSPACE)\nraw,name=store.export(request)\nprint(json.dumps(store.import_bytes(raw,name)['document']))";
  const python=backend.pythonCandidates()[0],result=spawnSync(python.command,[...python.args,'-c',script],{cwd:fileURLToPath(new URL('..',import.meta.url)),input:JSON.stringify({document,format}),encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  assert.equal(result.status,0,result.stderr||result.error?.message);return JSON.parse(result.stdout);
}
test('STYK retains editable pivots while native PIV bakes every displayed pose and cannot double-compose',()=>{
  const editor=fixture(),before=editor.serialize();editor.setOrigin(99);const source=editor.serialize(),styk=roundtrip(source,'styk'),native=roundtrip(materializePivotDocument(source),'piv');
  assert.deepEqual(styk.figure_types[0]._styk.animationOrigin,source.figure_types[0]._styk.animationOrigin);assert.deepEqual(styk._styk.animation,source._styk.animation);
  assert.equal(native.keyframes.length,21);assert.equal(needsPivotMaterialization(native),false);
  for(let tick=0;tick<=20;tick++){equalWorld(shape(before,tick),shape(styk,tick));equalWorld(shape(before,tick),shape(native,tick),.00035);}
  assert.deepEqual(editor.serialize(),source);
});
test('malformed retained pivot coordinates and missing topology references are rejected',()=>{
  const editor=fixture();editor.setOrigin(99);const source=editor.serialize();
  for(const mutate of [r=>r.keyframes[0].objects[0]._stykAnimationOrigin.x=NaN,r=>r.keyframes[0].objects[0]._stykAnimationOrigin.y=1e100,
    r=>r.keyframes[0].objects[0]._stykAnimationOrigin.offsetX=Infinity,r=>r.keyframes[0].objects[0]._stykAnimationOrigin.offsetY=1e100,
    r=>delete r.keyframes[0].objects[0]._stykAnimationOrigin,
    r=>r.figure_types[0]._styk.animationOrigin.handleId=65534,r=>r.figure_types[0]._styk.animationOrigin.rotationHandleId=0,r=>r.figure_types[0]._styk.animationOrigin.reversed=1]){
    const invalid=clone(source);mutate(invalid);assert.throws(()=>validateScene(invalid));
  }
});
test('independent layer pose tracks and retained source poses retain their joined world anchors',()=>{
  const editor=fixture(),layer=editor.createLayer('Attached figure');editor.assignFiguresToLayer([2],layer.id);
  const parentTrack=editor.nativePoseChannel({kind:'layer',id:'layer-1'}),childTrack=editor.nativePoseChannel({kind:'layer',id:layer.id});
  editor.moveAnimationKeys([{channelId:parentTrack.id,keyIds:[parentTrack.keys[1].id]}],2);
  editor.moveAnimationKeys([{channelId:childTrack.id,keyIds:[childTrack.keys[2].id]}],-1);
  const sourceId=editor.captureFrameSource(sample(editor.report,4.5));editor.addAnimationKey({kind:'layer',id:'layer-1'},'pose',4,{frameId:sourceId});
  const before=editor.serialize(),expected=Array.from({length:101},(_,i)=>shape(before,i/5));editor.select(1);editor.setOrigin(99);
  assert.ok(editor.report._styk.frameSources[sourceId].objects[0]._stykAnimationOrigin);
  for(let i=0;i<expected.length;i++)equalWorld(expected[i],shape(editor.report,i/5));
});
test('new instances initialize their virtual pivot and a split retains the physical rotation reference',()=>{
  const editor=fixture({authored:false});editor.setOrigin(301);const figure=editor.figure;
  const object=createObject(figure,99,320,210,{scale:1.7}),offset=animationOriginOffset(figure,object);
  assert.deepEqual(object._stykAnimationOrigin,{x:320+offset.x,y:210+offset.y});assert.equal(animationRotation(figure,object),0);
  // Split an unreversed reference after returning construction origin to the
  // original vertex; its first piece owns the same original tangent.
  editor.setOrigin(figure._styk.animationOrigin.handleId);const reference=editor.figure._styk.animationOrigin.rotationHandleId;
  editor.select(1,editor.figure.segments.findIndex(segment=>segment.segment_id===reference));
  const before=animationRotation(editor.figure,editor.object);editor.splitSegment(.4);
  assert.notEqual(editor.figure._styk.animationOrigin.rotationHandleId,reference);
  assert.ok(Math.abs(animationRotation(editor.figure,editor.object)-before)<1e-10);
});
test('native PIV retains tied segment and polygon paint order through required topology reordering',()=>{
  const editor=fixture({authored:false}),figure=editor.figure;
  figure.segments.forEach((segment,i)=>{segment.z_order=1;segment.color_rgb=[30+i*70,50,190];});
  figure.polyfills=[{polyfill_id:1,segment_ids:[0,7,99],color_rgb:[240,10,80],alpha_raw:0,z_order:1}];
  editor._invalidate();const expected=shape(editor.report,0).geometry.objects.get(0).drawables.map(item=>item.rgb);
  editor.setOrigin(99);const native=roundtrip(materializePivotDocument(editor.report),'piv');
  assert.deepEqual(shape(native,0).geometry.objects.get(0).drawables.map(item=>item.rgb),expected);
});
for(const authored of [false,true])test(`subsequent translated poses retain the preview and style edits retain their pivot (authored=${authored})`,()=>{
  const editor=fixture({authored}),report=editor.report;editor.setOrigin(99);editor.seek(7);editor.select(1);
  const before=editor.serialize(),origin=clone(editor.object._stykAnimationOrigin),history=editor._undo.length;
  editor.beginTranslationDrag();editor.moveSelection(15,-12,{fromStart:true});
  const expected={frame:clone(editor.selectionFrame),geometry:editor.geometry};editor.commitDrag();
  equalWorld(expected,{frame:editor.selectionFrame,geometry:editor.geometry});assert.equal(editor._undo.length,history+1);
  const comparable=()=>{const value=editor.serialize();if(authored)delete value._styk.frameSources;return value;};
  editor.undo();assert.deepEqual(comparable(),before);
  editor.updateObject({field28:77});assert.deepEqual(editor.object._stykAnimationOrigin,origin);editor.undo();
  editor.beginTranslationDrag();editor.moveSelection(15,-12,{fromStart:true});editor.moveSelection(0,0,{fromStart:true});editor.commitDrag();
  assert.deepEqual(comparable(),before);assert.equal(editor.report,report);
});
for(const authored of [false,true])test(`rig joint preview survives commit after reroot (authored=${authored})`,()=>{
  const editor=fixture({authored});editor.setOrigin(99);editor.seek(7);editor.select(1,0);
  const point=editor.geometry.objects.get(0).segments[0].end,before=editor.serialize();editor.beginRigDrag();editor.editRigJoint(point.x+6,point.y-4);
  const expected={frame:clone(editor.selectionFrame),geometry:editor.geometry};editor.commitRigDrag();
  equalWorld(expected,{frame:editor.selectionFrame,geometry:editor.geometry});editor.undo();assert.deepEqual(editor.serialize(),before);
});
test('local pivot offsets survive another reroot, dense interpolation, undo and native export',()=>{
  const editor=fixture();editor.setOrigin(99);editor.seek(7);editor.select(1,0);
  const point=editor.geometry.objects.get(0).segments[0].end;editor.beginRigDrag();editor.editRigJoint(point.x+6,point.y-4);editor.commitRigDrag();
  const before=editor.serialize(),expected=Array.from({length:101},(_,i)=>shape(before,i/5));
  assert.ok(Math.abs(editor.report.keyframes[0].objects[0]._stykAnimationOrigin.offsetX)>1e-5);
  editor.select(1);editor.setOrigin(301);const after=editor.serialize();
  for(let i=0;i<expected.length;i++)equalWorld(expected[i],shape(after,i/5));
  const styk=roundtrip(after,'styk'),native=roundtrip(materializePivotDocument(after),'piv');
  for(let tick=0;tick<=20;tick++){equalWorld(shape(before,tick),shape(styk,tick));equalWorld(shape(before,tick),shape(native,tick),.00035);}
  editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});
test('native writer changes keep untouched source PIV bytes identical',()=>{
  const script="import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path('backend').resolve()))\nimport server\nstore=server.ProjectStore(server.WORKSPACE)\npath=server.WORKSPACE/'Pivot Animator v5/Animations/tween_camera.piv'\nsource=path.read_bytes();imported=store.import_bytes(source,path.name)\noutput,_=store.export({**imported,'format':'piv'})\nassert output==source\nprint(len(output))";
  const python=backend.pythonCandidates()[0],result=spawnSync(python.command,[...python.args,'-c',script],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.error?.message);assert.ok(Number(result.stdout)>0);
});
