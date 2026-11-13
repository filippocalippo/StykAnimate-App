/**
 * The one instrumentation layer (docs/DEVTOOLS.md): named spans, instants, counters and live parameters, written
 * once where the work is owned (the frame loop, the engine's calls, saving, exports).
 *
 * In the shipping build nothing records: `sink` is null, every function returns at once and `tuned` returns its default.
 * Only the developer build's early script (src/devtools/early.js, never shipped) defines the sink before any module runs.
 *
 * The statistics collector (docs/STATISTICS.md) may also listen, in every build, while statistics are on: it hears the
 * name and duration of the completed spans it asked for, nothing else. Span arguments stay the developer tools' own:
 * call sites build them only when `tracing` is true.
 *
 *   const span = traceBegin('engine call');  ...  traceEnd(span, tracing ? {method} : undefined);
 *   const ahead = tuned('playback.prepareAhead', 48, {min: 4, max: 240});
 */
const sink = globalThis.__stykTrace ?? null;

/** Whether spans are recorded (the developer build). Callers build span arguments only when true. */
export const tracing = sink !== null;

/** The listener's open spans: preallocated slots, so a span it hears allocates nothing. A listener token is negative. */
const SLOTS = 64;
const slotNames = new Array(SLOTS).fill(null), slotStarts = new Float64Array(SLOTS), slotSink = new Float64Array(SLOTS);
let listener = null, listened = null, nextSlot = 0;

/**
 * Hears every completed span named in `names` (a Set) as `onSpan(name, milliseconds)`, until `stopListening`. One listener
 * at a time: the statistics collector.
 */
export function listenSpans(names, onSpan) { listened = names; listener = onSpan; }
export function stopListening() { listener = null; listened = null; slotNames.fill(null); }

/** Opens a span on the interface thread; returns the token `traceEnd` takes (0 when nothing records or listens). */
export function traceBegin(name, args) {
  if (listener === null || !listened.has(name)) return sink === null ? 0 : sink.begin(name, args);
  const slot = nextSlot; nextSlot = (nextSlot + 1) % SLOTS;
  slotNames[slot] = name; slotSink[slot] = sink === null ? 0 : sink.begin(name, args); slotStarts[slot] = performance.now();
  return -(slot + 1);
}

/** Closes the span `token` opened, with optional extra arguments. */
export function traceEnd(token, args) {
  if (token > 0) { if (sink !== null) sink.end(token, args); return; }
  if (token === 0) return;
  const slot = -token - 1, name = slotNames[slot];
  if (name === null) return;
  slotNames[slot] = null;
  if (slotSink[slot] !== 0 && sink !== null) sink.end(slotSink[slot], args);
  if (listener !== null) listener(name, performance.now() - slotStarts[slot]);
}

/** A span measured elsewhere: `start` and `duration` in performance.now() milliseconds, on the named thread. */
export function traceComplete(name, start, duration, args, thread) {
  if (sink !== null) sink.complete(name, start, duration, args, thread);
  if (listener !== null && listened.has(name)) listener(name, duration);
}

/**
 * A run of phases that follow one another (the app's start): ends the phase before and begins `name`; null ends the
 * last. Each is a span of the profiler's phases lane, so a start says which of its steps the time went to.
 */
export function tracePhase(name) { if (sink !== null) sink.phase(name); }

/** A moment worth marking (a document opened, a device lost). */
export function traceInstant(name, args) { if (sink !== null) sink.instant(name, args); }

/** A sampled value (a queue depth, bytes held). */
export function traceCounter(name, value) { if (sink !== null) sink.counter(name, value); }

/**
 * Memory an owner holds outside the engine's memory and the JavaScript heap (pixels in array buffers, canvases, image
 * bitmaps), so the developer tools can say who holds the page's memory (docs/DEVTOOLS.md "Memory by owner"). `read(target)`
 * returns the bytes `target` holds now: a number, or `{bytes, count}`. The tools call it when they take a memory checkpoint,
 * never on the app's own paths, so it reads a count the owner keeps or walks a short list. `target` is held weakly, so an
 * owner nothing else holds drops out by itself: `read` takes it as its argument and must not capture it. Returns the
 * function that removes the registration (call it when the owner is disposed). `kind` says what the bytes are:
 * `buffers` (typed arrays and array buffers), `pixels` (canvases, image bitmaps the browser keeps in this process) or
 * `graphics` (kept in the graphics process). The shipping build registers nothing.
 *
 *   traceMemory('drawing: tiles', this, resources => resources.residentMemory().bytes);
 */
export function traceMemory(owner, target, read, kind = 'buffers') { return sink === null ? untraced : sink.memory(owner, target, read, kind); }
const untraced = () => {};

/**
 * A live parameter: the value worth tuning at `name`, read where it is used. The developer build lets the panel, the
 * control channel or a saved profile change it while the app runs; the shipping build always returns `fallback`.
 * `spec`: {min, max, step, options, description}.
 */
export function tuned(name, fallback, spec) { return sink === null ? fallback : sink.parameter(name, fallback, spec); }
