/**
 * The engine boundary meter (developer build only; docs/DEVTOOLS.md "The engine boundary").
 *
 * Every call the interface thread makes into the WebAssembly engine goes through a method of one of a few generated
 * classes (the edit session, the engine handle, the stage). This wraps those methods where they are defined, so the
 * whole boundary is measured without a line in the app: per method, how often it was called and how long it took.
 * A call of 0.25 ms or more is also a span in the profiler (`engine <Class>.<method>`), inside whatever asked for it.
 *
 * While nothing watches (no capture, panel or overlay), a wrapped method costs one comparison.
 */

/** Calls shorter than this are counted but leave no span: thousands of tiny reads would push the hitch out of the ring. */
const SPAN_MS = 0.25;
/** The edit session's entry points that take a method name: counted per method, and already spans of their own (`edit session call`). */
const NAMED_CALLS = new Set(['call', 'call_with_document']);
const SKIPPED = new Set(['constructor', 'free', '__destroy_into_raw']);

/**
 * Wraps the methods of `classes` ({EditSession, EngineHandle, Stage, …}). `early` is the early script's state and
 * `trace` its sink. Returns the meter: `rows()` and `reset()`.
 */
export function meterBoundary(classes, early, trace) {
  const totals = new Map();
  const entry = name => {
    let row = totals.get(name);
    if (!row) totals.set(name, row = {name, calls: 0, totalMs: 0, worstMs: 0});
    return row;
  };
  const wrap = (owner, key, label) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) return;
    const original = descriptor.value, named = NAMED_CALLS.has(key);
    const row = named ? null : entry(label);
    const metered = function (...args) {
      if (!early.frames.watching) return original.apply(this, args);
      const started = performance.now();
      try { return original.apply(this, args); }
      finally {
        const ms = performance.now() - started, into = row ?? entry(`${label}(${args[0]})`);
        into.calls++; into.totalMs += ms;
        if (ms > into.worstMs) into.worstMs = ms;
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
    rows: () => [...totals.values()].filter(row => row.calls).map(row => ({...row})).sort((a, b) => b.totalMs - a.totalMs),
    /** Starts counting afresh (a capture does when it starts, so its rows are its own). */
    reset() { for (const row of totals.values()) { row.calls = 0; row.totalMs = 0; row.worstMs = 0; } },
  };
}
