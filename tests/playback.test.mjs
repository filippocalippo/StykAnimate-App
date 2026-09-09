import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { PlaybackCache } from '../src/playback.mjs';
import { compilePlaybackPacket, playbackLocation, playbackVisibleBounds, playbackRasterBounds } from '../src/playback-worker.mjs';
import { evaluatedFrame, timeline, buildGeometry } from '../src/pivot/geometry.mjs';
import { compileVectorObject, SHAPE_FLOATS, worldToScreen } from '../src/renderer-geometry.mjs';
import { createDemo, createFrame, createObject, defaultFigure, emptyDocument } from '../src/demo.mjs';

export const nodeWorkerFactory = () => {
  const worker = new Worker(new URL('./playback-node-worker.mjs', import.meta.url));
  return { postMessage: (message, transfer) => worker.postMessage(message, transfer), terminate: () => worker.terminate(),
    addEventListener: (name, callback) => worker.on(name, value => callback(name === 'message' ? { data: value } : value)) };
};

test('prepared stage bounds include all rotated-camera corners and honor camera disable', () => {
  const report = { canvas_width: 640, canvas_height: 480 };
  const frame = { camera: { x: 193, y: -87, angle_rad: .67, scale: 2.4 } };
  const bounds = playbackVisibleBounds(report, frame);
  const corners = [];
  for (const x of [bounds.x, bounds.x + bounds.width]) for (const y of [bounds.y, bounds.y + bounds.height])
    corners.push(worldToScreen({ x, y }, { report, frame }));
  assert.ok(Math.min(...corners.map(p => p.x)) <= 0 && Math.max(...corners.map(p => p.x)) >= 640);
  assert.ok(Math.min(...corners.map(p => p.y)) <= 0 && Math.max(...corners.map(p => p.y)) >= 480);
  assert.deepEqual(playbackVisibleBounds(report, frame, false), { x: 0, y: 0, width: 640, height: 480 });
});

test('prepared raster cropping retains sample grid, filtering guards and original resolution', () => {
  const original = { x: -1000, y: -750, width: 3400, height: 2800 };
  const visible = { x: 0, y: 0, width: 640, height: 480 };
  const clipped = playbackRasterBounds(original, visible, 2);
  assert.equal(clipped.pixelScale, 4096 / 3400);
  assert.ok(clipped.pixelWidth * clipped.pixelHeight < clipped.fullPixels / 15);
  assert.ok(Math.abs((clipped.x - original.x) * clipped.pixelScale - Math.round((clipped.x - original.x) * clipped.pixelScale)) < 1e-9);
  assert.ok(clipped.x <= visible.x - 2 / clipped.pixelScale);
  assert.ok(clipped.y + clipped.height >= visible.y + visible.height + 2 / clipped.pixelScale);
  assert.equal(playbackRasterBounds({ x: 3000, y: 4000, width: 100, height: 100 }, visible, 2), null);
});

test('texture resolution quantizes the native camera and physical view scale together', async () => {
  const report = createDemo(); report.keyframes[0].camera = { x: 0, y: 0, angle_rad: 0, scale: .9 };
  const packet = await compilePlaybackPacket(report, 0, { scale: 1.49 });
  assert.equal(packet.scale, 1.49); assert.equal(packet.resolution, 2);
  assert.equal((await compilePlaybackPacket(report, 0, { scale: 2 })).resolution, 4,
    'Rounding physical scale before applying the native camera would oversample this view.');
});

test('prepared packets identify the camera view that determined their texture crop', async () => {
  const report = createDemo(); report.keyframes[0].camera = {x: 200, y: 100, angle_rad: .25, scale: .25};
  const camera = await compilePlaybackPacket(report, 0), neutral = await compilePlaybackPacket(report, 0, {cameraEnabled: false});
  assert.equal(camera.cameraEnabled, true); assert.equal(neutral.cameraEnabled, false);
  assert.equal(camera.resolution, 4); assert.equal(neutral.resolution, 1);
  assert.deepEqual(camera.shapes, neutral.shapes, 'world-space vectors remain independent of the chosen camera view');
  await assert.rejects(compilePlaybackPacket(report, 0, {cameraEnabled: 'false'}), /boolean/);
});

test('worker packets preserve native easing, camera, colors, joins and primitive order on every tick', async () => {
  const report = createDemo(); report.auto_easing = true;
  report.keyframes.length = 4;
  report.keyframes.forEach((frame, i) => {
    frame.camera = { x: 8 * i, y: -2 * i, angle_rad: .11 * i, scale: 1 + .04 * i };
    frame.background_id = i; frame.background_id_b = i + 1; frame.background_mix = 31 * i;
    frame.objects[2].join = { target_object_slot: 0, target_segment_id: 1 };
    frame.objects[0].color_override_raw = (0xff000000 | i * 0x00502010) >>> 0;
    frame.object_draw_order = [2, 0, 1];
  });
  const cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(report); const ticks = Array.from({ length: cache.totalTicks }, (_, i) => i); await cache.prepareRange(ticks);
    for (const tick of ticks) {
      const packet = cache.get(tick), location = playbackLocation(timeline(report), tick), frame = evaluatedFrame(report, location.index, location.t);
      assert.equal(packet.frameIndex, location.index); assert.deepEqual(packet.frame.camera, frame.camera);
      assert.equal(packet.frame.background_id, frame.background_id); assert.equal(packet.frame.background_mix, frame.background_mix);
      const geometry = buildGeometry(report, frame);
      assert.deepEqual(packet.groups.map(group => group.slot), frame.object_draw_order);
      for (const group of packet.groups) {
        const object = geometry.objects.get(group.slot), items = geometry.drawables.filter(s => s.slot === group.slot);
        const expected = compileVectorObject(items, object.root, group.transformIndex);
        assert.deepEqual(packet.shapes.slice(group.firstInstance * SHAPE_FLOATS, (group.firstInstance + group.instanceCount) * SHAPE_FLOATS), expected);
        assert.equal(packet.transforms[group.transformIndex * 4], Math.fround(object.root.x));
        assert.equal(packet.transforms[group.transformIndex * 4 + 1], Math.fround(object.root.y));
      }
      assert.equal(packet.frame.objects, undefined, 'Full scene graphs should not cross the worker boundary.');
      assert.ok(packet.shapes instanceof Float32Array); assert.ok(packet.uids instanceof Uint32Array);
    }
  } finally { cache.dispose(); }
});

test('zero-duration keys and the last native v5 key preserve their exact tick semantics', async () => {
  const report = createDemo(); report.keyframes.length = 4;
  report.keyframes[0].duration_raw = 0; report.keyframes[1].duration_raw = 3;
  report.keyframes[2].duration_raw = 0; report.keyframes[3].duration_raw = 12;
  const cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(report); assert.equal(cache.totalTicks, 4); await cache.prepareRange([0, 1, 2, 3, -1, 4]);
    assert.deepEqual([0, 1, 2, 3].map(tick => cache.get(tick).frameIndex), [1, 1, 1, 3]);
    assert.equal(cache.get(4), null);
  } finally { cache.dispose(); }
});

test('bounded LRU eviction, generation invalidation, in-flight cancellation and disposal', async () => {
  const report = createDemo(), cache = new PlaybackCache({ workerFactory: nodeWorkerFactory, maxFrames: 2 });
  try {
    cache.load(report); await cache.prepareRange([0, 1]); const first = cache.get(0), generation = first.revision;
    await cache.prepareRange([2]); assert.equal(cache.has(0), true); assert.equal(cache.has(1), false); assert.equal(cache.stats.evictions, 1);
    assert.ok(cache.stats.bytes <= cache.maxBytes);
    const pending = cache.prepareRange([3, 4, 5]); const rejected = assert.rejects(pending, { name: 'AbortError' });
    report.keyframes[0].objects[0].root_x += 333; cache.invalidate(); await rejected;
    assert.equal(cache.get(0), null); await cache.prepareRange([0]);
    const latest = cache.get(0); assert.notEqual(latest.key, first.key); assert.ok(latest.revision > generation);
    assert.equal(latest.transforms[4], Math.fround(report.keyframes[0].objects[0].root_x));
    const outstanding = cache.prepareRange([1, 2]); const disposed = assert.rejects(outstanding, { name: 'AbortError' }); cache.dispose(); await disposed;
    assert.equal(cache.stats.bytes, 0); assert.equal(cache.stats.readyFrames, 0);
    await assert.rejects(cache.prepareRange([0]), /disposed/);
  } finally { cache.dispose(); }
});

test('worker budget errors are explicit and never retain an oversized frame', async () => {
  const cache = new PlaybackCache({ workerFactory: nodeWorkerFactory, maxBytes: 100 });
  try {
    cache.load(createDemo()); await assert.rejects(cache.prepareRange([0]), { code: 'playback_frame_budget' });
    assert.equal(cache.stats.readyFrames, 0); assert.equal(cache.stats.bytes, 0);
  } finally { cache.dispose(); }
});

test('a replacement document or disposal cancels an in-flight chunked snapshot before publishing frames', async () => {
  const cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    const first = createDemo(), second = createDemo(); second.keyframes[0].objects[0].root_x = 919;
    cache.load(first); const stale = cache.prepareRange([0]); const rejected = assert.rejects(stale, { name: 'AbortError' });
    cache.load(second); await rejected; await cache.prepareRange([0]);
    assert.equal(cache.get(0).transforms[4], 919); assert.ok(cache.stats.loadChunks > 1);
    cache.load(first); const preparing = cache.prepareRange([0]); const disposed = assert.rejects(preparing, { name: 'AbortError' });
    cache.dispose(); await disposed; assert.equal(cache.stats.bytes, 0);
  } finally { cache.dispose(); }
});

test('changing the prefetch window discards distant queued work and prepares the exact requested ticks', async () => {
  const cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(createDemo()); await cache.prepareRange([0]);
    const oldWindow = cache.prepareRange([1, 2, 3, 4, 5, 6, 7, 8]);
    const rejected = assert.rejects(oldWindow, { name: 'AbortError' });
    await cache.prepareRange([20, 21], { replacePending: true }); await rejected;
    assert.ok(cache.get(20)); assert.ok(cache.get(21)); assert.equal(cache.stats.pendingFrames, 0);
  } finally { cache.dispose(); }
});

test('frame deltas retain definitions and update native easing on neighboring ticks', async () => {
  const report = createDemo(); report.auto_easing = true;
  const cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(report); await cache.prepareRange([1]); const before = cache.get(1);
    report.keyframes[1].objects[0].root_x += 90;
    cache.updateFrame(1, report.keyframes[1], { revision: 2 }); await cache.prepareRange([1]);
    const after = cache.get(1), expected = evaluatedFrame(report, 0, .5);
    assert.notEqual(after.key, before.key); assert.notEqual(after.transforms[4], before.transforms[4]);
    assert.equal(after.transforms[4], Math.fround(expected.objects[0].root_x));
    assert.equal(cache.stats.loadKind, 'frame'); assert.equal(cache.stats.updatedFrames, 1);
  } finally { cache.dispose(); }
});

test('rapid edits to different frames merge across cancelled in-flight delta snapshots', async () => {
  const report = createDemo(), cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(report); await cache.prepareRange([0]);
    report.keyframes[0].objects[0].root_x = 123;
    cache.updateFrame(0, report.keyframes[0], { revision: 2 });
    const first = cache.prepareRange([0]), interrupted = assert.rejects(first, { name: 'AbortError' });
    report.keyframes[1].objects[0].root_x = 789;
    cache.updateFrame(1, report.keyframes[1], { revision: 3 });
    await cache.prepareRange([0, 2]); await interrupted;
    assert.equal(cache.get(0).transforms[4], 123); assert.equal(cache.get(2).transforms[4], 789);
    assert.equal(cache.stats.updatedFrames, 2);
  } finally { cache.dispose(); }
});

test('view changes retain the worker document and cancel outdated frame preparations', async () => {
  const report = createDemo(), cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  report.keyframes[0].camera = { x: 20, y: 30, angle_rad: .1, scale: .75 };
  try {
    cache.load(report, { revision: 7 }); await cache.prepareRange([0]);
    const before = cache.get(0), chunks = cache.stats.loadChunks, bytes = cache.stats.loadSerializationMs;
    cache.updateView({ scale: 1.49 });
    const old = cache.prepareRange([0, 1, 2]), cancelled = assert.rejects(old, { name: 'AbortError' });
    cache.updateView({ scale: 3, cameraEnabled: false });
    await cache.prepareRange([0]); await cancelled;
    const latest = cache.get(0);
    assert.notEqual(latest.key, before.key); assert.equal(latest.scale, 3); assert.equal(latest.resolution, 4);
    assert.equal(cache.documentRevision, 7); assert.equal(cache.stats.loadChunks, chunks); assert.equal(cache.stats.loadSerializationMs, bytes);
    assert.deepEqual(latest.frame.camera, before.frame.camera, 'View options must not alter native camera data.');
    const key = latest.key; cache.updateView({ scale: 3, cameraEnabled: false }); assert.equal(cache.get(0).key, key);
  } finally { cache.dispose(); }
});

test('view changes during document or frame transfer preserve the latest source and edit revision', async () => {
  const report = createDemo(), cache = new PlaybackCache({ workerFactory: nodeWorkerFactory });
  try {
    cache.load(report, { revision: 9 });
    const initial = cache.prepareRange([0]), abortedLoad = assert.rejects(initial, { name: 'AbortError' });
    cache.updateView({ scale: 1.7 }); await cache.prepareRange([0]); await abortedLoad;
    assert.equal(cache.get(0).scale, 1.7); assert.equal(cache.documentRevision, 9);
    report.keyframes[0].objects[0].root_x = 456;
    cache.updateFrame(0, report.keyframes[0], { revision: 10 });
    const delta = cache.prepareRange([0]), abortedDelta = assert.rejects(delta, { name: 'AbortError' });
    cache.updateView({ scale: .8, cameraEnabled: false }); await cache.prepareRange([0]); await abortedDelta;
    assert.equal(cache.get(0).transforms[4], 456); assert.equal(cache.get(0).scale, .8); assert.equal(cache.documentRevision, 10);
    assert.equal(cache._frameUpdates.size, 0); assert.equal(cache.stats.loadKind, 'patch');
  } finally { cache.dispose(); }
});

test('the next exact tick survives speculative prefetch when scene memory grows abruptly', async () => {
  const report = emptyDocument(), figure = defaultFigure(); report.figure_types = [figure];
  report.keyframes = Array.from({ length: 5 }, (_, index) => createFrame(Array.from({ length: index ? 4 : 1 }, (_, object) => createObject(figure, object + 1, 50 * object, 100))));
  const big = await compilePlaybackPacket(report, 1), cache = new PlaybackCache({ workerFactory: nodeWorkerFactory, maxBytes: Math.ceil(big.byteLength * 2.25) });
  try {
    cache.load(report); await cache.prepareRange([0]);
    await assert.rejects(cache.prepareRange([1, 2, 3, 4], { replacePending: true }), { name: 'AbortError' });
    await cache.prepareRange([1, 2], { replacePending: true });
    assert.ok(cache.get(1), 'A speculative frame evicted the next exact playback tick.');
    assert.ok(cache.get(2), 'Distant speculative frames evicted the nearest frame after the next tick.');
    assert.ok(cache.stats.bytes <= cache.maxBytes); assert.ok(cache.stats.evictions > 0);
  } finally { cache.dispose(); }
});

test('known oversized prefetch windows do not repeatedly compile discarded future packets', async () => {
  const report = emptyDocument(), figure = defaultFigure(); report.figure_types = [figure];
  report.keyframes = Array.from({ length: 6 }, (_, index) => createFrame(Array.from({ length: index ? 4 : 1 }, (_, object) => createObject(figure, object + 1, 50 * object, 100))));
  const big = await compilePlaybackPacket(report, 1), requests = [];
  const workerFactory = () => { const worker = nodeWorkerFactory(), post = worker.postMessage;
    worker.postMessage = (message, transfer) => { if (message.type === 'prepare') requests.push(...message.ticks); post(message, transfer); }; return worker; };
  const cache = new PlaybackCache({ workerFactory, maxBytes: Math.ceil(big.byteLength * 2.25) });
  try {
    cache.load(report); await cache.prepareRange([0]);
    await assert.rejects(cache.prepareRange([1, 2, 3, 4], { replacePending: true }), { name: 'AbortError' });
    await cache.prepareRange([1, 2], { replacePending: true });
    assert.ok(cache.has(1) && cache.has(2)); assert.equal(cache.has(3), false);
    const prior = requests.length;
    for (let i = 0; i < 10; i++) await cache.prepareRange([1, 2, 3, 4], { replacePending: true });
    assert.equal(requests.length, prior, 'Packets known not to fit must not repeatedly feed GPU rasterization.');
    assert.ok(cache.stats.suppressedPrefetchFrames >= 20);
    await cache.prepareRange([2, 3, 4], { replacePending: true });
    assert.ok(cache.has(2) && cache.has(3)); assert.equal(cache.has(4), false);
    assert.deepEqual(requests.slice(prior), [3], 'Advancing playback should admit only the nearest newly feasible frame.');
    cache.updateView({ scale: 1.5 }); assert.equal(cache._packetSizes.size, 0, 'Old view size estimates must not constrain new textures.');
  } finally { cache.dispose(); }
});

test('the first measured packet immediately trims cold speculative work without cancelling explicit requests', async () => {
  const messages = [], cache = new PlaybackCache({ maxBytes: 125, workerFactory: () => ({
    postMessage: message => messages.push(message), addEventListener() {}, terminate() {}
  }) });
  // A controlled endpoint lets the test observe the queue before a second packet
  // or an animation-loop prepareRange call can hide excessive speculative work.
  cache.report = createDemo(); cache.totalTicks = 24;
  try {
    const initial = cache.prepareRange([0, 1, 2, 3, 4, 5], { replacePending: true });
    const cancelled = assert.rejects(initial, { name: 'AbortError' });
    await Promise.resolve();
    const explicit = cache.prepareRange([9]); await Promise.resolve();
    assert.deepEqual(messages.filter(message => message.type === 'prepare').map(message => message.ticks), [[0, 1, 2, 3, 4, 5], [9]]);
    const packet = (tick, byteLength = 50) => ({ tick, byteLength, compileMs: 1, compatibility: [] });
    cache._receive({ type: 'packet', revision: cache.revision, tick: 0, packet: packet(0) });
    assert.deepEqual([...cache.pending.keys()], [1, 9]);
    assert.deepEqual([...cache._prefetchRanks.keys()], [0, 1]);
    assert.equal(cache._protectedTick, 0);
    assert.deepEqual(messages.at(-1), { type: 'retain', revision: cache.revision, ticks: [0, 1, 9] });
    assert.equal(cache.stats.suppressedPrefetchFrames, 4); assert.equal(cache.stats.pendingFrames, 2);
    await cancelled;
    cache._receive({ type: 'packet', revision: cache.revision, tick: 1, packet: packet(1) });
    cache._receive({ type: 'packet', revision: cache.revision, tick: 9, packet: packet(9, 10) });
    await explicit;
    assert.ok(cache.has(0) && cache.has(1) && cache.has(9)); assert.equal(cache.stats.bytes, 110);
    let closed = 0;
    cache._receive({ type: 'packet', revision: cache.revision, tick: 2,
      packet: { ...packet(2), compatibility: [{ bitmap: { close() { closed++; } } }] } });
    assert.equal(closed, 1, 'An already-running cancelled packet must release its transferred bitmap.');
    assert.equal(cache.stats.bytes, 110); assert.equal(cache.stats.pendingFrames, 0);
  } finally { cache.dispose(); }
});

test('compatibility packet retains exact complex geometry when OffscreenCanvas is unavailable', async () => {
  const report = emptyDocument(), figure = defaultFigure(); figure.segments[0].transparency = 128; figure.segments[0].bend_rad = .3;
  report.figure_types = [figure]; report.keyframes = [createFrame([createObject(figure, 1, 240, 220)])];
  const packet = await compilePlaybackPacket(report, 0);
  assert.equal(packet.compatibility.length, 1); assert.ok(packet.compatibility[0].items.some(item => item.alpha < 1));
  assert.equal(packet.groups[0].compatibilityIndex, 0); assert.equal(packet.groups[0].instanceCount, 1);
  assert.equal(packet.shapes[20], 4);
});
