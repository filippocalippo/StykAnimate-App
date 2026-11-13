/**
 * Reading the span ring (src/devtools/early.js): captures, Perfetto (Chrome trace) export and the statistics the profiler
 * panel, the control channel and the profiling runner share. Developer build only.
 */
import {frameSeries, frameWindow, inputWindow, summarizeFrames, summarizeInputs} from './frames.mjs';
import {quantile, round, sorted} from './stats.mjs';

export const DEVELOPER = 'styk-devtools';

/** Events of the ring from absolute index `from` (ring.total counts every event ever pushed) up to now, oldest first. */
export function ringEvents(ring, from = 0) {
  const oldest = Math.max(0, ring.total - ring.capacity);
  const first = Math.max(from, oldest), events = [];
  for (let index = first; index < ring.total; index++) {
    const at = index % ring.capacity;
    events.push({
      name: ring.names[ring.name[at]], thread: ring.threads[ring.thread[at]] ?? 'interface', start: ring.start[at],
      duration: ring.duration[at], depth: ring.depth[at], value: ring.value[at], args: ring.args[at],
    });
  }
  return {events, dropped: first - from > 0 ? first - from : 0};
}

/**
 * The events of the ring that began between `since` and `until` (performance.now ms), oldest first, read from the
 * newest backwards so a look at the last seconds costs what those seconds hold, not the whole ring. The ring is in the
 * order events ended, give or take a browser observer's delay (a long task is reported after it ends): the walk stops
 * once 32 events in a row ended more than a second before `since`.
 */
export function recentEvents(ring, since, until = Infinity) {
  const oldest = Math.max(0, ring.total - ring.capacity), events = [];
  for (let index = ring.total - 1, old = 0; index >= oldest && old < 32; index--) {
    const at = index % ring.capacity, start = ring.start[at], duration = ring.duration[at];
    if (start + Math.max(0, duration) < since - 1000) { old++; continue; }
    old = 0;
    if (start < since || start > until) continue;
    events.push({name: ring.names[ring.name[at]], thread: ring.threads[ring.thread[at]] ?? 'interface', start, duration, depth: ring.depth[at], value: ring.value[at], args: ring.args[at]});
  }
  return events.reverse();
}

/** What the engine's threads prepared between two reads of its counters (src/devtools/sampler.mjs `preparation`): frames, and the mean time of one (ms). */
export function preparationSince(before, after) {
  if (!before || !after) return null;
  // The engine starts its counters afresh for a new document: what it counts then is all since.
  const since = after.prepared >= before.prepared ? before : {prepared: 0, totalMs: 0, inline: 0};
  const frames = after.prepared - since.prepared;
  return {frames, msPerFrame: frames > 0 ? round((after.totalMs - since.totalMs) / frames) : null, inline: Math.max(0, after.inline - since.inline)};
}

/**
 * One capture at a time: `start()` marks the ring, `stop()` takes what was recorded since. With the frame recorder
 * (`frames`, the early script's), the engine boundary meter (`boundary`) and a read of the engine's preparation
 * counters (`preparation`, the sampler's) it also takes the frames, the inputs' latencies, the calls into the engine
 * and what the engine's threads prepared in that stretch.
 */
export class Capture {
  constructor(ring, {frames = null, boundary = null, preparation = null} = {}) {
    Object.assign(this, {ring, frames, boundary, preparation, running: null, last: null});
  }
  start(label = '') {
    if (this.running) throw new Error('A capture is already running: stop it first.');
    this.boundary?.reset();
    this.running = {label, from: this.ring.total, framesFrom: this.frames?.total ?? 0, inputsFrom: this.frames?.inputs.total ?? 0, startedAt: performance.now(), startedTime: Date.now(),
      prepared: this.preparation?.() ?? null};
    return {started: true, label};
  }
  stop() {
    const running = this.running;
    if (!running) throw new Error('No capture is running.');
    this.running = null;
    const {events, dropped} = ringEvents(this.ring, running.from);
    this.last = {label: running.label, startedAt: running.startedAt, startedTime: running.startedTime, stoppedAt: performance.now(), events, dropped,
      frames: this.frames ? frameWindow(this.frames, running.framesFrom) : null, inputs: this.frames ? inputWindow(this.frames, running.inputsFrom) : null,
      boundary: this.boundary?.rows() ?? null, preparation: this.preparation ? preparationSince(running.prepared, this.preparation()) : null};
    return this.last;
  }
}

/** The name a span is grouped under: an edit session call by its method, an interface update by its surface. */
export const spanKey = event => { const detail = event.args?.method ?? event.args?.surface; return detail ? `${event.name} ${detail}` : event.name; };

/**
 * Everything a capture says, as numbers: the spans' statistics (`summarize`), the display frames with the interface
 * thread's work by phase (`frames`), the inputs' latencies, the calls into the engine and what the engine's threads
 * prepared. `taken` is a capture, or any {startedAt, stoppedAt, events, dropped, frames, inputs, boundary, preparation}
 * (the last seconds of the rings). This is the summary the profiling runner stores and the performance panel shows.
 * `periodMs` is the display's period when the caller measured it; `series` adds the frames as chart series.
 */
export function analyze(taken, {periodMs = null, slowest, series = false} = {}) {
  const seconds = (taken.stoppedAt - taken.startedAt) / 1000, shown = shownFrames(taken);
  return {
    ms: round(taken.stoppedAt - taken.startedAt, 1), events: taken.events.length, dropped: taken.dropped,
    ...summarize(taken.events, {slowest}),
    frames: taken.frames ? summarizeFrames(taken.frames, {periodMs, seconds}) : null,
    inputs: taken.inputs ? summarizeInputs(taken.inputs) : null,
    boundary: taken.boundary ? taken.boundary.slice(0, 40).map(row => ({name: row.name, calls: row.calls, totalMs: round(row.totalMs), worstMs: round(row.worstMs)})) : null,
    preparation: taken.preparation ?? null,
    shown, pictures: pictureTimes(shown, round(taken.stoppedAt - taken.startedAt, 1)),
    ...(series && taken.frames ? {series: frameSeries(taken.frames)} : {}),
  };
}

/**
 * The pictures the stage showed during a capture and the inputs it received, as times in milliseconds from the
 * capture's start: `at` and `tick` of every frame the stage drew (`prepared`: a frame the engine's threads made, as
 * playback and a dense scrub show), and `inputs`, when each input happened. With both, a scenario can say how long a
 * key press or a pointer move took to show its frame, which the frame after its handler does not tell when the
 * picture is made off the interface thread. At most the last 2,000 of each.
 */
/** The spans of a picture shown: drawn in the frame that drew it (`stage draw`), or shown later (`stage picture`). */
const PICTURE_SPANS = new Set(['stage draw', 'stage draw prepared', 'stage picture', 'stage picture prepared']);

export function shownFrames(taken) {
  const at = [], tick = [], prepared = [], asked = [], later = [];
  for (const event of taken.events) {
    if (!PICTURE_SPANS.has(event.name) || event.args?.drawn !== true || !Number.isFinite(event.args.tick)) continue;
    at.push(round(event.start + event.duration - taken.startedAt, 1)); tick.push(event.args.tick); prepared.push(event.name.endsWith('prepared') ? 1 : 0);
    // A picture drawn on the engine's workers spans from the frame that asked for it to its showing (engine-stage-processor.mjs).
    asked.push(round(event.start - taken.startedAt, 1)); later.push(event.name.startsWith('stage picture') ? 1 : 0);
  }
  const keep = list => list.slice(-2000);
  return {at: keep(at), tick: keep(tick), prepared: keep(prepared), asked: keep(asked), later: keep(later), inputs: keep((taken.inputs?.at ?? []).map(time => round(time - taken.startedAt, 1)))};
}

/**
 * How the stage's pictures followed the hand when they were shown after the frame that asked for them (drawn on the
 * engine's workers): there the display frames run on while the picture is still being drawn, so the frame time and the
 * input delay say how free the interface thread was, not what the person saw. `felt` weighs how long each picture
 * stood still while the hand had moved (as `frames.felt` weighs frames): from the later of the picture before it and
 * the first input that picture did not show, to the picture; a picture after a pause in the input (between two notches
 * of a wheel) counts from the input, not from the picture before. `input` runs from each input to the first picture
 * asked for after it ({p50, p95}; an input no picture answered waits to the capture's end). Null for a capture whose
 * pictures were all shown in the frame that drew them, or without inputs.
 */
export function pictureTimes(shown, endMs = Infinity) {
  if (!shown?.later?.includes(1) || !shown.inputs?.length) return null;
  const inputs = shown.inputs, waits = inputs.map(input => {
    const answer = shown.at.find((at, index) => shown.asked[index] >= input && at >= input);
    return (answer ?? Math.max(endMs, input)) - input;
  });
  let total = 0, squares = 0, pictures = 0;
  for (let index = 1; index < shown.at.length; index++) {
    // The first input the picture before did not show: the picture stood still for the hand from then (or from that picture).
    const waiting = inputs.find(input => input >= shown.asked[index - 1]);
    if (waiting === undefined || waiting > shown.at[index]) continue;
    const ms = shown.at[index] - Math.max(shown.at[index - 1], waiting);
    pictures++;
    if (ms > 0) { total += ms; squares += ms * ms; }
  }
  const input = sorted(waits);
  return {pictures, felt: total > 0 ? round(squares / total, 1) : null, input: {p50: round(quantile(input, .5), 1), p95: round(quantile(input, .95), 1)}};
}

/**
 * Statistics of a list of events: per span name its thread, count, total, p50, p95 and worst (ms); per counter its last,
 * least and most; and the slowest single spans. Display frames are the frame recorder's (`analyze`), not spans to rank.
 * Threads: `interface` (the app's own spans), `tasks` (an open, a save), `long tasks` and `input` (the browser's reports).
 */
export function summarize(events, {slowest = 10} = {}) {
  const spans = new Map(), threads = new Map(), counters = new Map(), instants = new Map(), top = [];
  // The shortest of the slowest kept so far: a span no longer is not one of them, and is not sorted in.
  let floor = -Infinity;
  for (const event of events) {
    if (event.duration === -2) {
      const counter = counters.get(event.name) ?? {count: 0, last: 0, min: Infinity, max: -Infinity};
      counter.count++; counter.last = event.value; counter.min = Math.min(counter.min, event.value); counter.max = Math.max(counter.max, event.value);
      counters.set(event.name, counter);
    } else if (event.duration === -1) instants.set(event.name, (instants.get(event.name) ?? 0) + 1);
    else {
      if (event.name === 'display frame') continue;
      const key = spanKey(event);
      let list = spans.get(key);
      if (!list) { spans.set(key, list = []); threads.set(key, event.thread); }
      list.push(event.duration);
      if (event.duration <= floor) continue;
      top.push(event);
      if (top.length > slowest * 4) { top.sort((a, b) => b.duration - a.duration); top.length = slowest; floor = top.at(-1).duration; }
    }
  }
  const spanRows = [...spans].map(([name, durations]) => {
    const list = sorted(durations);
    let total = 0;
    for (const value of list) total += value;
    return {name, thread: threads.get(name), count: list.length, totalMs: round(total), p50: round(quantile(list, .5)), p95: round(quantile(list, .95)), worst: round(list.at(-1))};
  }).sort((a, b) => b.totalMs - a.totalMs);
  top.sort((a, b) => b.duration - a.duration);
  return {
    spans: spanRows,
    counters: Object.fromEntries([...counters].map(([name, c]) => [name, {last: round(c.last), min: round(c.min), max: round(c.max), samples: c.count}])),
    instants: Object.fromEntries(instants),
    slowest: top.slice(0, slowest).map(event => ({name: spanKey(event), thread: event.thread, ms: round(event.duration), at: round(event.start), args: event.args ?? undefined})),
  };
}

/**
 * The Chrome trace event format Perfetto opens (ui.perfetto.dev, chrome://tracing): complete events for spans, instant
 * events, counter tracks, and a name for each thread. Times are microseconds from `origin` (ms).
 */
export function perfettoTrace(events, {origin = 0, metadata = {}} = {}) {
  const threads = new Map(), traceEvents = [];
  const tid = name => { if (!threads.has(name)) threads.set(name, threads.size + 1); return threads.get(name); };
  const us = ms => Math.round((ms - origin) * 1000);
  tid('interface');
  for (const event of events) {
    const base = {name: event.name, pid: 1, tid: tid(event.thread), ts: us(event.start)};
    if (event.duration === -2) traceEvents.push({...base, ph: 'C', cat: 'counter', args: {value: event.value}});
    else if (event.duration === -1) traceEvents.push({...base, ph: 'i', s: 't', cat: 'instant', ...(event.args ? {args: event.args} : {})});
    else traceEvents.push({...base, ph: 'X', cat: event.thread, dur: Math.max(0, Math.round(event.duration * 1000)), ...(event.args ? {args: event.args} : {})});
  }
  traceEvents.push({name: 'process_name', ph: 'M', pid: 1, tid: 0, args: {name: 'StykAnimate (developer build)'}});
  for (const [name, id] of threads) traceEvents.push({name: 'thread_name', ph: 'M', pid: 1, tid: id, args: {name}});
  return {traceEvents, displayTimeUnit: 'ms', metadata: {producer: DEVELOPER, ...metadata}};
}
