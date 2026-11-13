/**
 * The one copy of the statistics every measurement here uses: the panels, the control channel's summaries and the
 * profiling runner (perf/) import it, so a p95 means the same thing wherever it is printed. Pure: no DOM, no Node.
 */

/** Rounds to `digits` decimals; null for a value that is not a finite number. */
export const round = (value, digits = 3) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

/**
 * The finite numbers of `values`, ascending, as a new Float64Array: a typed array sorts natively, several times faster
 * than a comparator, which the live panels pay for four times a second over thousands of spans.
 */
export function sorted(values) {
  const list = new Float64Array(values.length ?? 0);
  let count = 0;
  for (const value of values) if (Number.isFinite(value)) list[count++] = value;
  return list.subarray(0, count).sort();
}

/** The nearest-rank quantile `q` (0 to 1) of an ascending list: the smallest value with at least `q` of the list at or below it. */
export const quantile = (ascending, q) => (ascending.length ? ascending[Math.min(ascending.length - 1, Math.max(0, Math.ceil(q * ascending.length) - 1))] : null);

/** The median of any list of numbers (the mean of the two middle values of an even count); null when it has none. */
export function median(values) {
  const list = sorted(values);
  if (!list.length) return null;
  const middle = list.length >> 1;
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** Count, mean, p50, p95, p99 and worst of a list of numbers, rounded. */
export function distribution(values, digits = 3) {
  const list = sorted(values);
  if (!list.length) return {count: 0, mean: null, p50: null, p95: null, p99: null, worst: null};
  let total = 0;
  for (const value of list) total += value;
  return {count: list.length, mean: round(total / list.length, digits), p50: round(quantile(list, .5), digits), p95: round(quantile(list, .95), digits),
    p99: round(quantile(list, .99), digits), worst: round(list.at(-1), digits)};
}

/**
 * How far repeated measurements of one thing spread: the median and the median absolute deviation from it (a spread
 * one stray run does not move), with the least and the most.
 */
export function spread(values, digits = 3) {
  const list = sorted(values);
  if (!list.length) return {n: 0, median: null, mad: null, min: null, max: null};
  const centre = median(list);
  return {n: list.length, median: round(centre, digits), mad: round(median(list.map(value => Math.abs(value - centre))), digits), min: round(list[0], digits), max: round(list.at(-1), digits)};
}
