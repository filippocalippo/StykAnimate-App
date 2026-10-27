/**
 * Library previews drawn by the engine (docs/engine/rendering.md, Thumbnails and library
 * previews; stage S4 of docs/RUST-ENGINE-PORT.md).
 *
 * One preview worker per page (engine-preview-worker.mjs) joins the engine's shared memory
 * and draws library files with the stage's GPU renderer on a device of its own, or with the
 * CPU rasterizer (styk-raster) where the worker gets no device whose pictures reach the page:
 * posters for saved assets and the hover animations of the asset library. A library file is
 * opened on its own; it never touches the document the engine holds. It also draws, on the
 * CPU, the frame thumbnails the stage cannot draw (engine-thumbnails.mjs), from the document
 * the engine holds. Requests from every client run one at a time in arrival order; one
 * cancelled before it starts is never sent, one cancelled while it runs has its answer dropped.
 *
 * The worker starts with the first request and is released after five idle minutes: it
 * destroys its device, frees what it holds in the engine's memory and its thread's stack,
 * then ends (a worker that does not answer within 5 s is terminated; what it held then stays
 * allocated). Without the engine, worker threads (a page that is not cross-origin isolated)
 * or an OffscreenCanvas, the helpers below resolve null and no preview is drawn.
 */
import {loadEngine} from './engine.mjs';

const WORKER_NAME = 'StykAnimate previews (engine)';
/** How long an idle worker keeps its pictures and thread. */
const PREVIEW_IDLE_MS = 300000;
/** How long a worker may take to release the engine memory it holds. */
const RELEASE_MS = 5000;

const abortError = () => new DOMException('The preview was superseded.', 'AbortError');
const settled = request => request?.signal?.removeEventListener('abort', request.onAbort);

export class EnginePreviewWorker {
  /**
   * @param {{join: object}} engine from loadEngine()
   * @param {{idleMs?: number, spawn?: () => Worker}} [options] `spawn()` starts the worker (tests give a stand-in)
   */
  constructor(engine, {idleMs = PREVIEW_IDLE_MS, spawn = () => new Worker(new URL('./engine-preview-worker.mjs', import.meta.url), {type: 'module', name: WORKER_NAME})} = {}) {
    this.engine = engine;
    this.idleMs = idleMs;
    this.spawnWorker = spawn;
    this.worker = null;
    this.queue = [];
    this.active = null;
    this.sequence = 0;
    this.broken = null;
    this.idleTimer = 0;
    this.stats = {requests: 0, cancelled: 0, starts: 0, releases: 0, lastMs: 0, backend: null, cpu: false, gpuRefusal: null};
  }

  /** Whether a request can be sent (the worker has not failed). */
  get usable() { return !this.broken; }

  _spawn() {
    const worker = this.worker = this.spawnWorker();
    this.stats.starts++;
    // `answered`: the worker can still free what it holds (it said so); otherwise it is gone or stuck.
    const fail = (message, answered) => {
      if (this.worker !== worker) return;
      this.broken = message;
      this.worker = null;
      if (answered) dismiss(worker); else worker.terminate();
      const active = this.active;
      this.active = null;
      settled(active);
      active?.reject(new Error(message));
      for (const request of this.queue.splice(0)) { settled(request); request.reject(new Error(message)); }
    };
    // The thread could not join the engine: every request since fails.
    worker.addEventListener('message', ({data}) => {
      if (data?.id !== 0) return this._answer(worker, data);
      if (!data.ok) return fail(`The preview worker could not start: ${data.error}`, true);
      // How the worker draws library previews: its GPU device, or the CPU (and why).
      Object.assign(this.stats, {backend: data.backend ?? null, cpu: Boolean(data.cpu), gpuRefusal: data.gpuRefusal ?? null});
    });
    worker.addEventListener('error', event => { event.preventDefault(); fail(event.message || 'The preview worker stopped.', false); });
    worker.addEventListener('messageerror', () => fail('A preview could not be transferred.', false));
    const {module, memory, stack, progress} = this.engine.join;
    worker.postMessage({operation: 'start', id: 0, module, memory, stack, progress});
    return worker;
  }

  _answer(worker, data) {
    if (worker !== this.worker || data?.id === 0) return;
    const request = this.active;
    if (!request || request.id !== data.id) { data?.bitmap?.close(); return; }
    this.active = null;
    settled(request);
    this.stats.lastMs = performance.now() - request.sent;
    if (request.signal?.aborted) { data.bitmap?.close(); request.reject(abortError()); }
    else if (data.ok) request.resolve(data);
    else request.reject(Object.assign(new Error(data.error), {name: data.name || 'Error'}));
    this._next();
  }

  /**
   * Sends `message` to the worker after the requests before it (a function is called for the
   * message when it is sent: what it creates, such as an engine address, exists only for
   * requests that reach the worker). Resolves with the worker's answer (`{refused, message}`
   * when the engine declined to draw it); rejects with an AbortError when `signal` aborts first.
   */
  request(message, {signal, transfer = [], discard} = {}) {
    if (this.broken) return Promise.reject(new Error(this.broken));
    if (signal?.aborted) return Promise.reject(abortError());
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    return new Promise((resolve, reject) => {
      const request = {id: ++this.sequence, message, transfer, discard, signal, resolve, reject, sent: 0};
      this.stats.requests++;
      request.onAbort = () => {
        const at = this.queue.indexOf(request);
        if (at >= 0) { this.queue.splice(at, 1); settled(request); this.stats.cancelled++; reject(abortError()); this._scheduleIdle(); }
        if (this.active === request) try { this.worker?.postMessage({operation: 'cancel', request: request.id}); } catch { /* the worker will answer or fail */ }
        // A request in the worker keeps its place until it answers; its answer is dropped.
      };
      signal?.addEventListener('abort', request.onAbort, {once: true});
      this.queue.push(request);
      this._next();
    });
  }

  _next() {
    if (this.active || this.broken) return;
    const request = this.queue.shift();
    if (!request) { this._scheduleIdle(); return; }
    const worker = this.worker ?? this._spawn();
    this.active = request;
    request.sent = performance.now();
    let message;
    try {
      message = typeof request.message === 'function' ? request.message() : request.message;
      worker.postMessage({...message, id: request.id}, request.transfer);
    } catch (error) { if (message) request.discard?.(message); this.active = null; settled(request); request.reject(error); this._next(); }
  }

  _scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    if (!this.worker || this.active || this.queue.length || this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = 0; if (!this.active && !this.queue.length) this.release(); }, this.idleMs);
  }

  /** Frees the worker's pictures and thread; the next request starts a new one. */
  release() {
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.stats.releases++;
    const active = this.active;
    this.active = null;
    settled(active);
    active?.reject(abortError());
    for (const request of this.queue.splice(0)) { settled(request); request.reject(abortError()); }
    dismiss(worker);
  }
}

/**
 * Asks a preview worker to free what it holds in the engine's memory and its device, then end;
 * terminated if it does not say so in time (what it held then stays allocated).
 */
function dismiss(worker) {
  const timer = setTimeout(() => worker.terminate(), RELEASE_MS);
  worker.addEventListener('message', ({data}) => { if (data?.released) { clearTimeout(timer); worker.terminate(); } });
  try { worker.postMessage({operation: 'release'}); } catch { clearTimeout(timer); worker.terminate(); }
}

let shared = null;

/**
 * The page's preview worker, or null where previews cannot be drawn: the engine failed to
 * load, the page has no worker threads (not cross-origin isolated), or the browser has no
 * OffscreenCanvas.
 */
export function enginePreviews() {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas === 'undefined') return Promise.resolve(null);
  return shared ??= loadEngine().then(engine => engine.threaded ? new EnginePreviewWorker(engine) : null, () => null);
}

/**
 * One pending camera-monitor frame and one retained bitmap. Captures the stage's
 * displayed pose only when the existing preview worker sends it; camera/parallax
 * preparation and rasterization run there, including the first appearance. New
 * views cancel old requests without terminating a shared-memory thread.
 */
export class EngineCameraMonitor {
  constructor(stage, {previews = enginePreviews, invalidate = () => {}} = {}) {
    this.stage = stage;
    this.previews = previews;
    this.invalidate = invalidate;
    this.pending = null;
    this.picture = null;
    this.key = null;
    this.disposed = false;
    this.refused = false;
    this.stats = {requests: 0, drawn: 0, lastMs: 0, captureMs: 0, backend: null, cpu: false, gpuRefusal: null};
  }

  draw(target, view, afterSourcePaint) {
    if (this.disposed || this.refused) return false;
    const version = this.stage.monitor_version();
    if (!version) {
      this.key = null;
      this.pending?.controller.abort();
      // The caller clears its canvas before asking. Keep the last actually
      // accepted picture while its shown source is cold, only at the same view.
      const previous = this.picture && JSON.parse(this.picture.key);
      if (previous && previous[1] === view.width && previous[2] === view.height
          && previous[3] === view.zoom && previous[4] === view.panX && previous[5] === view.panY
          && (previous[6] ?? 1) === (view.dpr ?? 1)) this._paint(target, afterSourcePaint);
      // The stage owns the cold pose and its existing progress waiter schedules
      // another draw. No monitor pose may be prepared on the interface thread.
      return true;
    }
    const key = JSON.stringify([version, view.width, view.height, view.zoom, view.panX, view.panY, view.dpr ?? 1]);
    this.key = key;
    if (this.picture?.key === key) {
      this._paint(target, afterSourcePaint);
      return true;
    }
    if (this.pending && this.pending.key !== key) this.pending.controller.abort();
    if (!this.pending) {
      const request = this.pending = {key, controller: new AbortController()};
      const {signal} = request.controller;
      void this._render(request, view, version, signal);
    }
    // Accepted asynchronously: the caller must not prepare the same pose in JavaScript.
    return true;
  }

  _paint(target, afterSourcePaint) {
    const background = this.picture.rootBackground;
    if (background) {
      target.save();
      target.setTransform(background.dpr,0,0,background.dpr,0,0);
      target.beginPath();target.rect(...background.clip);target.clip();
      target.transform(...background.matrix);target.fillStyle=background.style;
      target.fillRect(...background.rect);target.restore();
    }
    target.save(); target.setTransform(1, 0, 0, 1, 0, 0); target.drawImage(this.picture.bitmap, 0, 0); target.restore();
    afterSourcePaint?.(Boolean(this.picture.gpuSource));
  }

  async _render(request, view, version, signal) {
    let bitmap;
    const started = performance.now();
    try {
      const worker = await this.previews();
      if (!worker?.usable) { this.refused = true; return; }
      if (signal.aborted || this.disposed || this.key !== request.key) return;
      const answer = await worker.request(() => {
        if (signal.aborted || this.disposed || this.key !== request.key || this.stage.monitor_version() !== version) throw abortError();
        const capturing = performance.now(), address = this.stage.monitor_address();
        this.stats.captureMs = performance.now() - capturing;
        this.stats.requests++;
        if (!address) throw abortError();
        return {operation: 'monitor', address, ...view};
      }, {signal, discard: message => this.stage.forget_monitor(message.address)});
      bitmap = answer.bitmap;
      if (worker.stats) Object.assign(this.stats, {backend: worker.stats.backend, cpu: worker.stats.cpu, gpuRefusal: worker.stats.gpuRefusal});
      if (signal.aborted || this.disposed || this.key !== request.key || this.stage.monitor_version() !== version) return;
      if (answer.refused) { if (answer.refused !== 'stale') this.refused = true; return; }
      if (!bitmap) { this.refused = true; return; }
      this.picture?.bitmap.close();
      this.picture = {key: request.key, bitmap, rootBackground: answer.rootBackground, gpuSource: answer.gpuSource};
      this.stats.drawn++;
      this.stats.lastMs = performance.now() - started;
      bitmap = null;
    } catch (error) { if (error?.name !== 'AbortError') this.refused = true; }
    finally {
      bitmap?.close();
      if (this.pending === request) this.pending = null;
      if (!this.disposed) this.invalidate();
    }
  }

  destroy() {
    this.disposed = true;
    this.pending?.controller.abort();
    this.picture?.bitmap.close();
    this.picture = null;
    this.stage.detach_monitor?.();
  }
}

/** A library file's extension as the engine reads it (`stkz`, `stykmov`, …), from its name. */
function libraryExtension(file, fallback = 'stkz') {
  const match = /\.([a-z0-9]+)$/i.exec(file?.name ?? '');
  return match ? match[1].toLowerCase() : fallback;
}

/**
 * A library file's poster drawn by the engine: a 320-pixel PNG of its first frame with
 * artwork, fitted on transparency. Resolves null where the engine does not draw it (no
 * preview worker, a file it cannot read).
 * @param {Blob|Promise<Blob>} file the saved asset's bytes (or the export making them)
 * @param {string} [extension] `stkz` or `stykmov` (by default from the file's name)
 */
export async function engineLibraryPoster(file, extension) {
  const previews = await enginePreviews();
  if (!previews?.usable) return null;
  try {
    const blob = await file, bytes = await blob.arrayBuffer();
    const result = await previews.request({operation: 'library-poster', bytes, extension: extension ?? libraryExtension(blob)}, {transfer: [bytes]});
    return result.refused ? null : result.blob;
  } catch { return null; }
}

let sessions = 0;

/**
 * A library file's hover animation drawn by the engine, or null where the engine does not
 * draw it. `frame(elapsed)` resolves with the frame at
 * `elapsed` seconds (`{bitmap, tick}`; the caller closes the bitmap) or null once the engine
 * declines; `close()` ends it. One animation is open at a time: opening another ends this one.
 * @param {Blob} file
 * @param {{extension?: string, signal?: AbortSignal}} [options] aborting rejects pending frames
 */
export async function engineLibraryAnimation(file, {extension = libraryExtension(file), signal} = {}) {
  const previews = await enginePreviews();
  if (!previews?.usable) return null;
  const session = ++sessions;
  try {
    const bytes = await file.arrayBuffer();
    const opened = await previews.request({operation: 'library-open', session, bytes, extension}, {signal, transfer: [bytes]});
    const begun = await previews.request({operation: 'library-begin', session}, {signal});
    if (begun.refused) { previews.request({operation: 'library-close', session}).catch(() => {}); return null; }
    return {
      fps: opened.fps, duration: opened.duration, matte: begun.matte,
      async frame(elapsed) {
        const result = await previews.request({operation: 'library-frame', session, elapsed}, {signal});
        return result.refused ? null : {bitmap: result.bitmap, tick: result.tick, rasterMs: result.rasterMs};
      },
      close() { previews.request({operation: 'library-close', session}).catch(() => {}); },
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
}
