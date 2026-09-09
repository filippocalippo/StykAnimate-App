import test from 'node:test';
import assert from 'node:assert/strict';
import {Timeline} from '../src/timeline.mjs';
import {SimpleTimeline} from '../src/simple-timeline.mjs';

function queued(prototype,editor){const t=Object.create(prototype),queue=[],ranges=[];
  Object.assign(t,{editor,disposed:false,_selectionCount:()=>2,_setRange:(...args)=>ranges.push(args),
    runClipboardOperation:(kind,execute)=>new Promise((resolve,reject)=>queue.push({kind,execute,resolve,reject})),
    onRangeChange:()=>{},update:()=>{},ensureVisible:()=>{}});
  Object.defineProperty(t,'selectedFrameIndices',{value:[1,4],writable:true});
  return{t,queue,ranges,async run(options={}){const job=queue.shift();try{job.resolve(await job.execute(options));}catch(error){job.reject(error);}}};
}

test('Advanced clipboard queues immutable selection and insertion intent, selecting exact returned keys',async()=>{
  const calls=[],editor={_frameClipboardWorker:{},_documentToken:1,frameIndex:4,
    copyFramesAsync:async(indices,options)=>{calls.push({indices,options});return indices.length;},
    pasteFramesAsync:async(index,options)=>{calls.push({index,options});editor.frameIndex=9;return 3;}};
  const q=queued(Timeline.prototype,editor),signal=new AbortController().signal;
  const copy=q.t.copySelection();q.t.selectedFrameIndices=[2,7];await q.run({signal});assert.equal(await copy,2);
  assert.deepEqual(calls[0].indices,[1,4]);assert.equal(calls[0].options.signal,signal);
  const paste=q.t.pasteSelection();editor.frameIndex=6;await q.run();assert.equal(await paste,3);
  assert.equal(calls[1].index,5);assert.deepEqual(q.ranges,[[9],[11,true]]);
});

test('Advanced failed or cancelled clipboard leaves selection and propagates to guarded handler',async()=>{
  const editor={_frameClipboardWorker:{},_documentToken:1,frameIndex:4,pasteFramesAsync:async()=>{throw new DOMException('Cancelled','AbortError');}};
  const q=queued(Timeline.prototype,editor),paste=q.t.pasteSelection();const rejected=assert.rejects(paste,{name:'AbortError'});
  await q.run();await rejected;assert.deepEqual(q.ranges,[]);
});

test('Simple context Paste captures target and retains working draft through the async contract',async()=>{
  let called;const editor={_frameClipboardWorker:{},_documentToken:1,frameIndex:4,report:{keyframes:Array(8)},
    frameDraft:{mode:'add',dirty:true,empty:false},pasteFramesAsync:async(index,options)=>{called={index,options};return 2;}};
  const q=queued(SimpleTimeline.prototype,editor);q.t.confirmDiscardFrame=()=>{throw new Error('Context Paste must preserve working copy');};
  const paste=q.t._asyncClipboardAction('paste',{contextIndex:3});q.t.selectedFrameIndices=[6];editor.frameIndex=6;
  await q.run();assert.equal(await paste,2);assert.equal(called.index,3);assert.equal(called.options.storedFrames,true);assert.equal(called.options.preserveWorking,true);
});

test('Simple confirmed discard is staged by worker and never pre-mutates the working draft',async()=>{
  let called;const draft={mode:'add',dirty:true,empty:false},editor={_frameClipboardWorker:{},_documentToken:1,revision:0,frameIndex:4,
    report:{keyframes:Array(8)},frameDraft:draft,pasteFramesAsync:async(index,options)=>{called={index,options};throw new DOMException('Cancelled','AbortError');}};
  const q=queued(SimpleTimeline.prototype,editor);q.t.confirmDiscardFrame=async()=>true;
  const paste=q.t._asyncClipboardAction('paste');const rejected=assert.rejects(paste,{name:'AbortError'});
  await Promise.resolve();await q.run();await rejected;
  assert.equal(editor.frameDraft,draft);assert.equal(draft.dirty,true);assert.equal(called.index,1);assert.equal(called.options.preserveWorking,false);
});

test('Simple Paste at End requests Add mode atomically; empty Copy remains a no-op',async()=>{
  let called;const editor={_frameClipboardWorker:{},_documentToken:1,frameIndex:4,report:{keyframes:Array(8)},
    frameDraft:{mode:'update',empty:false},pasteFramesAsync:async(index,options)=>{called={index,options};return 1;}};
  const q=queued(SimpleTimeline.prototype,editor),paste=q.t._asyncClipboardAction('paste-end');await q.run();assert.equal(await paste,1);
  assert.equal(called.index,8);assert.equal(called.options.afterMode,'add');
  editor.frameDraft={mode:'add',empty:true};assert.equal(await q.t._asyncClipboardAction('copy'),0);assert.equal(q.queue.length,0);
});

test('Simple Cut All retains the working pose without an unnecessary discard prompt',async()=>{
  for(const mode of ['add','update']){
    let called;const editor={_frameClipboardWorker:{},_documentToken:1,frameIndex:1,report:{keyframes:Array(2)},
      frameDraft:{mode,dirty:true,empty:false},cutFramesAsync:async(indices,options)=>{called={indices,options};return 2;}};
    const q=queued(SimpleTimeline.prototype,editor);q.t.selectedFrameIndices=[0,1];
    q.t.confirmDiscardFrame=()=>{throw new Error('Cut All must retain the working pose');};
    const cut=q.t._asyncClipboardAction('cut');await q.run();assert.equal(await cut,2);
    assert.deepEqual(called.indices,[0,1]);assert.equal(called.options.storedFrames,true);assert.equal(called.options.preserveWorking,true);
  }
});
