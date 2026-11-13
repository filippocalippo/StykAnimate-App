/**
 * Two runs side by side (docs/PERFORMANCE.md "Comparing two runs"): for every scenario both measured on the same
 * environment and workload, whether each metric got better, worse, or moved no more than the runs' own noise.
 *
 * A difference counts only when it is larger than what repeating a run moves by itself: twice the wider of the two
 * runs' spreads between passes, and never less than five percent of the value or the metric's smallest step that
 * matters. So a comparison of a run with itself says "same" everywhere, and a claim of "faster" has that behind it.
 *
 * `compareEngine` applies the same rule to two engine runs (perf/engine/README.md): every metric of every benchmark both
 * measured on the same workload, and the capacity figures of their scaling runs.
 */
import {format, METRICS} from './metrics.mjs';

/**
 * The least difference that counts for a unit, whatever the spread: timers and frames do not resolve less. A metric's
 * definition may name its own `floor` where it resolves finer (the engine tier times calls in Node to the microsecond).
 */
const FLOOR = {ms: .3, '%': 1, fps: 1, '/s': 1, MB: 5, '': 0};
/** The metrics a comparison prints unless asked for all: what a person feels, and what explains it. */
const HEADLINE = ['duration', 'frame.felt', 'work.p95', 'input.p95'];

/** How one metric changed between its two spreads ({median, mad, min, max, n}). */
export function change(base, head, definition = {unit: '', better: 'lower'}) {
  if (!Number.isFinite(base?.median) || !Number.isFinite(head?.median)) return null;
  const difference = head.median - base.median;
  const noise = Math.max((base.max - base.min) / 2, (head.max - head.min) / 2, base.mad ?? 0, head.mad ?? 0);
  const threshold = Math.max(2 * noise, Math.abs(base.median) * .05, definition.floor ?? FLOOR[definition.unit] ?? 0);
  const better = definition.better === 'higher' ? difference > 0 : difference < 0;
  return {base: base.median, head: head.median, difference, ratio: base.median ? difference / Math.abs(base.median) : null, threshold,
    verdict: Math.abs(difference) <= threshold ? 'same' : better ? 'better' : 'worse'};
}

/**
 * Every scenario of `base` and `head` on a pair both have: {rows: [{environment, workload, scenario, title, metric,
 * judged, ...change}], counts: {better, worse, same}, missing: [what only one run has]}. `all` compares every metric.
 */
export function compare(base, head, {all = false} = {}) {
  const key = (pair, scenario) => `${pair.environment.id}/${pair.workload.id}/${scenario.id}`;
  const before = new Map();
  for (const pair of base.pairs) for (const scenario of pair.scenarios) before.set(key(pair, scenario), scenario);
  const rows = [], missing = [], seen = new Set();
  for (const pair of head.pairs) {
    for (const scenario of pair.scenarios) {
      const id = key(pair, scenario), was = before.get(id);
      seen.add(id);
      if (!was) { missing.push(`${id}: only in ${head.label}`); continue; }
      if (scenario.error || was.error || scenario.skipped || was.skipped) { if (scenario.error || was.error) missing.push(`${id}: ${scenario.error ? `failed in ${head.label}` : `failed in ${base.label}`}`); continue; }
      const definitions = {...METRICS, ...was.definitions, ...scenario.definitions};
      const judgedOn = (scenario.judged?.criteria ?? []).map(row => row.metric);
      const metrics = all ? Object.keys(scenario.metrics) : [...new Set([...judgedOn, ...HEADLINE])];
      for (const metric of metrics) {
        const changed = change(was.metrics[metric], scenario.metrics[metric], definitions[metric]);
        if (changed) rows.push({environment: pair.environment.id, workload: pair.workload.id, scenario: scenario.id, title: scenario.title, metric, judged: judgedOn.includes(metric), definitions, ...changed});
      }
    }
  }
  for (const id of before.keys()) if (!seen.has(id)) missing.push(`${id}: only in ${base.label}`);
  return {base: base.label, head: head.label, rows, counts: tally(rows), missing};
}

/** How many rows got better, worse, or stayed within noise. */
function tally(rows) {
  const counts = {better: 0, worse: 0, same: 0};
  for (const row of rows) counts[row.verdict]++;
  return counts;
}

/**
 * Two engine runs (schema styk-perf-engine/1): every metric of every benchmark both measured on the same workload, then
 * the capacity figures of both scaling runs. The rows and the text are those of `compare`, the environment being the one
 * thread the engine tier runs on. A benchmark that failed in either run is listed, not compared.
 */
export function compareEngine(base, head) {
  const key = (workload, benchmark) => `${workload.id}/${benchmark.id}`;
  const before = new Map();
  for (const workload of base.workloads) for (const benchmark of workload.benchmarks) before.set(key(workload, benchmark), benchmark);
  const rows = [], missing = [], seen = new Set();
  const add = (workload, benchmark, title, metric, was, now, definitions) => {
    const changed = change(was, now, definitions[metric]);
    if (changed) rows.push({environment: 'engine', workload, scenario: benchmark, title, metric, judged: false, definitions, ...changed});
  };
  for (const workload of head.workloads) {
    for (const benchmark of workload.benchmarks) {
      const id = key(workload, benchmark), was = before.get(id);
      seen.add(id);
      if (!was) { missing.push(`${id}: only in ${head.label}`); continue; }
      if (benchmark.error || was.error) { missing.push(`${id}: failed in ${benchmark.error ? head.label : base.label}`); continue; }
      const definitions = {...was.definitions, ...benchmark.definitions};
      for (const metric of Object.keys(benchmark.metrics)) add(workload.id, benchmark.id, benchmark.title, metric, was.metrics[metric], benchmark.metrics[metric], definitions);
    }
  }
  for (const id of before.keys()) if (!seen.has(id)) missing.push(`${id}: only in ${base.label}`);
  // A capacity is compared where both runs found it inside the sizes they measured.
  const capacities = new Map((base.scaling?.capacity ?? []).map(row => [row.id, row]));
  for (const row of head.scaling?.capacity ?? []) {
    const was = capacities.get(row.id);
    if (!was) continue;
    if (!was.segments || !row.segments) { missing.push(`capacity ${row.id}: outside the sizes measured in ${was.segments ? head.label : base.label}`); continue; }
    add('scaling', 'capacity', row.title, row.id, was.segments, row.segments, {[row.id]: {title: row.title, unit: 'segments', better: 'higher', digits: 0}});
  }
  return {base: base.label, head: head.label, rows, counts: tally(rows), missing};
}

/** A comparison as text: what changed first, then a line for everything that did not. */
export function comparisonText(result, {all = false} = {}) {
  const lines = [`${result.base} → ${result.head}: ${result.counts.better} better, ${result.counts.worse} worse, ${result.counts.same} within noise`, ...(result.notes ?? []), ''];
  const line = row => `  ${`${row.environment}/${row.workload}`.padEnd(18)} ${row.scenario.padEnd(22)} ${((row.definitions[row.metric]?.title ?? row.metric).slice(0, 40)).padEnd(40)} `
    + `${format(row.metric, row.base, row.definitions).padStart(10)} → ${format(row.metric, row.head, row.definitions).padEnd(10)} ${row.ratio === null ? '' : `${row.ratio > 0 ? '+' : ''}${(row.ratio * 100).toFixed(0)}%`.padStart(6)}`;
  for (const [verdict, heading] of [['worse', 'WORSE'], ['better', 'BETTER']]) {
    const rows = result.rows.filter(row => row.verdict === verdict).sort((a, b) => Math.abs(b.ratio ?? 0) - Math.abs(a.ratio ?? 0));
    if (rows.length) lines.push(`${heading} (more than the runs' own noise):`, ...rows.map(line), '');
  }
  if (all) lines.push('WITHIN NOISE:', ...result.rows.filter(row => row.verdict === 'same').map(line), '');
  if (result.missing.length) lines.push('Not compared:', ...result.missing.map(text => `  ${text}`), '');
  return `${lines.join('\n')}\n`;
}
