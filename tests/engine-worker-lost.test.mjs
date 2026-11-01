// A preparation thread that traps cannot tell the engine itself: the page sees its `error` event and tells the engine, so that a save
// waiting for a job on that thread gives up (engine/crates/styk-engine/src/together.rs, src/engine/engine.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadEngine} from '../src/engine/engine.mjs';
import {lendableWorkers, lendsSceneWorker} from '../src/document-export.mjs';

function fakeWorkers(t) {
  const started = [], real = globalThis.Worker;
  globalThis.Worker = class {
    constructor(url, init) { this.url = String(url); this.name = init?.name; started.push(this); }
    postMessage() { queueMicrotask(() => this.onmessage?.({})); }
    terminate() {}
  };
  t.after(() => { globalThis.Worker = real; });
  return started;
}

test('an error of a running engine thread is reported to the engine', async t => {
  const started = fakeWorkers(t);
  (await loadEngine({workers: 0})).destroy();
  const engine = await loadEngine({workers: 2});
  t.after(() => engine.destroy());
  assert.equal(engine.handle.workers_lost(), 0);
  started[1].onerror({message: 'RuntimeError: unreachable'});
  assert.equal(engine.handle.workers_lost(), 1, 'the trap reached the engine');
  started[0].onerror({message: 'RuntimeError: unreachable'});
  assert.equal(engine.handle.workers_lost(), 2);
});

test('a save lends the engine threads it can spare and keeps one for the frame on show', () => {
  const lent = workers => lendableWorkers({workers});
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8, 16].map(lent), [0, 0, 1, 2, 3, 3, 3, 3]);
  assert.equal(lendableWorkers(undefined), 0);
  assert.equal(lendableWorkers({}), 0);
});

test('what a save borrows leaves a thread free for the frame on show at every size of pool', () => {
  const borrowed = workers => lendableWorkers({workers}) + (lendsSceneWorker({workers}) ? 1 : 0);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 8, 12, 16].map(borrowed), [0, 0, 1, 2, 3, 4, 4, 4, 4, 4]);
  for (let workers = 0; workers <= 16; workers++) {
    assert.ok(borrowed(workers) <= Math.max(0, workers - 1), `${workers} threads: ${borrowed(workers)} borrowed`);
    if (workers >= 1) assert.ok(workers - borrowed(workers) >= 1, `${workers} threads leave one free`);
  }
  assert.equal(lendsSceneWorker({workers: 4}), false, 'a pool of four lends its three and keeps one');
  assert.equal(lendsSceneWorker({workers: 5}), true);
  assert.equal(lendsSceneWorker(undefined), false);
});
