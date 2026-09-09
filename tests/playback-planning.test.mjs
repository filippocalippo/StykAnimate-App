import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackPlanner, LayerMigrationService, migrationPlanPayload} from '../src/playback-planning.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {Worker} from 'node:worker_threads';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {planLayerMembershipMigration} from '../src/editor-layer-migration.mjs';

function fixture() {
  const retained = {id: 'retained', keys: [{id: 'existing', value: 123}]}, changed = {id: 'changed', keys: []}, removed = {id: 'removed', keys: []};
  const beforeAnimation = {version: 1, nextKeyId: 2, channels: [retained, changed, removed]};
  const source = {_styk: {frameId: 'frame-2'}, objects: [{unique_id: 1, angles: Array.from({length: 12000}, (_, i) => i / 100)}]};
  const afterAnimation = {...beforeAnimation, nextKeyId: 3, channels: [retained, {...changed, keys: [{id: 'key-2', value: {frameId: 'frame-2'}}]}]};
  return {beforeAnimation, afterAnimation, frameSources: {'frame-2': source}, frameSourceChanges: [{id: 'frame-2', after: {exists: true, value: source}}],
    nextFrameIdentity: 3, sampledTicks: 12, affectedLayerIds: ['layer-1', 'layer-2'], hadFrameSourceTable: false};
}
function connection(planner, {holdChunks = false} = {}) {
  const sent = [], owner = {revision: 1, report: {}, stats: {}, timeoutMs: 1000, _loadWorker: () => Promise.resolve()};
  let receive, held; const snapshot = {revision: 1, report: owner.report};
  const service = new LayerMigrationService({snapshot: () => snapshot, planner, postMessage(message) {
    const copy = structuredClone(message); sent.push(copy);
    if (holdChunks && copy.type === 'migration-chunk') held = copy;
    else queueMicrotask(() => receive(copy));
  }});
  owner.worker = {postMessage(message) {const copy = structuredClone(message); queueMicrotask(() => service.receive(copy));}};
  const client = new PlaybackPlanner(owner); receive = message => client.receive(message);
  return {client, service, owner, sent, held: () => held, deliver: message => receive(message)};
}
const request = {uids: [1], targetLayerId: 'layer-2', nextFrameIdentity: 2};

test('migration payload excludes unchanged channels and duplicate history source assets', () => {
  const plan = fixture(), payload = migrationPlanPayload(plan).plan;
  assert.deepEqual(payload.channelUpdates.map(entry => [entry.id, entry.channel === null]), [['changed', false], ['removed', true]]);
  assert.deepEqual(payload.channelOrder, ['retained', 'changed']);
  assert.equal(payload.frameSources, plan.frameSources); assert.equal(payload.frameSourceChanges, undefined);
  assert.equal(payload.beforeAnimation, undefined); assert.deepEqual(migrationPlanPayload(null), {plan: null});
});

test('read-only migration planning returns a bounded staged delta through ACK chunks', async () => {
  const plan = fixture(), progress = [];
  const c = connection(function* () {yield {completedTicks: 8, totalTicks: 12}; return plan;});
  const result = await c.client.planLayerMigration(request, {onProgress: value => progress.push(value)});
  assert.deepEqual(result, migrationPlanPayload(plan).plan); assert.equal(c.owner.report._styk, undefined);
  assert.deepEqual(progress, [{completedTicks: 8, totalTicks: 12}]);
  const chunks = c.sent.filter(message => message.type === 'migration-chunk');
  assert.ok(chunks.length > 2); assert.ok(chunks.every(message => (message.chunk.estimatedBytes || 0) <= 64 * 1024));
  assert.equal(c.owner.stats.migrationChunks, chunks.length); assert.equal(c.client.pending, null);
});

test('cancelling an unacknowledged reverse transfer drops staging and leaves the mirror untouched', async () => {
  const c = connection(function* () {return fixture();}, {holdChunks: true});
  const controller = new AbortController(), result = c.client.planLayerMigration(request, {signal: controller.signal});
  const rejected = assert.rejects(result, {name: 'AbortError'});
  while (!c.held()) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(); await rejected; c.deliver(c.held());
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(c.client.pending, null); assert.equal(c.service.busy, false); assert.deepEqual(c.owner.report, {});
});

test('a replaced mirror before planning starts and malformed chunk order reject without publication', async () => {
  const c = connection(function* () {return fixture();});
  let loaded; c.owner._loadWorker = () => new Promise(resolve => {loaded = resolve;});
  const waiting = c.client.planLayerMigration(request), rejected = assert.rejects(waiting, {name: 'AbortError'});
  c.owner.revision++; loaded(); await rejected; assert.equal(c.sent.length, 0);
  const next = connection(function* () {return fixture();}, {holdChunks: true});
  const pending = next.client.planLayerMigration(request), malformed = assert.rejects(pending, /order|Invalid/);
  while (!next.held()) await new Promise(resolve => setTimeout(resolve, 1));
  next.deliver({...next.held(), sequence: 9}); await malformed; assert.deepEqual(next.owner.report, {});
});

test('an overlapping request cannot replace the active planning waiter', async () => {
  const c = connection(function* () {return fixture();}, {holdChunks: true});
  const waiting = c.client.planLayerMigration(request), rejected = assert.rejects(waiting, {name: 'AbortError'});
  while (!c.held()) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(c.client.planLayerMigration(request), /already/);
  c.client.cancel(); await rejected;
});

test('a result budget failure after partial transfer never publishes staged source assets', async () => {
  const c = connection(function* () {return fixture();});
  const post = c.owner.worker.postMessage;
  c.owner.worker.postMessage = message => post(message.type === 'plan-layer-migration' ? {...message, maxBytes: 70000} : message);
  await assert.rejects(c.client.planLayerMigration(request), /result budget/);
  assert.equal(c.client.pending, null); assert.deepEqual(c.owner.report, {});
  const chunks = c.sent.filter(message => message.type === 'migration-chunk');
  assert.ok(chunks.length > 1, 'the limit is enforced across multiple acknowledged chunks');
  assert.ok(chunks.reduce((sum, message) => sum + (message.chunk.estimatedBytes || 0), 0) <= 70000);
});

function actualFixture() {
  const report = emptyDocument(); report.keyframes = [0, 80, 20].map(x => createFrame([
    createObject(report.figure_types[0], 1, x, 100), createObject(report.figure_types[0], 2, x + 200, 200)], 10));
  const editor = new Editor({demo: false}).load(report); editor.createLayer('Second'); editor.assignFiguresToLayer([2], 'layer-2');
  editor.addAnimationKeys([['layer-1', 0, 0], ['layer-1', 20, 2], ['layer-2', 0, 1], ['layer-2', 20, 0]].map(([id, tick, index]) =>
    ({target: {kind: 'layer', id}, property: 'pose', tick, value: {frameId: editor.getFrameId(index)}, interpolation: 'linear'})));
  return editor;
}
function actualCache() {
  return new PlaybackCache({workerFactory: () => {
    const worker = new Worker(new URL('./playback-node-worker.mjs', import.meta.url));
    return {postMessage: (message, transfer) => worker.postMessage(message, transfer), terminate: () => worker.terminate(),
      addEventListener(name, callback) {worker.on(name, value => callback(name === 'message' ? {data: value} : value));}};
  }});
}

test('the actual worker planner uses its retained mirror and preserves every planned pose', async () => {
  const editor = actualFixture(), cache = actualCache(), before = editor.serialize(), progress = [];
  const request = {uids: [1], targetLayerId: 'layer-2', nextFrameIdentity: editor._nextFrameIdentity};
  const expected = migrationPlanPayload(planLayerMembershipMigration(editor, request.uids, request.targetLayerId, {worker: true})).plan;
  try {
    cache.load(editor.report, {revision: editor.revision}); await cache.prepareRange([0]); const loadChunks = cache.stats.loadChunks;
    const result = await cache.planLayerMigration(request, {onProgress: value => progress.push(value)});
    assert.deepEqual(result, expected); assert.deepEqual(editor.serialize(), before);
    assert.equal(cache.stats.loadChunks, loadChunks, 'planning must not resend the document');
    assert.equal(cache.stats.migrationChunks > 1, true); assert.equal(progress.at(-1).completed, editor.totalTicks);
    assert.ok(result.sourceBytes > 0); await cache.prepareRange([1]); assert.equal(cache.has(1), true);
  } finally {cache.dispose();}
});

test('a view revision during actual worker planning cancels the plan and leaves playback usable', async () => {
  const editor = actualFixture(), cache = actualCache();
  try {
    cache.load(editor.report); await cache.prepareRange([0]);
    const pending = cache.planLayerMigration({uids: [1], targetLayerId: 'layer-2', nextFrameIdentity: editor._nextFrameIdentity},
      {onProgress: () => cache.updateView({scale: 2})});
    await assert.rejects(pending, {name: 'AbortError'}); assert.equal(cache.planner.pending, null);
    await cache.prepareRange([0]); assert.equal(cache.get(0).scale, 2); assert.equal(cache.failure, undefined);
  } finally {cache.dispose();}
});
