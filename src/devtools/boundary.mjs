/**
 * The engine boundary meter (developer build only; docs/DEVTOOLS.md "The engine boundary").
 *
 * Every call the interface thread makes into the WebAssembly engine goes through a method of one of a few generated
 * classes (the edit session, the engine handle, the stage). This wraps those methods where they are defined, so the
 * whole boundary is measured without a line in the app: per method, how often it was called and how long it took.
 * A call of 0.25 ms or more is also a span in the profiler (`engine <Class>.<method>`), inside whatever asked for it.
 *
 * Two reads: `rows()`, every call since the last reset (a capture resets it when it starts, so its rows are its own),
 * and `recent(ms)`, the calls of the last seconds whatever a capture did (the performance panel's live list). For the
 * second each method keeps its calls, total and worst per half second of the last sixteen seconds, so a window's worst
 * is the worst of that window.
 *
 * While nothing watches (no capture, panel or overlay), a wrapped method costs one comparison. The tools' own reads of
 * the engine (the sampler's statistics and memory) run through `unmetered`, so the list shows only the app's calls.
 */

/** Calls shorter than this are counted but leave no span: thousands of tiny reads would push the hitch out of the ring. */
const SPAN_MS = 0.25;
/** The edit session's entry points that take a method name: counted per method, and already spans of their own (`edit session call`). */
const NAMED_CALLS = new Set(['call', 'call_with_document']);
const SKIPPED = new Set(['constructor', 'free', '__destroy_into_raw']);
/** The live window's resolution: half-second buckets, sixteen seconds of them. */
const BUCKET_MS = 500, BUCKETS = 32;

/**
 * Wraps the methods of `classes` ({EditSession, EngineHandle, Stage, …}). `early` is the early script's state and
 * `trace` its sink. Returns the meter: `rows()`, `recent(ms)`, `reset()` and `unmetered(work)`.
 */
export function meterBoundary(classes, early, trace) {
  const totals = new Map();
  /** Above zero while the tools read the engine for themselves. */
  let quiet = 0;
  const entry = name => {
    let row = totals.get(name);
    if (!row) {
      totals.set(name, row = {name, calls: 0, totalMs: 0, worstMs: 0,
        buckets: {bucket: new Float64Array(BUCKETS).fill(-1), calls: new Uint32Array(BUCKETS), totalMs: new Float64Array(BUCKETS), worstMs: new Float64Array(BUCKETS)}});
    }
    return row;
  };
  const record = (row, started, ms) => {
    row.calls++; row.totalMs += ms;
    if (ms > row.worstMs) row.worstMs = ms;
    const bucket = Math.floor(started / BUCKET_MS), slot = bucket % BUCKETS, recent = row.buckets;
    if (recent.bucket[slot] !== bucket) { recent.bucket[slot] = bucket; recent.calls[slot] = 0; recent.totalMs[slot] = 0; recent.worstMs[slot] = 0; }
    recent.calls[slot]++; recent.totalMs[slot] += ms;
    if (ms > recent.worstMs[slot]) recent.worstMs[slot] = ms;
  };
  const wrap = (owner, key, label) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) return;
    const original = descriptor.value, named = NAMED_CALLS.has(key);
    const row = named ? null : entry(label);
    const metered = function (...args) {
      if (!early.frames.watching || quiet) return original.apply(this, args);
      const started = performance.now();
      try { return original.apply(this, args); }
      finally {
        const ms = performance.now() - started;
        record(row ?? entry(`${label}(${args[0]})`), started, ms);
        if (!named && ms >= SPAN_MS) trace.nested(`engine ${label}`, started, ms);
      }
    };
    Object.defineProperty(owner, key, {...descriptor, value: metered});
  };
  for (const [className, type] of Object.entries(classes ?? {})) {
    if (typeof type !== 'function') continue;
    for (const key of Object.getOwnPropertyNames(type.prototype)) if (!SKIPPED.has(key) && !key.startsWith('__')) wrap(type.prototype, key, `${className}.${key}`);
    // Static constructors (`Stage.create`, `EditSession.from_document`) cross the boundary too.
    for (const key of Object.getOwnPropertyNames(type)) if (!['length', 'name', 'prototype'].includes(key) && !key.startsWith('__')) wrap(type, key, `${className}.${key}`);
  }
  return {
    /** What was called since the last reset, heaviest first: {name, calls, totalMs, worstMs}. */
    rows: () => [...totals.values()].filter(row => row.calls).map(({name, calls, totalMs, worstMs}) => ({name, calls, totalMs, worstMs})).sort((a, b) => b.totalMs - a.totalMs),
    /**
     * What was called in the last `ms` (to the half second, at most sixteen seconds), heaviest first: {name, calls,
     * totalMs, worstMs}. `now` is performance.now(), given by tests.
     */
    recent(ms, now = performance.now()) {
      const first = Math.floor((now - Math.min(ms, (BUCKETS - 1) * BUCKET_MS)) / BUCKET_MS), last = Math.floor(now / BUCKET_MS), found = [];
      for (const row of totals.values()) {
        const recent = row.buckets;
        let calls = 0, totalMs = 0, worstMs = 0;
        for (let slot = 0; slot < BUCKETS; slot++) {
          const bucket = recent.bucket[slot];
          if (bucket < first || bucket > last) continue;
          calls += recent.calls[slot]; totalMs += recent.totalMs[slot];
          if (recent.worstMs[slot] > worstMs) worstMs = recent.worstMs[slot];
        }
        if (calls) found.push({name: row.name, calls, totalMs, worstMs});
      }
      return found.sort((a, b) => b.totalMs - a.totalMs);
    },
    /** Runs `work` without counting the calls it makes: the tools' own reads of the engine. */
    unmetered(work) { quiet++; try { return work(); } finally { quiet--; } },
    /** Starts counting afresh (a capture does when it starts, so its rows are its own). The live window is not touched. */
    reset() { for (const row of totals.values()) { row.calls = 0; row.totalMs = 0; row.worstMs = 0; } },
  };
}
