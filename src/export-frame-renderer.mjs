import { documentChunks } from "./document-transport.mjs";
import { exportSamplingSize } from "./export-sampling.mjs";

const abortError = (message = "Export rendering cancelled.") =>
  new DOMException(message, "AbortError");
/** One export session: bounded document transfer, worker scene evaluation and
 * rasterization, then a reusable output canvas consumed by any existing encoder.
 */
export class ExportFrameRenderer {
  constructor({
    width,
    height,
    smoothing = "edges",
    baseURL = globalThis.location?.origin,
    token = "",
    signal,
    getRevision,
    canvas,
    timeoutMs = 120000,
  } = {}) {
    Object.assign(this, exportSamplingSize(width, height, smoothing), {
      baseURL,
      token,
      signal,
      getRevision,
      timeoutMs,
    });
    this.canvas = canvas ?? document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.context = this.canvas.getContext("2d");
    this.sequence = 0;
    this.disposed = false;
    this.loaded = false;
    this.busy = false;
    this.stats = {
      loadChunks: 0,
      maxChunkBytes: 0,
      maxMainSnapshotMs: 0,
      renderedFrames: 0,
    };
    this.worker = new Worker(
      new URL("./export-frame-worker.mjs", import.meta.url),
      { type: "module", name: "StykAnimate export rendering" },
    );
    this.worker.addEventListener("message", ({ data }) => {
      const pending = this.pending;
      if (!pending || pending.id !== data.id) {
        data.bitmap?.close();
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      data.ok
        ? pending.resolve(data)
        : pending.reject(new Error(data.error || "Export rendering failed."));
    });
    this.worker.addEventListener("error", (event) => {
      event.preventDefault();
      this._fail(new Error(event.message || "The export renderer stopped."));
    });
    this.worker.addEventListener("messageerror", () =>
      this._fail(new Error("An export frame could not be transferred.")),
    );
    this.abort = () => this._fail(abortError());
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  _check() {
    if (this.failure) throw this.failure;
    if (this.disposed || this.signal?.aborted) throw abortError();
    if (this.loaded && this.getRevision && this.getRevision() !== this.revision)
      throw abortError("The animation changed during export.");
  }
  _fail(error) {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.worker.terminate();
  }
  _request(operation, payload = {}) {
    this._check();
    if (this.pending)
      return Promise.reject(
        new Error("Export renderer requests must run sequentially."),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.sequence,
        timer =
          this.timeoutMs > 0
            ? setTimeout(
                () => this._fail(new Error("Export rendering timed out.")),
                this.timeoutMs,
              )
            : null;
      this.pending = { id, resolve, reject, timer };
      try {
        this.worker.postMessage({ id, operation, ...payload });
      } catch (error) {
        this._fail(error);
      }
    });
  }
  async _chunks(report, operation) {
    const chunks = documentChunks(report, {
      maxRecords: 128,
      maxBytes: 64 * 1024,
      timeBudgetMs: 2,
    });
    for (;;) {
      this._check();
      const started = performance.now(),
        next = chunks.next();
      this.stats.maxMainSnapshotMs = Math.max(
        this.stats.maxMainSnapshotMs,
        performance.now() - started,
      );
      if (next.done) return;
      await this._request(operation, { chunk: next.value });
      this.stats.loadChunks++;
      this.stats.maxChunkBytes = Math.max(
        this.stats.maxChunkBytes,
        next.value.estimatedBytes || 0,
      );
      if (this.getRevision && this.getRevision() !== this.revision)
        throw abortError("The animation changed during export.");
    }
  }
  async load(report) {
    this._check();
    if (this.busy) throw new Error("Wait for the current export frame.");
    this.busy = true;
    this.loaded = false;
    try {
      this.revision = this.getRevision?.();
      await this._request("start", {
        options: {
          width: this.width,
          height: this.height,
          smoothing: this.smoothing,
          baseURL: this.baseURL,
          token: this.token,
        },
      });
      const { _stykSource, ...renderReport } = report;
      await this._chunks(renderReport, "chunk");
      await this._request("loaded");
      this.loaded = true;
      return this;
    } finally {
      this.busy = false;
    }
  }
  _paint(result) {
    if (!result.bitmap)
      throw new Error("The export renderer returned no pixel frame.");
    try {
      this._check();
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.clearRect(0, 0, this.width, this.height);
      this.context.imageSmoothingEnabled = false;
      this.context.drawImage(result.bitmap, 0, 0);
    } finally {
      result.bitmap.close();
    }
    Object.assign(this.stats, result.stats);
    this.stats.renderedFrames++;
    return this.canvas;
  }
  async _render({ tick, frame, svg = false }) {
    this._check();
    if (!this.loaded) throw new Error("Load the animation before exporting.");
    if (this.busy)
      throw new Error("Export frames must be rendered sequentially.");
    this.busy = true;
    try {
      if (frame) {
        await this._request("frame-start");
        await this._chunks({ keyframes: [frame] }, "frame-chunk");
      }
      const result = await this._request("render", {
        tick,
        override: Boolean(frame),
        svg,
      });
      if (svg) {
        this._check();
        Object.assign(this.stats, result.stats);
        return result.svg;
      }
      return await this._paint(result);
    } finally {
      this.busy = false;
    }
  }
  renderTick(tick) {
    return this._render({ tick });
  }
  renderFrame(frame) {
    return this._render({ frame });
  }
  renderSVGTick(tick) {
    return this._render({ tick, svg: true });
  }
  renderSVGFrame(frame) {
    return this._render({ frame, svg: true });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.abort);
    this._fail(abortError());
    this.canvas.width = this.canvas.height = 1;
  }
}
