import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
function fixture(){const report=emptyDocument();report.keyframes=[0,1,2].map(i=>createFrame([createObject(report.figure_types[0],i+1,100+i*30,200)],4));return report;}
test('asynchronous scene preparation keeps old document live and publishes exact frame/geometry before listeners',async()=>{
  const editor=new Editor({demo:false}),previous=editor.report,report=fixture();let scene,events=0;
  editor.addEventListener('change',event=>{if(event.detail.kind==='document'){
    events++;assert.equal(editor.report,report);assert.equal(editor.frameIndex,2);assert.equal(editor.tick,8);
    assert.equal(editor.evaluatedFrame,scene.frame);assert.equal(editor.geometry,scene.geometry);
  }});
  await editor.loadAsync(report,'Prepared',{initialFrameIndex:'last',prepareScene:async context=>{
    assert.equal(editor.report,previous);assert.equal(context.frameIndex,2);assert.equal(context.tick,8);
    context.checkCurrent();await Promise.resolve();context.checkCurrent();assert.equal(events,0);
    scene={frame:context.frame,geometry:buildGeometry(context.report,context.frame)};return scene;
  }});
  assert.equal(events,1);assert.equal(editor.selectedUid,3);assert(Number.isFinite(editor.lastLoadTimings.sceneMs));
  const geometry=editor.geometry;editor.enableFrameDrafts({restoreSaved:false});editor.beginFrameDraft({mode:'add'});
  assert.equal(editor.geometry,geometry);
});
test('initial authored tick and saved Simple working-frame restoration use the prepared target',async()=>{
  const source=new Editor({demo:false}).load(fixture());source.addAnimationKey({kind:'figure',uid:2},'x',5,345);
  const editor=new Editor({demo:false});let prepared;
  await editor.loadAsync(source.serialize(),'Animated',{initialTick:5,prepareScene:async context=>{
    assert.equal(context.frameIndex,1);assert.equal(context.tick,5);assert.equal(context.frame.objects.find(o=>o.unique_id===2).root_x,345);
    return prepared={frame:context.frame,geometry:buildGeometry(context.report,context.frame)};
  }});assert.equal(editor.geometry,prepared.geometry);
  const draft=new Editor({demo:false}).load(fixture());draft.enableFrameDrafts();draft.selectFrame(1);draft.select(2);draft.beginFrameDraft({mode:'add'});draft.moveSelection(17,9);
  editor.enableFrameDrafts();
  await editor.loadAsync(draft.serialize(),'Working',{initialFrameIndex:0,prepareScene:async context=>{
    assert.equal(context.frameIndex,1);assert.equal(context.tick,4);
    return prepared={frame:context.frame,geometry:buildGeometry(context.report,context.frame)};
  }});
  assert.equal(editor.frameIndex,1);assert.equal(editor.tick,4);assert.equal(editor.geometry,prepared.geometry);assert(editor.frameDraft.dirty);
});
test('abort, scene failure and concurrent edits cannot publish a prepared scene or replace history',async()=>{
  for(const mode of ['abort','failure','edit','load','checkpoint']){
    const editor=new Editor({demo:false}).load(fixture());editor.enableFrameDrafts();const report=editor.report,history=editor._undo,signal=new AbortController();
    await assert.rejects(editor.loadAsync(fixture(),'Incoming',{signal:signal.signal,prepareScene:async context=>{
      await Promise.resolve();
      if(mode==='abort')signal.abort();
      if(mode==='failure')throw new Error('Media preparation failed.');
      if(mode==='edit')editor.moveSelection(4,0);
      if(mode==='load')editor.load(fixture(),'Newer');
      if(mode==='checkpoint')editor.beginFrameDraft({mode:'add'});
      return {geometry:buildGeometry(context.report,context.frame)};
    }}),mode==='failure'?/Media preparation failed/:{name:'AbortError'});
    if(mode==='load')assert.equal(editor.name,'Newer');else assert.equal(editor.report,report);
    if(['abort','failure','checkpoint'].includes(mode))assert.equal(editor._undo,history);
  }
});
