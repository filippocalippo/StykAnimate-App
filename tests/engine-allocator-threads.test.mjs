// The engine's allocator keeps a cache of small blocks for each thread behind a lock of its own (engine/crates/styk-alloc, docs/engine/memory.md):
// real threads on the shared memory allocate, free each other's blocks, grow the heap together and end the way the export worker does
// (`__wbindgen_thread_destroy`, which frees the thread's stack and thread-local block, the cache's home).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {engineBuilt, nodeEngine} from './support/engine-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = new URL('./support/allocator-thread.mjs', import.meta.url);
const KIB = 1024;

// `execArgv: []`: `npm test` runs with `--import` of a script that loads a private engine, which a worker would inherit and then not
// join the shared memory.
const start = ({module, memory, stack}) => new Promise((resolve, reject) => {
  const worker = new Worker(WORKER, {workerData: {module, memory, stack}, execArgv: []});
  worker.once('message', () => resolve(worker));
  worker.once('error', reject);
});
const ask = (worker, message) => new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.postMessage(message);
});

test('threads allocate, free one another\'s blocks and end without losing or corrupting any', {skip: !engineBuilt || !existsSync(path.join(root, 'src/engine/pkg/styk_engine_bg.wasm'))}, async () => {
  const {engine} = await nodeEngine();
  const before = engine.memory();
  let afterFirst;
  for (let round = 0; round < 4; round++) {
    const workers = await Promise.all(Array.from({length: 4}, () => start(engine.join)));
    // Every thread makes blocks that the next one frees, while all of them allocate large blocks and so grow the heap together.
    const made = await Promise.all(workers.map(worker => ask(worker, {type: 'allocate', count: 20000, big: 6, bigBytes: 3 << 20})));
    assert.ok(made.every(m => m.intact), 'a block was overwritten while its thread used it');
    const freed = await Promise.all(workers.map((worker, i) => ask(worker, {type: 'free', given: made[(i + 1) % made.length].given})));
    assert.ok(freed.every(m => m.intact), 'a block arrived changed in the thread that freed it');
    // Ending a thread frees its thread-local block and its stack, with the allocator's cache in the first.
    await Promise.all(workers.map(worker => ask(worker, {type: 'end'})));
    await Promise.all(workers.map(worker => worker.terminate()));
    afterFirst ??= engine.memory();
  }
  const after = engine.memory();
  // Nothing is left outstanding: what each thread counted for itself was added when it ended (the main thread's own count is exact,
  // and so is the sum of the others up to the step a thread adds in).
  assert.ok(Math.abs(after.liveBytes - before.liveBytes) < 256 * KIB, `live ${before.liveBytes} -> ${after.liveBytes}`);
  // Threads that came and went reuse the memory the first ones grew to.
  assert.ok(after.heapBytes - afterFirst.heapBytes < 64 * 1024 * KIB, `the heap grew by ${(after.heapBytes - afterFirst.heapBytes) / KIB / KIB} MiB over three more rounds`);
});
