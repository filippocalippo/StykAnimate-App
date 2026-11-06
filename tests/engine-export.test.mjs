// Export frames from the engine (src/engine/engine-export.mjs): how an export's worker is
// started, warmed, released and replaced; the request, timeout, revision and canvas rules
// around it; the retry ladder for GPU memory failures; and vector (SVG) exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportFrameRenderer, EngineExportFrames, ENGINE_TILE_SIDE, prewarmExportRenderer} from '../src/engine/engine-export.mjs';

const MiB = 1024 * 1024;

/** Fake workers, canvases and bitmaps; `respond(message, worker, bitmap)` answers a request (nothing: it stalls). */
function environment(t, respond) {
  const workers = [], canvases = [], bitmaps = [];
  const bitmap = (width = 32, height = 32) => {
    const value = {width, height, closed: false, close() { this.closed = true; }};
    bitmaps.push(value);
    return value;
  };
  class Canvas extends EventTarget {
    constructor() {
      super();
      canvases.push(this);
      this.width = this.height = 32;
      this.context = {canvas: this, isContextLost: () => this.lost, setTransform() {}, clearRect() {}, drawImage() {}};
    }
    getContext() { return this.context; }
  }
  class Worker extends EventTarget {
    constructor(url, init) { super(); this.url = String(url); this.name = init?.name; this.messages = []; workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      const response = respond(message, this, bitmap);
      if (!response) return;
      queueMicrotask(() => { const event = new Event('message'); event.data = response; this.dispatchEvent(event); });
    }
    terminate() { this.terminated = true; }
  }
  for (const [key, value] of Object.entries({Worker, OffscreenCanvas: Canvas, document: {createElement: () => new Canvas()}})) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  return {workers, canvases, bitmaps};
}

/** Answers the worker's requests; it says when it released what it held. */
const answer = (overrides = {}) => (message, worker, bitmap) => {
  if (message.operation === 'release') return {released: true};
  if (message.operation === 'warm') return overrides.warm?.(message, worker) ?? {warmed: true};
  const custom = overrides[message.operation]?.(message, worker, bitmap);
  if (custom !== undefined) return custom && {id: message.id, ...custom};
  return {id: message.id, ok: true, ...(message.operation === 'render' ? {bitmap: bitmap()} : {}), ...(message.operation === 'start' ? {engine: {backend: 'test', tiles: 1}} : {})};
};

/** The app's stage renderer, as the export sees it; `behind` exports find the engine one revision short that many times. */
function app({refusal = null, threaded = true, behind = 0} = {}) {
  const calls = [];
  let waits = behind;
  const stage = {
    engineSide: {engine: {threaded, handle: {address: () => 4096}, join: {module: 'module', memory: 'memory', stack: 65536, progress: 64}}},
    prepareExport: (report, revision) => {
      calls.push(['definitions', revision]);
      // The engine's session has not published this revision yet: the export waits for it.
      if (waits-- > 0) return 'the engine does not hold this revision of the document';
      return refusal;
    },
  };
  return {stage, calls};
}

const report = () => ({figure_types: [], keyframes: [{duration_raw: 1, objects: []}]});
const exporter = (options = {}, context = {}) => createExportFrameRenderer({width: 32, height: 32, ...options}, {...app(), revision: 1, ...context});

test('exports need the engine with worker threads', t => {
  environment(t, answer());
  const {stage} = app();
  const options = {width: 32, height: 32};
  for (const vector of [false, true]) {
    const renderer = createExportFrameRenderer(options, {stage, revision: 3, range: [0, 9], vector});
    assert.ok(renderer instanceof EngineExportFrames, vector ? "SVG is the engine's too" : 'pixels');
    renderer.dispose();
  }
  for (const [why, context] of [
    ['no engine', {stage: {}, revision: 3}],
    ['no stage', {stage: undefined}],
    ['no worker threads (not cross-origin isolated)', {...app({threaded: false}), revision: 3}],
  ]) assert.throws(() => createExportFrameRenderer(options, context), {code: 'engine_unavailable', cause: 'no engine with worker threads'}, why);
});

test('the engine draws a document it holds: its worker starts with the export settings', async t => {
  const {workers} = environment(t, answer({render: (message, worker, bitmap) => ({ok: true, bitmap: bitmap(640, 360)})}));
  const {stage, calls} = app();
  const renderer = createExportFrameRenderer({width: 640, height: 360, smoothing: 'sprites'}, {stage, revision: 7, range: [5, 20]});
  assert.equal(workers.length, 0, 'no worker before the engine holds the document');
  await renderer.load(report());
  assert.deepEqual(calls, [['definitions', 7]], 'the stage answers for the export revision');
  assert.equal(workers.length, 1);
  const start = workers[0].messages[0];
  assert.equal(start.operation, 'start');
  assert.deepEqual({revision: start.revision, width: start.width, height: start.height, smoothing: start.smoothing, tileSize: start.tileSize, last: start.last, address: start.address, vector: start.vector},
    {revision: 7, width: 640, height: 360, smoothing: 'sprites', tileSize: ENGINE_TILE_SIDE, last: 20, address: 4096, vector: false});
  assert.equal(start.module, 'module');
  assert.equal(renderer.stats.renderer, 'engine');
  const canvas = await renderer.renderTick(5);
  assert.equal(canvas.width, 640);
  assert.equal(workers[0].messages.at(-1).operation, 'render');
  // Disposal asks the worker to free the engine memory and GPU device it holds; it ends once it has.
  renderer.dispose();
  assert.equal(workers[0].messages.at(-1).operation, 'release');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(workers[0].terminated, true);
});

test('an SVG export asks the engine for vector artwork, which needs no GPU device', async t => {
  const blob = new Blob(['<svg/>'], {type: 'image/svg+xml'});
  const {workers} = environment(t, answer({render: () => ({ok: true, svg: blob, stats: {workerMs: 3}})}));
  const renderer = createExportFrameRenderer({width: 640, height: 360}, {...app(), revision: 2, range: [0, 3], vector: true});
  await renderer.load(report());
  const start = workers[0].messages[0];
  assert.equal(start.vector, true);
  assert.equal(await renderer.renderSVGTick(3), blob);
  assert.deepEqual({...workers[0].messages.at(-1), id: undefined}, {id: undefined, operation: 'render', tick: 3, override: false, svg: true, native: false, preserveAlpha: false});
  // The pose the editor shows is sent to the worker first, as chunks.
  assert.equal(await renderer.renderSVGFrame({objects: []}), blob);
  const operations = workers[0].messages.map(message => message.operation), posed = operations.lastIndexOf('frame-start');
  assert.ok(posed > 0 && operations.slice(posed + 1, -1).every(operation => operation === 'frame-chunk') && operations.at(-1) === 'render');
  renderer.dispose();
});

test('the export waits for the engine to publish its revision', async t => {
  const {workers} = environment(t, answer());
  const {stage, calls} = app({behind: 2});
  const renderer = createExportFrameRenderer({width: 32, height: 32}, {stage, revision: 2});
  await renderer.load(report());
  assert.deepEqual(calls.map(call => call[0]), ['definitions', 'definitions', 'definitions']);
  assert.equal(renderer.stats.renderer, 'engine');
  assert.equal(workers.length, 1);
  renderer.dispose();
});

test('a document the engine does not draw fails the export with the reason', async t => {
  const {workers} = environment(t, answer());
  const renderer = exporter({}, app({refusal: 'property channels'}));
  await assert.rejects(renderer.load(report()), {code: 'engine_unavailable', cause: 'property channels', messageKey: 'errors.exportFrameRenderer.exportRenderingFailed'});
  assert.equal(workers.length, 0, 'no worker was started');
  renderer.dispose();
});

test('an engine worker that cannot start the export fails it and is released, not killed', async t => {
  const {workers} = environment(t, answer({
    start: () => ({ok: false, code: 'engine_unavailable', error: 'the engine holds revision 2 of the document, the export is of revision 1'}),
  }));
  const renderer = exporter();
  await assert.rejects(renderer.load(report()), {code: 'engine_unavailable', cause: /holds revision 2/});
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.at(-1).operation, 'release');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(workers[0].terminated, true);
  renderer.dispose();
});

test('a GPU memory failure retries the frame in smaller tiles, keeping the worker', async t => {
  let renders = 0;
  const {workers} = environment(t, answer({
    render: () => ++renders === 1 ? {ok: false, error: 'out of memory', code: 'export_gpu_memory', recoverable: true} : undefined,
  }));
  const renderer = exporter();
  await renderer.load(report());
  assert.equal((await renderer.renderTick(0)).width, 32);
  const retile = workers[0].messages.find(message => message.operation === 'retile');
  assert.equal(retile.tileSize, ENGINE_TILE_SIDE / 2);
  assert.equal(renders, 2);
  assert.equal(renderer.tileSize, ENGINE_TILE_SIDE / 2, 'the working size persists for later frames');
  assert.equal(workers.length, 1);
  renderer.dispose();
});

test('failures through the tile floor rebuild the worker and still deliver the frame', async t => {
  let renders = 0, starts = 0;
  const state = environment(t, answer({
    render: (message, worker, bitmap) => state.workers.length === 1
      ? (++renders, {ok: false, code: 'export_memory_limit', error: 'allocation failed.', recoverable: true})
      : {ok: true, bitmap: bitmap()},
    start: () => { starts++; },
  }));
  const renderer = exporter();
  await renderer.load(report());
  assert.equal((await renderer.renderTick(0)).width, 32);
  assert.equal(renders, 7, 'the ladder tried 2048, 1024, 512, 256, 128, 64 and 32');
  assert.equal(state.workers.length, 2);
  assert.equal(state.workers[0].messages.at(-1).operation, 'release');
  assert.equal(starts, 2, 'the rebuilt worker started the export again');
  assert.equal(renderer.tileSize, 32);
  renderer.dispose();
});

test('a wedged retile request falls through to the worker rebuild', async t => {
  const state = environment(t, answer({
    render: (message, worker, bitmap) => state.workers.length > 1 ? {ok: true, bitmap: bitmap()} : {ok: false, code: 'vfx_surface_budget', error: 'too big.', recoverable: true},
    retile: (message) => state.workers.length > 1 ? undefined : null,
  }));
  const renderer = exporter({timeoutMs: 10});
  await renderer.load(report());
  assert.equal((await renderer.renderTick(0)).width, 32);
  assert.equal(state.workers.length, 2);
  assert.equal(state.workers[0].messages.at(-1).operation, 'release');
  renderer.dispose();
});

test('a rebuilt worker that still fails surfaces the original error instead of looping', async t => {
  const state = environment(t, answer({render: () => ({ok: false, code: 'vfx_surface_budget', error: 'permanent.', recoverable: true})}));
  const renderer = exporter();
  await renderer.load(report());
  await assert.rejects(renderer.renderTick(0), {code: 'vfx_surface_budget'});
  assert.equal(state.workers.length, 2, 'exactly one rebuild was attempted');
  renderer.dispose();
});

test('stalled rendering rebuilds the worker and still delivers the frame', async t => {
  const state = environment(t, answer({render: (message, worker, bitmap) => state.workers.length === 1 ? null : {ok: true, bitmap: bitmap()}}));
  const first = exporter({timeoutMs: 10});
  await first.load(report());
  // The first worker stalls; the retry ladder rebuilds and the frame arrives.
  assert.equal((await first.renderTick(0)).width, 32);
  assert.ok(state.workers.length >= 2);
  assert.equal(state.workers[0].messages.at(-1).operation, 'release');
  assert.equal(first.canvas.width, 32);
  first.dispose();
});

test('a worker that does not release in time is terminated, and cancellation rejects at once', async t => {
  const {workers} = environment(t, (message, worker, bitmap) => message.operation === 'release' || message.operation === 'render' ? null
    : answer()(message, worker, bitmap));
  t.mock.timers.enable({apis: ['setTimeout']});
  const controller = new AbortController();
  const renderer = exporter({signal: controller.signal});
  const loading = renderer.load(report());
  await t.mock.timers.runAll?.();
  await loading;
  const pending = renderer.renderTick(0);
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(renderer.canvas.width, 1, 'the output surface is freed');
  assert.equal(workers[0].messages.at(-1).operation, 'release');
  assert.equal(workers[0].terminated, undefined, 'given time to free its memory');
  t.mock.timers.tick(5000);
  assert.equal(workers[0].terminated, true);
  renderer.dispose();
});

test('invalid allowances and pre-aborted jobs allocate no worker or canvas', t => {
  const state = environment(t, answer());
  assert.throws(() => exporter({width: 3840, height: 2160, maxWorkingBytes: 4 * MiB}), {code: 'export_memory_limit'});
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => exporter({signal: controller.signal}), {name: 'AbortError'});
  assert.equal(state.canvases.length, 0);
  assert.equal(state.workers.length, 0);
});

test('lost or undersized frames cannot be returned to an encoder, even if context restores', async t => {
  let undersized = false;
  const state = environment(t, answer({render: (message, worker, bitmap) => ({ok: true, bitmap: bitmap(undersized ? 1 : 32)})}));
  for (const failure of ['lost', 'restored', 'undersized']) {
    const renderer = exporter();
    await renderer.load(report());
    if (failure === 'lost') renderer.canvas.lost = true;
    if (failure === 'restored') renderer.canvas.dispatchEvent(new Event('contextlost'));
    undersized = failure === 'undersized';
    await assert.rejects(renderer.renderTick(0), failure === 'undersized' ? /incomplete frame/ : {code: 'export_canvas_lost'});
    assert.equal(renderer.stats.renderedFrames, 0);
    assert.equal(renderer.canvas.width, 1);
    renderer.dispose();
  }
  assert.ok(state.bitmaps.every(bitmap => bitmap.closed));
});

test('native frame delivery rejects stale revisions and malformed PNG responses before publishing', async t => {
  let revision = 1, malformed = false;
  const state = environment(t, answer({render: () => ({ok: true, nativeFrame: {width: 32, height: 32, blob: new Blob(malformed ? [] : ['png'], {type: 'image/png'})}})}));
  for (const scenario of ['stale', 'malformed']) {
    const renderer = exporter({getRevision: () => revision});
    await renderer.load(report());
    malformed = scenario === 'malformed';
    const pending = renderer.renderNativeTick(0);
    if (scenario === 'stale') revision++;
    await assert.rejects(pending, scenario === 'stale' ? {name: 'AbortError'} : /incomplete native frame/);
    assert.equal(renderer.stats.renderedFrames, 0);
    assert.equal(renderer.canvas.width, 1);
    renderer.dispose();
  }
  assert.ok(state.workers.every(worker => worker.messages.at(-1).operation === 'release'));
});

test('worker failures keep their actionable error and release the export', async t => {
  const frames = [{module: 'engine-export-worker.mjs', line: 180}];
  const state = environment(t, answer({start: () => ({ok: false, code: 'export_memory_limit', error: 'Source image exceeds allowance.', name: 'RangeError', telemetryCode: 'out_of_memory', telemetryStage: 'prepare', telemetryFrames: frames})}));
  const renderer = exporter();
  await assert.rejects(renderer.load(report()), {code: 'export_memory_limit', name: 'RangeError', telemetryCode: 'out_of_memory', telemetryStage: 'prepare', telemetryFrames: frames});
  assert.equal(renderer.canvas.width, 1);
  assert.equal(state.workers[0].messages.at(-1).operation, 'release');
  renderer.dispose();
});

test('the export dialog warms a worker that the export then takes', async t => {
  const {workers} = environment(t, answer());
  const {stage} = app();
  prewarmExportRenderer({stage});
  prewarmExportRenderer({stage});
  assert.equal(workers.length, 1, 'one warm worker at a time');
  assert.equal(workers[0].messages[0].operation, 'warm');
  assert.equal(workers[0].messages[0].module, 'module', 'it joins the engine');
  const renderer = createExportFrameRenderer({width: 32, height: 32}, {stage, revision: 4});
  await renderer.load(report());
  assert.equal(workers.length, 1, 'the export takes the warm worker instead of starting one');
  assert.deepEqual(workers[0].messages.map(message => message.operation), ['warm', 'start']);
  renderer.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(workers[0].terminated, true);
});

test('a warm worker no export takes is released after a minute, and one that cannot warm at once', async t => {
  const {workers} = environment(t, answer({warm: (message, worker) => workers.indexOf(worker) === 1 ? {warmed: false, error: 'the engine module could not start'} : undefined}));
  t.mock.timers.enable({apis: ['setTimeout']});
  const {stage} = app();
  // Nothing is warmed where exports would not use the engine.
  prewarmExportRenderer({stage: {}});
  prewarmExportRenderer({stage: app({threaded: false}).stage});
  assert.equal(workers.length, 0);
  prewarmExportRenderer({stage});
  t.mock.timers.tick(59999);
  assert.equal(workers[0].messages.at(-1).operation, 'warm');
  t.mock.timers.tick(1);
  assert.equal(workers[0].messages.at(-1).operation, 'release', 'given up after a minute');
  await new Promise(resolve => queueMicrotask(resolve));
  // A worker that cannot warm says so and is released at once; the next dialog warms again.
  prewarmExportRenderer({stage});
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(workers[1].messages.at(-1).operation, 'release');
  prewarmExportRenderer({stage});
  assert.equal(workers.length, 3);
  t.mock.timers.tick(60000);
});
