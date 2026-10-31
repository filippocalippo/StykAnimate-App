/**
 * The engine's export worker (engine-export.mjs, docs/engine/rendering.md, Exports).
 *
 * It joins the engine's shared memory as the preparation workers do, but keeps its
 * event loop: the export's GPU device lives here (WebGPU, else WebGL2 on an
 * OffscreenCanvas), frames are drawn tile by tile, read back and put on one output
 * canvas, then handed over as the JavaScript export worker hands them over (an
 * ImageBitmap, or a PNG for native video, APNG and PNG sequences). Where the worker gets
 * no GPU device, the CPU rasterizer draws the same tiles here (`ExportRenderer.create_cpu`,
 * each tile drawn when asked for, nothing drawn ahead). The document comes from the engine
 * (the revision the export started from); the pose the editor shows comes as document
 * chunks. An SVG export (`vector`) takes no tiles: the engine writes the prepared frame as
 * vector artwork (`ExportRenderer.svg`, styk-export `svg`) and the worker hands it over as a Blob.
 *
 * A browser hands a read-back over only when its GPU process gets to it, which can take
 * far longer than drawing (about 100 ms a frame while the page repaints, measured in
 * docs/engine/rendering.md, Exports). So the worker draws the export's next frames ahead
 * into free read-back slots while earlier ones are mapped, and puts a frame on the canvas
 * only when it is asked for: at most `AHEAD` frames, as many slots as the renderer has.
 *
 * `warm` joins the engine and gets the GPU device ahead of an export (while the export
 * dialog is open), so `start` only pins the document. Requests run one at a time;
 * `release` ends the worker after freeing what it holds in the engine's memory (its
 * renderer, its thread's stack) and its GPU device.
 */
import {initSync, ExportDevice, ExportRenderer} from './pkg/styk_engine.js';
import {applyDocumentChunk} from '../document-transport.mjs';
import {exportContext, checkExportContext, deliverExportFrame} from '../export-canvas.mjs';

/** When this worker's modules were loaded, from its creation (ms). */
const loadedAt = performance.now();

/** Derived caches the engine does not read (as the stage strips them). */
const STRIP = new Set(['runtime_segments']);

/** Frames drawn ahead of the one asked for, at most (within the renderer's read-back slots). */
const AHEAD = 6;

let wasm = null, device = null, renderer = null, progress = null, options = null, canvas = null, context = null, tile = null, frameDocument;
/** Why this worker has no GPU device (its exports are drawn on the CPU), or null. */
let noDevice = null;
let releasing = false, running = Promise.resolve();
/** Read-back slots not holding a tile, and the frames drawn ahead by tick: their slots and reads. */
let free = [];
const ahead = new Map();

const released = () => new DOMException('The export renderer was released.', 'AbortError');
const check = () => { if (releasing) throw released(); };

/**
 * Resolves when the engine's workers finished something (a frame, a picture) since the
 * progress counter read `seen`. Read it before asking, so work finishing in between is not missed.
 */
function whenProgress(seen) {
  if (Atomics.load(progress, 0) !== seen) return Promise.resolve();
  if (typeof Atomics.waitAsync === 'function') {
    const waiting = Atomics.waitAsync(progress, 0, seen, 250);
    return waiting.async ? waiting.value.then(() => {}) : Promise.resolve();
  }
  return new Promise(resolve => setTimeout(resolve, 4));
}

/**
 * Joins the engine (once per worker) and gets a GPU device, unless the worker has a usable one.
 * Where none can be had, the export is drawn by the CPU rasterizer (`noDevice` says why).
 */
async function warm(message) {
  wasm ??= initSync({module: message.module, memory: message.memory, thread_stack_size: message.stack});
  progress ??= new Int32Array(message.memory.buffer, message.progress, 1);
  if (device && !device.usable()) { device.dispose(); device.free(); device = null; }
  // A vector export (SVG) draws no tiles: the picture of a frame without a vector form is the CPU rasterizer's.
  if (message.vector) {
    noDevice ??= 'a vector export draws on the CPU';
    if (device) { device.dispose(); device.free(); device = null; }
  }
  if (!device && !noDevice) {
    try { device = await ExportDevice.create(new OffscreenCanvas(1, 1)); }
    catch (error) { noDevice = String(error?.message ?? error); }
  }
  return {warm: true, cpu: Boolean(noDevice)};
}

async function start(message) {
  const began = performance.now(), warmed = Boolean(device);
  let joined;
  try {
    await warm(message);
    joined = performance.now();
    options = message;
    renderer?.free();
    renderer = null;
    if (device) {
      // The device moves into the renderer.
      const ready = device;
      device = null;
      renderer = ExportRenderer.create(message.address, message.revision, message.width, message.height, message.smoothing, message.maxPixels, message.tileSize, ready);
    } else {
      // No GPU device in this worker: the CPU rasterizer draws the same frames (docs/engine/rendering.md, CPU).
      renderer = ExportRenderer.create_cpu(message.address, message.revision, message.width, message.height, message.smoothing, message.maxPixels, message.tileSize);
    }
  } catch (error) {
    renderer = null;
    throw Object.assign(new Error(`The engine cannot draw this export here: ${error?.message ?? error}`), {code: 'engine_unavailable'});
  }
  if (!message.vector) {
    canvas ??= new OffscreenCanvas(message.width, message.height);
    context = exportContext(canvas);
  }
  layout();
  return {engine: {...JSON.parse(renderer.stats()), backend: renderer.backend(), gpuRefusal: noDevice, warmed, modulesMs: loadedAt, startAt: began, deviceMs: joined - began, createMs: performance.now() - joined}};
}

/** One tile's pixels, reused for every tile of every frame, and every slot free. */
function layout() {
  const [, , , , width, height] = renderer.tile_rect(0);
  if (tile?.width !== width || tile?.height !== height) tile = new ImageData(width, height);
  free = Array.from({length: renderer.slots()}, (_, slot) => slot);
}

/**
 * Resolves with `read` once settled. WebGL2 completes a read-back only when its device is
 * polled, so the worker polls between turns of its event loop until it does.
 */
async function settled(read) {
  if (!renderer.needs_poll()) return read;
  let done = false;
  read.then(() => { done = true; }, () => { done = true; });
  while (!done && !releasing) {
    renderer.poll();
    if (!done) await new Promise(resolve => setTimeout(resolve, 1));
  }
  check();
  return read;
}

/** Draws tiles `first`… of the prepared frame into free slots: `[{index, slot, read}]`. */
function draw(first, count) {
  const drawn = [];
  for (let index = first; index < count && free.length; index++) {
    const slot = free.shift(), read = renderer.draw_tile(index, slot);
    read.catch(() => {});
    drawn.push({index, slot, read});
  }
  return drawn;
}

/** Gives back the slots of frames drawn ahead that the export will not ask for in turn. */
async function discardAhead() {
  for (const tiles of ahead.values()) for (const {slot, read} of tiles) {
    try { await settled(read); renderer.discard(slot); } catch { /* the device is gone: the slot is never read */ }
    free.push(slot);
  }
  ahead.clear();
}

/** The prepared frame of a vector export, as an SVG Blob (the engine writes the file). */
async function svg(message, pose, last, started) {
  await discardAhead();
  if (pose) renderer.prepare_pose(JSON.stringify(pose, (key, value) => STRIP.has(key) ? undefined : value));
  else for (let seen = Atomics.load(progress, 0); !renderer.prepare(message.tick, last); seen = Atomics.load(progress, 0)) { await whenProgress(seen); check(); }
  const text = renderer.svg(`StykAnimate frame ${(message.tick ?? 0) + 1}`);
  renderer.check();
  return {svg: new Blob([text], {type: 'image/svg+xml'}),
    stats: {...JSON.parse(renderer.stats()), workerMs: performance.now() - started, smoothing: options.smoothing, renderWidth: options.width, renderHeight: options.height, renderer: 'engine'}};
}

async function render(message) {
  const started = performance.now();
  const pose = message.override ? frameDocument?.keyframes?.[0] : null;
  if (message.override && !pose) throw new Error('The current export frame was not transferred.');
  // Every picture is in before the first frame: an export never shows a frame without one.
  for (let seen = Atomics.load(progress, 0); renderer.upload_images() > 0; seen = Atomics.load(progress, 0)) { await whenProgress(seen); check(); }
  const count = renderer.tiles(), last = Math.max(options.last ?? message.tick ?? 0, message.tick ?? 0);
  if (message.svg) return svg(message, pose, last, started);
  let drawn = pose ? null : ahead.get(message.tick) ?? null;
  if (drawn) ahead.delete(message.tick);
  else {
    // Drawn ahead for another order (a second GIF pass, the current pose): given back first.
    await discardAhead();
    if (pose) renderer.prepare_pose(JSON.stringify(pose, (key, value) => STRIP.has(key) ? undefined : value));
    else for (let seen = Atomics.load(progress, 0); !renderer.prepare(message.tick, last); seen = Atomics.load(progress, 0)) { await whenProgress(seen); check(); }
    drawn = draw(0, count);
  }
  const evaluated = performance.now();
  // The next frames, drawn while this one is read, as far as slots and prepared frames allow
  // (now, and again once this frame's tiles are read and more frames are prepared).
  const speculate = () => {
    if (pose || drawn.length < count) return;
    const prepared = next => { try { return renderer.prepare(next, last); } catch { return false; } };
    for (let next = Math.max(message.tick, ...ahead.keys()) + 1; next <= last && ahead.size < AHEAD && free.length >= count && prepared(next); next++) ahead.set(next, draw(0, count));
  };
  speculate();
  // Video without transparency is composited over black by the engine (exact, before any rounding).
  const matte = Boolean(message.native && !message.preserveAlpha);
  let readMs = 0, resolveMs = 0;
  for (let at = 0; at < drawn.length; at++) {
    const {index, slot, read} = drawn[at], reading = performance.now();
    await settled(read);
    check();
    const resolving = performance.now();
    readMs += resolving - reading;
    renderer.resolve_tile(index, slot, matte, tile.data);
    free.push(slot);
    const [x, y, width, height] = renderer.tile_rect(index);
    context.putImageData(tile, x, y, 0, 0, width, height);
    resolveMs += performance.now() - resolving;
    // A frame of more tiles than slots: the rest are drawn as slots come back.
    if (at === drawn.length - 1 && index + 1 < count) drawn.push(...draw(index + 1, count));
  }
  speculate();
  checkExportContext(context);
  renderer.check();
  // Where a frame's time goes: pictures and evaluation, waiting for its pixels, then reading them.
  const stats = {...JSON.parse(renderer.stats()), workerMs: performance.now() - started, evaluateMs: evaluated - started, readMs, resolveMs, ahead: ahead.size,
    smoothing: options.smoothing, renderWidth: options.width, renderHeight: options.height, renderer: 'engine'};
  return deliverExportFrame(canvas, {native: message.native, preserveAlpha: true}, stats);
}

async function operate(message) {
  switch (message.operation) {
    case 'warm': return warm(message);
    case 'start': return start(message);
    case 'frame-start': frameDocument = undefined; return {};
    case 'frame-chunk': frameDocument = applyDocumentChunk(frameDocument, message.chunk); return {};
    case 'retile': await discardAhead(); renderer.retile(Math.max(64, Math.min(4096, message.tileSize | 0))); layout(); return {};
    case 'render': return render(message);
    default: throw new Error(`Unknown export operation ${message.operation}.`);
  }
}

/** Frees the renderer, the GPU device and this thread's stack, then ends the worker. */
async function release() {
  releasing = true;
  await running.catch(() => {});
  try { renderer?.dispose(); device?.dispose(); } catch { /* the device may be gone already */ }
  // Destroying the device rejects the read-backs still pending, and their answers run through
  // the module: let them run now, while this thread may still call it (after its destructor
  // below a call would write through a stack the shared memory has taken back).
  for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0));
  try { renderer?.free(); device?.free(); } catch { /* already freed */ }
  renderer = device = null;
  if (canvas) canvas.width = canvas.height = 1;
  canvas = context = tile = frameDocument = null;
  // No call into the module may follow on this thread (wasm-bindgen's thread destructor).
  try { wasm?.__wbindgen_thread_destroy(); } catch { /* never started */ }
  self.postMessage({released: true});
  self.close();
}

self.addEventListener('message', ({data: message}) => {
  if (message.operation === 'release') { release(); return; }
  const run = running.then(() => {
    check();
    return operate(message);
  });
  running = run.catch(() => {});
  run.then(result => {
    if (message.id === undefined) { self.postMessage({warmed: true}); return; }
    self.postMessage({id: message.id, ok: true, ...result}, result.bitmap ? [result.bitmap] : []);
  }, error => {
    if (message.id === undefined) { self.postMessage({warmed: false, error: String(error?.message ?? error)}); return; }
    const text = error?.message ?? String(error);
    // GPU memory exhaustion and a lost device may pass with smaller tiles or a new device.
    const recoverable = message.operation === 'render' && /^recoverable: /.test(text);
    self.postMessage({id: message.id, ok: false, error: text.replace(/^recoverable: /, ''), name: error?.name, code: error?.code ?? (recoverable ? 'export_gpu_memory' : undefined), recoverable,
      telemetryCode: recoverable ? 'export_gpu' : 'engine_failed', telemetryStage: message.operation === 'render' ? 'encode' : 'prepare'});
  });
});
