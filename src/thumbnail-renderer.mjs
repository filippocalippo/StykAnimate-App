import { documentChunks } from "./document-transport.mjs";

const abortError = () =>
  new DOMException("Thumbnail superseded.", "AbortError");
/** One worker, one native frame in flight, byte-bounded document snapshots.
 * The filmstrip owns its small bitmap LRU; this adapter never duplicates it.
 */
export class ThumbnailRenderer {
  constructor(
    editor,
    {
      baseURL = globalThis.location?.href,
      token = "",
      storedFrames = false,
      onError = () => {},
    } = {},
  ) {
    this.editor = editor;
    this.options = { baseURL, token, storedFrames };
    this.onError = onError;
    this.version = 1;
    this.sequence = 0;
    this.loadedVersion = 0;
    this.fullSnapshot = true;
    this.changedFrames = new Set();
    this.definitionsChanged = false;
    this.pending = new Map();
    this.chain = Promise.resolve();
    this.queued = 0;
    this.paused = false;
    this.disposed = false;
    this.stats = {
      backend: "Worker thumbnails",
      snapshots: 0,
      patches: 0,
      chunks: 0,
      maxChunkBytes: 0,
      maxMainTaskMs: 0,
      renders: 0,
      lastRenderMs: 0,
      mediaBytes: 0,
      pending: 0,
      cancelled: 0,
    };
    this.events = new AbortController();
    editor.addEventListener(
      "change",
      (event) => this.invalidate(event.detail || {}),
      { signal: this.events.signal },
    );
  }
  _worker() {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined")
      throw new Error(
        "Frame previews require a browser with worker canvas support.",
      );
    const worker = (this.worker = new Worker(
      new URL("./thumbnail-worker.mjs", import.meta.url),
      { type: "module", name: "StykAnimate frame thumbnails" },
    ));
    worker.addEventListener("message", (event) => {
      const message = event.data,
        request = this.pending.get(message.id);
      if (!request) {
        message.bitmap?.close();
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message);
      else {
        const error = new Error(message.error || "Frame preview failed.");
        error.name = message.name || "Error";
        request.reject(error);
      }
    });
    const fail = (error) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      worker.terminate();
      this.worker = null;
      this.fullSnapshot = true;
      this.loadedVersion = 0;
      this.onError(error);
    };
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      fail(new Error(event.message || "Frame preview worker stopped."));
    });
    worker.addEventListener("messageerror", () =>
      fail(new Error("Frame preview could not be transferred.")),
    );
    return worker;
  }
  invalidate(detail = {}) {
    if (!["document", "edit", "history", "frame-draft"].includes(detail.kind)) return;
    const draft = this.editor.report._styk?.simpleFrameDraft;
    const previous = this.draftSnapshot;
    this.draftSnapshot = draft;
    // A seek or a clean Add/Update toggle changes draft bookkeeping, not pixels.
    if (detail.kind === 'frame-draft' &&
        !(previous?.mode === 'add' && previous.baseline || draft?.mode === 'add' && draft.baseline) &&
        Boolean(previous?.empty) === Boolean(draft?.empty)) return;
    this.version++;
    if (
      detail.kind === "document" ||
      (detail.kind === "history" && !detail.animation && !detail.frameIndices) ||
      detail.structural
    )
      this.fullSnapshot = true;
    for (const index of detail.frameIndices || detail.changedFrames || [
      detail.frameIndex ?? this.editor.frameIndex,
    ])
      this.changedFrames.add(index);
    if (detail.definition) this.definitionsChanged = true;
    this.currentAbort?.abort();
  }
  setPaused(paused) {
    if(this.paused===Boolean(paused))return;
    this.paused = Boolean(paused);
    if (this.paused) this.currentAbort?.abort();
  }
  async _request(operation, data, signal) {
    if (signal?.aborted || this.disposed) throw abortError();
    const worker = this._worker(),
      id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const request = this.pending.get(id);
        if (!request) return;
        this.stats.cancelled++;
        // Keep backpressure until an in-flight native frame exits the worker;
        // another request must never race its reusable canvas/media context.
        if (operation === "render") {
          worker.postMessage({ operation: "cancel", request: id });
          return;
        }
        this.pending.delete(id);
        clearTimeout(request.timer);
        signal?.removeEventListener("abort", cancel);
        reject(abortError());
      };
      const finish = (callback) => (value) => {
        signal?.removeEventListener("abort", cancel);
        callback(value);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        this.fullSnapshot = true;
        this.loadedVersion = 0;
        reject(new Error("Frame preview timed out."));
      }, 60000);
      this.pending.set(id, {
        resolve: finish(resolve),
        reject: finish(reject),
        timer,
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        worker.postMessage({ id, operation, ...data });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(error);
      }
    });
  }
  async _snapshot(version, signal) {
    if (this.loadedVersion === version) return;
    const report = this.editor.report;
    const { _stykSource, keyframes, figure_types, ...properties } = report;
    const full = this.fullSnapshot || !this.loadedVersion;
    const frames = [...this.changedFrames]
      .filter((index) => keyframes[index])
      .map((index) => ({ index, frame: keyframes[index] }));
    const payload = full
      ? { ...properties, figure_types, keyframes }
      : {
          properties,
          frames,
          ...(this.definitionsChanged ? { figure_types } : {}),
        };
    const iterator = documentChunks(payload, {
      maxBytes: 64 * 1024,
      maxRecords: 128,
      timeBudgetMs: 2,
    });
    for (;;) {
      if (version !== this.version || signal.aborted) throw abortError();
      const started = performance.now(),
        next = iterator.next();
      if (next.done) break;
      const task = this._request(
        "snapshot-chunk",
        {
          revision: version,
          mode: full ? "document" : "patch",
          chunk: next.value,
        },
        signal,
      );
      this.stats.maxMainTaskMs = Math.max(
        this.stats.maxMainTaskMs,
        performance.now() - started,
      );
      this.stats.maxChunkBytes = Math.max(
        this.stats.maxChunkBytes,
        next.value.estimatedBytes || 0,
      );
      this.stats.chunks++;
      await task;
    }
    await this._request(
      "snapshot-complete",
      { revision: version, options: this.options },
      signal,
    );
    if (version !== this.version || signal.aborted) throw abortError();
    this.loadedVersion = version;
    this.fullSnapshot = false;
    this.changedFrames.clear();
    this.definitionsChanged = false;
    full ? this.stats.snapshots++ : this.stats.patches++;
  }
  renderThumbnail = (index, canvas, { signal, inbetween, tick, storedFrames = this.options.storedFrames } = {}) => {
    if (this.disposed || this.paused || signal?.aborted)
      return Promise.resolve(false);
    // A caller outside the virtual filmstrip still cannot queue an unbounded scene backlog.
    if (this.queued >= 8) return Promise.resolve(false);
    this.queued++;
    this.stats.pending = this.queued;
    const version = this.version;
    const task = this.chain
      .catch(() => {})
      .then(async () => {
        if (
          this.disposed ||
          this.paused ||
          signal?.aborted ||
          version !== this.version
        )
          return false;
        const controller = (this.currentAbort = new AbortController());
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await this._snapshot(version, controller.signal);
          const result = await this._request(
            "render",
            {
              revision: version,
              index,
              width: canvas.width,
              height: canvas.height,
              storedFrames,
              ...(tick!==undefined?{tick}:{}),
              ...(inbetween ? {inbetween} : {}),
            },
            controller.signal,
          );
          try {
            if (
              controller.signal.aborted ||
              version !== this.version ||
              this.paused
            )
              return false;
            const context = canvas.getContext("2d");
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(result.bitmap, 0, 0);
            this.stats.renders++;
            this.stats.lastRenderMs = result.renderMs;
            this.stats.mediaBytes = result.mediaBytes;
            return true;
          } finally {
            result.bitmap.close();
          }
        } catch (error) {
          if (error.name === "AbortError") return false;
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          if (this.currentAbort === controller) this.currentAbort = null;
        }
      });
    this.chain = task;
    return task.finally(() => {
      this.queued--;
      this.stats.pending = this.queued;
    });
  };
  destroy() {
    this.disposed = true;
    this.events.abort();
    this.currentAbort?.abort();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(abortError());
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
