/**
 * Reading the span ring (src/devtools/early.js): captures, Perfetto (Chrome trace) export and the statistics the profiler
 * panel, the control channel and the profiling command share. Developer build only.
 */
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

/** One capture at a time: `start()` marks the ring, `stop()` takes what was recorded since, with any samples taken meanwhile. */
export class Capture {
  constructor(ring) { this.ring = ring; this.running = null; this.last = null; }
  start(label = '') {
    if (this.running) throw new Error('A capture is already running: stop it first.');
    this.running = {label, from: this.ring.total, startedAt: performance.now(), startedTime: Date.now()};
    return {started: true, label};
  }
  stop() {
    const running = this.running;
    if (!running) throw new Error('No capture is running.');
    this.running = null;
    const {events, dropped} = ringEvents(this.ring, running.from);
    this.last = {label: running.label, startedAt: running.startedAt, startedTime: running.startedTime, stoppedAt: performance.now(), events, dropped};
    return this.last;
  }
}

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null;
const round = value => value === null || value === undefined ? null : Math.round(value * 1000) / 1000;

/** The name a span is grouped under: an edit session call is grouped by its method. */
export const spanKey = event => event.args?.method ? `${event.name} ${event.args.method}` : event.name;

/**
 * Statistics of a list of events: per span name the count, total, p50, p95 and worst (ms); per counter its last, least and
 * most; the slowest single spans; frame times and late frames (display frames longer than `lateMs`).
 */
export function summarize(events, {lateMs = 1000 / 60 * 1.5, slowest = 10} = {}) {
  const spans = new Map(), counters = new Map(), instants = new Map(), top = [];
  for (const event of events) {
    if (event.duration === -2) {
      const counter = counters.get(event.name) ?? {count: 0, last: 0, min: Infinity, max: -Infinity};
      counter.count++; counter.last = event.value; counter.min = Math.min(counter.min, event.value); counter.max = Math.max(counter.max, event.value);
      counters.set(event.name, counter);
    } else if (event.duration === -1) instants.set(event.name, (instants.get(event.name) ?? 0) + 1);
    else {
      const key = spanKey(event);
      const list = spans.get(key) ?? [];
      list.push(event.duration); spans.set(key, list);
      if (event.name !== 'display frame') {
        top.push(event);
        if (top.length > slowest * 4) { top.sort((a, b) => b.duration - a.duration); top.length = slowest; }
      }
    }
  }
  const spanRows = [...spans].map(([name, list]) => {
    list.sort((a, b) => a - b);
    const total = list.reduce((sum, value) => sum + value, 0);
    return {name, count: list.length, totalMs: round(total), p50: round(quantile(list, .5)), p95: round(quantile(list, .95)), worst: round(list.at(-1))};
  }).sort((a, b) => b.totalMs - a.totalMs);
  top.sort((a, b) => b.duration - a.duration);
  const frames = spans.get('display frame') ?? [];
  return {
    spans: spanRows,
    counters: Object.fromEntries([...counters].map(([name, c]) => [name, {last: round(c.last), min: round(c.min), max: round(c.max), samples: c.count}])),
    instants: Object.fromEntries(instants),
    slowest: top.slice(0, slowest).map(event => ({name: spanKey(event), thread: event.thread, ms: round(event.duration), at: round(event.start), args: event.args ?? undefined})),
    frames: {count: frames.length, p50: round(quantile(frames, .5)), p95: round(quantile(frames, .95)), worst: round(frames.at(-1) ?? null),
      late: frames.filter(ms => ms > lateMs).length, lateMs: round(lateMs)},
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
