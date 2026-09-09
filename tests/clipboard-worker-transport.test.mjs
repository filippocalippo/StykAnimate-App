import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {ClipboardWorkerClient, CLIPBOARD_CHUNK_BYTES, CLIPBOARD_TRANSFER_BYTES, clipboardControlBytes} from '../src/clipboard-worker-client.mjs';
import {createClipboardWorkerEndpoint} from '../src/clipboard-worker.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const minimal = () => ({version: 5, keyframes: [], figure_types: []});
function fixture() {
  const report = minimal();
  report.figure_types = [{name: 'Embedded glyph', asset: '日本語\ud800'.repeat(18000)}];
  report.keyframes = [{objects: [{root_x: -0, angles: Array.from({length: 18000}, (_, i) => i / 7),
    runtime_segments: [{length: 123}]}]}];
  report.opaque = JSON.parse('{"__proto__":{"keep":true},"negativeZero":0}');
  report.opaque.runtime_segments = 'opaque runtime_segments survives';
  return report;
}
function fakeFactory({planner = async input => input, transform, holdResult = false, silent = false} = {}) {
  const workers = [];
  const factory = () => {
    const listeners = new Map(), sent = [], returned = [], held = [];
    const worker = {sent, returned, held, terminated: false,
      addEventListener(name, callback) {listeners.set(name, callback);},
      removeEventListener(name, callback) {if (listeners.get(name) === callback) listeners.delete(name);},
      terminate() {this.terminated = true;},
      dispatch(message) {listeners.get('message')?.({data: message});},
      error(name, error = {}) {listeners.get(name)?.(error);},
      postMessage(message, transfer = []) {
        if (this.terminated) throw new Error('Worker is terminated.');
        const copy = structuredClone(message, {transfer}); sent.push(copy);
        if (!silent) queueMicrotask(() => {if (!this.terminated) receive(copy);});
      },
    };
    const receive = createClipboardWorkerEndpoint((message, transfer = []) => {
      const copy = structuredClone(message, {transfer}); returned.push(copy);
      if (holdResult && copy.type === 'result-chunk') held.push(copy);
      else queueMicrotask(() => {if (!worker.terminated) worker.dispatch(transform ? transform(copy) : copy);});
    }, {runRequest: planner, yieldControl: () => Promise.resolve()});
    workers.push(worker); return worker;
  };
  return {workers, factory};
}
function fakeClient(options = {}, behavior = {}) {
  const fakes = fakeFactory(behavior);
  return {...fakes, client: new ClipboardWorkerClient({workerFactory: fakes.factory, yieldControl: () => Promise.resolve(), ...options})};
}
async function until(check) {for (let i = 0; i < 1000; i++) {if (check()) return; await pause();} throw new Error('Test worker did not reach the expected state.');}

test('three isolated streams round-trip opaque fields through bounded bidirectional packets', async () => {
  const report = fixture(), clipboard = fixture(), state = {pending: {angles: Array.from({length: 12000}, (_, i) => -i / 3)}};
  const before = structuredClone({report, clipboard, state}), progress = [];
  const {client, workers} = fakeClient({}, {planner: async (input, options) => {options.onProgress({phase: 'capture', completed: 2}); return input;}});
  const output = await client.run({report, clipboard, state, request: {operation: 'copy', indices: [0]}}, {onProgress: value => progress.push(value)});
  const expected = structuredClone(before);
  for (const doc of [expected.report, expected.clipboard]) delete doc.keyframes[0].objects[0].runtime_segments;
  assert.deepEqual(output, {...expected, request: {operation: 'copy', indices: [0]}});
  assert.deepEqual({report, clipboard, state}, before);
  assert.notEqual(output.report, report); assert.notEqual(output.report.keyframes[0].objects[0].angles, report.keyframes[0].objects[0].angles);
  output.report.keyframes[0].objects[0].angles[0] = 999; assert.equal(report.keyframes[0].objects[0].angles[0], 0);
  assert.equal(Object.getPrototypeOf(output.report.opaque), Object.prototype); assert.equal({}.keep, undefined);
  assert.deepEqual(progress, [{phase: 'capture', completed: 2}]);
  const worker = workers[0], inputs = worker.sent.filter(message => message.operation === 'chunk'), results = worker.returned.filter(message => message.type === 'result-chunk');
  assert.ok(inputs.length > 2); assert.ok(results.length > 2);
  assert.deepEqual([...new Set(inputs.map(message => message.stream))], ['report', 'clipboard', 'state']);
  assert.ok([...inputs, ...results].every(message => message.chunk instanceof ArrayBuffer && message.chunk.byteLength <= CLIPBOARD_CHUNK_BYTES));
  assert.ok(client.lastTimings.inputLogicalBytes > client.lastTimings.inputBytes);
  assert.ok(client.lastTimings.outputLogicalBytes > client.lastTimings.outputBytes);
  assert.equal(client.lastTimings.inputChunks, inputs.length); assert.equal(client.lastTimings.outputChunks, results.length);
  assert.ok(client.lastTimings.maxPrepareMs >= 0); assert.ok(worker.terminated); assert.equal(client.active, null);
});

test('each operation owns a new worker and absent optional streams remain absent', async () => {
  const {client, workers} = fakeClient();
  const output = await client.run({report: minimal(), request: {operation: 'copy'}});
  assert.equal(Object.hasOwn(output, 'clipboard'), false); assert.equal(Object.hasOwn(output, 'state'), false);
  await client.run({report: minimal(), clipboard: null, state: null});
  assert.equal(workers.length, 2); assert.ok(workers.every(worker => worker.terminated));
  client.dispose(); await assert.rejects(client.run({report: minimal()}), /disposed/);
});

test('abort before creation and during reverse ACK discards unpublished staging', async () => {
  const {client, workers} = fakeClient({}, {holdResult: true});
  const already = new AbortController(); already.abort();
  await assert.rejects(client.run({report: minimal()}, {signal: already.signal}), {name: 'AbortError'}); assert.equal(workers.length, 0);
  const controller = new AbortController(), report = fixture(), before = structuredClone(report);
  const running = client.run({report}, {signal: controller.signal}), rejected = assert.rejects(running, {name: 'AbortError'});
  await until(() => workers[0]?.held.length); controller.abort(); await rejected;
  workers[0].dispatch(workers[0].held[0]); assert.deepEqual(report, before);
  assert.ok(workers[0].terminated); assert.equal(client.active, null); assert.equal(client.lastTimings, null);
});

test('dispose cancels pending work and overlapping calls cannot replace its waiter', async () => {
  const {client, workers} = fakeClient({}, {silent: true});
  const running = client.run({report: minimal()}), rejected = assert.rejects(running, {name: 'AbortError'});
  await assert.rejects(client.run({report: minimal()}), /already running/);
  client.dispose(); await rejected; assert.ok(workers[0].terminated); assert.equal(client.active, null);
});

test('freshness checks reject at ACK and after a progress callback changes the document', async () => {
  let current = true;
  const first = fakeClient({}, {transform: message => {if (message.type === 'ack' && message.operation === 'chunk') current = false; return message;}});
  await assert.rejects(first.client.run({report: fixture()}, {checkCurrent: () => current}), {name: 'AbortError'});
  assert.ok(first.workers[0].terminated);
  current = true;
  const second = fakeClient({}, {planner: async (input, {onProgress}) => {onProgress({phase: 'ready'}); return input;}});
  await assert.rejects(second.client.run({report: minimal()}, {checkCurrent: () => current, onProgress: () => {current = false;}}), {name: 'AbortError'});
  assert.equal(second.client.lastTimings, null);
});

test('malformed ACK identifiers, result sequence and oversized packet metadata fail closed', async () => {
  for (const transform of [
    message => message.type === 'ack' ? {...message, id: message.id + 1} : message,
    message => message.type === 'ack' ? {...message, jobId: message.jobId + 1} : message,
    message => message.type === 'result-chunk' ? {...message, sequence: message.sequence + 1} : message,
    message => message.type === 'result-chunk' ? {...message, chunk: new ArrayBuffer(CLIPBOARD_CHUNK_BYTES + 1)} : message,
  ]) {
    const {client, workers} = fakeClient({}, {transform});
    await assert.rejects(client.run({report: minimal()}), /match|order|oversized/); assert.ok(workers[0].terminated);
  }
});

test('actual encoded input/output limits hold across streams and partial result delivery', async () => {
  let called = false;
  const input = fakeClient({maxBytes: 100000}, {planner: async value => {called = true; return value;}});
  await assert.rejects(input.client.run({report: {data: 'a'.repeat(60000)}, clipboard: {data: 'b'.repeat(60000)}}), /input.*budget/);
  assert.equal(called, false); assert.ok(input.workers[0].sent.some(message => message.stream === 'report'));
  const output = fakeClient({maxBytes: 300000}, {planner: async () => ({data: Array.from({length: 3}, () => 'c'.repeat(200000))})});
  await assert.rejects(output.client.run({report: minimal()}), /output.*budget/);
  assert.ok(output.workers[0].returned.some(message => message.type === 'result-chunk'));
  assert.equal(output.client.lastTimings, null);
  assert.throws(() => new ClipboardWorkerClient({maxBytes: CLIPBOARD_TRANSFER_BYTES + 1}), /512 MiB/);
  assert.throws(() => clipboardControlBytes({keyframes: [{objects: [{runtime_segments: 'x'.repeat(70000)}]}]}), /64 KiB/);
});

test('planner failures, message decode failure and timeout propagate without hanging', async () => {
  const failed = fakeClient({}, {planner: async () => {throw Object.assign(new Error('Invalid joined figure'), {code: 'bad_join'});}});
  await assert.rejects(failed.client.run({report: minimal()}), error => error.message === 'Invalid joined figure' && error.code === 'bad_join');
  const decoded = fakeClient({}, {silent: true}), waiting = decoded.client.run({report: minimal()});
  const rejected = assert.rejects(waiting, /could not be transferred/); decoded.workers[0].error('messageerror'); await rejected;
  const timed = fakeClient({timeoutMs: 15}, {silent: true}); await assert.rejects(timed.client.run({report: minimal()}), /timed out/);
});

test('expanded resident admission is cumulative across the three compact streams', async () => {
  let planned = false;
  const {client, workers} = fakeClient({maxBytes: 4096}, {planner: async input => {planned = true; return input;}});
  // A sparse array needs little wire data but still reserves its full slot span.
  // Either stream fits alone; together they exceed the independent resident cap.
  await assert.rejects(client.run({report: {values: new Array(2400)}, clipboard: {values: new Array(2400)}}), /resident.*budget/);
  assert.equal(planned, false); assert.ok(workers[0].terminated);
  assert.ok(workers[0].sent.filter(message => message.operation === 'chunk').length >= 2);
  assert.equal(client.active, null); assert.equal(client.lastTimings, null);
});

test('worker rejects incomplete streams and reordered input before invoking a planner', async () => {
  for (const bad of [{jobId: 1, id: 2, operation: 'run'},
    {jobId: 1, id: 2, operation: 'chunk', stream: 'report', sequence: 1, chunk: {header: {}}}]) {
    const returned = []; let called = false;
    const receive = createClipboardWorkerEndpoint(value => returned.push(value), {runRequest: () => {called = true; return {};}});
    receive({jobId: 1, id: 1, operation: 'start', streams: ['report'], maxBytes: 100000, request: {}}); receive(bad);
    assert.equal(returned.at(-1).type, 'error'); assert.equal(called, false);
  }
});

function nodeClient() {
  const workers = [];
  const client = new ClipboardWorkerClient({yieldControl: () => Promise.resolve(), workerFactory: () => {
    const worker = new Worker(new URL('./clipboard-worker-node.mjs', import.meta.url)); workers.push(worker);
    const adapters = new Map();
    return {postMessage: (value, transfer) => worker.postMessage(value, transfer), terminate: () => {void worker.terminate();},
      addEventListener(name, callback) {const adapter = value => callback(name === 'message' ? {data: value} : value); adapters.set(callback, adapter); worker.on(name, adapter);},
      removeEventListener(name, callback) {worker.off(name, adapters.get(callback));}};
  }});
  return {client, workers};
}

test('real worker isolation round-trips the three bounded input streams', async () => {
  const {client} = nodeClient(), report = fixture();
  try {
    const result = await client.run({report, clipboard: {copied: [1, 2]}, state: {drag: {angles: [1 / 3]}}, request: {operation: 'echo'}});
    const expected = structuredClone(report); delete expected.keyframes[0].objects[0].runtime_segments;
    assert.deepEqual(result.report, expected); assert.deepEqual(result.clipboard, {copied: [1, 2]}); assert.deepEqual(result.state, {drag: {angles: [1 / 3]}});
    assert.ok(client.lastTimings.inputChunks > 1); assert.ok(client.lastTimings.outputChunks > 1);
  } finally {client.dispose();}
});

test('abort terminates a real worker even while its planner is synchronous', async () => {
  const {client} = nodeClient(), controller = new AbortController(); let began = 0;
  try {
    await assert.rejects(client.run({report: minimal(), request: {operation: 'busy'}}, {
      signal: controller.signal, onProgress: progress => {if (progress.phase === 'busy') {began = performance.now(); controller.abort();}},
    }), {name: 'AbortError'});
    assert.ok(began > 0); assert.ok(performance.now() - began < 1000, 'Cancellation does not wait for the 3-second synchronous planner');
    assert.equal(client.active, null);
  } finally {client.dispose();}
});
