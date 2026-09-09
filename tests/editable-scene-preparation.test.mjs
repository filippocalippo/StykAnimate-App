import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createDemo} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {RetainedGeometryCache} from '../src/playback-geometry-cache.mjs';
import {EditableScenePreparation} from '../src/editable-scene-preparation.mjs';
globalThis.requestAnimationFrame??=(callback)=>setTimeout(callback,0);

test('cooperative editor geometry is exact, retains alternate poses and does not create history', async()=>{
  const e=new Editor({demo:false}).load(createDemo()), history=e.historySize,revision=e.revision;
  const first=e.geometry;e.selectFrame(1);
  const geometry=await e.prepareGeometry({sliceMs:0,yieldControl:()=>Promise.resolve()});
  assert.equal(e.geometry,geometry);assert.deepEqual(geometry.drawables,buildGeometry(e.report,e.evaluatedFrame).drawables);
  assert.equal(e.historySize,history);assert.equal(e.revision,revision);
  e.selectFrame(0);const restored=await e.prepareGeometry({sliceMs:0,yieldControl:()=>Promise.resolve()});
  for(const [slot,g]of first.objects)if(!g.obj.join)assert.equal(restored.objects.get(slot),g);
});

test('a seek or synchronous geometry request supersedes cooperative publication', async()=>{
  for(const action of ['seek','materialize']){
    const e=new Editor({demo:false}).load(createDemo());e.geometry;e.selectFrame(1);let changed=false;
    const job=e.prepareGeometry({sliceMs:0,yieldControl:()=>{
      if(!changed){changed=true;if(action==='seek')e.selectFrame(0);else e.geometry;}
      return Promise.resolve();
    }});
    await assert.rejects(job,{name:'AbortError'});
    assert.deepEqual(e.geometry.drawables,buildGeometry(e.report,e.evaluatedFrame).drawables);
  }
});

test('an aborted retained build cannot alter its alternate cache or last published scene', async()=>{
  const r=createDemo(),cache=new RetainedGeometryCache(),base=cache.get(r,r.keyframes[0],1),controller=new AbortController();
  const job=cache.getAsync(r,r.keyframes[1],1,{signal:controller.signal,sliceMs:0,yieldControl:()=>{controller.abort();return Promise.resolve();}});
  await assert.rejects(job,{name:'AbortError'});
  assert.equal(cache.geometry,base);assert.equal(cache.alternates.size,0);
});

test('transition cancellation releases unpublished resources and never activates stale work', async()=>{
  const e=new Editor({demo:false}).load(createDemo()),events=[];let resolveStage,activations=0,disposals=0;
  const ready=new Promise(resolve=>{resolveStage=resolve;});
  const renderer={prepareSceneUpdate:()=>ready};
  const transition=new EditableScenePreparation(e,{onPending:value=>events.push(value)});
  const promise=transition.start(renderer,()=>({frame:e.evaluatedFrame}));
  await new Promise(resolve=>setTimeout(resolve,10));transition.cancel();
  resolveStage({activate(){activations++;},dispose(){disposals++;},timings:{}});
  assert.equal(await promise,false);assert.equal(activations,0);assert.equal(disposals,1);
  assert.equal(transition.pending,false);assert.deepEqual(events,[true,false]);
});
