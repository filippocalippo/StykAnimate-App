/**
 * How a measurement is judged: the limits of the four grades and the grading itself (docs/PERFORMANCE.md "Metrics and
 * grades"). The one copy: the profiling runner (perf/lib/metrics.mjs re-exports these) and the developer tools'
 * Record summary both grade here, so a gesture recorded in the panel and the same gesture in a run get the same word.
 * Pure: no DOM, no Node.
 */

/**
 * Limits of the grades, as [good, fair, poor]: at or under the first is good, the second fair, the third poor, beyond
 * it bad (for a `higher` metric: at or over).
 *   frame       a frame of a continuous gesture: 60 a second is smooth, 30 is usable, under 10 is a slideshow;
 *   response    the wait after one action (a click, a key, an undo): 100 ms feels instant, 1 s keeps the thought;
 *   input       how far the picture trails the hand in a drag: two frames at 60 Hz is tight, over 150 ms it swims.
 */
export const LIMITS = Object.freeze({frame: [1000 / 60 + .5, 1000 / 30 + .5, 100], response: [100, 300, 1000], input: [34, 67, 150]});
export const GRADES = ['good', 'fair', 'poor', 'bad'];

/** The grade of `value` against `limits` ([good, fair, poor]) for a metric that is better `lower` or `higher`. */
export function grade(value, limits, better = 'lower') {
  if (!Number.isFinite(value)) return null;
  const step = limits.findIndex(limit => (better === 'higher' ? value >= limit : value <= limit));
  return GRADES[step < 0 ? 3 : step];
}

/**
 * What a continuous gesture is judged on: how smooth it looks (the frame time a person sees) and how closely the
 * picture follows the hand (the input delay's p95). It is as good as the worse of the two.
 */
export const GESTURE = Object.freeze([{metric: 'frame.felt', limits: LIMITS.frame}, {metric: 'input.p95', limits: LIMITS.input}]);

/**
 * Judges measured values, `rows` being [{metric, limits, value, better}]: the grade is the worst row's and `decided`
 * names it. A row with nothing measured (no input while playing) is left out, and with none left the grade is null.
 * Returns {grade, decided, value, criteria: [{metric, limits, value, grade}]}.
 */
export function judgeValues(rows) {
  const criteria = rows.map(({metric, limits, value, better = 'lower'}) => ({metric, limits, value: value ?? null, grade: grade(value, limits, better)})).filter(row => row.grade !== null);
  const worst = criteria.reduce((found, row) => (!found || GRADES.indexOf(row.grade) > GRADES.indexOf(found.grade) ? row : found), null);
  return {grade: worst?.grade ?? null, decided: worst?.metric ?? null, value: worst?.value ?? null, criteria};
}

/**
 * One capture's summary (src/devtools/capture.mjs `analyze`) judged as a gesture: the runner's rule for a gesture
 * (perf/lib/metrics.mjs `defaultJudge`), applied to one stretch instead of the median of several passes.
 */
export const judgeCapture = summary => judgeValues([{...GESTURE[0], value: summary?.frames?.felt}, {...GESTURE[1], value: summary?.inputs?.p95}]);
