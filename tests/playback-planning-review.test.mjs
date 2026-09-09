import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackPlanner, LayerMigrationService} from '../src/playback-planning.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
function harness({holdComplete = false} = {}) {
  const report = {sentinel: 'unchanged'}, owner = {report, revision: 4, stats: {}, timeoutMs: 1000, _loadWorker: async () => {}}, snapshot = {report, revision: 4};
  let client, held, completed, invocations = 0;
  const result = () => ({beforeAnimation: null, afterAnimation: {version: 1, nextKeyId: ++invocations, channels: []}, frameSources: {},
    nextFrameIdentity: invocations, sampledTicks: 0, affectedLayerIds: [], hadFrameSourceTable: false});
  const service = new LayerMigrationService({snapshot: () => snapshot, planner: function* () {yield {completed: 0}; return result();},
    postMessage(message) {
      const copy = structuredClone(message);
      if (holdComplete && copy.type === 'migration-complete' && copy.jobId === 1) {held = copy; completed?.();}
      else queueMicrotask(() => client.receive(copy));
    }});
  owner.worker = {postMessage(message) {const copy = structuredClone(message); queueMicrotask(() => service.receive(copy));}};
  client = new PlaybackPlanner(owner);
  return {owner, client, service, waitComplete: () => new Promise(resolve => {completed = resolve; if (held) resolve();}), deliver: () => client.receive(held)};
}
test('a cancelled completed reverse transfer cannot resolve the next request with its late completion', async () => {
  const h = harness({holdComplete: true}), controller = new AbortController();
  const pending = h.client.planLayerMigration({}, {signal: controller.signal}), rejected = assert.rejects(pending, {name: 'AbortError'});
  await h.waitComplete(); assert.equal(h.service.busy, false); controller.abort(); await rejected;
  const next = h.client.planLayerMigration({}); await pause(); h.deliver();
  const result = await next; assert.equal(result.nextFrameIdentity, 2); assert.equal(h.client.pending, null);
  assert.deepEqual(h.owner.report, {sentinel: 'unchanged'});
});
test('a throwing progress callback aborts staging, releases the worker and permits another request', async () => {
  const h = harness();
  await assert.rejects(h.client.planLayerMigration({}, {onProgress() {throw new Error('UI was removed');}}), /UI was removed/);
  await pause(); assert.equal(h.client.pending, null); assert.equal(h.service.busy, false);
  const result = await h.client.planLayerMigration({}); assert.ok(result.nextFrameIdentity > 0); assert.equal(h.service.busy, false);
});
test('timeout while waiting for a reverse ACK releases unpublished staging and ignores old chunks', async () => {
  const h = harness(); h.owner.timeoutMs = 15;
  const post = h.owner.worker.postMessage; let held;
  h.owner.worker.postMessage = message => {if (message.type === 'migration-ack') held = message; else post(message);};
  await assert.rejects(h.client.planLayerMigration({}), /timed out/);
  await pause(); assert.ok(held); assert.equal(h.service.busy, false); assert.equal(h.client.pending, null);
  post(held); h.owner.worker.postMessage = post; h.owner.timeoutMs = 1000;
  await h.client.planLayerMigration({}); assert.deepEqual(h.owner.report, {sentinel: 'unchanged'});
});
