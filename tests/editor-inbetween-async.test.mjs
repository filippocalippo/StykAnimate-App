import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {planInsertInbetweens,planInsertInbetweenSteps} from '../src/editor-inbetween.mjs';
import {inbetweenPlanWire} from '../src/editor-inbetween-async.mjs';

const clone=value=>structuredClone(value);
function fixture(frames=5,count=8){
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:frames},(_,i)=>createFrame(Array.from({length:count},(_,j)=>createObject(figure,j+1,i*20+j*5,200,{join:j%2?{target_object_slot:j-1,target_handle_id:2}:null})),i===2?0:3));
  return new Editor({demo:false}).load(report);
}
function snapshot(e){return{report:e.report,frames:e.report.keyframes,animation:e.report._styk.animation,sources:e.report._styk.frameSources,
  revision:e.revision,identity:e._nextFrameIdentity,frame:e.frameIndex,tick:e.tick,undo:e._undo,redo:e._redo};}
function planner(e,mutate=value=>value){return async request=>mutate(inbetweenPlanWire(planInsertInbetweens(e,request.ratio,request.indices)));}

test('async chosen ratio matches synchronous native poses, hidden durations and one undo with reusable report copies',async()=>{
  const editor=fixture(30,40),before=clone(editor.report),frames=editor.report.keyframes.slice(),state=snapshot(editor),expected=new Editor({demo:false}).load(clone(before));
  const reference=expected.insertInbetweenFrames(.37,[1,2,29]);let yields=0,edits=0;
  editor.addEventListener('change',event=>{if(event.detail.kind==='edit')edits++;});
  const result=await editor.insertInbetweenFramesAsync(.37,[1,2,29],{planInbetweens:planner(editor),yieldControl:async()=>{yields++;assert.deepEqual(snapshot(editor),state);}});
  assert(yields>0);assert.equal(edits,1);assert.deepEqual(result,reference);assert.deepEqual(editor.report,expected.report);assert.equal(editor._undo.length,1);
  assert.equal(editor._undo[0].reuseFrameCopies,true);assert.equal(editor.report.keyframes[0],frames[0]);
  assert.equal(editor._layerUidCounts.get(1),33);const inserted=editor.report.keyframes[1];
  assert.notEqual(inserted,editor._undo[0].changes[0].after[0]);
  editor.select(1);editor.moveSelection(5,0);editor.undo();editor.undo();assert.deepEqual(editor.report,before);assert.equal(editor._layerUidCounts.get(1),30);
  editor.redo();assert.deepEqual(editor.report,expected.report);assert.equal(editor.report.keyframes[1],inserted);assert.equal(editor._layerUidCounts.get(1),33);
  assert(Number.isFinite(editor.lastInbetweenTimings.commitMs));
});

test('async authored insertion preserves scoped channels and retained source history across later rig edits',async()=>{
  const editor=fixture();editor.adoptNativePoseTrack({kind:'layer',id:'layer-1'});editor.adoptNativePoseTrack({kind:'camera'});
  editor.addAnimationKeys([{target:{kind:'figure',uid:1},property:'x',tick:0,value:80},{target:{kind:'figure',uid:1},property:'x',tick:8,value:120}]);
  const before=clone(editor.report),history=editor._undo.length,reference=new Editor({demo:false}).load(clone(before));
  reference.insertInbetweenFrames(.5,[1,2,4]);
  await editor.insertInbetweenFramesAsync(.5,[1,2,4],{planInbetweens:planner(editor)});
  assert.deepEqual(editor.report,reference.report);assert.equal(editor._undo.length,history+1);
  const command=editor._undo.at(-1),id=command.frameSourceChanges[0].id;
  assert.notEqual(editor.report._styk.frameSources[id],command.frameSourceChanges[0].after.value);
  const after=clone(editor.report);editor.select(1);const definition=clone(editor.figure);definition.segments[0].length=150;
  editor.replaceFigureDefinition(definition.figure_type_id,definition);editor.undo();editor.undo();assert.deepEqual(editor.report,before);
  editor.redo();assert.deepEqual(editor.report,after);
});

test('cancellation during worker planning and staged cloning leaves report, history and identifiers untouched',async()=>{
  const editor=fixture(10,40),before=snapshot(editor),controller=new AbortController();
  await assert.rejects(editor.insertInbetweenFramesAsync(.5,[1,2],{signal:controller.signal,planInbetweens:async request=>{
    const wire=await planner(editor)(request);controller.abort();return wire;
  }}),{name:'AbortError'});assert.deepEqual(snapshot(editor),before);
  const staging=new AbortController();let staged=false;
  await assert.rejects(editor.insertInbetweenFramesAsync(.5,[1,2],{signal:staging.signal,planInbetweens:planner(editor),onProgress:progress=>{
    if(progress.phase==='staging'){staged=true;staging.abort();}
  }}),{name:'AbortError'});assert(staged);assert.deepEqual(snapshot(editor),before);
});

test('a changed document, selection time or Simple checkpoint supersedes a pending insertion',async()=>{
  for(const mutate of [e=>e.selectFrame(2),e=>e.moveSelection(4,0),e=>e.load(emptyDocument(),'Newer'),e=>{e.enableFrameDrafts();e.beginFrameDraft({mode:'add'});}]){
    const editor=fixture(),frameCount=editor.report.keyframes.length;let expected;
    await assert.rejects(editor.insertInbetweenFramesAsync(.5,[1],{planInbetweens:async request=>{const wire=await planner(editor)(request);mutate(editor);expected=snapshot(editor);return wire;}}),{name:'AbortError'});
    assert.deepEqual(snapshot(editor),expected);assert(editor.report.keyframes.length<=frameCount);
  }
});

test('untrusted worker plans with invalid poses, identity allocations, timing or missing authored channels reject atomically',async()=>{
  const mutations=[wire=>{wire.entries[0].frame.objects[0].angles[0]=NaN;},wire=>{wire.entries[0].duration++;},
    wire=>{wire.entries[0].frame._styk.frameId='frame-1';},wire=>{wire.nextFrameIdentity++;},wire=>{wire.entries[0].frame.camera={is_default:false,x:0,y:0,scale:0};}];
  for(const mutate of mutations){const editor=fixture(),before=snapshot(editor);await assert.rejects(editor.insertInbetweenFramesAsync(.5,[1],{planInbetweens:planner(editor,wire=>{mutate(wire);return wire;})}));assert.deepEqual(snapshot(editor),before);}
  const editor=fixture();editor.adoptNativePoseTrack({kind:'camera'});const before=snapshot(editor);
  await assert.rejects(editor.insertInbetweenFramesAsync(.5,[1],{planInbetweens:planner(editor,wire=>({...wire,animation:null}))}));assert.deepEqual(snapshot(editor),before);
});

test('worker-safe generator needs only report and identity allocator, yields, and never clones derived runtime caches',()=>{
  const editor=fixture();for(const object of editor.report.keyframes[0].objects)object.runtime_segments=[()=>{throw new Error('Derived cache must not clone');}];
  const iterator=planInsertInbetweenSteps({report:editor.report,_nextFrameIdentity:editor._nextFrameIdentity},0,[1]);
  let count=0,step;do{step=iterator.next();if(!step.done)count++;}while(!step.done);
  assert(count>0);assert(step.value.entries[0].frame.objects.every(object=>!('runtime_segments'in object)));
});

test('empty range is a no-op even with authored channels, and invalid ratio never finishes an active drag',async()=>{
  const editor=fixture();editor.adoptNativePoseTrack({kind:'camera'});const before=snapshot(editor);
  assert.equal((await editor.insertInbetweenFramesAsync(.5,[])).insertedFrames,0);assert.deepEqual(snapshot(editor),before);
  editor.select(1);editor.beginDrag();const drag=editor._drag;await assert.rejects(editor.insertInbetweenFramesAsync(-1,[1]));assert.equal(editor._drag,drag);
});
