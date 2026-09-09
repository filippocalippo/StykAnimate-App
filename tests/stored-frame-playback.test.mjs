import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';
import {storedFrameReport} from '../src/pivot-frame-draft.mjs';

function fixture() {
  const report=emptyDocument(); report.keyframes=[100,200,300].map(x=>createFrame([createObject(report.figure_types[0],1,x,250)],5));
  new Editor({demo:false}).load(report);
  const baseline=structuredClone(report.keyframes[1]);
  report.keyframes[1].objects[0].root_x=777;
  report._styk.simpleFrameDraft={version:1,mode:'add',index:1,frameId:baseline._styk.frameId,baseline};
  return report;
}
const rootX=packet=>packet.transforms[4];
const workerFactory=()=>{
  const worker=new Worker(new URL('./playback-node-worker.mjs',import.meta.url));
  return {postMessage:(...args)=>worker.postMessage(...args),terminate:()=>worker.terminate(),
    addEventListener:(name,fn)=>worker.on(name,value=>fn(name==='message'?{data:value}:value))};
};
test('stored playback excludes Add working pose and interpolates the stored baseline without mutation',async()=>{
  const report=fixture(),before=structuredClone(report);
  assert.equal(rootX(await compilePlaybackPacket(report,5)),777);
  const stored=await compilePlaybackPacket(report,5,{storedFrames:true});
  assert.equal(stored.storedFrames,true); assert.equal(rootX(stored),200);
  assert.deepEqual((await compilePlaybackPacket(report,7,{storedFrames:true})).transforms,
    (await compilePlaybackPacket(storedFrameReport(report),7)).transforms);
  assert.deepEqual(report,before);
  report._styk.simpleFrameDraft.mode='update';
  assert.equal(rootX(await compilePlaybackPacket(report,5,{storedFrames:true})),777);
});
test('stored worker view changes and metadata-only Add-to-Update patch retain the loaded document',async()=>{
  const report=fixture(),cache=new PlaybackCache({workerFactory});
  try {
    cache.load(report,{storedFrames:true}); await cache.prepareRange([5]);
    assert.equal(rootX(cache.get(5)),200);
    const loads=cache.stats.documentLoads;
    cache.updateView({storedFrames:false}); await cache.prepareRange([5]);
    assert.equal(rootX(cache.get(5)),777);
    cache.updateView({storedFrames:true}); await cache.prepareRange([5]);
    assert.equal(rootX(cache.get(5)),200);
    report._styk.simpleFrameDraft={...report._styk.simpleFrameDraft,mode:'update'};
    cache.updateDocument(report,{frameIndices:[],revision:1}); await cache.prepareRange([5]);
    assert.equal(rootX(cache.get(5)),777); assert.equal(cache.stats.documentLoads,loads);
  } finally {cache.dispose();}
});
