/**
 * The one instrumentation layer (docs/DEVTOOLS.md): named spans, instants, counters and live parameters, written
 * once where the work is owned (the frame loop, the engine's calls, saving, exports).
 *
 * In the shipping build nothing records: `sink` is null, every function returns at once and `tuned` returns its default.
 * Only the developer build's early script (src/devtools/early.js, never shipped) defines the sink before any module runs.
 *
 *   const span = traceBegin('engine call');  ...  traceEnd(span, {method});
 *   const ahead = tuned('playback.prepareAhead', 48, {min: 4, max: 240});
 */
const sink = globalThis.__stykTrace ?? null;

/** Whether spans are recorded (the developer build). Callers may skip building span arguments when false. */
export const tracing = sink !== null;

/** Opens a span on the interface thread; returns the token `traceEnd` takes (0 when nothing records). */
export function traceBegin(name, args) { return sink === null ? 0 : sink.begin(name, args); }

/** Closes the span `token` opened, with optional extra arguments. */
export function traceEnd(token, args) { if (token !== 0 && sink !== null) sink.end(token, args); }

/** A span measured elsewhere: `start` and `duration` in performance.now() milliseconds, on the named thread. */
export function traceComplete(name, start, duration, args, thread) { if (sink !== null) sink.complete(name, start, duration, args, thread); }

/** A moment worth marking (a document opened, a device lost). */
export function traceInstant(name, args) { if (sink !== null) sink.instant(name, args); }

/** A sampled value (a queue depth, bytes held). */
export function traceCounter(name, value) { if (sink !== null) sink.counter(name, value); }

/**
 * A live parameter: the value worth tuning at `name`, read where it is used. The developer build lets the panel, the
 * control channel or a saved profile change it while the app runs; the shipping build always returns `fallback`.
 * `spec`: {min, max, step, options, description}.
 */
export function tuned(name, fallback, spec) { return sink === null ? fallback : sink.parameter(name, fallback, spec); }
