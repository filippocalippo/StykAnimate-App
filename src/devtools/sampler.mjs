/**
 * What the performance panel, the overlay, the jobs panel and the control channel's `metrics` read, through the narrow
 * reads the app already offers (`window.styk.performance()`, the stage's and the engine's statistics) and the frame
 * recorder (frames.mjs). Developer build only.
 *
 * Reading never waits: the engine's statistics are `try_lock` reads that answer `busy` instead (styk-wasm `EngineHandle::stats`).
 *
 * While something watches, `sample` runs four times a second (src/devtools/devtools.mjs `watch`): it writes the numbers
 * worth graphing as counters into the span ring (the profiler's tracks, and a capture's) and keeps the same numbers in a
 * short history (the last minute) that the live panel and the overlay read, so nothing reads the engine twice for them.
 */
import {preparationSince} from './capture.mjs';
import {displayPeriod, frameCountAt, frameWindow, inputCountAt, inputWindow, summarizeFrames, summarizeInputs} from './frames.mjs';
import {distribution, round} from './stats.mjs';

/** The numbers `sample` keeps, with the counter each is written to in the span ring (null: kept, not graphed). Bytes are counted in megabytes. */
export const SAMPLED = Object.freeze({
  jsHeapBytes: 'memory jsHeap MB', engineLiveBytes: 'memory engine live MB', engineHeapBytes: 'memory engine heap MB', gpuBytes: 'memory gpu MB', gpuTotalBytes: 'memory gpu total MB',
  prepared: 'engine prepared', preparedTotalMs: null, preparedInline: null, imagesPending: 'engine imagesPending', cachedFrames: 'engine cachedFrames', cachedBytes: null,
  playbackReady: 'playback readyFrames', threadsLive: 'threads live',
});
/** Samples the history holds: a minute at four a second. */
const HISTORY = 240;

const parsed = (read) => { try { return read(); } catch (error) { return {error: String(error?.message ?? error)}; } };
/** The period assumed until the display's own has been seen (60 Hz). */
const ASSUMED_PERIOD = 1000 / 60;

export class Sampler {
  /** `engine` is the loaded engine (src/engine/engine.mjs loadEngine's result), or null while it loads; `boundary` the engine boundary meter. */
  constructor({app, early, engine = null, boundary = null}) {
    Object.assign(this, {app, early, engine, boundary, period: null, periodSeenAt: -Infinity, last: null});
    this.history = {total: 0, at: new Float64Array(HISTORY), ...Object.fromEntries(Object.keys(SAMPLED).map(key => [key, new Float64Array(HISTORY)]))};
  }

  /**
   * The display's period (ms). Frames never come faster than the display takes them, so the shortest run of frames
   * seen so far is the period; until 30 frames were recorded, 60 Hz is assumed. `measured` says which.
   */
  displayPeriod() {
    // Until measured, read on every call; then again once a second of frames (at 60 Hz) has passed: the period hardly moves, and every live view asks for it.
    const total = this.early.frames.total;
    if (this.period === null || total - this.periodSeenAt >= 60 || total < this.periodSeenAt) {
      this.periodSeenAt = total;
      const seen = displayPeriod(frameWindow(this.early.frames, Math.max(0, total - 240)).interval);
      if (seen !== null && total >= 30 && (this.period === null || seen < this.period)) this.period = seen;
    }
    return {periodMs: this.period ?? ASSUMED_PERIOD, measured: this.period !== null};
  }

  /** The recorder's frames of the last `ms` (frames.mjs `frameWindow`). */
  window(ms = 2000) { return frameWindow(this.early.frames, frameCountAt(this.early.frames, performance.now() - ms)); }

  /**
   * The frames of the last `ms` (default 2 s), or of a `window` already read, with the interface thread's work by
   * phase: `summarizeFrames`' shape.
   */
  frames({ms = 2000, window = null} = {}) {
    const {periodMs, measured} = this.displayPeriod();
    return {...summarizeFrames(window ?? this.window(ms), {periodMs}), periodMeasured: measured, watching: this.early.frames.watching > 0};
  }

  /** The latency of the inputs of the last `ms`: from each input to the end of the frame that followed its handler. */
  inputs({ms = 2000} = {}) {
    return summarizeInputs(inputWindow(this.early.frames, inputCountAt(this.early.frames, performance.now() - ms)));
  }

  /** Runs the tools' own reads of the engine outside the boundary meter, which counts only the app's calls. */
  quietly(read) { return this.boundary ? this.boundary.unmetered(read) : read(); }

  /**
   * The page's memory, the engine's and the GPU's as the stage counts it: `gpuBytes` is the stage's own figure (the one
   * the app reports), which leaves out its render targets and sprite pages; `gpuTotalBytes` adds them, all the stage holds.
   */
  memory() { return this.quietly(() => this.#readMemory()); }
  #readMemory() {
    const heap = performance.memory ? {usedBytes: performance.memory.usedJSHeapSize, totalBytes: performance.memory.totalJSHeapSize, limitBytes: performance.memory.jsHeapSizeLimit} : null;
    const engine = this.engine ? parsed(() => this.engine.memory()) : null;
    const renderer = this.app.state?.renderer?.stats ?? null;
    return {jsHeap: heap, engine, engineMemoryBytes: this.engine?.memoryBytes ?? null, engineMaximumBytes: this.engine?.memoryMaximumBytes ?? null,
      gpuBytes: renderer?.gpuBytes ?? null, gpuTotalBytes: renderer?.engine ? renderer.gpuBytes + renderer.engine.targetBytes + renderer.engine.spriteBytes : null, gpu: renderer?.engine ? {spriteBytes: renderer.engine.spriteBytes, targetBytes: renderer.engine.targetBytes, effectBytes: renderer.engine.effectBytes,
        layerBytes: renderer.engine.layerBytes, glyphBytes: renderer.engine.glyphBytes, softBytes: renderer.engine.softBytes} : null};
  }

  /** The engine's frame preparation counters since it started: frames prepared on its threads, their total and worst time. Null when it is busy or not loaded. */
  preparation() { return this.quietly(() => this.#readPreparation()); }
  #readPreparation() {
    const stats = this.engine ? parsed(() => JSON.parse(this.engine.handle.stats())) : null;
    return stats && !stats.error && !stats.busy ? {prepared: stats.prepared, totalMs: stats.totalMs, worstMs: stats.worstMs, inline: stats.inline, cached: stats.cached, cachedBytes: stats.cachedBytes, imagesPending: stats.imagesPending} : null;
  }

  /** Queues and jobs: the engine's preparation, pictures waiting, playback's buffer, exports, imports and the page's workers. */
  jobs() { return this.quietly(() => this.#readJobs()); }
  #readJobs() {
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

  /**
   * One sample: the queues, the engine's preparation and memory, written as counters into the span ring and kept in the
   * history. `last` holds the whole reads ({at, jobs, memory}) for the panels' current values. A value not known now
   * (the engine busy, no WebGPU stage) is NaN.
   */
  sample(trace) {
    const jobs = this.jobs(), memory = this.memory(), engine = jobs.engine ?? {}, number = value => (Number.isFinite(value) ? value : NaN);
    const values = {jsHeapBytes: memory.jsHeap?.usedBytes, engineLiveBytes: memory.engine?.liveBytes, engineHeapBytes: memory.engine?.heapBytes ?? memory.engineMemoryBytes, gpuBytes: memory.gpuBytes, gpuTotalBytes: memory.gpuTotalBytes,
      prepared: engine.busy ? NaN : engine.prepared, preparedTotalMs: engine.busy ? NaN : engine.preparedTotalMs, preparedInline: engine.busy ? NaN : engine.inline,
      imagesPending: engine.imagesPending, cachedFrames: engine.cachedFrames, cachedBytes: engine.cachedBytes, playbackReady: jobs.playback?.readyFrames, threadsLive: jobs.threads.live};
    const history = this.history, slot = history.total % HISTORY, at = performance.now();
    history.at[slot] = at;
    for (const [key, counter] of Object.entries(SAMPLED)) {
      const value = number(values[key]);
      history[key][slot] = value;
      if (counter) trace?.counter(counter, key.endsWith('Bytes') ? value / 1048576 : value);
    }
    history.total++;
    this.last = {at, jobs, memory};
    return this.last;
  }

  /** The history's samples of the last `ms`, oldest first: {at: [...], <key>: [...]} for each key of `SAMPLED` asked for (all by default). */
  series(ms = 60000, keys = Object.keys(SAMPLED)) {
    const history = this.history, since = performance.now() - ms, first = Math.max(0, history.total - HISTORY), found = {at: [], ...Object.fromEntries(keys.map(key => [key, []]))};
    for (let index = first; index < history.total; index++) {
      const slot = index % HISTORY;
      if (history.at[slot] < since) continue;
      found.at.push(history.at[slot]);
      for (const key of keys) found[key].push(history[key][slot]);
    }
    return found;
  }

  /**
   * What the engine's threads prepared over the last `ms` of samples: frames per second, the mean time of one (ms) and
   * the frames drawn on the interface thread for want of a prepared one (`inline`). Null with fewer than two samples.
   */
  preparationRate(ms = 2000) {
    const {at, prepared, preparedTotalMs, preparedInline} = this.series(ms, ['prepared', 'preparedTotalMs', 'preparedInline']);
    const known = at.map((_, index) => index).filter(index => Number.isFinite(prepared[index]));
    if (known.length < 2) return null;
    const first = known[0], last = known.at(-1), read = index => ({prepared: prepared[index], totalMs: preparedTotalMs[index], inline: preparedInline[index]});
    const since = preparationSince(read(first), read(last)), seconds = (at[last] - at[first]) / 1000;
    return {...since, perSecond: seconds > 0 ? round(since.frames / seconds, 1) : null, seconds: round(seconds, 2)};
  }
}
