/**
 * What the performance overlay, the jobs panel and the control channel's `metrics` read, through the narrow reads the app
 * already offers (`window.styk.performance()`, the stage's and the engine's statistics). Developer build only.
 *
 * Reading never waits: the engine's statistics are `try_lock` reads that answer `busy` instead (styk-wasm `EngineHandle::stats`).
 */
const percentile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};
const round = (value, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : value ?? null);
const parsed = (read) => { try { return read(); } catch (error) { return {error: String(error?.message ?? error)}; } };

/** The display frames the early script measured, newest last: up to `count` intervals (ms). */
export function frameIntervals(frames, count = 240) {
  const available = Math.min(frames.total, frames.intervals.length, count), values = new Array(available);
  for (let i = 0; i < available; i++) values[i] = frames.intervals[(frames.head - available + i + frames.intervals.length) % frames.intervals.length];
  return values;
}

export class Sampler {
  /** `engine` is the loaded engine (src/engine/engine.mjs loadEngine's result), or null while it loads. */
  constructor({app, early, engine = null}) { this.app = app; this.early = early; this.engine = engine; }

  /** Frame times of the last `count` display frames, late frames over `lateMs` (default: one and a half refresh periods at 60 Hz). */
  frames({count = 240, lateMs = 25} = {}) {
    const values = frameIntervals(this.early.frames, count);
    return {count: values.length, last: round(values.at(-1)), p50: round(percentile(values, .5)), p95: round(percentile(values, .95)),
      worst: round(values.length ? Math.max(...values) : null), late: values.filter(ms => ms > lateMs).length, lateMs, watching: this.early.frames.watching > 0};
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
        prepared: handleStats?.prepared ?? null, preparedTotalMs: round(handleStats?.totalMs), preparedWorstMs: round(handleStats?.worstMs), inline: handleStats?.inline ?? null,
        cachedFrames: handleStats?.cached ?? null, cachedBytes: handleStats?.cachedBytes ?? null, imagesPending: handleStats?.imagesPending ?? null, busy: handleStats?.busy ?? null} : null,
      playback: playback && !playback.error ? {preparedFrames: playback.preparedFrames, readyFrames: playback.readyFrames, bytes: playback.bytes, lastCompileMs: round(playback.lastCompileMs)} : playback,
      stage: stage && !stage.error ? {frames: stage.frames, lastSendMs: round(stage.lastSendMs), lastDrawMs: round(stage.lastDrawMs), refusal: stage.refusal ?? null, backend: stage.backend ?? null} : stage,
      importing: Boolean(app.state?.importing), playing: Boolean(app.state?.playing), buffering: Boolean(app.state?.buffering),
      threads: {live: live.length, started: this.early.workers.sequence, byName},
      browser: {longTasks: this.early.browser.longTasks, longTaskMs: round(this.early.browser.longTaskMs), slowInputs: this.early.browser.slowInputs, worstInputMs: round(this.early.browser.worstInputMs)},
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
    return {
      at: round(performance.now(), 1),
      frames: this.frames(options),
      paint: {count: paints.length, p50: round(percentile(paints, .5)), p95: round(percentile(paints, .95)), worst: round(paints.length ? Math.max(...paints) : null)},
      presentation: perf?.presentation ? {fps: round(perf.presentation.fps, 1), targetFps: perf.presentation.targetFps, bufferingMs: round(perf.presentation.bufferingMs), bufferingEvents: perf.presentation.bufferingEvents} : null,
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
