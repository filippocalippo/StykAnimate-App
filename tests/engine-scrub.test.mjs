import test from 'node:test';
import assert from 'node:assert/strict';
import {createScrubPreview, createSeekCosts, DEAR_SEEK_MS} from '../src/engine/engine-scrub.mjs';

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
