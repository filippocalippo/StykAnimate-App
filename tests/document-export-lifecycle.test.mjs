import assert from 'node:assert/strict';
import test from 'node:test';
import {DocumentExporter} from '../src/document-export.mjs';
import {createDemo} from '../src/demo.mjs';
import {registeredEngine} from '../src/engine/engine-open.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';

/** A document the engine owns: a `.styk` save is written from the snapshot of its session. */
const project = () => ownedEditorFor({demo: false}, createDemo()).report;

const turn = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate, nextTurn = turn) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await nextTurn(); }
  assert.fail('Export did not reach the expected stage.');
}

function environment(t, options = {}) {
  // Cancelled codec jobs, in order (the codec runs in a worker of the page).
  const workers = [], host = new FakeCodecHost(), cancellations = host.cancellations;
  class Worker extends EventTarget {
    constructor() { super(); workers.push(this); this.messages = []; }
    postMessage(message) {
      this.messages.push(message);
      // A worker that joined the engine gives its thread back when told to, then it is ended (document-export.mjs, _retire).
      if (message.operation === 'release') { queueMicrotask(() => { const event = new Event('message'); event.data = {released: true}; this.dispatchEvent(event); }); return; }
      if (message.operation !== 'export') queueMicrotask(() => this.reply(message.id));
    }
    reply(id, payload = {}) { const event = new Event('message'); event.data = {id, ok: true, ...payload}; this.dispatchEvent(event); }
    finish(payload = {}) { this.reply(this.messages.at(-1).id, {blob: new Blob(['exact bytes']), timings: {output_bytes: 11}, ...payload}); }
    fail(type = 'error') { const event = new Event(type, {cancelable: true}); event.message = 'Worker stopped'; this.dispatchEvent(event); }
    terminate() { this.terminated = true; }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {value: Worker, configurable: true});
  const exporter = new DocumentExporter({codecHost: host, timeoutMs: 0, engine: {...registeredEngine(), join: {}}, ...options});
  t.after(() => {
    exporter.dispose(); host.close();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker;
  });
  return {workers, exporter, cancellations};
}

test('successful exports reuse one worker with distinct request identities and bounded idle lifetime', async t => {
  const {workers, exporter, cancellations} = environment(t, {idleMs: 20});
  const report = project(), first = exporter.export(report);
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export');
  const oldId = workers[0].messages.at(-1).id;
  workers[0].finish(); assert.equal(await (await first).text(), 'exact bytes');
  assert.equal(exporter.lastTimings.reused_worker, false);
  const second = exporter.export(report);
  await until(() => workers[0].messages.at(-1).operation === 'export' && workers[0].messages.at(-1).id > oldId);
  workers[0].reply(oldId, {blob: new Blob(['stale'])});
  workers[0].finish(); assert.equal(await (await second).text(), 'exact bytes');
  assert.equal(exporter.lastTimings.reused_worker, true); assert.equal(workers.length, 1);
  assert.equal(cancellations.length, 0);
  await until(() => workers[0].terminated);
  assert.equal(exporter.worker, null);
});

test('exports serialize, queued cancellation is isolated, and admission stays bounded', async t => {
  const {workers, exporter} = environment(t, {maxQueued: 1});
  const report = project(), first = exporter.export(report);
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export');
  const abort = new AbortController(), waiting = exporter.export(report, {signal: abort.signal});
  await assert.rejects(exporter.export(report), {code: 'export_busy'});
  abort.abort(); await assert.rejects(waiting, {name: 'AbortError'});
  assert.equal(workers[0].terminated, undefined);
  const next = exporter.export(report), oldId = workers[0].messages.at(-1).id;
  workers[0].finish(); await first;
  await until(() => workers[0].messages.at(-1).operation === 'export' && workers[0].messages.at(-1).id > oldId);
  workers[0].finish(); await next;
  assert.equal(workers.length, 1); assert.equal(exporter.jobs.size, 0); assert.equal(exporter.queue.length, 0);
});

for (const reason of ['cancel', 'error', 'messageerror', 'timeout']) test(`a ${reason} destroys partial worker state and the next export starts fresh`, async t => {
  if (reason === 'timeout') t.mock.timers.enable({apis: ['setTimeout']});
  // Complete snapshot yields without consuming either export's deadline.
  const pollTurn = reason === 'timeout' ? async () => {
    await Promise.resolve();
    t.mock.timers.tick(0);
  } : turn;
  const {workers, exporter, cancellations} = environment(t, {timeoutMs: reason === 'timeout' ? 30 : 0});
  const controller = new AbortController(), report = project();
  const result = exporter.export(report, {signal: controller.signal});
  const rejected = assert.rejects(result, error => reason === 'cancel' ? error.name === 'AbortError'
    : reason === 'timeout' ? error.telemetryCode === 'timeout' : Boolean(error.telemetryCode));
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export', pollTurn);
  if (reason === 'cancel') controller.abort();
  else if (reason === 'timeout') {
    t.mock.timers.tick(29);
    assert.equal(workers[0].terminated, undefined);
    assert.equal(cancellations.length, 0);
    t.mock.timers.tick(1);
  } else workers[0].fail(reason);
  await rejected; assert.equal(workers[0].terminated, true); assert.equal(cancellations.length, 1);
  // The engine work in the worker was told to stop, whatever ended the export: a worker ended inside the shared memory could freeze it.
  assert.equal(Atomics.load(workers[0].messages.find(message => message.operation === 'export').cancel, 0), 1);
  const next = exporter.export(report);
  await until(() => workers[1]?.messages.at(-1)?.operation === 'export', pollTurn);
  workers[0].reply(workers[1].messages.at(-1).id, {blob: new Blob(['stale'])});
  workers[1].finish(); assert.equal(await (await next).text(), 'exact bytes');
  assert.equal(workers.length, 2); assert.equal(cancellations.length, 1);
});

test('a worker ended after its export returned is told to stop the engine work first, even when the document changed meanwhile', async t => {
  const {workers, exporter} = environment(t);
  let revision = 1;
  const report = project(), result = exporter.export(report, {getRevision: () => revision});
  const rejected = assert.rejects(result, {name: 'AbortError'});
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export');
  const {cancel} = workers[0].messages.at(-1);
  assert.equal(Atomics.load(cancel, 0), 0);
  revision = 2;
  workers[0].finish();
  await rejected;
  assert.equal(workers[0].terminated, true);
  assert.equal(Atomics.load(cancel, 0), 1);
});

test('a worker that is inside the engine when its export is cancelled is not ended, and the next save does not wait for it', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const pollTurn = async () => { await Promise.resolve(); t.mock.timers.tick(0); };
  const {workers, exporter} = environment(t);
  const controller = new AbortController(), report = project();
  const first = exporter.export(report, {signal: controller.signal});
  const rejected = assert.rejects(first, {name: 'AbortError'});
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export', pollTurn);
  const {guard} = workers[0].messages.find(message => message.operation === 'start').options;
  // The worker is in a long call into the engine: it neither answers the release nor can be ended.
  Atomics.store(guard, 0, 1);
  workers[0].postMessage = message => { workers[0].messages.push(message); };
  controller.abort();
  await rejected;
  assert.equal(Atomics.load(workers[0].messages.find(message => message.operation === 'export').cancel, 0), 1, 'told to stop');
  assert.ok(workers[0].messages.some(message => message.operation === 'release'), 'told to give its thread back');
  // The next save gets a worker of its own at once.
  const next = exporter.export(report);
  await until(() => workers[1]?.messages.at(-1)?.operation === 'export', pollTurn);
  workers[1].finish(); assert.equal(await (await next).text(), 'exact bytes');
  t.mock.timers.tick(30000);
  assert.equal(workers[0].terminated, undefined, 'still inside the engine after the timeout, so not ended');
  // The call returned and the worker is outside: the next look at it ends it.
  Atomics.store(guard, 0, 0);
  t.mock.timers.tick(5000);
  assert.equal(workers[0].terminated, true);
});

for (const [threads, lent] of [[1, 0], [2, 1], [4, 3], [8, 3]]) test(`a save on an engine of ${threads} thread(s) is handed ${lent} of them to borrow`, async t => {
  const {workers, exporter} = environment(t, {engine: {handle: registeredEngine().handle, join: {}, workers: threads}});
  const saving = exporter.export(project());
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export');
  assert.equal(workers[0].messages.at(-1).project.helpers, lent);
  workers[0].finish(); await saving;
});

test('queued revision changes reject before snapshot and disposal cancels active and waiting requests', async t => {
  const {workers, exporter} = environment(t);
  const report = project(), first = exporter.export(report);
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export');
  let revision = 1;
  const changed = exporter.export(report, {getRevision: () => revision});
  const changedRejected = assert.rejects(changed, {name: 'AbortError'});
  revision++; workers[0].finish(); await first; await changedRejected;
  const active = exporter.export(report), waiting = exporter.export(report);
  const rejections = Promise.all([assert.rejects(active, {name: 'AbortError'}), assert.rejects(waiting, {name: 'AbortError'})]);
  exporter.dispose(); await rejections;
  assert.equal(exporter.jobs.size, 0); assert.equal(exporter.queue.length, 0); assert.equal(exporter.worker, null);
  await assert.rejects(exporter.export(report), /disposed/);
});

test('an idle worker failure is discarded before another export', async t => {
  const {workers, exporter} = environment(t);
  const report = project(), first = exporter.export(report);
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export');
  workers[0].finish(); await first; workers[0].fail();
  assert.equal(exporter.worker, null);
  const next = exporter.export(report);
  await until(() => workers[1]?.messages.at(-1)?.operation === 'export');
  workers[1].finish(); await next;
});

test('invalid capacities and revision callbacks cannot leak exporter jobs', async t => {
  const {workers, exporter} = environment(t);
  for (const options of [{maxQueued: Infinity}, {maxQueued: 17}, {maxQueued: -1}, {idleMs: NaN}])
    assert.throws(() => new DocumentExporter(options), RangeError);
  await assert.rejects(exporter.export(project(), {getRevision: () => {throw new Error('Revision unavailable');}}), /Revision unavailable/);
  assert.equal(exporter.jobs.size, 0); assert.equal(workers.length, 0);
});

test('a save hands the worker the snapshot of the session and lets go of what the worker did not take', async t => {
  const {workers, exporter} = environment(t), report = project();
  const first = exporter.export(report, {format: 'styk'});
  await until(() => workers[0]?.messages.at(-1)?.operation === 'export');
  const {project: handed} = workers[0].messages.at(-1);
  assert.equal(handed.snapshots.length, 1); assert.deepEqual(handed.scopes, []);
  workers[0].finish(); await first;
  // The fake worker never took the snapshot: the save let go of it, so no later save finds it.
  assert.throws(() => makeProjectFile({join: null, cancelled: () => false, request: {snapshots: handed.snapshots, scopes: []}}), {name: 'AbortError'});
  await assert.rejects(exporter.export({figure_types: [], keyframes: []}, {format: 'styk'}), {messageKey: 'errors.documentExportWorker.theDocumentSnapshotWasNotInitialized'}, 'a document no session holds has nothing to save');
  assert.equal(exporter.jobs.size, 0);
});

test('every export on a page that is not cross-origin isolated is refused with a message, before any worker starts', async t => {
  const {workers, exporter} = environment(t, {engine: {join: {}}});
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
  Object.defineProperty(globalThis, 'crossOriginIsolated', {value: false, configurable: true});
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'crossOriginIsolated', descriptor); else delete globalThis.crossOriginIsolated; });
  for (const format of ['styk', 'piv', 'stk', 'stkz', 'stykmov']) {
    await assert.rejects(exporter.export(project(), {format, revision: 1}), error =>
      error.messageKey === 'errors.documentExport.theEngineCannotMakeThisFileHere' && error.telemetryCode === 'engine_failed' && /shared memory/.test(error.message), format);
  }
  assert.equal(workers.length, 0, 'no worker was started');
  assert.equal(exporter.jobs.size, 0); assert.equal(exporter.active, false);
});
