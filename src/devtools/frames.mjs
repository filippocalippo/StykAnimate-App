/**
 * Reading the frame recorder (src/devtools/early.js `frames`): the display frames of a stretch of time, what the
 * interface thread spent on each by phase, and how long inputs waited for their frame. The performance panel, the
 * overlay, the control channel's captures and the profiling runner all read frames through here. Pure: no DOM.
 *
 * A frame's phases (milliseconds of the interface thread):
 *   handlers  input handlers that ran since the frame before (a drag's pointer moves, a wheel, a key);
 *   script    animation-frame callbacks: the app's paint of the scene and its pass of interface updates;
 *   render    the browser's own style, layout and paint after them, measured to the first task after the frame: an
 *             upper estimate, since a task that was already waiting lands in it;
 *   work      their sum: what the frame cost this thread. A frame is on time while it stays under the display's period.
 */
import {distribution, quantile, round, sorted} from './stats.mjs';

/** The phases of a frame, in the order they happen. */
export const PHASES = ['handlers', 'script', 'render'];

/**
 * The frames recorded since the recorder's count was `from` (frames.total then), oldest first, as parallel arrays:
 * {at, interval, handlers, script, render, dropped}. `dropped` counts frames the ring had already overwritten. The
 * newest frame is left out while its rendering is still being measured (`settled: false` keeps it).
 */
export function frameWindow(frames, from = 0, {settled = true} = {}) {
  const capacity = frames.intervals.length, oldest = Math.max(0, frames.total - capacity);
  const first = Math.max(from, oldest), last = frames.total - (settled && frames.total > first ? 1 : 0), count = Math.max(0, last - first);
  const window = {at: new Array(count), interval: new Array(count), handlers: new Array(count), script: new Array(count), render: new Array(count), dropped: Math.max(0, first - from)};
  for (let index = 0; index < count; index++) {
    const slot = (first + index) % capacity;
    window.at[index] = frames.at[slot]; window.interval[index] = frames.intervals[slot];
    window.handlers[index] = frames.handlers[slot]; window.script[index] = frames.script[slot]; window.render[index] = frames.render[slot];
  }
  return window;
}

/** The recorder's count of the first frame that began at or after `time` (performance.now ms): where a window of recent frames starts. */
export function frameCountAt(frames, time) {
  const capacity = frames.intervals.length;
  let first = frames.total;
  while (first > Math.max(0, frames.total - capacity) && frames.at[(first - 1) % capacity] >= time) first--;
  return first;
}

/** The recorder's input count of the first input at or after `time`. */
export function inputCountAt(frames, time) {
  const inputs = frames.inputs, capacity = inputs.latency.length;
  let first = inputs.total;
  while (first > Math.max(0, inputs.total - capacity) && inputs.at[(first - 1) % capacity] >= time) first--;
  return first;
}

/** Each input since the recorder's input count was `from`, oldest first: when it happened (`at`) and how long it waited for its frame (`latency`, ms). */
export function inputWindow(frames, from = 0) {
  const inputs = frames.inputs, capacity = inputs.latency.length, first = Math.max(from, inputs.total - capacity), latency = [], at = [];
  for (let index = first; index < inputs.total; index++) { latency.push(inputs.latency[index % capacity]); at.push(inputs.at[index % capacity]); }
  return {latency, at, dropped: Math.max(0, first - from)};
}

/**
 * The display's period (ms) as a run of frames shows it: their median interval, which is the period whenever more
 * than half of the frames were on time (two frames' callbacks jitter around it, one early and the next late). Null
 * without enough frames; a stretch where most frames were slow reads longer than the display's real period, so callers
 * measure it while the app rests and keep the shortest they have seen.
 */
export function displayPeriod(intervals) {
  const list = sorted(intervals);
  return list.length >= 8 ? quantile(list, .5) : null;
}

/**
 * The summary of a window of frames. `periodMs` is the display's period; a frame is late when it took over one and a
 * half periods. `seconds` (the window's duration) gives the rates.
 *
 *   frames   count, per second, and the intervals' p50, p95, p99 and worst; `felt`, the frame time a person sees
 *            (each frame weighted by how long it stayed on screen, so three freezes among a hundred smooth frames
 *            count for the time they took, which a percentile of the frame count hides); late frames and their
 *            share; frames over 16.7, 33.3 and 100 ms (under 60 and 30 frames a second, and a visible freeze);
 *   work     the interface thread's cost per frame: mean, p50, p95, worst, and the share of the period the p95 takes;
 *   phases   mean and p95 of each phase, and each phase's share of all the work.
 */
export function summarizeFrames(window, {periodMs = null, seconds = null} = {}) {
  const count = window.interval.length;
  const period = periodMs ?? displayPeriod(window.interval);
  const lateOver = period === null ? null : period * 1.5;
  const over = limit => window.interval.reduce((total, ms) => total + (ms > limit ? 1 : 0), 0);
  const work = window.interval.map((_, index) => window.handlers[index] + window.script[index] + window.render[index]);
  const totals = Object.fromEntries(PHASES.map(phase => [phase, window[phase].reduce((sum, ms) => sum + ms, 0)]));
  const allWork = PHASES.reduce((sum, phase) => sum + totals[phase], 0);
  const late = lateOver === null ? null : over(lateOver);
  const shown = window.interval.reduce((sum, ms) => sum + ms, 0), squares = window.interval.reduce((sum, ms) => sum + ms * ms, 0);
  const span = seconds ?? shown / 1000;
  const workStats = distribution(work);
  return {
    count, perSecond: span > 0 ? round(count / span, 1) : null, periodMs: round(period), ...pick(distribution(window.interval), ['p50', 'p95', 'p99', 'worst']),
    felt: shown > 0 ? round(squares / shown) : null,
    late, lateShare: count && late !== null ? round(late / count) : null, lateOverMs: round(lateOver),
    over16: over(1000 / 60 + .5), over33: over(1000 / 30 + .5), over100: over(100), dropped: window.dropped,
    work: {...pick(workStats, ['mean', 'p50', 'p95', 'worst']), budgetShare: period && workStats.p95 !== null ? round(workStats.p95 / period) : null},
    phases: Object.fromEntries(PHASES.map(phase => {
      const stats = distribution(window[phase]);
      return [phase, {mean: stats.mean, p95: stats.p95, worst: stats.worst, share: allWork > 0 ? round(totals[phase] / allWork) : null}];
    })),
  };
}

/** The input latency of a window: count, p50, p95 and worst (ms from the input to the end of the frame that followed its handler). */
export function summarizeInputs(window) {
  return {...pick(distribution(window.latency), ['count', 'p50', 'p95', 'worst']), dropped: window.dropped};
}

/**
 * A window's frames as compact series for a chart, at most `limit` points: each point is the worst of its bucket, so
 * a single slow frame never disappears. {interval, handlers, script, render} in tenths of a millisecond precision;
 * `indices: true` adds `index`, each point's frame in the window (a chart that shows the frame under the pointer).
 * The buckets end at the newest frame, so a live chart's columns keep their frames while new ones arrive.
 */
export function frameSeries(window, limit = 600, {indices = false} = {}) {
  const count = window.interval.length, bucket = Math.max(1, Math.ceil(count / limit)), series = {bucket, interval: [], handlers: [], script: [], render: []};
  if (indices) series.index = [];
  for (let start = count - Math.ceil(count / bucket) * bucket; start < count; start += bucket) {
    let worst = Math.max(0, start);
    for (let index = worst + 1; index < start + bucket; index++) if (window.interval[index] > window.interval[worst]) worst = index;
    for (const key of ['interval', ...PHASES]) series[key].push(round(window[key][worst], 1));
    series.index?.push(worst);
  }
  return series;
}

/**
 * When the frame `index` of a window did its work on the interface thread (performance.now ms): from the frame before
 * (its input handlers ran since then) to the end of its own rendering. The spans that began in it are that frame's.
 */
export function frameBounds(window, index) {
  const at = window.at[index];
  return {from: at - window.interval[index], to: at + window.script[index] + window.render[index]};
}

const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
