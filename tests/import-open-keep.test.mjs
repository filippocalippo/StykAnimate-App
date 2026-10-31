import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTask} from 'node:timers/promises';
import {ImportClient} from '../src/import-client.mjs';
import {registeredEngine, useEngine} from '../src/engine/engine-open.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';

// A Pivot project's original goes to the codec at the same time as the engine reads the file: the open does not
// wait for it, and whichever side fails or is cancelled leaves nothing leased.
const META = JSON.stringify({name: 'a', kind: 'piv', version: 5, savedDraft: false, lineage: 1, splits: [],
  indexes: {nextFrameIdentity: 1, nextUid: 1, layerUidCounts: [], layerSeenUids: [], layerGroups: []}});

/** An engine whose open finishes when the test says so. */
function fakeEngine() {
  const engine = {
    cancelled: [], job: null, outcome: undefined, wake: null,
    progressSeen: () => 0,
    whenProgress: () => new Promise(resolve => { engine.wake = resolve; }),
    handle: {
      admit_open() {},
      open_document() { engine.job = 7; return engine.job; },
      cancel_open(job) { engine.cancelled.push(job); engine.finish({error: new Error(JSON.stringify({code: 'cancelled', message: 'cancelled'}))}); },
      take_opened_document() {
        if (!engine.outcome) return undefined;
        if (engine.outcome.error) throw engine.outcome.error;
        return {
          meta: () => META, free() {},
          part: () => ({skeleton: '{}', arrays: new Uint8Array(0), arrays_base: 0, payloads: new Uint8Array(0), payloads_base: 0, sequences: null, free() {}}),
        };
      },
    },
    finish(outcome) { engine.outcome = outcome; engine.wake?.(); },
  };
  return engine;
}

function environment(t) {
  const previous = registeredEngine(), engine = fakeEngine();
  useEngine(engine);
  t.after(() => useEngine(previous));
  const workers = [], host = new FakeCodecHost(() => ({status: 204}));
  class Worker extends EventTarget {
    constructor() { super(); workers.push(this); this.messages = []; }
    postMessage(message) { this.messages.push(message); }
    terminate() {}
    reply(message, result) { this.dispatchEvent(new MessageEvent('message', {data: {id: message.id, ok: true, result}})); }
    refuse(message, error) { this.dispatchEvent(new MessageEvent('message', {data: {id: message.id, ok: false, error}})); }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {value: Worker, configurable: true});
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker; });
  const client = new ImportClient({baseURL: 'http://localhost', timeoutMs: 0, codecHost: host,
    readSample: path => ({ok: true, name: path, bytes: new Uint8Array([1])})});
  t.after(() => { client.dispose(); host.close(); });
  const start = async () => {
    const pending = client.openSample('a.piv', {project: true, open: {layerTimeline: false}});
    pending.catch(() => {});
    await nextTask(); await nextTask();
    return {pending};
  };
  const released = () => host.sent('/api/source/release').map(request => JSON.parse(request.text).ownerId);
  return {client, engine, workers, host, start, released};
}

test('the original goes to the codec while the engine is still reading the file', async t => {
  const {client, engine, workers, start} = environment(t);
  const {pending} = await start();
  assert.ok(engine.job !== null && !engine.outcome, 'the engine is still decoding');
  const [keep] = workers[0].messages;
  assert.equal(keep?.operation, 'keep');
  workers[0].reply(keep, {sourceId: 'source', sourceOwner: keep.sourceOwner});
  engine.finish({});
  const result = await pending;
  assert.equal(result.sourceOwner, keep.sourceOwner);
  client.adoptSource(result);
  assert.equal(client.activeSourceOwner, keep.sourceOwner);
});

test('an open that fails releases what the codec kept once it has kept it', async t => {
  const {client, engine, workers, start, released} = environment(t);
  const {pending} = await start();
  const [keep] = workers[0].messages;
  engine.finish({error: new Error(JSON.stringify({code: 'decode', message: 'The file is damaged.'}))});
  await assert.rejects(pending, /damaged/);
  assert.deepEqual(released(), [], 'the codec has not answered yet');
  workers[0].reply(keep, {sourceId: 'source', sourceOwner: keep.sourceOwner});
  await nextTask(); await client.sourceRelease;
  assert.deepEqual(released(), [keep.sourceOwner]);
  assert.equal(client.sourceOwners.size, 0);
});

test('a codec that refuses the original stops the open and gives its own error', async t => {
  const {client, engine, workers, start, released} = environment(t);
  const {pending} = await start();
  const [keep] = workers[0].messages;
  workers[0].refuse(keep, {message: 'The file service refused it.', status: 413});
  await assert.rejects(pending, /refused it/);
  assert.deepEqual(engine.cancelled, [engine.job], 'the engine stopped reading');
  await client.sourceRelease;
  assert.deepEqual(released(), [keep.sourceOwner]);
});

test('cancelling stops the open and releases the original, kept or not yet kept', async t => {
  const {client, engine, workers, start, released} = environment(t);
  const {pending} = await start();
  const [keep] = workers[0].messages;
  client.cancelPending();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(engine.cancelled, [engine.job]);
  workers[0].reply(keep, {sourceId: 'source', sourceOwner: keep.sourceOwner});
  await nextTask(); await client.sourceRelease;
  assert.deepEqual(released(), [keep.sourceOwner]);
});
