import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {PlaybackCache} from '../src/playback.mjs';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';

const workerFactory = () => {
  const worker = new Worker(new URL('./playback-node-worker.mjs', import.meta.url));
  return {postMessage: (message, transfer) => worker.postMessage(message, transfer), terminate: () => worker.terminate(),
    addEventListener: (name, callback) => worker.on(name, value => callback(name === 'message' ? {data: value} : value))};
};
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = Array.from({length: 5}, (_, index) => createFrame([
    createObject(figure, 1, 100 + index * 20, 150),
    createObject(figure, 2, 200, 150, {join: {target_object_slot: 0, target_handle_id: 1}, field28: 100}),
  ], 4));
  return new Editor({demo: false}).load(report).report;
}
const ticks = cache => Array.from({length: cache.totalTicks}, (_, i) => i);
test('independent playback controllers never share a resource ownership epoch', () => {
  const first = new PlaybackCache({workerFactory}), second = new PlaybackCache({workerFactory});
  try {
    first.invalidate(); second.invalidate();
    assert.equal(first.revision, second.revision);
    assert.notEqual(first.cacheEpoch, second.cacheEpoch);
  } finally {first.dispose(); second.dispose();}
});
async function matches(cache, report) {
  await cache.prepareRange(ticks(cache));
  for (const tick of ticks(cache)) {
    const actual = cache.get(tick), expected = await compilePlaybackPacket(report, tick, {scale: cache.scale, cameraEnabled: cache.cameraEnabled});
    assert.deepEqual(actual.shapes, expected.shapes, `shapes at ${tick}`);
    assert.deepEqual(actual.transforms, expected.transforms, `joined transforms at ${tick}`);
    assert.deepEqual(actual.frame, expected.frame, `frame metadata at ${tick}`);
  }
}

test('native edits keep independent packets, invalidate incoming tweens, and retain exact joined output', async () => {
  const report = fixture(), cache = new PlaybackCache({workerFactory});
  try {
    cache.load(report); await matches(cache, report);
    const original = new Map(cache.cache), before = cache.stats.preparedFrames;
    report.keyframes[2].objects[0].angles[0] += .31;
    cache.updateFrame(2, report.keyframes[2]);
    assert.deepEqual([...cache.cache.keys()].sort((a,b)=>a-b), [0,1,2,3,4,12,13,14,15,16]);
    assert.equal(cache.stats.retainedFrames, 10);
    assert.equal(cache.get(0), original.get(0));
    await matches(cache, report);
    assert.equal(cache.stats.preparedFrames - before, 7);
    assert.equal(cache.get(0).cacheEpoch, cache.get(8).cacheEpoch);
    assert.notEqual(cache.get(0).revision, cache.get(8).revision);
    report.keyframes[1].camera = {is_default: false, x: 40, y: -20, scale: 1.2, angle_rad: .15};
    cache.updateFrame(1, report.keyframes[1]); await matches(cache, report);
  } finally {cache.dispose();}
});

test('timing shifts invalidate displaced ticks and legacy easing invalidates distant interpolated packets', async () => {
  for (const legacy of [false, true]) {
    const report = fixture(); report.auto_easing = legacy;
    const cache = new PlaybackCache({workerFactory});
    try {
      cache.load(report); await matches(cache, report);
      report.keyframes[2].objects[0].root_x += 70;
      cache.updateFrame(2, report.keyframes[2]);
      if (legacy) assert.deepEqual([...cache.cache.keys()].sort((a,b)=>a-b), [0,4,12,16]);
      await matches(cache, report);
      report.keyframes[2].duration_raw = 8;
      cache.updateFrame(2, report.keyframes[2]);
      assert.deepEqual([...cache.cache.keys()].sort((a,b)=>a-b), legacy ? [0,4] : [0,1,2,3,4]);
      await matches(cache, report);
      report.keyframes[2].duration_raw = 0;
      cache.updateFrame(2, report.keyframes[2]); await matches(cache, report);
    } finally {cache.dispose();}
  }
});

test('metadata, view, definition and authored source changes cannot reuse stale packets', async () => {
  const report = fixture(), cache = new PlaybackCache({workerFactory});
  try {
    cache.load(report); await matches(cache, report);
    report.canvas_width += 20; cache.updateDocument(); assert.equal(cache.cache.size, 0); await matches(cache, report);
    cache.updateView({scale: 2}); assert.equal(cache.cache.size, 0); await matches(cache, report);
    report.keyframes[2].objects[0].root_y += 20; cache.updateFrame(2, report.keyframes[2]);
    assert.equal(cache.cache.size, 10, 'View reset establishes a new retention snapshot.'); await matches(cache, report);
    report.figure_types[0].segments[0].thickness += 2;
    cache.updateDocument({definition: true}); assert.equal(cache.cache.size, 0); await matches(cache, report);
    const source = structuredClone(report.keyframes[0]); source._styk.frameId = 'frame-source-test';
    report._styk.frameSources = {'frame-source-test': source};
    cache.updateDocument(); assert.equal(cache.cache.size, 0); await matches(cache, report);
  } finally {cache.dispose();}
});

test('superseding pending patches preserves only packets independent of both edits', async () => {
  const report = fixture(), cache = new PlaybackCache({workerFactory});
  try {
    cache.load(report); await matches(cache, report); const untouched = cache.get(0);
    report.keyframes[2].objects[0].root_y += 11; cache.updateFrame(2, report.keyframes[2]);
    report.keyframes[3].objects[1].scale *= 1.2; cache.updateFrame(3, report.keyframes[3]);
    assert.equal(cache.get(0), untouched);
    assert.ok([...cache.cache.keys()].every(tick => tick <= 4 || tick === 16));
    await matches(cache, report);
  } finally {cache.dispose();}
});

test('Auto easing invalidates neighboring tangents when a non-endpoint pose or mode changes', async () => {
  const report = fixture(), cache = new PlaybackCache({workerFactory});
  for (const frame of report.keyframes) frame._styk.easing = {interpolation: 'auto'};
  try {
    cache.load(report); await matches(cache, report); const before = cache.get(5);
    report.keyframes[3].objects[0].root_x += 19;
    cache.updateFrame(3, report.keyframes[3]);
    assert.equal(cache.get(5), null, 'A following tangent depends on the key after the endpoint.');
    await matches(cache, report); assert.notDeepEqual(cache.get(5).transforms, before.transforms);
    report.keyframes[0]._styk.easing = {interpolation: 'linear'};
    cache.updateFrame(0, report.keyframes[0]);
    assert.equal(cache.get(5), null, 'Ending the preceding Auto interval changes this interval tangent.');
    await matches(cache, report);
  } finally {cache.dispose();}
});
