import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTask} from 'node:timers/promises';
import {ImportClient} from '../src/import-client.mjs';
import {openBytes, registeredEngine, useEngine} from '../src/engine/engine-open.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';

// A Pivot project is opened on the engine, which describes the file it read and carries it in the document: the page gives the
// engine the file once, and nothing keeps a copy of it, in the codec or anywhere else.
const meta = source => JSON.stringify({name: 'a', kind: 'piv', version: 5, savedDraft: false, lineage: 1, source, splits: [], rows: {}, timeline: [],
  indexes: {nextFrameIdentity: 1, nextUid: 1, layerUidCounts: [], layerSeenUids: [], layerGroups: []}});

/** An engine whose open finishes when the test says so. */
function fakeEngine({source = true, copy = () => {}} = {}) {
  const engine = {
    cancelled: [], job: null, outcome: undefined, wake: null, attached: [], freed: 0, join: {memory: {buffer: new ArrayBuffer(64)}},
    progressSeen: () => 0, grow: () => {},
    whenProgress: () => new Promise(resolve => { engine.wake = resolve; }),
    handle: {
      admit_open() {},
      workers_lost: () => engine.lost ?? 0,
      admit_copy(size) { copy(size); },
      open_document() { engine.job = 7; return engine.job; },
      cancel_open(job) { engine.cancelled.push(job); engine.finish({error: new Error(JSON.stringify({code: 'cancelled', message: 'cancelled'}))}); },
      take_opened_document() {
        if (!engine.outcome) return undefined;
        if (engine.outcome.error) throw engine.outcome.error;
        return {
          meta: () => meta(source), free() { engine.freed++; },
          begin_source(length) { engine.writing = new Uint8Array(engine.join.memory.buffer, 0, length); return 0; },
          end_source() { engine.attached.push([...engine.writing]); },
          part: () => ({skeleton: '{}', arrays: new Uint8Array(0), arrays_base: 0, payloads: new Uint8Array(0), payloads_base: 0, sequences: null, free() {}}),
        };
      },
    },
    finish(outcome) { engine.outcome = outcome; engine.wake?.(); },
  };
  return engine;
}

function environment(t, options) {
  const previous = registeredEngine(), engine = fakeEngine(options);
  useEngine(engine);
  t.after(() => useEngine(previous));
  const workers = [], host = new FakeCodecHost(() => ({status: 204}));
  class Worker extends EventTarget {
    constructor() { super(); workers.push(this); this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    terminate() {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {value: Worker, configurable: true});
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker; });
  const file = {buffer: new Uint8Array([1, 2, 3, 4]).buffer};
  const client = new ImportClient({baseURL: 'http://localhost', timeoutMs: 0, codecHost: host,
    readSample: () => ({ok: true, name: 'a.piv', bytes: new Uint8Array(file.buffer)})});
  t.after(() => { client.dispose(); host.close(); });
  const start = async () => {
    const pending = client.openSample('a.piv', {open: {layerTimeline: false}});
    pending.catch(() => {});
    await nextTask(); await nextTask();
    return {pending};
  };
  return {client, engine, workers, host, file, start};
}

test('a Pivot project is given to the engine, which carries it; the codec is not asked', async t => {
  const {engine, workers, host, file, start} = environment(t);
  const {pending} = await start();
  engine.finish({});
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(engine.attached.length, 1, 'the engine was given the file');
  assert.deepEqual(engine.attached[0], [1, 2, 3, 4]);
  assert.equal(workers.every(worker => worker.messages.length === 0), true, 'the importer worker was sent nothing');
  assert.equal(host.sent('/api/source/keep').length + host.sent('/api/source/release').length, 0, 'nothing leased in the codec');
  assert.equal('sourceId' in result || 'sourceOwner' in result, false, 'no lease for the interface to track');
});

test('the page lets go of the file once the engine has its own copy', async t => {
  const {engine, file, start} = environment(t);
  const {pending} = await start();
  engine.finish({});
  const result = await pending;
  assert.equal(result.timings.source_bytes, 4, 'the size is reported');
  assert.equal(file.buffer.byteLength, 0, 'the buffer the page read the file into is freed');
});

test('a document that was not read from a Pivot file is given no original', async t => {
  const {engine, start} = environment(t, {source: false});
  const {pending} = await start();
  engine.finish({});
  await pending;
  assert.equal(engine.attached.length, 0);
});

test('an open the engine refuses attaches nothing and says why', async t => {
  const {engine, start} = environment(t);
  const {pending} = await start();
  engine.finish({error: new Error(JSON.stringify({message: 'bad', code: 'invalid_project', status: 422, stage: 'decode'}))});
  await assert.rejects(pending, error => error.code === 'invalid_project');
  assert.equal(engine.attached.length, 0);
});

test('a copy of the original the memory cannot hold fails the open with its message, and the opening is released', async t => {
  const {engine, start} = environment(t, {copy() { throw new Error(JSON.stringify({message: 'out of memory', code: 'out_of_memory', status: 507, stage: 'decode', messageKey: 'errors.engine.outOfMemory'})); }});
  const {pending} = await start();
  engine.finish({});
  await assert.rejects(pending, error => error.code === 'out_of_memory');
  assert.equal(engine.attached.length, 0);
  assert.equal(engine.freed, 1, 'the engine drops the opened document');
});

test('an open whose worker was lost ends with an error instead of waiting for ever', async () => {
  const engine = fakeEngine();
  engine.whenProgress = () => new Promise(resolve => setTimeout(resolve, 10));
  const pending = openBytes(new Uint8Array(4), 'a.piv', {engine, lostGraceMs: 40});
  pending.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  engine.lost = 1;
  await assert.rejects(pending, error => error.code === 'worker_failed' && error.messageKey === 'errors.importClient.theFileImporterStoppedUnexpectedly');
  assert.deepEqual(engine.cancelled, [7], 'the open is asked to stop');
});

test('a worker lost while the open still answers does not end it', async () => {
  const engine = fakeEngine();
  engine.whenProgress = () => new Promise(resolve => setTimeout(resolve, 10));
  const pending = openBytes(new Uint8Array(4), 'a.piv', {engine, lostGraceMs: 200});
  await new Promise(resolve => setTimeout(resolve, 20));
  engine.lost = 1;
  setTimeout(() => engine.finish({}), 40);
  const opening = await pending;
  assert.ok(opening);
  assert.deepEqual(engine.cancelled, []);
});
