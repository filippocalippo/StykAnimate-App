/**
 * The engine's preview worker (engine-previews.mjs; docs/engine/rendering.md, Thumbnails and
 * library previews).
 *
 * It joins the engine's shared memory as a thread of its own, as the export worker does, and
 * keeps its event loop. Where it gets a GPU device (WebGPU in the worker, else WebGL2 on its
 * OffscreenCanvas) whose pictures reach the page, it draws library files with the stage's
 * renderer (`Previews`, styk_wasm::preview): a poster (a PNG), the hover animation's frames and
 * the samples its card's backdrop is chosen from, each taken from the canvas as an ImageBitmap.
 * Where it gets none, the CPU rasterizer (styk-raster) draws the same pictures and they are put
 * on a 2D canvas, then taken the same way. Frame thumbnails the stage cannot draw are drawn here
 * on the CPU, from the document the engine holds. The pictures the interface needs outside the
 * stage are drawn here too: small documents it built (`sketch`: an effect's still, a background, a
 * rig being tested, a figure of the asset library) and poses of the open document seen through a
 * camera of their own (`pose`: the parallax monitor). Requests run one at a time. `release` ends
 * the worker after freeing its device and what it holds in the engine's memory.
 */
import {initSync, Previews} from './pkg/styk_engine.js';
import {libraryPreviewMatte, LIBRARY_MATTES} from '../library-matte.mjs';

/** Side of a library preview and of the samples its backdrop is chosen from (styk_engine::thumbnails::library). */
const SIZE = 320, SAMPLE = 40;
/** How long a frame thumbnail waits for its frame and pictures (as the stage's thumbnails do). */
const THUMBNAIL_WAIT_MS = 60000;

let wasm = null, previews = null, canvas = null, flat = null, progress = null, releasing = false, running = Promise.resolve();
/** Why library pictures are drawn on the CPU (no GPU device, or its canvas gives no pixels), or null. */
let gpuRefusal = null;
/** The hover animation open in the worker: requests of an older session are answered `stale`. */
let session = null;
const cancelled = new Set();

async function start(message) {
  wasm ??= initSync({module: message.module, memory: message.memory, thread_stack_size: message.stack});
  progress ??= new Int32Array(message.memory.buffer, message.progress, 1);
  if (!previews) {
    try {
      canvas = new OffscreenCanvas(SIZE, SIZE);
      const created = await Previews.create(canvas);
      // Some setups give no pixels from a GPU canvas (Xvfb without ANGLE on Vulkan): check before any preview.
      created.probe();
      const bitmap = canvas.transferToImageBitmap(), sample = new OffscreenCanvas(1, 1), context = sample.getContext('2d', {willReadFrequently: true});
      context.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
      bitmap.close();
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      if (!(r > 200 && g < 60 && b > 200 && a > 200)) { created.dispose(); created.free(); throw new Error('the GPU canvas gives no pixels in this worker'); }
      previews = created;
    } catch (error) {
      // No GPU device whose pictures reach the page: the CPU rasterizer draws them.
      gpuRefusal = String(error?.message ?? error);
      canvas = null;
      previews = Previews.create_cpu();
    }
  }
  return {started: true, backend: previews.backend(), cpu: previews.cpu(), gpuRefusal};
}

/** The CPU's last picture on a 2D canvas, as an ImageBitmap (its pixels move into the bitmap). */
function cpuPicture() {
  const [width, height] = previews.picture_size(), image = new ImageData(width, height);
  previews.picture(image.data);
  flat ??= new OffscreenCanvas(width, height);
  if (flat.width !== width || flat.height !== height) { flat.width = width; flat.height = height; }
  flat.getContext('2d').putImageData(image, 0, 0);
  return flat.transferToImageBitmap();
}

/** The last library picture: the GPU canvas's (nothing is read back), or the CPU's. */
const picture = () => previews.cpu() ? cpuPicture() : canvas.transferToImageBitmap();
function canvasSize(width, height) {
  if (!canvas) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

async function poster({bytes, extension}) {
  canvasSize(SIZE, SIZE);
  const result = JSON.parse(previews.poster(new Uint8Array(bytes), extension));
  const bitmap = picture(), out = new OffscreenCanvas(SIZE, SIZE);
  out.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return {...result, blob: await out.convertToBlob({type: 'image/png'})};
}

function begin() {
  const count = previews.library_begin(), pixels = new Uint8ClampedArray(count * SAMPLE * SAMPLE * 4);
  const sample = new OffscreenCanvas(SAMPLE, SAMPLE), context = sample.getContext('2d', {willReadFrequently: true});
  for (let i = 0; i < count; i++) {
    canvasSize(SAMPLE, SAMPLE);
    previews.library_sample(i);
    const bitmap = picture();
    context.clearRect(0, 0, SAMPLE, SAMPLE);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    pixels.set(context.getImageData(0, 0, SAMPLE, SAMPLE).data, i * SAMPLE * SAMPLE * 4);
  }
  // One backdrop for the whole hover, chosen across the samples' colours.
  return {samples: count, matte: LIBRARY_MATTES[libraryPreviewMatte(pixels)]};
}

function frame({elapsed}) {
  canvasSize(SIZE, SIZE);
  const result = JSON.parse(previews.library_frame(elapsed));
  return {...result, bitmap: picture()};
}

/** A picture of a document that is not the open one, framed by `mode` and `params` (styk_wasm::preview `Placement`). */
function sketch({bytes, extension, tick, width, height, mode, params, background}) {
  canvasSize(width, height);
  const result = JSON.parse(previews.sketch(new Uint8Array(bytes), extension, tick, width, height, mode, Float64Array.from(params), background ?? NaN));
  return {...result, bitmap: picture()};
}

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
 * A frame thumbnail of the open document, drawn on the CPU: `tick` of `revision` on a
 * `width × height` card. Its frame is prepared and its pictures decoded on the engine's
 * workers; this waits for them on the progress counter.
 */
async function thumbnail({address, revision, tick, width, height}) {
  previews.adopt_engine(address);
  const started = performance.now();
  for (;;) {
    if (releasing) throw new DOMException('The preview worker was released.', 'AbortError');
    if (performance.now() - started > THUMBNAIL_WAIT_MS) return {refused: 'timeout', message: 'the frame was not prepared in time'};
    const seen = Atomics.load(progress, 0), status = previews.thumbnail(revision, tick, width, height);
    if (status === 2) return {refused: 'stale', message: 'the engine holds another revision'};
    if (status === 0) return {bitmap: cpuPicture(), width, height};
    await whenProgress(seen);
  }
}

/**
 * The artwork of `tick` of the open document on transparency, drawn on the CPU through `matrix`
 * (scene units to pixels): `width × height` pixels from `(x, y)`, for the drawing workspace's fill
 * and magic wand (engine-composite.mjs). Waits for the frame's pictures like a thumbnail does.
 */
async function composite({id, address, revision, tick, x, y, width, height, matrix}) {
  previews.adopt_engine(address);
  const started = performance.now();
  try {
    for (;;) {
      if (releasing || cancelled.has(id)) throw new DOMException('The sample was superseded.', 'AbortError');
      if (performance.now() - started > THUMBNAIL_WAIT_MS) return {refused: 'timeout'};
      const seen = Atomics.load(progress, 0), status = previews.composite(revision, tick, x, y, width, height, Float64Array.from(matrix));
      if (status === 2) return {refused: 'stale'};
      if (status === 0) {
        const pixels = new Uint8ClampedArray(width * height * 4);
        previews.picture(pixels);
        return {pixels: pixels.buffer, width, height};
      }
      await whenProgress(seen);
    }
  } finally { previews.forget_picture(); }
}

/** A pose of the open document (a keyframe record) seen through its own camera, framed by `mode` and `params`. */
async function pose({id, address, revision, json, width, height, mode, params}) {
  previews.adopt_engine(address);
  const started = performance.now();
  for (;;) {
    if (releasing || cancelled.has(id)) throw new DOMException('The preview was superseded.', 'AbortError');
    if (performance.now() - started > THUMBNAIL_WAIT_MS) return {refused: 'timeout'};
    canvasSize(width, height);
    const seen = Atomics.load(progress, 0), status = previews.pose(revision, json, width, height, mode, Float64Array.from(params));
    if (status === 2) return {refused: 'stale'};
    if (status === 0) return {bitmap: picture(), width, height};
    await whenProgress(seen);
  }
}

/** The frame displayed by the stage, captured by shared pointers and prepared here. */
async function monitor({id, address, width, height, zoom, panX, panY, dpr = 1}) {
  previews.monitor_begin(address);
  const started = performance.now();
  try {
    for (;;) {
      if (releasing || cancelled.has(id)) throw new DOMException('The preview was superseded.', 'AbortError');
      if (performance.now() - started > THUMBNAIL_WAIT_MS) return {refused: 'timeout'};
      canvasSize(width, height);
      const seen = Atomics.load(progress, 0), status = previews.monitor(width, height, zoom, panX, panY, dpr);
      if (status === 2) return {refused: 'stale'};
      if (status === 0) {
        const values = Array.from(previews.monitor_background());
        const rootBackground = values.length === 19 ? {
          rect: values.slice(0,4), style: `rgba(${values[4]},${values[5]},${values[6]},${values[7]/255})`,
          matrix: values.slice(8,14), clip: values.slice(14,18), dpr: values[18]
        } : null;
        let bitmap;
        const pixels = previews.monitor_pixels();
        if (pixels) {
          const image = new ImageData(width,height);previews.picture(image.data);
          bitmap = await createImageBitmap(image);
        } else bitmap = picture();
        if (releasing || cancelled.has(id)) { bitmap.close(); throw new DOMException('The preview was superseded.', 'AbortError'); }
        return {bitmap,width,height,rootBackground,gpuSource: Boolean(rootBackground && !pixels)};
      }
      await whenProgress(seen);
    }
  } finally { cancelled.delete(id); previews.monitor_end(); }
}

async function operate(message) {
  if (message.operation === 'start') return start(message);
  if (!previews) {
    if (message.operation === 'monitor' && wasm) Previews.forget_monitor(message.address);
    if (['thumbnail', 'pose', 'composite'].includes(message.operation) && wasm) Previews.forget_engine(message.address);
    throw new Error('The preview worker has not started.');
  }
  if (['library-begin', 'library-frame', 'library-close'].includes(message.operation) && message.session !== session) return {refused: 'stale', message: 'another library preview is open'};
  switch (message.operation) {
    case 'library-poster': return poster(message);
    case 'library-open': session = message.session; return JSON.parse(previews.library_open(new Uint8Array(message.bytes), message.extension));
    case 'library-begin': return begin();
    case 'library-frame': return frame(message);
    case 'library-close': session = null; previews.library_close(); return {};
    case 'thumbnail': return thumbnail(message);
    case 'composite': return composite(message);
    case 'sketch': return sketch(message);
    case 'pose': return pose(message);
    case 'monitor': return monitor(message);
    default: throw new Error(`Unknown preview operation ${message.operation}.`);
  }
}

/** Frees the device, what this thread holds in the engine's memory and its stack, then ends the worker. */
async function release() {
  releasing = true;
  await running.catch(() => {});
  try { previews?.dispose(); } catch { /* the device may be gone already */ }
  // Destroying the device settles what was pending on it; let those answers run first.
  for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0));
  try { previews?.free(); } catch { /* already freed */ }
  previews = null;
  if (canvas) canvas.width = canvas.height = 1;
  canvas = flat = null;
  // No call into the module may follow on this thread (wasm-bindgen's thread destructor).
  try { wasm?.__wbindgen_thread_destroy(); } catch { /* never started */ }
  self.postMessage({released: true});
  self.close();
}

self.addEventListener('message', ({data: message}) => {
  if (message.operation === 'cancel') { cancelled.add(message.request); return; }
  if (message.operation === 'release') { release(); return; }
  const run = running.then(() => {
    if (releasing) {
      // A thumbnail's engine address is consumed even when it is not drawn.
      if (['thumbnail', 'pose', 'composite'].includes(message.operation) && wasm) try { Previews.forget_engine(message.address); } catch { /* the module is gone */ }
      if (message.operation === 'monitor' && wasm) try { Previews.forget_monitor(message.address); } catch { /* the module is gone */ }
      throw new DOMException('The preview worker was released.', 'AbortError');
    }
    return operate(message);
  });
  running = run.catch(() => {});
  run.then(result => {
    cancelled.delete(message.id);
    const transfer = result?.bitmap ? [result.bitmap] : result?.pixels ? [result.pixels] : [];
    self.postMessage({id: message.id, ok: true, ...result}, transfer);
  }, error => {
    cancelled.delete(message.id);
    self.postMessage({id: message.id, ok: false, error: String(error?.message ?? error), name: error?.name});
  });
});
