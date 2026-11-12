import test from 'node:test';
import assert from 'node:assert/strict';
import {createScrubPreview, createSeekCosts, createStepRun, DEAR_SEEK_MS, STEP_RUN_MS} from '../src/engine/engine-scrub.mjs';

test('a scene scrubs from prepared frames when its paints at a new tick cost over 12 ms, by the median of the last three', () => {
  const costs = createSeekCosts(), dense = {}, light = {};
  assert.equal(DEAR_SEEK_MS, 12);
  assert.equal(costs.dear(dense), false, 'nothing measured is not dear');
  costs.record(dense, 0, 140);
  assert.equal(costs.dear(dense), true);
  assert.equal(costs.dear(light), false, 'what was measured of one document says nothing of another');
  // A redraw of the tick on show (a pan, an edit) reuses what that tick built: it is not a seek.
  costs.record(dense, 0, 1); costs.record(dense, 0, 1);
  assert.deepEqual(costs.samples, [140]);
  // One cheap paint among dear ones does not flip the rule, two of three do.
  costs.record(dense, 1, 3);
  assert.equal(costs.dear(dense), false, 'of two paints, both must be dear');
  costs.record(dense, 2, 150);
  assert.equal(costs.dear(dense), true);
  costs.record(dense, 3, 4);
  assert.equal(costs.dear(dense), false);
  assert.deepEqual(costs.samples, [3, 150, 4]);
  // Another document starts over.
  costs.record(light, 0, 2);
  assert.deepEqual(costs.samples, [2]);
  assert.equal(costs.dear(dense), false);
  for (const [tick, ms] of [[1, 11.9], [2, 12], [3, 11]]) costs.record(light, tick, ms);
  assert.equal(costs.dear(light), false, 'paints that keep up with the display scrub as editing');
});

/** A playback adapter whose frames are ready when the test says, and an engine whose progress the test advances. */
function preparedSide({total = 101} = {}) {
  const ready = new Set(), requests = [], reads = [];
  let progress = 0, wake = null;
  const playback = {get(tick) { reads.push(tick); return ready.has(tick) ? {tick, key: `engine:1:1:${tick}`, frame: {camera: {x: tick}}} : null; }};
  const engine = {
    progressSeen: () => progress,
    whenProgress: (seen, ms) => new Promise(resolve => { wake = {seen, ms, resolve}; }),
  };
  const preview = createScrubPreview({playback, total: () => total, engine: () => engine, prepare: (ticks, playhead) => requests.push({ticks: [...ticks], playhead})});
  return {preview, ready, requests, reads, engine, advance() { progress++; const waiting = wake; wake = null; waiting?.resolve(); return waiting; }, get wake() { return wake; }};
}

test('the pointer\'s tick is asked for first, then its neighbours in the drag\'s direction, three frames at a time', () => {
  const {preview, requests, ready} = preparedSide();
  preview.begin(10);
  preview.point(10);
  assert.deepEqual(requests.at(-1), {ticks: [10, 11, 12], playhead: 10});
  // Three frames are being made: the next moves wait for one of them (the pointer's tick of that moment is asked for then).
  preview.point(13); preview.point(15);
  assert.equal(requests.length, 1);
  ready.add(11);
  assert.equal(preview.next()?.tick, 11, 'a frame the pointer passed is shown');
  // Tick 10 and 11 are behind the pointer now (10 passed before 11 is not wanted; 11 is ready): their places go to the pointer.
  assert.deepEqual(requests.at(-1).ticks.slice(0, 2), [15, 16]);
  assert.ok(requests.at(-1).ticks.includes(12), 'the frame still being made and still wanted is asked for again, after the new ones');
});

test('a backward drag prepares the ticks before the pointer and the cache counts from the lowest of them', () => {
  const {preview, requests} = preparedSide();
  preview.begin(50);
  preview.point(50);
  preview.end();
  preview.begin(50);
  preview.point(40);
  assert.deepEqual(requests.at(-1), {ticks: [40, 39, 38], playhead: 38});
  // The document's ends bound what is asked for.
  preview.end(); preview.begin(1); preview.point(0);
  assert.deepEqual(requests.at(-1).ticks, [0]);
});

test('the frame shown is the newest one ready and never an older place of the pointer that gets ready late', () => {
  const {preview, ready} = preparedSide();
  preview.begin(0);
  for (const tick of [2, 5, 9, 14, 20]) preview.point(tick);
  ready.add(3); ready.add(12); ready.add(7);
  const first = preview.next();
  assert.equal(first.tick, 12, 'of the ticks passed, the one passed last that is ready');
  assert.equal(first.packet.key, 'engine:1:1:12');
  preview.presented(first);
  assert.equal(preview.next(), null, 'frames of ticks passed before the one on show are never shown after it');
  ready.add(13);
  assert.equal(preview.next()?.tick, 13, 'a tick passed after it is');
  preview.presented(preview.next());
  ready.add(20);
  assert.equal(preview.next()?.tick, 20);
  preview.presented(preview.next());
  assert.equal(preview.waiting, false);
  // Back over ticks already shown: they are newer places of the pointer now.
  preview.point(16);
  assert.equal(preview.waiting, true);
  ready.add(17);
  assert.equal(preview.next()?.tick, 17);
});

test('the presenter waits for the engine\'s progress without blocking, and stops at the release', async () => {
  const side = preparedSide();
  const {preview, ready} = side;
  let invalidated = 0;
  preview.begin(0);
  preview.point(6);
  assert.equal(preview.next(), null);
  preview.watch(() => invalidated++);
  preview.watch(() => invalidated++);
  assert.deepEqual({seen: side.wake.seen, ms: side.wake.ms}, {seen: 0, ms: 50}, 'one wait at a time, on the counter read before the ready reads');
  ready.add(6);
  side.advance();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(invalidated, 1);
  assert.equal(preview.next()?.tick, 6);
  // After the release nothing is shown, asked for or waited on.
  preview.point(9);
  preview.watch(() => invalidated++);
  preview.end();
  side.advance();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(invalidated, 1, 'a wait begun before the release does not paint after it');
  assert.equal(preview.active, false);
  assert.equal(preview.next(), null);
  const asked = side.requests.length;
  preview.point(12);
  assert.equal(side.requests.length, asked);
});

test('a pointer held on the frame on show, or past the end of the document, draws it once', () => {
  const {preview, ready} = preparedSide({total: 47});
  preview.begin(40);
  preview.point(46);
  ready.add(46);
  preview.presented(preview.next());
  for (const tick of [60, 68, 70]) { preview.point(tick); assert.equal(preview.next(), null, `past the end the last tick stays on show (${tick})`); }
  assert.equal(preview.shown.tick, 46);
  preview.point(44);
  ready.add(44);
  assert.equal(preview.next()?.tick, 44);
});

test('a jump marks only the ticks nearest the pointer, and what is kept stays bounded', () => {
  const {preview, ready, reads} = preparedSide({total: 100000});
  preview.begin(0);
  preview.point(90000);
  ready.add(90000 - 40); ready.add(90000 - 20);
  reads.length = 0;
  assert.equal(preview.next()?.tick, 90000 - 20);
  // The 24 newest places are read (each a read of the engine's cache), and the three being made and three to ask for.
  assert.ok(reads.length <= 24 + 6, `a paint makes a bounded number of ready reads (${reads.length})`);
  for (let tick = 0; tick < 2000; tick += 3) preview.point(tick);
  ready.add(1998);
  assert.equal(preview.next()?.tick, 1998);
});

/** A run of steps on a clock and timers the test moves; `dear` says whether the scene scrubs from prepared frames. */
function stepSide({dear = true} = {}) {
  let time = 0, serial = 0;
  const timers = new Map(), log = [];
  const run = createStepRun({
    begin: () => { log.push('begin'); return side.dear; }, end: () => log.push('end'),
    now: () => time, setTimer: (callback, ms) => { timers.set(++serial, {at: time + ms, callback}); return serial; }, clearTimer: id => timers.delete(id),
  });
  const side = {run, log, dear,
    /** The clock moves on `ms`; the timers due fire. */
    wait(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); } },
    /** A step `ms` after the one before, from the key `code` (its auto-repeat when `repeat`); true when it is a step of a run. */
    step(ms, {code = 'Period', repeat = false} = {}) { side.wait(ms); return run.step({code, repeat}); },
    get timers() { return timers.size; }};
  return side;
}

test('a held key: the first step is exact, the run starts at the first auto-repeat and ends with the key up', () => {
  const side = stepSide(), {run, log} = side;
  assert.equal(STEP_RUN_MS, 250);
  assert.equal(side.step(0), false, 'one press is an exact step');
  assert.deepEqual(log, []);
  // The keyboard's repeat delay (half a second) is longer than the gap: the repeat says it is a run.
  assert.equal(side.step(500, {repeat: true}), true);
  assert.deepEqual(log, ['begin']);
  for (let i = 0; i < 60; i++) assert.equal(side.step(33, {repeat: true}), true);
  assert.deepEqual(log, ['begin'], 'the run is begun once');
  // While the key is down the run waits for it, however long the interface keeps the next repeat.
  side.wait(1000);
  assert.equal(run.active, true);
  assert.equal(side.timers, 0);
  run.keyup({code: 'Comma'});
  assert.equal(run.active, true, 'another key going up does not end it');
  run.keyup({code: 'Period'});
  assert.deepEqual(log, ['begin', 'end'], 'the key up ends the run at once: the exact frame is drawn');
  assert.equal(run.active, false);
  // The next press is a single exact step again.
  assert.equal(side.step(400), false);
});

test('taps closer than the gap are one run, which ends a gap after the last tap', () => {
  const side = stepSide(), {run, log} = side;
  assert.equal(side.step(0), false);
  run.keyup({code: 'Period'});
  assert.equal(side.step(STEP_RUN_MS + 1), false, 'steps a quarter of a second apart are each exact');
  run.keyup({code: 'Period'});
  assert.equal(side.step(180), true, 'a tap within the gap starts a run');
  run.keyup({code: 'Period'});
  assert.equal(run.active, true, "a tap's key up leaves the run for the next tap");
  side.wait(200);
  assert.equal(side.step(0), true, 'the next tap joins it');
  run.keyup({code: 'Period'});
  side.wait(STEP_RUN_MS - 1);
  assert.equal(run.active, true);
  side.wait(1);
  assert.deepEqual(log, ['begin', 'end'], 'no step for the gap ends the run');
  // A run of taps that becomes a held key ends with the key.
  side.step(0); side.step(100); side.step(500, {repeat: true});
  run.keyup({code: 'Period'});
  assert.deepEqual(log, ['begin', 'end', 'begin', 'end']);
});

test('steps in an ordinary scene, during a drag or after losing focus are as before', () => {
  const side = stepSide({dear: false}), {run, log} = side;
  side.step(0);
  for (let i = 0; i < 5; i++) assert.equal(side.step(33, {repeat: true}), false, 'a scene whose frame keeps up steps exactly, every step');
  assert.equal(run.active, false);
  assert.deepEqual(log, ['begin', 'begin', 'begin', 'begin', 'begin'], 'asked at each step whether it scrubs from prepared frames');
  side.dear = true;
  assert.equal(side.step(33, {repeat: true}), true);
  // A playhead drag takes the run over: its release draws the exact frame, the run's end does not.
  run.cancel();
  run.keyup({code: 'Period'});
  assert.equal(log.at(-1), 'begin');
  assert.equal(run.active, false);
  // The window losing focus ends a run whose key up it will never see.
  side.step(33, {repeat: true});
  run.finish();
  assert.equal(log.at(-1), 'end');
  run.finish();
  assert.equal(log.filter(entry => entry === 'end').length, 1, 'a run ends once');
  // A step from no key (a source that has no key up) settles on its own.
  side.wait(1000); side.step(0, {code: ''}); assert.equal(side.step(100, {code: ''}), true);
  side.wait(STEP_RUN_MS);
  assert.equal(run.active, false);
});

test('a run of frame steps keeps two frames being prepared, a drag three', () => {
  const {preview, requests, ready} = preparedSide();
  preview.begin(10, {steps: true});
  preview.point(11);
  assert.deepEqual(requests.at(-1), {ticks: [11, 12], playhead: 11}, 'the playhead\'s tick and the next in the run\'s direction');
  preview.point(12); preview.point(13);
  assert.equal(requests.length, 1, 'two being made: the next steps wait for one of them');
  ready.add(12);
  assert.equal(preview.next()?.tick, 12);
  assert.deepEqual(requests.at(-1).ticks, [13, 14], 'what the run passed is dropped; its place goes to the playhead');
  preview.end();
  preview.begin(30);
  preview.point(31);
  assert.deepEqual(requests.at(-1).ticks, [31, 32, 33], 'the next drag prepares three again');
});
