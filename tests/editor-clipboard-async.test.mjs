import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {runClipboardWorkerRequest} from '../src/clipboard-worker-plan.mjs';
import {nodeClipboardClient} from './helpers/clipboard-node-client.mjs';
import {materializeSimpleFrameDraftForPivot} from '../src/pivot-frame-draft.mjs';

const clone=structuredClone;
function fixture(version=5,count=8){const report=emptyDocument();report.version=version;
  report.keyframes=Array.from({length:6},(_,i)=>createFrame(Array.from({length:count},(_,j)=>createObject(report.figure_types[0],j+1,100+i*10+j*4,200)),i===2?0:3));
  return new Editor({demo:false}).load(report);
}
function client(options={}){return{lastTimings:{inputBytes:10000,outputBytes:20000},async run(payload,controls){
  controls.checkCurrent();options.before?.(payload,controls);
  const wire=await runClipboardWorkerRequest(clone(payload),{onProgress:controls.onProgress});
  options.after?.(wire,controls);controls.checkCurrent();return clone(wire);
}};}
function snapshot(e){return{report:e.report,document:clone(e.report),clipboard:e._frameClipboard,token:e._documentToken,
  undo:e._undo,redo:e._redo,undoValues:JSON.stringify(e._undo),redoValues:JSON.stringify(e._redo),drag:e._drag,authored:e._authoredPoseEdit,
  identity:e._nextFrameIdentity,uid:e._nextUid,revision:e.revision,frame:e.frameIndex,tick:e.tick};}
function unchanged(e,before){assert.deepEqual(snapshot(e),before);}

test('async copy is immutable and asynchronous same-document paste matches native sync behavior with reusable history',async()=>{
  const e=fixture(),reference=fixture(),before=clone(e.report),original=e.report;let yields=0;
  e.setFrameClipboardWorker(client());reference.copyFrames([0,2,5]);reference.pasteFrames(1);
  assert.equal(await e.copyFramesAsync([0,2,5]),3);assert.equal(e.report,original);assert.equal(e._undo.length,0);
  const clipboard=clone(e.frameClipboardDocument());
  assert.equal(await e.pasteFramesAsync(1,{yieldControl:async()=>{yields++;}}),3);
  assert.deepEqual(e.report,reference.report);assert.equal(e._undo.length,1);
  const after=clone(e.report),adopted=e.report;e.undo();assert.equal(e.report,original);assert.deepEqual(e.report,before);
  e.redo();assert.equal(e.report,adopted);assert.deepEqual(e.report,after);
  e.select(1);e.moveSelection(17,0);assert.deepEqual(e.frameClipboardDocument(),clipboard);e.undo();e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
});

test('async modern clipboard upgrades each legacy destination and preserves one exact report transition',async()=>{
  for(const version of [2,3,4]){
    const e=fixture();e.setFrameClipboardWorker(client());await e.copyFramesAsync([0,1]);
    e.load(fixture(version).report);const before=clone(e.report),token=e._documentToken,original=e.report;
    const reference=new Editor({demo:false}).load(clone(e.report));reference.restoreFrameClipboard(clone(e.frameClipboardDocument()));reference.pasteFrames(1);
    assert.equal(await e.pasteFramesAsync(1),2);assert.deepEqual(e.report,reference.report);assert.equal(e._documentToken,token);
    const after=clone(e.report);e.undo();assert.equal(e.report,original);assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
  }
});

test('cancelled copy and paste preserve a pending authored gesture, document and existing clipboard/history',async()=>{
  for(const operation of ['copy','paste']){
    const e=fixture();e.copyFrames([0]);e.addAnimationKeys([{target:{kind:'figure',uid:1},property:'x',tick:0,value:111}]);e.select(1);
    e.beginTranslationDrag();e.moveSelection(35,0);const before=snapshot(e),controller=new AbortController();
    e.setFrameClipboardWorker(client({after(){controller.abort();}}));
    await assert.rejects(operation==='copy'?e.copyFramesAsync([0],{signal:controller.signal}):e.pasteFramesAsync(1,{signal:controller.signal}),{name:'AbortError'});
    unchanged(e,before);
  }
});

test('worker or staging failures preserve document identity, active rig gesture and Redo',async()=>{
  for(const failure of ['worker','pose','staging']){
    const e=fixture();e.copyFrames([0]);e.select(1,0);e.moveSelection(3,0);e.undo();e.beginRigDrag();
    const end=e.geometry.objects.get(0).segments[0].end;e.editRigJoint(end.x+4,end.y+7);
    const before=snapshot(e),controller=new AbortController();
    e.setFrameClipboardWorker(client({before(){if(failure==='worker')throw new Error('worker failed');},after(wire){if(failure==='pose')wire.report.keyframes[0].objects[0].angles[0]=NaN;}}));
    await assert.rejects(e.pasteFramesAsync(1,{signal:controller.signal,onProgress(value){if(failure==='staging'&&value.phase==='staging')controller.abort();}}));
    unchanged(e,before);
  }
});

test('a later edit or frame seek supersedes a captured result without replacing the newer state',async()=>{
  for(const mutate of [e=>e.moveSelection(3,0),e=>e.selectFrame(3),e=>e.load(emptyDocument()),e=>e.beginAnimationEdit({kind:'figure',uid:1},'x')]){
    const e=fixture();e.copyFrames([0]);let changed;e.setFrameClipboardWorker(client({after(){mutate(e);changed=snapshot(e);}}));
    await assert.rejects(e.pasteFramesAsync(1),{name:'AbortError'});unchanged(e,changed);
  }
});

test('native single-key copy sends only its stored frame, used definitions and no original source blob',async()=>{
  const e=fixture();e.report._stykSource={source_base64:'x'.repeat(100000)};e.report.figure_types.push({...clone(e.report.figure_types[0]),figure_type_id:99,name:'Unused'});
  const before=clone(e.report);let sent;e.setFrameClipboardWorker(client({before(payload){sent=payload;}}));
  await e.copyFramesAsync([4]);assert.equal(sent.report.keyframes.length,1);assert.equal(sent.report.figure_types.length,1);assert.equal(sent.report._stykSource,undefined);
  assert.deepEqual(sent.state.indices,[0]);assert.equal(e._frameClipboard[0].objects[0].root_x,140);assert.deepEqual(e.report,before);
});

test('Paste waits for the latest pending copy and a cancelled replacement cannot reuse stale clipboard',async()=>{
  const e=fixture();e.setFrameClipboardWorker(client());e.copyFrames([0]);
  const first=e.copyFramesAsync([1]),latest=e.copyFramesAsync([4]);const pasted=e.pasteFramesAsync(1);
  await assert.rejects(first,{name:'AbortError'});assert.equal(await latest,1);assert.equal(await pasted,1);assert.equal(e.report.keyframes[1].objects[0].root_x,140);
  const controller=new AbortController(),copy=e.copyFramesAsync([0],{signal:controller.signal});controller.abort();const before=clone(e.report);
  await assert.rejects(e.pasteFramesAsync(1),{name:'AbortError'});await assert.rejects(copy,{name:'AbortError'});assert.deepEqual(e.report,before);
});

test('malformed worker selection and source metadata reject before committing the held edit',async()=>{
  for(const mutate of [wire=>{wire.generatedFrameSources={bad:true};},wire=>{wire.selection.frameIndex=NaN;},wire=>{wire.selection.uids=[NaN];},wire=>{wire.sourceTableWasPresent='yes';}]){
    const e=fixture();e.copyFrames([0]);e.beginTranslationDrag();e.moveSelection(9,0);const before=snapshot(e);
    e.setFrameClipboardWorker(client({after:mutate}));await assert.rejects(e.pasteFramesAsync(1),/invalid/);unchanged(e,before);
  }
});

test('async Simple stored paste/cut retain Add working poses and zero stored frame Undo',async()=>{
  for(const empty of [false,true]){
    const e=fixture();e.copyFrames([0,1]);e.enableFrameDrafts();e.beginFrameDraft({mode:'add'});
    // Empty state is only valid with one physical working frame.
    if(empty){e.load({...emptyDocument(),keyframes:[createFrame([])]});e.enableFrameDrafts();e.beginFrameDraft({mode:'add',empty:true});}
    const before=clone(e.report);e.setFrameClipboardWorker(client());
    await e.pasteFramesAsync(empty?0:2,{storedFrames:true,preserveWorking:!empty});const after=clone(e.report);
    assert.equal(e.frameDraft.empty,false);e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
  }
  const e=fixture();e.enableFrameDrafts();e.beginFrameDraft({mode:'add'});const before=clone(e.report);e.setFrameClipboardWorker(client());
  assert.equal(await e.cutFramesAsync([0,2],{storedFrames:true,preserveWorking:true}),2);assert.equal(e.clipboardFrameCount,2);assert.equal(e._undo.length,1);
  const after=clone(e.report);e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
});

test('Simple Cut All keeps clean/dirty Add and Update working poses with true zero stored keys',async()=>{
  for(const mode of ['add','update'])for(const dirty of [false,true]){
    const e=fixture(5,1);e.enableFrameDrafts();e.beginFrameDraft({mode,index:2});e.select(1);
    if(dirty)e.updateObject({root_x:999});
    const before=clone(e.report),working=clone(e.frame.objects),history=e._undo.length;
    const storedRoots=materializeSimpleFrameDraftForPivot(e.report).keyframes.map(frame=>frame.objects[0].root_x);
    const indices=e.report.keyframes.map((_,index)=>index);e.setFrameClipboardWorker(client());
    assert.equal(await e.cutFramesAsync(indices,{storedFrames:mode==='add',preserveWorking:false}),6);
    assert.equal(e.clipboardFrameCount,6);assert.deepEqual(e._frameClipboard.map(frame=>frame.objects[0].root_x),storedRoots);
    assert.equal(e.frameDraft.mode,'add');assert.equal(e.frameDraft.empty,true);assert.equal(e.frameDraft.storedCount,0);
    assert.equal(e.totalTicks,0);assert.equal(materializeSimpleFrameDraftForPivot(e.report).keyframes.length,0);
    assert.deepEqual(e.frame.objects,working);assert.equal(e._undo.length,history+1);
    const after=clone(e.report);e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
  }
  const e=fixture(5,1);e.copyFrames([0]);e.enableFrameDrafts();e.beginFrameDraft({mode:'add'});e.select(1);e.updateObject({root_x:999});
  const before=snapshot(e),controller=new AbortController();e.setFrameClipboardWorker(client({after(){controller.abort();}}));
  await assert.rejects(e.cutFramesAsync([0,1,2,3,4,5],{storedFrames:true,signal:controller.signal}),{name:'AbortError'});unchanged(e,before);
});

test('successful pending authored and rig gestures are retained before asynchronous paste',async()=>{
  for(const mode of ['authored','rig']){
    const e=fixture();e.copyFrames([0]);e.setFrameClipboardWorker(client());e.select(1,0);
    if(mode==='authored'){e.addAnimationKeys([{target:{kind:'figure',uid:1},property:'x',tick:0,value:111}]);e.beginTranslationDrag();e.moveSelection(35,0);}
    else{e.beginRigDrag();const end=e.geometry.objects.get(0).segments[0].end;e.editRigJoint(end.x+4,end.y+7);}
    const preview=clone(e.geometry.objects.get(0).joints),history=e._undo.length;await e.pasteFramesAsync(e.report.keyframes.length);
    assert.equal(e._undo.length,history+2);e.selectFrame(0);assert.deepEqual(e.geometry.objects.get(0).joints,preview);
    const after=clone(e.report);e.undo();assert.deepEqual(e.geometry.objects.get(0).joints,preview);e.redo();assert.deepEqual(e.report,after);
  }
});

test('restored owned clipboard is validated cooperatively and adopted without a second full clone',async()=>{
  const e=fixture();e.copyFrames([0,2]);const report=clone(e.frameClipboardDocument()),restored=fixture();
  assert.equal(await restored.restoreFrameClipboardAsync(report),2);assert.equal(restored._frameClipboard,report.keyframes);assert.equal(restored.frameClipboardDocumentView(),report);
  const controller=new AbortController(),before=restored._frameClipboard;controller.abort();await assert.rejects(restored.restoreFrameClipboardAsync(clone(report),{signal:controller.signal}),{name:'AbortError'});assert.equal(restored._frameClipboard,before);
});

test('the actual isolated worker copies, upgrades, cuts and returns bounded editable results',async()=>{
  const e=fixture(),worker=nodeClipboardClient();e.setFrameClipboardWorker(worker);
  try{
    assert.equal(await e.copyFramesAsync([0,2,5]),3);e.load(fixture(4,20).report);const before=clone(e.report),token=e._documentToken;
    assert.equal(await e.pasteFramesAsync(1),3);assert.equal(e.report.version,5);assert.equal(e._documentToken,token);
    assert.ok(e.lastClipboardTimings.inputChunks>=3);assert.ok(e.lastClipboardTimings.outputChunks>=1);
    const after=clone(e.report);e.undo();assert.deepEqual(e.report,before);e.redo();assert.deepEqual(e.report,after);
    assert.equal(await e.cutFramesAsync([0,2]),2);assert.equal(e.clipboardFrameCount,2);e.undo();assert.deepEqual(e.report,after);
  }finally{worker.dispose();}
});

test('native Paste sends only destination timing and UID metadata, preserving every untouched existing frame',async()=>{
  const e=fixture(5,120),reference=fixture(5,120),beforeFrames=e.report.keyframes.slice();
  e.copyFrames([2]);reference.copyFrames([2]);reference.pasteFrames(1);
  e.report._stykSource={base64:'unused-source'.repeat(10000),sha256:'owned-original'};const source=e.report._stykSource;
  let payloadSeen=false,resultSeen=false;
  e.setFrameClipboardWorker(client({before(payload){
    payloadSeen=true;assert.equal(payload.request.sparseNativePaste,true);assert.equal(payload.report.keyframes.length,6);
    assert.ok(payload.report.keyframes.every(frame=>frame.objects.length===0));assert.equal(payload.report._stykSource,undefined);
    assert.deepEqual(payload.report.keyframes.map(frame=>frame._styk.frameId),beforeFrames.map(frame=>frame._styk.frameId));
    assert.equal(payload.state.destinationSummary.objectCount,720);assert.equal(payload.state.destinationSummary.uidCounts.length,120);
  },after(wire){resultSeen=true;assert.equal(wire.report,null);assert.equal(wire.sparsePaste.frames.length,1);}}));
  assert.equal(await e.pasteFramesAsync(1),1);assert(payloadSeen&&resultSeen);assert.equal(e.report._stykSource,source);
  for(let i=0;i<beforeFrames.length;i++)assert.equal(e.report.keyframes[i+(i>=1?1:0)],beforeFrames[i]);
  assert.deepEqual(e.report.keyframes,reference.report.keyframes);
  e.selectFrame(1);e.select(1);e.moveSelection(5,0);e.undo();e.undo();
  assert.deepEqual(e.report.keyframes,beforeFrames);assert.equal(e.report._stykSource,source);
});

test('native clipboard preserves valid unsigned imported identities above the signed allocator range',async()=>{
  const e=fixture(),report=e.report;
  for(const frame of report.keyframes)frame.objects[0].unique_id=0xfffffff0;
  e.load(report);e.setFrameClipboardWorker(client());const before=clone(e.report);
  assert.equal(await e.copyFramesAsync([0]),1);assert.equal(await e.pasteFramesAsync(1),1);
  assert.equal(e.report.keyframes[1].objects[0].unique_id,0xfffffff0);
  e.undo();assert.deepEqual(e.report,before);
});

test('Copy and Paste preserve the permanent Scene and Camera track selection',async()=>{
  for(const id of ['scene','camera'])for(const legacy of [false,true]){
    const e=fixture();e.setFrameClipboardWorker(client());e.setActiveLayer(id);
    assert.equal(await e.copyFramesAsync([0]),1);
    if(legacy){e.load(fixture(4).report);e.setActiveLayer(id);}
    const before=clone(e.report);assert.equal(await e.pasteFramesAsync(1),1);
    assert.equal(e._selectionState().activeLayerId,id);e.undo();assert.deepEqual(e.report,before);
  }
});
