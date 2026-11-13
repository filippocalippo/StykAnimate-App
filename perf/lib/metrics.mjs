/**
 * The measurements a scenario reports, and how they are judged (docs/PERFORMANCE.md "Metrics and grades").
 *
 * A metric has a unit and a direction, so a comparison knows whether a change is an improvement, and every table
 * prints it the same way. A scenario is graded on one metric (its `judge`): the grade says how the scenario feels to a
 * person, in four steps, from limits that come from how people perceive delay, not from what the app does today.
 */
import {GESTURE, GRADES, LIMITS, grade, judgeValues} from '../../src/devtools/grades.mjs';
import {spread} from '../../src/devtools/stats.mjs';

// The limits of the grades and the grading live with the developer tools, whose Record summary grades in the page
// (perf/ is not served to it): one copy, re-exported here for every import of them from this module.
export {GRADES, LIMITS, grade};

/** key → {title, short, unit, better: 'lower' | 'higher', digits}. `short` is the name in a one-line summary. A scenario may add its own (`scenario.metrics`). */
export const METRICS = Object.freeze({
  'duration': {title: 'Time to finish', short: 'took', unit: 'ms', better: 'lower', digits: 0},
  'frame.felt': {title: 'Frame time as seen (weighted by time on screen)', short: 'frame seen', unit: 'ms', better: 'lower', digits: 1},
  'frame.p50': {title: 'Frame time, median', unit: 'ms', better: 'lower', digits: 1},
  'frame.p95': {title: 'Frame time, 95th percentile', unit: 'ms', better: 'lower', digits: 1},
  'frame.worst': {title: 'Longest frame', unit: 'ms', better: 'lower', digits: 0},
  'frames.late': {title: 'Late frames', unit: '%', better: 'lower', digits: 1},
  'frames.perSecond': {title: 'Display frames per second', unit: 'fps', better: 'higher', digits: 1},
  'work.mean': {title: 'Interface thread per frame, mean', unit: 'ms', better: 'lower', digits: 2},
  'work.p95': {title: 'Interface thread per frame, 95th percentile', unit: 'ms', better: 'lower', digits: 1},
  'work.handlers': {title: 'Input handlers per frame', unit: 'ms', better: 'lower', digits: 2},
  'work.script': {title: 'Animation-frame script per frame', unit: 'ms', better: 'lower', digits: 2},
  'work.render': {title: 'Browser style, layout and paint per frame', unit: 'ms', better: 'lower', digits: 2},
  'input.p50': {title: 'Input to frame, median', unit: 'ms', better: 'lower', digits: 1},
  'input.p95': {title: 'Input to frame, 95th percentile', short: 'input to frame', unit: 'ms', better: 'lower', digits: 1},
  'paints.perSecond': {title: 'Stage redraws per second', unit: '/s', better: 'higher', digits: 1},
  'longTasks.count': {title: 'Long tasks (over 50 ms)', unit: '', better: 'lower', digits: 0},
  'longTasks.longest': {title: 'Longest task', unit: 'ms', better: 'lower', digits: 0},
  'engine.calls': {title: 'Calls into the engine', unit: '', better: 'lower', digits: 0},
  'engine.ms': {title: 'Interface time inside the engine', unit: 'ms', better: 'lower', digits: 1},
  'prepare.msPerFrame': {title: 'Engine threads per prepared frame', unit: 'ms', better: 'lower', digits: 2},
  'memory.total': {title: 'Memory of all processes', unit: 'MB', better: 'lower', digits: 0},
  'memory.page': {title: 'Memory of the page', unit: 'MB', better: 'lower', digits: 0},
  'memory.graphics': {title: 'Memory of the graphics process', unit: 'MB', better: 'lower', digits: 0},
  'memory.engine': {title: 'Engine memory in use', unit: 'MB', better: 'lower', digits: 0},
  'memory.jsHeap': {title: 'JavaScript heap', unit: 'MB', better: 'lower', digits: 0},
});

/**
 * The criteria a scenario of `kind` is judged on unless it names its own. A gesture is as good as the worse of two
 * things: how smooth it looks (the frame time a person sees) and how closely the picture follows the hand.
 */
export const defaultJudge = kind => (kind === 'gesture' ? [...GESTURE] : [{metric: 'duration', limits: LIMITS.response}]);

/**
 * Judges a scenario's aggregated `metrics` (their medians) on each of its `criteria` ({metric, limits}): the grade is
 * the worst criterion's, and `decided` names it (grades.mjs `judgeValues`). A criterion the scenario did not measure
 * (no input in playback) is left out.
 */
export function judge(criteria, metrics, definitions = {}) {
  const judged = judgeValues(criteria.map(({metric, limits}) => ({metric, limits, value: metrics[metric]?.median, better: (definitions[metric] ?? METRICS[metric])?.better})));
  return {...judged, decided: judged.decided ?? criteria[0]?.metric ?? null};
}

/** The metrics every capture gives (`summary` is the control channel's full capture summary), as plain numbers. */
export function captureMetrics(summary) {
  const {frames, inputs} = summary, seconds = summary.ms / 1000, values = {};
  const span = name => summary.spans.find(row => row.name === name);
  if (frames?.count) {
    Object.assign(values, {'frame.felt': frames.felt, 'frame.p50': frames.p50, 'frame.p95': frames.p95, 'frame.worst': frames.worst, 'frames.perSecond': frames.perSecond,
      'work.mean': frames.work.mean, 'work.p95': frames.work.p95, 'work.handlers': frames.phases.handlers.mean, 'work.script': frames.phases.script.mean, 'work.render': frames.phases.render.mean});
    if (frames.lateShare !== null) values['frames.late'] = frames.lateShare * 100;
  }
  if (inputs?.count) Object.assign(values, {'input.p50': inputs.p50, 'input.p95': inputs.p95});
  if (seconds > 0) values['paints.perSecond'] = (span('paint')?.count ?? 0) / seconds;
  const longTasks = span('long task');
  values['longTasks.count'] = longTasks?.count ?? 0;
  values['longTasks.longest'] = longTasks?.worst ?? 0;
  if (summary.boundary) {
    values['engine.calls'] = summary.boundary.reduce((total, row) => total + row.calls, 0);
    values['engine.ms'] = summary.boundary.reduce((total, row) => total + row.totalMs, 0);
  }
  if (summary.preparation?.msPerFrame !== null && summary.preparation?.msPerFrame !== undefined) values['prepare.msPerFrame'] = summary.preparation.msPerFrame;
  return values;
}

/** The passes' values of each metric as {median, mad, min, max, n}: what a result keeps. */
export function aggregate(passes) {
  const keys = new Set(passes.flatMap(pass => Object.keys(pass)));
  return Object.fromEntries([...keys].sort().map(key => [key, spread(passes.map(pass => pass[key]))]));
}

/** `value` of the metric `key` as text with its unit ("12.4 ms"); `definitions` adds a scenario's own metrics. */
export function format(key, value, definitions = {}) {
  const metric = definitions[key] ?? METRICS[key] ?? {unit: '', digits: 1};
  if (!Number.isFinite(value)) return '–';
  const digits = metric.digits ?? 1, text = Math.abs(value) >= 1000 && digits === 0 ? Math.round(value).toLocaleString('en') : value.toFixed(digits);
  return metric.unit ? `${text}${metric.unit === '%' ? '' : ' '}${metric.unit}` : text;
}
