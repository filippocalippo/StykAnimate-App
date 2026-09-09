import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {PlaybackPlanner, PlaybackPlanningService, inbetweenPlanPayload} from '../src/playback-planning.mjs';
import {PlaybackCache} from '../src/playback.mjs';

function fixture() {
  const retained = {id: 'retained', keys: [{id: 'key-1', tick: 0, value: 1}]};
  const changed = {id: 'changed', keys: []};
  const source = {_styk: {frameId: 'frame-5'}, objects: [{unique_id: 1, angles: Array.from({length: 6000}, (_, i) => i / 100)}]};
  const frame = {_styk: {frameId: 'frame-4'}, objects: [{unique_id: 1, angles: Array.from({length: 12000}, (_, i) => i / 100)}], duration_raw: 3};
  const pose = {}; pose.self = pose;
  return {entries: [{index: 1, insertedIndex: 1, originalTick: 3, tick: 3, ratio: .5, sourceIndex: 0,
    sampleRatio: .5, duration: 3, cumulativeDuration: 3, sourceTick: 1.5, frame, pose, sourceId: 'frame-5',
    internalEvaluationReference: {unrelatedReport: 'must stay in the worker'}}], skippedIndices: [], nextFrameIdentity: 6,
    animation: {before: {version: 1, nextKeyId: 2, channels: [retained, changed]},
      after: {version: 1, nextKeyId: 3, channels: [retained, {...changed, keys: [{id: 'key-2', tick: 3, value: {frameId: 'frame-5'}}]}]},
      sources: [source], patch: {historicalDuplicate: source}}};
}
const request = {ratio: .5, indices: [1], nextFrameIdentity: 4};
const waitUntil = async predicate => {
  const end = performance.now()+2000;
  while (!predicate()) {if (performance.now()>end) throw new Error('Timed out waiting for protocol state'); await new Promise(resolve=>setTimeout(resolve,1));}
};
function connection(inbetweenPlanner, {holdChunks = false} = {}) {
  const sent = [], acknowledgements = [], owner = {revision: 1, report: {}, stats: {}, timeoutMs: 1000, _loadWorker: () => Promise.resolve()};
  let receive, held; const snapshot = {revision: 1, report: owner.report};
  const service = new PlaybackPlanningService({snapshot: () => snapshot, inbetweenPlanner, postMessage(message) {
    const copy = structuredClone(message); sent.push(copy);
    if (holdChunks && copy.type === 'inbetween-chunk') held = copy;
    else queueMicrotask(() => receive(copy));
  }});
  owner.worker = {postMessage(message) {const copy = structuredClone(message); acknowledgements.push(copy); queueMicrotask(() => service.receive(copy));}};
  const client = new PlaybackPlanner(owner); receive = message => client.receive(message);
  return {client, service, owner, sent, acknowledgements, held: () => held, deliver: message => receive(message)};
}

test('inbetween payload keeps each captured frame once and drops evaluated graphs and history', () => {
  const plan = fixture(), payload = inbetweenPlanPayload(plan).plan;
  assert.equal(payload.entries[0].frame, plan.entries[0].frame);
  assert.equal(payload.animation.sources, plan.animation.sources);
  assert.equal(payload.entries[0].pose, undefined); assert.equal(payload.entries[0].internalEvaluationReference, undefined);
  assert.equal(payload.animation.before, undefined); assert.equal(payload.animation.patch, undefined); assert.equal(payload.animation.after, undefined);
  assert.deepEqual(payload.animation.channelUpdates.map(item => item.id), ['changed']);
  assert.deepEqual(payload.animation.channelOrder, ['retained', 'changed']);
  assert.equal(payload.animation.nextKeyId, 3); assert.equal(payload.version, 1);
  assert.doesNotThrow(() => structuredClone(payload));
});

test('inbetween reverse ACK transport stages bounded chunks with progress and no mirror edits', async () => {
  const plan = fixture(), progress = [];
  const c = connection(function* (editor, ratio, indices) {
    assert.equal(editor.report, c.owner.report); assert.equal(editor._nextFrameIdentity, 4);
    assert.equal(ratio, .5); assert.deepEqual(indices, [1]);
    yield {phase: 'sampling', completed: 1, total: 1}; return plan;
  });
  const result = await c.client.planInsertInbetweens(request, {onProgress: value => progress.push(value)});
  assert.deepEqual(result, inbetweenPlanPayload(plan).plan); assert.deepEqual(c.owner.report, {});
  assert.deepEqual(progress, [{phase: 'sampling', completed: 1, total: 1}]);
  const chunks = c.sent.filter(message=>message.type==='inbetween-chunk');
  assert.ok(chunks.length>2); assert.ok(chunks.every(message=>(message.chunk.estimatedBytes??0)<=64*1024));
  assert.equal(c.owner.stats.inbetweenChunks, chunks.length);
  assert.deepEqual(c.acknowledgements.filter(message=>message.type==='inbetween-ack').map(message=>message.sequence), chunks.map(message=>message.sequence));
  assert.equal(c.client.pending, null);
});

test('cancellation drops unpublished inbetween chunks and excludes overlapping migration jobs', async () => {
  const c = connection(function* () {return fixture();}, {holdChunks: true}), controller = new AbortController();
  const pending = c.client.planInsertInbetweens(request, {signal: controller.signal});
  const rejected = assert.rejects(pending, {name: 'AbortError'});
  await waitUntil(c.held);
  await assert.rejects(c.client.planLayerMigration({uids: [1], targetLayerId: 'layer-2'}), /already/);
  c.service.receive({type: 'plan-layer-migration', revision: 1, jobId: 999, request: {}});
  assert.equal(c.service.active.kind, 'inbetween');
  controller.abort(); await rejected; c.deliver(c.held()); await waitUntil(()=>!c.service.busy);
  assert.equal(c.client.pending, null); assert.deepEqual(c.owner.report, {});
});

test('supersession during sampling closes the generator without publishing its plan', async () => {
  let closed = false;
  const c = connection(function* () {try {yield {phase: 'sampling', completed: 1, total: 2}; return fixture();} finally {closed = true;}});
  const controller = new AbortController();
  await assert.rejects(c.client.planInsertInbetweens(request, {signal: controller.signal, onProgress: ()=>controller.abort()}), {name: 'AbortError'});
  await waitUntil(()=>closed); assert.equal(c.sent.some(message=>message.type==='inbetween-complete'), false);
  assert.deepEqual(c.owner.report, {});
});

test('malformed ordering and oversized partial inbetween transfers reject without publication', async () => {
  const c = connection(function* () {return fixture();}, {holdChunks: true});
  const pending = c.client.planInsertInbetweens(request), rejected = assert.rejects(pending, /order|Invalid/);
  await waitUntil(c.held); c.deliver({...c.held(), sequence: 5}); await rejected;
  const bounded = connection(function* () {return fixture();}), post = bounded.owner.worker.postMessage;
  bounded.owner.worker.postMessage = message => post(message.type === 'plan-insert-inbetween' ? {...message, maxBytes: 70000} : message);
  await assert.rejects(bounded.client.planInsertInbetweens(request), /result budget/);
  const chunks = bounded.sent.filter(message=>message.type==='inbetween-chunk');
  assert.ok(chunks.length>1); assert.ok(chunks.reduce((sum,message)=>sum+(message.chunk.estimatedBytes??0),0)<=70000);
  assert.equal(bounded.client.pending, null); assert.deepEqual(bounded.owner.report, {});
});

function actualCache() {
  return new PlaybackCache({workerFactory: () => {
    const worker = new Worker(new URL('./playback-node-worker.mjs', import.meta.url));
    return {postMessage: (message, transfer) => worker.postMessage(message, transfer), terminate: () => worker.terminate(),
      addEventListener(name, callback) {worker.on(name, value => callback(name === 'message' ? {data: value} : value));}};
  }});
}
async function actualFixture() {
  const {Editor} = await import('../src/editor.mjs'), {emptyDocument, createFrame, createObject} = await import('../src/demo.mjs');
  const report = emptyDocument(); report.keyframes = [0, 80, 20].map((x,index) => createFrame([
    createObject(report.figure_types[0], 1, x, 100), createObject(report.figure_types[0], 2, x+200, 200)], index===1?0:3));
  const editor = new Editor({demo:false}).load(report);
  editor.addAnimationKeys([{target:{kind:'scene',id:'scene'},property:'pose',tick:0,value:{frameId:editor.getFrameId(0)},interpolation:'linear'},
    {target:{kind:'scene',id:'scene'},property:'pose',tick:6,value:{frameId:editor.getFrameId(2)},interpolation:'linear'},
    {target:{kind:'figure',uid:1},property:'x',tick:0,value:0,interpolation:'linear'},
    {target:{kind:'figure',uid:1},property:'x',tick:6,value:20,interpolation:'linear'}]);
  return editor;
}

test('actual retained worker inbetween plan equals local native/authored planning and leaves playback usable', async () => {
  const {planInsertInbetweens} = await import('../src/editor-inbetween.mjs');
  const editor = await actualFixture(), cache = actualCache(), before = editor.serialize(), progress = [];
  const request = {ratio:.5,indices:[1,2],nextFrameIdentity:editor._nextFrameIdentity};
  const expected = inbetweenPlanPayload(planInsertInbetweens(editor,request.ratio,request.indices)).plan;
  try {
    cache.load(editor.report,{revision:editor.revision}); await cache.prepareRange([0]); const chunks=cache.stats.loadChunks;
    const actual = await cache.planInsertInbetweens(request,{onProgress:value=>progress.push(value)});
    assert.deepEqual(actual,expected); assert.deepEqual(editor.serialize(),before);
    assert.equal(cache.stats.loadChunks,chunks,'planning reuses the acknowledged mirror');
    assert.ok(cache.stats.inbetweenChunks>1); assert.ok(progress.some(item=>item.phase==='sampling'));
    assert.ok(actual.entries.some(entry=>entry.duration===0));
    await cache.prepareRange([1]); assert.ok(cache.has(1));
  } finally {cache.dispose();}
});

test('actual inbetween planning rejects a changed view revision and a concurrent worker failure cleanly', async () => {
  const editor=await actualFixture(),cache=actualCache();
  try {
    cache.load(editor.report); await cache.prepareRange([0]);
    const request={ratio:.5,indices:[1,2],nextFrameIdentity:editor._nextFrameIdentity};
    await assert.rejects(cache.planInsertInbetweens(request,{onProgress:()=>cache.updateView({scale:2})}),{name:'AbortError'});
    assert.equal(cache.planner.pending,null); await cache.prepareRange([0]); assert.equal(cache.get(0).scale,2);
    await assert.rejects(cache.planInsertInbetweens({...request,ratio:2}),/ratio/);
    assert.equal(cache.failure,undefined); assert.equal(cache.planner.pending,null);
    await cache.prepareRange([1]); assert.ok(cache.has(1));
  } finally {cache.dispose();}
});
