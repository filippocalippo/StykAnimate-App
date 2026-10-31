// A worker inside the engine is never ended by the interface (src/engine/engine-guard.mjs): ending a thread of the shared memory in
// the middle of a call can leave the engine's allocator or a lock held for good.
import assert from 'node:assert/strict';
import test from 'node:test';
import {inside, guarded, releaseWorker, workerGuard} from '../src/engine/engine-guard.mjs';

/** A worker that never answers: it records what it is told and whether it was ended. */
function silentWorker() {
  const listeners = [], worker = {messages: [], terminated: false,
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
    postMessage(message) { worker.messages.push(message); },
    terminate() { worker.terminated = true; },
    say(data) { for (const listener of listeners) listener({data}); }};
  return worker;
}

test('a worker inside the engine is not ended when it is slow to release, and is once it is outside', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const worker = silentWorker(), guard = workerGuard(worker);
  let entered;
  inside(guard, () => { entered = true; releaseWorker(worker, 5000); t.mock.timers.tick(5000); t.mock.timers.tick(5000); });
  assert.ok(entered);
  assert.deepEqual(worker.messages, [{operation: 'release'}]);
  assert.equal(worker.terminated, false, 'still inside the engine after two timeouts');
  t.mock.timers.tick(5000);
  assert.equal(worker.terminated, true, 'outside the engine at the next one');
});

test('a worker outside the engine that does not release in time is ended, and one that releases is ended at once', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const stuck = silentWorker();
  workerGuard(stuck);
  releaseWorker(stuck, 5000);
  t.mock.timers.tick(4999);
  assert.equal(stuck.terminated, false);
  t.mock.timers.tick(1);
  assert.equal(stuck.terminated, true);
  const polite = silentWorker();
  workerGuard(polite);
  releaseWorker(polite, 5000);
  polite.say({released: true});
  assert.equal(polite.terminated, true);
});

test('a worker the interface claimed does not enter the engine, so the claim and the entry cannot both succeed', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const worker = silentWorker(), guard = workerGuard(worker);
  releaseWorker(worker, 100);
  t.mock.timers.tick(100);
  assert.equal(worker.terminated, true);
  let ran = false;
  assert.throws(() => inside(guard, () => { ran = true; }), {name: 'AbortError'});
  assert.equal(ran, false);
});

test('inside nests, leaves the guard on every exit, and a guarded object keeps its methods\' this', () => {
  const guard = workerGuard({});
  assert.throws(() => inside(guard, () => inside(guard, () => { assert.equal(Atomics.load(guard, 0), 1); throw new Error('boom'); })), /boom/);
  assert.equal(Atomics.load(guard, 0), 0);
  const object = {value: 7, read() { return [this.value, Atomics.load(guard, 0)]; }};
  assert.deepEqual(guarded(guard, object).read(), [7, 1]);
  assert.equal(Atomics.load(guard, 0), 0);
  assert.equal(inside(null, () => 'no guard, no claim'), 'no guard, no claim');
});
