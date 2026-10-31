// A launch starts two engine threads; the rest join when a document, playback or an export needs them (src/engine/engine.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadEngine} from '../src/engine/engine.mjs';

/** Workers that answer at once, standing in for engine threads: only how many start is under test. */
function fakeWorkers(t) {
  const started = [], real = globalThis.Worker;
  globalThis.Worker = class {
    constructor(url, init) { this.url = String(url); this.name = init?.name; this.ended = false; started.push(this); }
    postMessage() { queueMicrotask(() => this.onmessage?.({})); }
    terminate() { this.ended = true; }
  };
  t.after(() => { globalThis.Worker = real; });
  return started;
}

test('a launch starts two threads and grow() starts the rest once', async t => {
  const started = fakeWorkers(t);
  const first = await loadEngine({workers: 0}); // the preloaded engine (tests/support/register-engine.mjs)
  first.destroy();
  const engine = await loadEngine({workers: 6});
  t.after(() => engine.destroy());
  assert.equal(engine.threaded, true);
  assert.equal(engine.workers, 2, 'two threads at launch');
  assert.equal(started.length, 2);
  const growing = engine.grow();
  assert.equal(engine.grow(), growing, 'one growth, however many callers');
  await growing;
  assert.equal(engine.workers, 6);
  assert.equal(started.length, 6);
  await engine.grow();
  assert.equal(started.length, 6, 'a grown pool does not grow again');
});

test('a device with fewer cores than the launch count starts what it has', async t => {
  const started = fakeWorkers(t);
  (await loadEngine({workers: 0})).destroy();
  const engine = await loadEngine({workers: 1});
  t.after(() => engine.destroy());
  await engine.grow();
  assert.equal(started.length, 1);
});

test('grow() starts nothing once the engine is destroyed', async t => {
  const started = fakeWorkers(t);
  (await loadEngine({workers: 0})).destroy();
  const engine = await loadEngine({workers: 4});
  engine.destroy();
  await engine.grow();
  assert.equal(started.length, 2);
});

test('an engine without threads has nothing to grow', async t => {
  fakeWorkers(t);
  (await loadEngine({workers: 0})).destroy();
  const engine = await loadEngine({workers: 0});
  t.after(() => engine.destroy());
  assert.equal(engine.threaded, false);
  await engine.grow();
  assert.equal(engine.workers, 0);
});
