/**
 * Export frames drawn by the engine (docs/engine/rendering.md, Exports; stage S4 of
 * docs/RUST-ENGINE-PORT.md).
 *
 * An export's pixels come from the engine's renderer: the frame the stage would show at
 * that tick, through the scene camera, at the export's size and sampling, without onion
 * skins. Encoders (PNG, GIF, APNG, ZIP, WebCodecs, FFmpeg) receive canvases and PNG frames
 * from this interface; SVG exports receive the frame written as vector artwork by the
 * engine (styk-export `svg`).
 *
 * `EngineExportFrames` talks to the engine's export worker (engine-export-worker.mjs): a
 * dedicated worker that joins the engine's shared memory and holds a GPU device of its
 * own, or draws on the CPU (styk-raster) where it gets none, so nothing is drawn or read
 * back on the interface thread (D7). This class owns what an export needs around it: one
 * request at a time with a timeout each, progress, revision checks (an edit during the
 * export cancels it), a retry ladder for GPU memory failures (smaller tiles, then a new
 * worker), and the output canvas the encoders read. `prewarmExportRenderer` starts the
 * worker and its device while the export dialog is open.
 */
import {restoreMessageError, messageError} from '../localized-error.mjs';
import {documentChunks} from '../document-transport.mjs';
import {drawingBarrier} from '../drawing-resources.mjs';
import {exportMemoryPlan} from '../export-memory.mjs';
import {exportContext, checkExportContext} from '../export-canvas.mjs';
import {EXPORT_MAX_PIXELS} from '../export-sampling.mjs';
import {engineDocument} from './engine-document.mjs';

/** Rendered pixels a side of an export tile at most (styk-export `TILE_SIDE`). */
export const ENGINE_TILE_SIDE = 2048;
/** How long a worker may take to release the engine memory and GPU device it holds. */
const RELEASE_MS = 5000;
/** How long a worker warmed for an export waits for it. */
const WARM_MS = 60000;
const WORKER_NAME = 'StykAnimate export rendering (engine)';

const abortError = (message = 'Export rendering cancelled.') => new DOMException(message, 'AbortError');

/**
 * Asks an engine export worker to free what it holds in the engine's memory and its GPU
 * device, then end; it is terminated if it does not say so in time (what it held then stays
 * allocated).
 */
function release(worker) {
  const timer = setTimeout(() => worker.terminate(), RELEASE_MS);
  worker.addEventListener('message', ({data}) => { if (data?.released) { clearTimeout(timer); worker.terminate(); } });
  try { worker.postMessage({operation: 'release'}); } catch { clearTimeout(timer); worker.terminate(); }
}

/** An engine export worker started ahead of an export, and when it is given up. */
let warm = null;

/**
 * Starts an engine export worker ahead of an export (the export dialog opens): joining the
 * engine and getting a GPU device take most of a second, which the next export then skips.
 * Given up after a minute without an export. Does nothing where exports cannot use the engine.
 */
export function prewarmExportRenderer({stage} = {}) {
  const engine = stage?.engineSide?.engine;
  if (warm || !engine?.threaded || typeof Worker !== 'function') return;
  engine.grow?.();
  const worker = new Worker(new URL('./engine-export-worker.mjs', import.meta.url), {type: 'module', name: WORKER_NAME});
  const entry = warm = {worker, timer: setTimeout(() => { if (warm === entry) { warm = null; release(worker); } }, WARM_MS)};
  worker.addEventListener('message', ({data}) => { if (data?.warmed === false && warm === entry) { warm = null; clearTimeout(entry.timer); release(worker); } });
  worker.postMessage({operation: 'warm', ...engine.join});
}

/** The warmed worker, for an export that uses it. */
function takeWarm() {
  const entry = warm;
  warm = null;
  if (entry) clearTimeout(entry.timer);
  return entry?.worker ?? null;
}

/**
 * The export frame renderer for an export. `stage` is the app's stage renderer
 * (engine-stage.mjs), `revision` the editor's revision, `range` the first and last tick the export draws, `vector` an SVG export.
 * Fails where the engine has no worker threads (a page that is not cross-origin isolated).
 */
export function createExportFrameRenderer(options, {stage, revision, range, vector = false} = {}) {
  const side = stage?.engineSide;
  if (!side?.engine?.threaded || typeof stage.prepareExport !== 'function')
    throw unavailable('no engine with worker threads');
  side.engine.grow?.();
  return new EngineExportFrames(options, {stage, revision, range, vector});
}

/** An export the engine cannot draw, and why. */
function unavailable(reason) {
  return Object.assign(messageError(new Error(''), 'errors.exportFrameRenderer.exportRenderingFailed', {}), {cause: reason, code: 'engine_unavailable', telemetryCode: 'engine_failed', telemetryStage: 'prepare'});
}

export class EngineExportFrames {
  constructor({
    width,
    height,
    smoothing = 'edges',
    signal,
    getRevision,
    canvas,
    timeoutMs = 120000,
    maxWorkingBytes,
    onFrame,
  } = {}, engine) {
    if (signal?.aborted) throw abortError();
    Object.assign(this, exportMemoryPlan(width, height, smoothing, {maxWorkingBytes}), {signal, getRevision, timeoutMs, onFrame});
    this.engine = engine;
    this.canvas = canvas ?? document.createElement('canvas');
    // Native video consumes worker PNGs directly; allocate presentation pixels
    // only if a canvas consumer actually requests them.
    this.canvas.width = this.canvas.height = 1;
    // Export frames are read by image/video encoders. Keep this large surface
    // CPU-backed instead of competing with the editor's WebGPU allocations.
    try { this.context = exportContext(this.canvas); } catch (error) { this.canvas.width = this.canvas.height = 1; throw error; }
    this.sequence = 0;
    this.disposed = false;
    this.loaded = false;
    this.busy = false;
    this.stats = {renderedFrames: 0, renderer: 'engine'};
    this.abort = () => this._fail(abortError());
    signal?.addEventListener('abort', this.abort, {once: true});
  }

  /** Starts the export's worker (the warmed one when there is one). */
  _spawn() {
    this._attach(takeWarm() ?? new Worker(new URL('./engine-export-worker.mjs', import.meta.url), {type: 'module', name: WORKER_NAME}));
  }

  /** The worker frees what it holds in the shared memory and its GPU device, then ends. */
  _release(worker) {
    if (worker) release(worker);
  }

  /** Makes `worker` the session's renderer: replies settle the pending request. */
  _attach(worker) {
    this._release(this.worker);
    this.worker = worker;
    // A worker being released may still speak: only the current one settles requests.
    const current = () => this.worker === worker;
    worker.addEventListener('message', ({data}) => {
      const pending = this.pending;
      if (!current() || !pending || pending.id !== data.id) {
        data.bitmap?.close();
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      if (data.ok) pending.resolve(data);
      else {
        const error = Object.assign(restoreMessageError(data.error ? new Error(data.error) : messageError(new Error(''), 'errors.exportFrameRenderer.exportRenderingFailed'), data), {code: data.code,
          name: data.name || 'Error', recoverable: Boolean(data.recoverable), telemetryCode: data.telemetryCode, telemetryStage: data.telemetryStage, telemetryFrames: data.telemetryFrames});
        data.bitmap?.close();
        // Recoverable render errors keep the worker alive for a tile retry.
        if (!error.recoverable) this._fail(error);
        pending.reject(error);
      }
    });
    worker.addEventListener('error', event => {
      event.preventDefault();
      if (current()) this._fail(Object.assign(event.message ? new Error(event.message) : messageError(new Error(''), 'errors.exportFrameRenderer.theExportRendererStopped'), {telemetryCode: 'worker_failed', telemetryStage: 'encode'}));
    });
    worker.addEventListener('messageerror', () => {
      if (current()) this._fail(Object.assign(messageError(new Error(''), 'errors.exportFrameRenderer.anExportFrameCouldNotBeTransferred', {}), {telemetryCode: 'snapshot_failed', telemetryStage: 'prepare'}));
    });
  }

  _check() {
    if (this.failure) throw this.failure;
    if (this.disposed || this.signal?.aborted) throw abortError();
    if (this.loaded && this.getRevision && this.getRevision() !== this.revision)
      throw abortError('The animation changed during export.');
  }

  _fail(error) {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    const worker = this.worker;
    this.worker = null;
    this._release(worker);
    this.canvas.width = this.canvas.height = 1;
  }

  _request(operation, payload = {}) {
    this._check();
    if (this.pending) return Promise.reject(messageError(new Error(''), 'errors.exportFrameRenderer.exportRendererRequestsMustRunSequentially', {}));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence,
        timer = this.timeoutMs > 0
          ? setTimeout(() => this._fail(Object.assign(messageError(new Error(''), 'errors.exportFrameRenderer.exportRenderingTimedOut', {}), {telemetryCode: 'timeout', telemetryStage: operation === 'render' ? 'encode' : 'prepare'})), this.timeoutMs)
          : null;
      this.pending = {id, resolve, reject, timer};
      try {
        this.worker.postMessage({id, operation, ...payload});
      } catch (error) {
        this._fail(error);
      }
    });
  }

  /** Sends `report` (the pose the editor shows) in bounded chunks. */
  async _chunks(report, operation) {
    const chunks = documentChunks(report, {maxRecords: 128, maxBytes: 64 * 1024, timeBudgetMs: 2});
    for (;;) {
      this._check();
      const next = chunks.next();
      if (next.done) return;
      await this._request(operation, {chunk: next.value});
    }
  }

  /** What the engine's worker needs to start drawing this export. */
  _start(tileSize) {
    const {stage, vector} = this.engine, engine = stage.engineSide.engine;
    return {
      ...engine.join, address: engine.handle.address(), revision: this.engine.revision,
      width: this.width, height: this.height, smoothing: this.smoothing, maxPixels: EXPORT_MAX_PIXELS, tileSize, vector,
      last: this.engine.range?.[1] ?? null,
    };
  }

  /** Brings the engine to the editor's document, then starts the worker and its device. */
  async load(report) {
    this._check();
    await drawingBarrier(report, {signal: this.signal});
    this._check();
    if (this.busy) throw messageError(new Error(''), 'errors.exportFrameRenderer.waitForTheCurrentExportFrame', {});
    this.busy = true;
    this.loaded = false;
    try {
      this.revision = this.getRevision?.();
      const began = performance.now();
      const {stage, revision} = this.engine;
      const reason = await engineDocument({stage, report, revision, check: () => this._check()});
      this._check();
      if (reason) throw unavailable(reason);
      this.tileSize = ENGINE_TILE_SIDE;
      const documented = performance.now();
      this._spawn();
      let started;
      try { started = await this._request('start', this._start(this.tileSize)); }
      catch (error) {
        // The engine moved on, or its worker could not start the export.
        if (error?.code === 'engine_unavailable') throw Object.assign(unavailable(error.message), {cause: error.message});
        throw error;
      }
      this.stats.engine = started.engine;
      // Bringing the engine's document to the export's revision, then starting the worker and its GPU device.
      this.stats.engineLoad = {documentMs: documented - began, startMs: performance.now() - documented};
      this.loaded = true;
      return this;
    } catch (error) { this._fail(error); throw error; } finally { this.busy = false; }
  }

  /** Resource failures retriable at smaller tiles or after a worker rebuild;
   * aborts, document errors and encoder faults are not. */
  _recoverable(error) {
    if (error?.name === 'AbortError') return false;
    return Boolean(error?.recoverable) ||
      ['vfx_surface_budget', 'export_memory_limit', 'export_canvas_lost'].includes(error?.code) ||
      ['timeout', 'worker_failed', 'snapshot_failed'].includes(error?.telemetryCode);
  }

  /** Replaces a failed engine worker (a new GPU device), drawing in tiles of at most `tileSize`. */
  async _rebuild(tileSize) {
    this.failure = null;
    this.loaded = false;
    this._spawn();
    const started = await this._request('start', this._start(tileSize));
    this.stats.engine = started.engine;
    this.loaded = true;
  }

  _paint(result) {
    if (!result.bitmap) throw messageError(new Error(''), 'errors.exportFrameRenderer.theExportRendererReturnedNoPixelFrame', {});
    try {
      this._check();
      if (this.canvas.width !== this.width) this.canvas.width = this.width;
      if (this.canvas.height !== this.height) this.canvas.height = this.height;
      checkExportContext(this.context);
      if (result.bitmap.width !== this.width || result.bitmap.height !== this.height)
        throw messageError(new Error(''), 'errors.exportFrameRenderer.theExportRendererReturnedAnIncompleteFrame', {});
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.clearRect(0, 0, this.width, this.height);
      this.context.imageSmoothingEnabled = false;
      this.context.drawImage(result.bitmap, 0, 0);
      checkExportContext(this.context);
    } finally {
      result.bitmap.close();
    }
    Object.assign(this.stats, result.stats);
    this.stats.renderedFrames++;
    return this.canvas;
  }

  async _render({tick, frame, svg = false, native = false, preserveAlpha = false}) {
    this._check();
    if (!this.loaded) throw messageError(new Error(''), 'errors.exportFrameRenderer.loadTheAnimationBeforeExporting', {});
    if (this.busy) throw messageError(new Error(''), 'errors.exportFrameRenderer.exportFramesMustBeRenderedSequentially', {});
    this.busy = true;
    try {
      this.onFrame?.({stage: 'rendering', tick});
      const sendFrame = async () => {
        if (!frame) return;
        await this._request('frame-start');
        await this._chunks({keyframes: [frame]}, 'frame-chunk');
      };
      await sendFrame();
      const payload = {tick, override: Boolean(frame), svg, native, preserveAlpha};
      // Retry ladder: resource failures halve the render tile to a 32px floor,
      // then rebuild the worker once and try again. Output pixels are identical;
      // only the amount of frame held in memory per pass changes.
      let result, tileSize = this.tileSize, mayRebuild = true;
      for (;;) {
        try {
          result = await this._request('render', payload);
          this.tileSize = tileSize; // later frames start at the size that worked
          break;
        } catch (error) {
          if (!this._recoverable(error) || this.signal?.aborted) throw error;
          // A wedged worker can't answer retile either; then or at the 32px
          // floor the ladder rebuilds it once with the document replayed.
          if (!this.failure && tileSize > 32) {
            tileSize = Math.max(32, Math.floor(tileSize / 2));
            this.onFrame?.({stage: 'retrying', tick, tileSize});
            try { await this._request('retile', {tileSize}); continue; }
            catch { /* fall through to the rebuild */ }
          }
          if (!mayRebuild) throw error; // the rebuilt worker already had its ladder
          mayRebuild = false;
          this.onFrame?.({stage: 'rebuilding', tick});
          await this._rebuild(tileSize);
          await sendFrame();
        }
      }
      if (native) {
        this._check();
        const output = result.nativeFrame;
        if (!(output?.blob instanceof Blob) || output.blob.type !== 'image/png' || !output.blob.size ||
            output.width !== this.width || output.height !== this.height)
          throw messageError(new Error(''), 'errors.exportFrameRenderer.theExportRendererReturnedAnIncompleteNativeFrame', {});
        Object.assign(this.stats, result.stats);
        this.stats.renderedFrames++;
        this.onFrame?.({stage: 'rendered', tick});
        return output;
      }
      if (svg) {
        this._check();
        Object.assign(this.stats, result.stats);
        this.onFrame?.({stage: 'rendered', tick});
        return result.svg;
      }
      const canvas = this._paint(result);
      this.onFrame?.({stage: 'rendered', tick});
      return canvas;
    } catch (error) { this._fail(error); throw error; } finally {
      this.busy = false;
    }
  }

  renderTick(tick) {
    return this._render({tick});
  }

  renderNativeTick(tick, {preserveAlpha = false} = {}) {
    return this._render({tick, native: true, preserveAlpha});
  }

  /** The pose the editor shows (`frame`, a keyframe), not a tick of the timeline. */
  renderFrame(frame) {
    return this._render({frame});
  }

  /** `tick` as an SVG Blob. */
  renderSVGTick(tick) {
    return this._render({tick, svg: true});
  }

  renderSVGFrame(frame) {
    return this._render({frame, svg: true});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.abort);
    this._fail(abortError());
    this.canvas.width = this.canvas.height = 1;
  }
}
