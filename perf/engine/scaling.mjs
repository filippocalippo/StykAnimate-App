/**
 * How an engine cost grows with the scene (perf/engine/README.md "Scaling"). A scaling run measures some benchmarks on
 * generated documents of 1,000 to 200,000 segments a frame; this fits each cost to a straight line (milliseconds per
 * thousand segments) and to a power (cost ∝ segments^exponent: 1 is linear), and finds the size where it crosses the time
 * of one frame at 60 and at 30 frames a second: the capacity of one thread. Pure: no engine, no files.
 */
import {round, spread} from '../../src/devtools/stats.mjs';

/** The scene sizes of a scaling run, in segments a frame: closer together where the frame limits are usually crossed. */
export const SIZES = Object.freeze([1000, 3000, 10000, 25000, 50000, 100000, 200000]);

/** One frame's time at 60 and at 30 frames a second. */
export const LIMITS = Object.freeze([{limit: 1000 / 60, rate: 60}, {limit: 1000 / 30, rate: 30}]);

/**
 * The costs whose capacity a scaling run reports, the first being the headline: a frame between keyframes is what playback
 * builds most, the first frame after a publication is what a seek right after an edit waits for, and a pose step is the
 * interface thread's share of a drag.
 */
export const CAPACITY = Object.freeze([
  {benchmark: 'frame', metric: 'between', what: 'a frame between keyframes is built'},
  {benchmark: 'frame', metric: 'cold', what: 'the first frame after a publication is built'},
  {benchmark: 'edit.pose', metric: 'step.whole', what: 'a pose step runs (the engine and the interface adopting its answer)'},
]);

/** Below this a cost is mostly fixed work (the calls, the bookkeeping), not the scene: the exponent is fitted on sizes from here up. */
const EXPONENT_FROM = 10000;

/** The least-squares line through `xs`, `ys`: {slope, intercept, r2} (r2: the share of the variation the line explains, 1 for a line). */
export function line(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let index = 0; index < n; index++) { const dx = xs[index] - mx, dy = ys[index] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const slope = sxx ? sxy / sxx : 0;
  return {slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : 1};
}

/**
 * How `points` ({segments, value}) grow: the straight line's slope (value per thousand segments) and intercept, how well
 * it fits, and the exponent of the power that fits the sizes from 10,000 up with its verdict (`linear` from 0.85 to 1.15).
 * Null with fewer than two usable points.
 */
export function growth(points) {
  const usable = points.filter(point => Number.isFinite(point.value) && point.segments > 0).sort((a, b) => a.segments - b.segments);
  if (usable.length < 2) return null;
  const straight = line(usable.map(point => point.segments / 1000), usable.map(point => point.value));
  const large = usable.filter(point => point.segments >= EXPONENT_FROM && point.value > 0);
  const exponent = large.length >= 2 ? line(large.map(point => Math.log(point.segments)), large.map(point => Math.log(point.value))).slope : null;
  return {slope: round(straight.slope, 4), intercept: round(straight.intercept, 3), r2: round(straight.r2, 3), exponent: round(exponent, 2),
    verdict: exponent === null ? null : exponent < .85 ? 'sublinear' : exponent > 1.15 ? 'superlinear' : 'linear'};
}

/**
 * The size at which `points` ({segments, value}) reach `limit`, read on the straight line between the two measured sizes
 * around it: {segments, bound}. `bound` is `within` when the limit falls inside the sizes measured, `below` when even the
 * smallest is over it and `above` when even the largest is under it (`segments` null for both).
 */
export function crossing(points, limit) {
  const usable = points.filter(point => Number.isFinite(point.value)).sort((a, b) => a.segments - b.segments);
  if (!usable.length) return {segments: null, bound: null};
  if (usable[0].value > limit) return {segments: null, bound: 'below'};
  for (let index = 1; index < usable.length; index++) {
    const low = usable[index - 1], high = usable[index];
    if (high.value > limit) return {segments: Math.round(low.segments + (limit - low.value) * (high.segments - low.segments) / (high.value - low.value)), bound: 'within'};
  }
  return {segments: null, bound: 'above'};
}

/**
 * The scaling of `workloads` (the sizes of a scaling run, each with its benchmarks' metrics and rounds) for the metrics
 * `definitions` ({benchmark: {metric: definition}}) marks `scale`: per metric the median at each size with its growth and
 * crossings, then the capacities (`CAPACITY` at each limit). A capacity's `segments` is a spread: its median is the crossing
 * of the medians (the number the rows give), its deviation and range those of the crossings of each round's values (round n
 * at every size), which is what a comparison of two runs weighs a change against.
 */
export function scaling(workloads, definitions) {
  const sizes = workloads.map(workload => workload.segmentsPerFrame);
  const series = (benchmark, metric) => workloads.map(workload => {
    const found = workload.benchmarks.find(row => row.id === benchmark && !row.error);
    return {segments: workload.segmentsPerFrame, value: found?.metrics[metric]?.median ?? null, mad: found?.metrics[metric]?.mad ?? null, rounds: found?.rounds?.[metric] ?? []};
  });
  const rows = [];
  for (const [benchmark, metrics] of Object.entries(definitions)) {
    for (const [metric, definition] of Object.entries(metrics)) {
      if (!definition.scale) continue;
      const points = series(benchmark, metric);
      rows.push({benchmark, metric, title: definition.title, unit: definition.unit, points: points.map(({segments, value, mad}) => ({segments, median: value, mad})),
        growth: growth(points), crossings: LIMITS.map(({limit, rate}) => ({limit: round(limit, 2), rate, ...crossing(points, limit)}))});
    }
  }
  const capacity = [];
  for (const wanted of CAPACITY) {
    const points = series(wanted.benchmark, wanted.metric);
    if (points.every(point => point.value === null)) continue;
    const rounds = Math.min(...points.map(point => point.rounds.length));
    for (const {limit, rate} of LIMITS) {
      const found = crossing(points, limit);
      const each = Array.from({length: rounds}, (_, index) => crossing(points.map(point => ({segments: point.segments, value: point.rounds[index]})), limit)).filter(row => row.bound === 'within');
      const spreadOfRounds = spread(each.map(row => row.segments), 0);
      capacity.push({id: `${wanted.benchmark}.${wanted.metric}@${rate}`, benchmark: wanted.benchmark, metric: wanted.metric, rate, limit: round(limit, 2),
        title: `${wanted.what} within ${round(limit, 1)} ms (${rate} frames a second)`, what: wanted.what, bound: found.bound,
        segments: found.bound === 'within' ? {...spreadOfRounds, median: found.segments, min: Math.min(found.segments, spreadOfRounds.min ?? found.segments), max: Math.max(found.segments, spreadOfRounds.max ?? found.segments)} : null});
    }
  }
  return {sizes, rows, capacity};
}
