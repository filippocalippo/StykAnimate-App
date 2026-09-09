import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {prepareSparseClipboardPaste,prepareOwnedSparseClipboardPaste,commitSparseClipboardPaste} from '../src/editor-clipboard-sparse.mjs';

function fixture() {
  const source=emptyDocument();
  source.keyframes=[createFrame([createObject(source.figure_types[0],1,120,180)],2)];
  const reference=new Editor({demo:false}).load(source);reference.copyFrames([0]);
  const destination=emptyDocument();destination.figure_types[0].segments[0].length+=7;
  reference.load(destination);
  const editor=new Editor({demo:false}).load(structuredClone(reference.report));
  reference.pasteFrames(1);
  const command=reference._undo.at(-1);
  const wire={index:1,frames:structuredClone(command.after),assets:structuredClone(command.clipboardAssets),
    afterSelection:structuredClone(command.afterSelection),nextFrameIdentity:reference._nextFrameIdentity,nextUid:reference._nextUid};
  assert.equal(wire.assets.figures.length,1);
  return {editor,wire};
}

function graphFixture(wire) {
  const shared={sentinel:73},numbers=new Array(513),metadata=Object.create(null);
  numbers[0]=0;numbers[255]=-.5;numbers[511]=undefined;numbers[512]=3.5;numbers.label='Sparse native values';
  Object.defineProperty(numbers,'__proto__',{value:shared,writable:true,enumerable:true,configurable:true});
  metadata.values=numbers;metadata.shared=shared;metadata.__proto__=shared;
  const graph={numbers,metadata,first:shared,second:shared};
  wire.frames[0].native_unknown=graph;wire.assets.figures[0].native_unknown=graph;
  const angles=wire.frames[0].objects[0].angles;
  angles.native_note=shared;
  Object.defineProperty(angles,'__proto__',{value:metadata,writable:true,enumerable:true,configurable:true});
  return graph;
}

function assertGraph(frame,figure) {
  const graph=frame.native_unknown,{numbers,metadata,first,second}=graph;
  assert.equal(figure.native_unknown,graph,'Frame and asset metadata retain their shared graph');
  assert.equal(first,second);assert.equal(metadata.shared,first);assert.equal(metadata.__proto__,first);
  assert.equal(Object.getPrototypeOf(metadata),null);
  assert.equal(Object.getPrototypeOf(numbers),Array.prototype);
  assert.equal(numbers.length,513);assert.equal(numbers[0],0);assert.equal(numbers[255],-.5);assert.equal(numbers[512],3.5);
  assert.equal(Object.hasOwn(numbers,1),false,'Array holes stay absent');
  assert.equal(Object.hasOwn(numbers,510),false);
  assert.equal(Object.hasOwn(numbers,511),true,'An explicit undefined stays present');
  assert.equal(numbers[511],undefined);assert.equal(numbers.label,'Sparse native values');
  assert.equal(Object.hasOwn(numbers,'__proto__'),true);assert.equal(numbers.__proto__,first);
  assert.equal(metadata.values,numbers);assert.equal(first.sentinel,73);
  const angles=frame.objects[0].angles;
  assert.equal(angles.native_note,first,'Dense numeric pose arrays preserve custom enumerable values');
  assert.equal(Object.getPrototypeOf(angles),Array.prototype);
  assert.equal(Object.hasOwn(angles,'__proto__'),true);assert.equal(angles.__proto__,metadata);
  return graph;
}

for(const [name,prepare,owned] of [
  ['public',prepareSparseClipboardPaste,false],['owned',prepareOwnedSparseClipboardPaste,true],
])test(`${name} clipboard copy preserves sparse arrays, safe own __proto__ properties, null records and shared metadata`,async()=>{
  const {editor,wire}=fixture(),input=graphFixture(wire),oldFrame=editor.report.keyframes[0];
  const prepared=await prepare(editor,wire,{yieldControl:async()=>{}});
  commitSparseClipboardPaste(editor,prepared);
  const command=editor._undo.at(-1),history=assertGraph(command.after[0],command.clipboardAssets.figures[0]),
    live=assertGraph(editor.report.keyframes[1],editor.report.figure_types[wire.assets.figureIndex]);
  assert.equal(history===input,owned);assert.notEqual(live,input);assert.notEqual(live,history);
  assert.notEqual(live.numbers,history.numbers);assert.notEqual(live.metadata,history.metadata);assert.notEqual(live.first,history.first);
  assert.equal(editor.report.keyframes[0],oldFrame);
  live.first.sentinel=999;live.numbers[255]=42;live.metadata.extra=true;
  assertGraph(command.after[0],command.clipboardAssets.figures[0]);
  assert.equal(Object.hasOwn(history.metadata,'extra'),false);
  editor.undo();assert.equal(editor.report.keyframes.length,1);assert.equal(editor.report.keyframes[0],oldFrame);
  editor.redo();assert.equal(editor.report.keyframes[1].native_unknown,live);
  assert.equal(editor.report.figure_types[wire.assets.figureIndex].native_unknown,live);
  assertGraph(command.after[0],command.clipboardAssets.figures[0]);
});

test('public preparation snapshots metadata before caller mutations and keeps live/history copies independent',async()=>{
  const {editor,wire}=fixture(),input=graphFixture(wire);
  const prepared=await prepareSparseClipboardPaste(editor,wire,{yieldControl:async()=>{}});
  input.first.sentinel=11;input.numbers[255]=17;input.metadata.extra='caller mutation';
  wire.frames[0].objects[0].angles[0]=.9;
  commitSparseClipboardPaste(editor,prepared);
  const command=editor._undo.at(-1);
  assertGraph(command.after[0],command.clipboardAssets.figures[0]);
  assertGraph(editor.report.keyframes[1],editor.report.figure_types[wire.assets.figureIndex]);
  assert.notEqual(editor.report.keyframes[1].objects[0].angles[0],.9);
  assert.equal(Object.hasOwn(command.after[0].native_unknown.metadata,'extra'),false);
});

test('numeric array fast copying preserves a numeric own prototype key and checkpoints groups of short vectors',async t=>{
  const {editor,wire}=fixture(),vectors=Array.from({length:512},()=>Array.from({length:127},(_,i)=>i));
  Object.defineProperty(vectors[0],'__proto__',{value:71,enumerable:true,writable:true,configurable:true});
  wire.frames[0].native_unknown=vectors;
  let clock=0,yields=0;t.mock.method(performance,'now',()=>clock+=.5);
  const prepared=await prepareOwnedSparseClipboardPaste(editor,wire,{yieldControl:async()=>{yields++;}});
  assert.ok(yields>10,'Short vector groups remain cooperative as well as one long vector');
  commitSparseClipboardPaste(editor,prepared);
  const copied=editor.report.keyframes[1].native_unknown;
  assert.equal(Object.getPrototypeOf(copied[0]),Array.prototype);
  assert.equal(Object.hasOwn(copied[0],'__proto__'),true);assert.equal(copied[0].__proto__,71);
  assert.deepEqual(copied,vectors);assert.notEqual(copied[0],vectors[0]);
});

const phaseNames=['history','layers','indexing','validation','live','selection'];
function assertTiming(metrics,{completed,yields}) {
  assert.equal(metrics.completed,completed);assert.equal(metrics.yields,yields);
  for(const [name,phase] of [['total',metrics],...Object.entries(metrics.phases)]) {
    for(const key of ['elapsedMs','cpuMs','maxTaskMs'])
      assert.ok(Number.isFinite(phase[key])&&phase[key]>=0,`${name}.${key} is a finite nonnegative duration`);
    for(const key of ['slices','yields'])
      assert.ok(Number.isSafeInteger(phase[key])&&phase[key]>=0,`${name}.${key} is a nonnegative count`);
    assert.ok(phase.elapsedMs>=phase.cpuMs,`${name} elapsed time includes CPU work`);
    assert.ok(phase.cpuMs>=phase.maxTaskMs,`${name} maximum task fits within total CPU time`);
  }
}

for(const [name,prepare] of [['public',prepareSparseClipboardPaste],['owned',prepareOwnedSparseClipboardPaste]])
test(`${name} staging reports all phases once and excludes cooperative waits from CPU timing`,async t=>{
  const {editor,wire}=fixture();wire.frames[0].native_unknown=Array.from({length:2300},(_,index)=>index/2);
  let clock=0,yields=0;const timings=[];
  t.mock.method(performance,'now',()=>clock+=.5);
  const prepared=await prepare(editor,wire,{onTiming:metrics=>timings.push(structuredClone(metrics)),
    yieldControl:async()=>{yields++;clock+=25;}});
  assert.equal(timings.length,1);const metrics=timings[0];assertTiming(metrics,{completed:true,yields});
  assert.deepEqual(Object.keys(metrics.phases).sort(),phaseNames.slice().sort());
  assert.ok(yields>0);assert.ok(metrics.elapsedMs-metrics.cpuMs>=25*yields,'Scheduler wait is elapsed time, not CPU work');
  assert.equal(editor.report.keyframes.length,1,'Timing notification does not publish the prepared graph');
  commitSparseClipboardPaste(editor,prepared);assert.equal(timings.length,1);
});

test('cancelling a metadata copy reports incomplete timing once without publishing any staged state',async()=>{
  const {editor,wire}=fixture();wire.frames[0].native_unknown=Array.from({length:2300},(_,index)=>({value:index}));
  const report=editor.report,before=structuredClone(report),frames=report.keyframes,figures=report.figure_types,
    layers=report._styk.layers,selection=editor._selectionState(),revision=editor.revision,identity=editor._nextFrameIdentity,uid=editor._nextUid;
  const controller=new AbortController(),timings=[];let yields=0;
  await assert.rejects(prepareSparseClipboardPaste(editor,wire,{signal:controller.signal,
    onTiming:metrics=>timings.push(structuredClone(metrics)),yieldControl:async()=>{yields++;controller.abort();}}),{name:'AbortError'});
  assert.equal(yields,1);assert.equal(timings.length,1);assertTiming(timings[0],{completed:false,yields});
  assert.equal(editor.report,report);assert.deepEqual(report,before);assert.equal(report.keyframes,frames);
  assert.equal(report.figure_types,figures);assert.equal(report._styk.layers,layers);assert.deepEqual(editor._selectionState(),selection);
  assert.equal(editor.revision,revision);assert.equal(editor._nextFrameIdentity,identity);assert.equal(editor._nextUid,uid);
  assert.equal(editor._undo.length,0);assert.equal(editor._redo.length,0);
});
