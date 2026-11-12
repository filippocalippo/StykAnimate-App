/**
 * What the performance panel, the overlay, the jobs panel and the control channel's `metrics` read, through the narrow
 * reads the app already offers (`window.styk.performance()`, the stage's and the engine's statistics) and the frame
 * recorder (frames.mjs). Developer build only.
 *
 * Reading never waits: the engine's statistics are `try_lock` reads that answer `busy` instead (styk-wasm `EngineHandle::stats`).
 */
import {displayPeriod, frameCountAt, frameWindow, inputCountAt, inputWindow, summarizeFrames, summarizeInputs} from './frames.mjs';
import {distribution, round} from './stats.mjs';

const parsed = (read) => { try { return read(); } catch (error) { return {error: String(error?.message ?? error)}; } };
/** The period assumed until the display's own has been seen (60 Hz). */
const ASSUMED_PERIOD = 1000 / 60;

export class Sampler {
  /** `engine` is the loaded engine (src/engine/engine.mjs loadEngine's result), or null while it loads; `boundary` the engine boundary meter. */
  constructor({app, early, engine = null, boundary = null}) { this.app = app; this.early = early; this.engine = engine; this.boundary = boundary; this.period = null; }

  /**
   * The display's period (ms). Frames never come faster than the display takes them, so the shortest run of frames
   * seen so far is the period; until 30 frames were recorded, 60 Hz is assumed. `measured` says which.
   */
  displayPeriod() {
    const seen = displayPeriod(frameWindow(this.early.frames, Math.max(0, this.early.frames.total - 240)).interval);
    if (seen !== null && this.early.frames.total >= 30 && (this.period === null || seen < this.period)) this.period = seen;
    return {periodMs: this.period ?? ASSUMED_PERIOD, measured: this.period !== null};
  }

  /** The frames of the last `ms` (default 2 s), with the interface thread's work by phase: `summarizeFrames`' shape. */
  frames({ms = 2000} = {}) {
    const since = performance.now() - ms, {periodMs, measured} = this.displayPeriod();
    return {...summarizeFrames(frameWindow(this.early.frames, frameCountAt(this.early.frames, since)), {periodMs}), periodMeasured: measured, watching: this.early.frames.watching > 0};
  }

  /** The latency of the inputs of the last `ms`: from each input to the end of the frame that followed its handler. */
  inputs({ms = 2000} = {}) {
    return summarizeInputs(inputWindow(this.early.frames, inputCountAt(this.early.frames, performance.now() - ms)));
  }

  /** The page's memory, the engine's and the GPU's as the stage counts it. */
  memory() {
    const heap = performance.memory ? {usedBytes: performance.memory.usedJSHeapSize, totalBytes: performance.memory.totalJSHeapSize, limitBytes: performance.memory.jsHeapSizeLimit} : null;
    const engine = this.engine ? parsed(() => this.engine.memory()) : null;
    const renderer = this.app.state?.renderer?.stats ?? null;
    return {jsHeap: heap, engine, engineMemoryBytes: this.engine?.memoryBytes ?? null, engineMaximumBytes: this.engine?.memoryMaximumBytes ?? null,
      gpuBytes: renderer?.gpuBytes ?? null, gpu: renderer?.engine ? {spriteBytes: renderer.engine.spriteBytes, targetBytes: renderer.engine.targetBytes, effectBytes: renderer.engine.effectBytes,
        layerBytes: renderer.engine.layerBytes, glyphBytes: renderer.engine.glyphBytes, softBytes: renderer.engine.softBytes} : null};
  }

  /** The engine's frame preparation counters since it started: frames prepared on its threads, their total and worst time. Null when it is busy or not loaded. */
  preparation() {
    const stats = this.engine ? parsed(() => JSON.parse(this.engine.handle.stats())) : null;
    return stats && !stats.error && !stats.busy ? {prepared: stats.prepared, totalMs: stats.totalMs, worstMs: stats.worstMs, inline: stats.inline, cached: stats.cached, cachedBytes: stats.cachedBytes, imagesPending: stats.imagesPending} : null;
  }

  /** Queues and jobs: the engine's preparation, pictures waiting, playback's buffer, exports, imports and the page's workers. */
  jobs() {
    const app = this.app, engine = this.engine;
    const handleStats = engine ? parsed(() => JSON.parse(engine.handle.stats())) : null;
    const playback = parsed(() => app.playback?.stats ?? null);
    const stage = parsed(() => app.state?.renderer?.engineStats ?? null);
    const workers = this.early.workers.rows;
    const live = workers.filter(row => row.terminated === null);
    const byName = {};
    for (const row of live) { const key = row.name || row.url.split('/').pop(); byName[key] = (byName[key] ?? 0) + 1; }
    return {
      engine: engine ? {threaded: engine.threaded, workers: engine.workers, workersLost: parsed(() => engine.handle.workers_lost()), generation: parsed(() => engine.handle.generation()),
        prepared: handleStats?.prepared ?? null, preparedTotalMs: round(handleStats?.totalMs, 2), preparedWorstMs: round(handleStats?.worstMs, 2), inline: handleStats?.inline ?? null,
        cachedFrames: handleStats?.cached ?? null, cachedBytes: handleStats?.cachedBytes ?? null, imagesPending: handleStats?.imagesPending ?? null, busy: handleStats?.busy ?? null} : null,
      playback: playback && !playback.error ? {preparedFrames: playback.preparedFrames, readyFrames: playback.readyFrames, bytes: playback.bytes, lastCompileMs: round(playback.lastCompileMs, 2)} : playback,
      stage: stage && !stage.error ? {frames: stage.frames, lastSendMs: round(stage.lastSendMs, 2), lastDrawMs: round(stage.lastDrawMs, 2), refusal: stage.refusal ?? null, backend: stage.backend ?? null} : stage,
      importing: Boolean(app.state?.importing), playing: Boolean(app.state?.playing), buffering: Boolean(app.state?.buffering),
      threads: {live: live.length, started: this.early.workers.sequence, byName},
      browser: {longTasks: this.early.browser.longTasks, longTaskMs: round(this.early.browser.longTaskMs, 2), slowInputs: this.early.browser.slowInputs, worstInputMs: round(this.early.browser.worstInputMs, 2)},
    };
  }

  /** The page's workers, one row each (the jobs panel's thread list). */
  threads({all = false} = {}) {
    return this.early.workers.rows.filter(row => all || row.terminated === null).map(row => ({id: row.id, name: row.name, url: row.url,
      ageMs: round(performance.now() - row.created, 0), terminated: row.terminated !== null, sent: row.sent, received: row.received, errors: row.errors}));
  }

  /** Everything at once, short: the overlay's numbers and the control channel's `metrics`. */
  snapshot(options) {
    const perf = parsed(() => this.app.performance?.() ?? null);
    const paints = Array.isArray(perf?.samples) ? perf.samples : [];
    const paint = distribution(paints, 2);
    return {
      at: round(performance.now(), 1),
      frames: this.frames(options),
      inputs: this.inputs(options),
      paint: {count: paint.count, p50: paint.p50, p95: paint.p95, worst: paint.worst},
      presentation: perf?.presentation ? {fps: round(perf.presentation.fps, 1), targetFps: perf.presentation.targetFps, bufferingMs: round(perf.presentation.bufferingMs, 2), bufferingEvents: perf.presentation.bufferingEvents} : null,
      memory: this.memory(),
      jobs: this.jobs(),
    };
  }

  /** Writes the numbers worth graphing as counters into the span ring (the profiler's tracks). */
  sampleCounters(trace) {
    const jobs = this.jobs(), memory = this.memory();
    trace.counter('engine imagesPending', jobs.engine?.imagesPending);
    trace.counter('engine cachedFrames', jobs.engine?.cachedFrames);
    trace.counter('engine prepared', jobs.engine?.prepared);
    trace.counter('threads live', jobs.threads.live);
    trace.counter('memory jsHeap MB', memory.jsHeap ? memory.jsHeap.usedBytes / 1048576 : NaN);
    trace.counter('memory engine live MB', memory.engine?.liveBytes / 1048576);
    trace.counter('memory gpu MB', memory.gpuBytes / 1048576);
  }
}
