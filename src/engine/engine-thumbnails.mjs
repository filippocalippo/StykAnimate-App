/**
 * Frame thumbnails drawn by the engine (docs/engine/rendering.md, Thumbnails and library
 * previews; stage S4 of docs/RUST-ENGINE-PORT.md).
 *
 * `createThumbnailRenderer` returns the object the filmstrip and the export dialog draw
 * thumbnails with (`renderThumbnail`, `invalidate`, `setPaused`,
 * `destroy`, `stats`). A thumbnail is the tick of the revision the editor is at, from the
 * document the engine already holds: its frame prepared on the engine's workers, drawn by
 * the stage's GPU renderer on the stage's device (`renderThumbnail` in engine-stage.mjs),
 * so it shows exactly what the stage shows. Nothing of the document is copied into a
 * thumbnail worker, and nothing is evaluated on the interface thread. Where the stage cannot
 * draw thumbnails (a WebGL2 stage cannot present one device to a second canvas; a WebGPU
 * canvas whose pictures do not reach the page), the engine's preview worker draws them with
 * the CPU rasterizer from the same document (engine-previews.mjs): the same pixels by the
 * app-parity rule.
 *
 * A thumbnail the engine cannot draw (no worker threads, a frame outside the timeline, a
 * document the stage refuses, a preview worker that fails) resolves `false` with the reason
 * in `stats.engine.refusal`: the filmstrip shows no picture for it and asks again later.
 */
import {layerAppearance, thumbnailVisualChange} from '../thumbnail-validity.mjs';
import {drawingBarrier} from '../drawing-resources.mjs';
import {engineDocument} from './engine-document.mjs';
import {enginePreviews} from './engine-previews.mjs';

const abortError = () => new DOMException('The thumbnail was superseded.', 'AbortError');
/** `_route`'s answer while the app is still creating its stage: the caller asks again later. */
const NOT_YET = 'the stage is not ready yet';

/**
 * A thumbnail renderer for `editor`. `stage()` returns the app's stage renderer (engine-stage.mjs)
 * once it exists; until then thumbnails are not drawn.
 */
export function createThumbnailRenderer(editor, {stage = () => null} = {}) {
  return new EngineThumbnails(editor, {stage});
}

export class EngineThumbnails {
  /** `previews()` resolves the engine's preview worker or null (tests give stand-ins). */
  constructor(editor, {stage, previews = enginePreviews}) {
    this.editor = editor;
    this.stage = stage;
    this.previews = previews;
    /** Why the preview worker cannot draw thumbnails, once found; null while it may. */
    this.cpuRefusal = null;
    this.version = 1;
    this.layerAppearance = layerAppearance(editor.report._styk?.layers);
    this.chain = Promise.resolve();
    this.queued = 0;
    this.paused = false;
    this.disposed = false;
    this.currentAbort = null;
    /** Why the last thumbnail was not drawn by the engine. */
    this.refusal = null;
    this.engineStats = {renders: 0, cpu: 0, refused: 0, stale: 0, lastRenderMs: 0};
    this.events = new AbortController();
    editor.addEventListener('change', event => this.invalidate(event.detail || {}), {signal: this.events.signal});
  }

  get stats() {
    return {backend: 'Engine thumbnails', engine: {...this.engineStats, refusal: this.refusal}};
  }

  invalidate(detail = {}) {
    const appearance = detail.layers || detail.kind === 'document' ? layerAppearance(this.editor.report._styk?.layers) : this.layerAppearance;
    const visual = thumbnailVisualChange(detail, this.layerAppearance, appearance);
    this.layerAppearance = appearance;
    if (!visual) return;
    this.version++;
    this.currentAbort?.abort();
  }

  setPaused(paused) {
    if (this.paused === Boolean(paused)) return;
    this.paused = Boolean(paused);
    if (this.paused) this.currentAbort?.abort();
  }

  /**
   * Why the engine cannot draw this thumbnail, or null: the stage has no engine with
   * worker threads, or neither the stage nor the preview worker can draw on this device.
   */
  _route() {
    const stage = this.stage();
    if (!stage) return NOT_YET;
    if (!stage?.engineSide?.engine?.threaded || typeof stage.renderThumbnail !== 'function') return 'no engine with worker threads';
    // A stage that cannot present to a second canvas (WebGL2) never will; the preview worker then draws them on the CPU.
    if (stage.engineSide.thumbnails === false && this.cpuRefusal) return `the stage cannot draw thumbnails on this device (${this.cpuRefusal})`;
    return null;
  }

  /** The engine's preview worker, or null (and why, in `cpuRefusal`) when there is none to draw thumbnails. */
  async _cpuReady() {
    if (this.cpuRefusal) return null;
    const previews = await this.previews();
    if (previews?.usable) return previews;
    this.cpuRefusal = 'no preview worker';
    return null;
  }

  /**
   * The thumbnail drawn on the CPU by the engine's preview worker, from the document the engine
   * holds at `revision`, and copied onto `canvas`. Resolves like the stage's `renderThumbnail`:
   * `drawn`, `stale` or `refused` (no usable preview worker, a frame it could not prepare).
   */
  async _cpu({revision, tick, width, height}, canvas, signal) {
    const previews = await this._cpuReady();
    if (!previews) return 'refused';
    const engine = this.stage().engineSide.engine;
    let answer;
    try {
      answer = await previews.request(() => {
        const address = engine.handle.address();
        return {operation: 'thumbnail', address, revision, tick, width, height};
      }, {signal, discard: message => engine.handle.forget_address(message.address)});
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (!previews.usable) this.cpuRefusal = String(error?.message ?? error);
      return 'refused';
    }
    if (signal.aborted) { answer.bitmap?.close?.(); return 'stale'; }
    if (answer.refused === 'stale') return 'stale';
    if (answer.refused || !answer.bitmap) { answer.bitmap?.close?.(); return 'refused'; }
    const context = canvas.getContext('2d');
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(answer.bitmap, 0, 0);
    answer.bitmap.close?.();
    this.engineStats.cpu++;
    return 'drawn';
  }

  renderThumbnail = (index, canvas, options = {}) => {
    const {signal} = options;
    if (this.disposed || this.paused || signal?.aborted) return Promise.resolve(false);
    const route = this._route();
    if (route === NOT_YET) return Promise.resolve(false);
    if (route) return Promise.resolve(this._refuse(route));
    // A caller outside the virtual filmstrip still cannot queue an unbounded backlog.
    if (this.queued >= 8) return Promise.resolve(false);
    this.queued++;
    const version = this.version;
    const task = this.chain.catch(() => {}).then(() => this._render(index, canvas, options, version));
    this.chain = task;
    return task.finally(() => { this.queued--; });
  };

  async _render(index, canvas, options, version) {
    const {signal} = options;
    if (this.disposed || this.paused || signal?.aborted || version !== this.version) return false;
    const controller = this.currentAbort = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const check = () => { if (controller.signal.aborted || version !== this.version || this.disposed) throw abortError(); };
    try {
      const editor = this.editor, report = editor.report, revision = editor.revision;
      const tick = options.tick ?? editor.timeline?.[index]?.start;
      if (!Number.isInteger(tick) || !report.keyframes?.[index]) return this._refuse('a frame outside the timeline');
      // Published drawing strokes are what thumbnails show (as the JavaScript worker waits for them).
      await drawingBarrier(report, {signal: controller.signal});
      check();
      // A stage that cannot draw thumbnails needs the preview worker: known before the engine is brought to the revision.
      if (this.stage()?.engineSide?.thumbnails === false) await this._cpuReady();
      const reason = this._route() ?? await engineDocument({stage: this.stage(), report, revision, check});
      check();
      // An edit landed meanwhile: the engine follows it, and the caller asks again.
      if (editor.revision !== revision || editor.report !== report) return false;
      if (reason) return this._refuse(reason);
      const started = performance.now(), request = {revision, tick, width: canvas.width, height: canvas.height};
      const stageless = () => this.stage().engineSide?.thumbnails === false;
      let result = stageless() ? 'refused' : await this.stage().renderThumbnail(request, canvas, {signal: controller.signal});
      // The stage cannot draw thumbnails on this device: the preview worker draws them on the CPU.
      if (result === 'refused' && stageless()) result = await this._cpu(request, canvas, controller.signal);
      if (result === 'stale') { this.engineStats.stale++; return false; }
      if (result !== 'drawn') {
        this.engineStats.refused++;
        return this._refuse(stageless() ? `the stage cannot draw thumbnails on this device (${this.cpuRefusal ?? 'the preview worker did not draw it'})` : 'the stage did not draw the thumbnail');
      }
      if (controller.signal.aborted || version !== this.version || this.paused) return false;
      this.refusal = null;
      Object.assign(this.engineStats, {renders: this.engineStats.renders + 1, lastRenderMs: performance.now() - started});
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
      return this.disposed ? false : this._refuse(String(error?.message ?? error));
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.currentAbort === controller) this.currentAbort = null;
    }
  }

  /** The thumbnail is not drawn: the caller asks again later. */
  _refuse(reason) {
    this.refusal = reason;
    return false;
  }

  destroy() {
    this.disposed = true;
    this.events.abort();
    this.currentAbort?.abort();
  }
}
