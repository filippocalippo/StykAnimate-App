import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForEngineProgress} from '../src/engine/engine.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function noProgress(threaded) {
  const progress = new Int32Array(new SharedArrayBuffer(4));
  let settled = false;
  const pending = waitForEngineProgress(progress, threaded, 0, 16).then(() => { settled = true; });
  try {
    // 16 ms were asked for, and a Windows timer takes up to 16 ms to fire (twice for the polling
    // owner): wait up to the interface's 250 ms ceiling for the timeout instead of a fixed 35 ms.
    for (const end = performance.now() + 250; !settled && performance.now() < end;) await delay(1);
    assert.equal(settled, true, 'a Busy lock release needs no progress publication to retry');
    assert.equal(Atomics.load(progress, 0), 0, 'timeout cannot manufacture progress');
  } finally {
    // Also release an original/mutated unbounded waiter before reporting failure.
    Atomics.add(progress, 0, 1); Atomics.notify(progress, 0); await pending;
  }
}

test('the no-thread progress owner times out with an unchanged actual counter', () => noProgress(false));

test('the actual waitAsync owner times out without fabricating progress', {skip: typeof Atomics.waitAsync !== 'function'}, () => noProgress(true));

test('threaded fallback without waitAsync also has a finite unchanged-progress wait', async () => {
  const original = Atomics.waitAsync;
  try { Atomics.waitAsync = undefined; await noProgress(true); }
  finally { Atomics.waitAsync = original; }
});

test('progress between the owner check and actual waitAsync is observed immediately', {skip: typeof Atomics.waitAsync !== 'function'}, async t => {
  const progress = new Int32Array(new SharedArrayBuffer(4));
  const original = Atomics.waitAsync;
  const timeouts = [];
  t.mock.method(Atomics, 'waitAsync', (array, index, seen, timeout) => {
    timeouts.push(timeout); Atomics.add(array, index, 1);
    return original(array, index, seen, timeout);
  });
  await waitForEngineProgress(progress, true, 0, 16);
  assert.deepEqual(timeouts, [16]);
  assert.equal(Atomics.load(progress, 0), 1, 'only the producer changes actual progress');
});

test('default and invalid progress waits retain the finite 250 ms ceiling', {skip: typeof Atomics.waitAsync !== 'function'}, async t => {
  const progress = new Int32Array(new SharedArrayBuffer(4));
  const original = Atomics.waitAsync, timeouts = [];
  t.mock.method(Atomics, 'waitAsync', (array, index, seen, timeout) => {
    timeouts.push(timeout);
    // Observe the actual owning primitive arguments without delaying this probe.
    return original(array, index, seen, 0);
  });
  for (const timeout of [undefined, Infinity, NaN, 1000, 16, 0, -1]) await waitForEngineProgress(progress, true, 0, timeout);
  assert.deepEqual(timeouts, [250, 250, 250, 250, 16]);
  assert.equal(Atomics.load(progress, 0), 0);
  Atomics.store(progress, 0, 1);
  await waitForEngineProgress(progress, true, 0, 16);
  assert.equal(timeouts.length, 5, 'already published work does not wait');
});
