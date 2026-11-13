/**
 * What the report page shows, computed from one or more runs (`npm run perf -- report`, perf/report/build.mjs).
 *
 * The page only draws: every fact it states is decided here, in Node, with the same helpers as the text summary and
 * `compare`, so a grade, a ranking or "worse" means the same thing on the page, in summary.txt and in a comparison.
 *
 *   pairs     every pair of environment and workload of every run, in the order the runs were named, each scenario
 *             with its `status` (its grade, or failed, skipped, ungraded) and `where` (summary.mjs `whereLine`);
 *   columns   one per environment and workload: the pair the page shows (`pair`, from the last run that has it) and,
 *             when an earlier run has it too, the baseline (`base`, from the first) with what changed (compare.mjs);
 *   rows      every scenario of the shown pairs, grouped by area, in the order the runs measured them;
 *   ranking   the scenarios that most need work, worst first;
 *   limits    every distinct criterion behind a grade (its metric's definition, its limits), with the scenarios judged on it.
 *
 * Nothing here knows a scenario, an environment or a metric by name: the page renders whatever a result holds.
 */
import {compare} from '../lib/compare.mjs';
import {GRADES, judge, METRICS} from '../lib/metrics.mjs';
import {BUSY_PERCENT} from '../lib/result.mjs';
import {whereLine} from '../lib/summary.mjs';

export const REPORT_SCHEMA = 'styk-perf-report/1';

/** A scenario's state on the page, worst first: the order of the ranking. `ungraded` measured but met no criterion. */
export const STATUSES = Object.freeze(['failed', ...[...GRADES].reverse(), 'ungraded', 'skipped']);
/** The states the ranking lists: everything that is not good. */
const NEEDS_WORK = new Set(['failed', ...GRADES.filter(grade => grade !== 'good')]);

/** The state of one scenario: a failure wins over a grade (a scenario can fail in its profiled pass after its timed ones). */
export const statusOf = scenario => (scenario.error ? 'failed' : scenario.skipped ? 'skipped' : scenario.grade ?? 'ungraded');

const definitionOf = (scenario, metric) => scenario.definitions?.[metric] ?? METRICS[metric];

/**
 * A scenario as the page reads it. A result recorded before the runner kept `judged` holds only the criteria it was
 * given (`judge`): it is judged again here by the runner's own function, so an older file still shows its numbers and
 * compares like a new one.
 */
function readable(scenario) {
  if (scenario.judged || !scenario.judge) return scenario;
  const judged = judge([scenario.judge].flat(), scenario.metrics ?? {}, scenario.definitions ?? {});
  return {...scenario, judged, grade: scenario.grade ?? judged.grade};
}

/**
 * How far a criterion's value is past its good limit: 1 at the limit, 2 at twice it, and for a metric that is better
 * higher the inverse (half the good rate is 2). It orders scenarios of the same grade: the further, the more work.
 */
export function excess({value, limits}, better = 'lower') {
  const good = limits?.[0];
  if (!Number.isFinite(value) || !(good > 0)) return 0;
  if (better === 'higher') return value > 0 ? good / value : Infinity;
  return value / good;
}

/** The scenarios of the shown pairs that are not good, worst state first, then furthest past their limit. */
export function ranking(pairs, columns) {
  const items = [];
  columns.forEach((column, index) => {
    for (const scenario of pairs[column.pair].scenarios) {
      if (!NEEDS_WORK.has(scenario.status)) continue;
      const decided = scenario.judged?.criteria?.find(row => row.metric === scenario.judged.decided) ?? null;
      const better = definitionOf(scenario, decided?.metric)?.better ?? 'lower';
      items.push({column: index, scenario: scenario.id, status: scenario.status, metric: decided?.metric ?? null, value: decided?.value ?? null, limits: decided?.limits ?? null,
        better, excess: decided ? excess(decided, better) : 0, where: scenario.where, error: scenario.error ?? null});
    }
  });
  return items.sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || b.excess - a.excess);
}

/**
 * Pairs of the runs merged into columns, one per environment and workload in the order first seen. The page shows the
 * last run's pair; with an earlier run of the same pair, the first named is the baseline and `changes` holds, per
 * scenario, compare.mjs's rows for this pair (`verdicts`: the judged metrics' verdict, worse before better).
 */
function columnsOf(runs, pairs) {
  const columns = new Map();
  pairs.forEach((pair, index) => {
    const key = `${pair.environment.id}/${pair.workload.id}`;
    const column = columns.get(key) ?? {key, environment: pair.environment, workload: pair.workload, pairs: []};
    column.pairs.push(index);
    columns.set(key, column);
  });
  const comparisons = new Map();
  return [...columns.values()].map(column => {
    const pair = column.pairs.at(-1), base = column.pairs.length > 1 ? column.pairs[0] : null;
    const shaped = {...column, pair, base, changes: null, verdicts: null, missing: []};
    if (base === null) return shaped;
    // One comparison per two runs, whatever the number of pairs they share.
    const runsKey = `${pairs[base].run}>${pairs[pair].run}`;
    if (!comparisons.has(runsKey)) comparisons.set(runsKey, compare(runs[pairs[base].run], runs[pairs[pair].run]));
    const compared = comparisons.get(runsKey);
    shaped.changes = {};
    shaped.verdicts = {};
    for (const {environment, workload, scenario, title: _title, definitions: _definitions, ...row} of compared.rows) {
      if (environment !== column.environment.id || workload !== column.workload.id) continue;
      (shaped.changes[scenario] ??= []).push(row);
      if (!row.judged) continue;
      const was = shaped.verdicts[scenario];
      if (row.verdict === 'worse' || (row.verdict === 'better' && was !== 'worse') || !was) shaped.verdicts[scenario] = row.verdict;
    }
    shaped.missing = compared.missing.filter(text => text.startsWith(`${column.key}/`)).map(text => text.slice(column.key.length + 1));
    return shaped;
  });
}

/** Every scenario of the shown pairs, grouped by area: areas, then their scenarios, in the order first measured. */
function rowsOf(pairs, columns) {
  const areas = new Map();
  for (const column of columns) {
    for (const scenario of pairs[column.pair].scenarios) {
      const area = areas.get(scenario.area) ?? new Map();
      if (!area.has(scenario.id)) area.set(scenario.id, {id: scenario.id, area: scenario.area, title: scenario.title, kind: scenario.kind, description: scenario.description});
      areas.set(scenario.area, area);
    }
  }
  return [...areas.values()].flatMap(area => [...area.values()]);
}

/** Every distinct criterion of the shown pairs (metric, limits, direction) with the scenarios graded on it. */
function limitsOf(pairs, columns) {
  const limits = new Map();
  for (const column of columns) {
    for (const scenario of pairs[column.pair].scenarios) {
      for (const row of scenario.judged?.criteria ?? []) {
        const key = `${row.metric}|${row.limits.join(',')}`;
        const entry = limits.get(key) ?? {metric: row.metric, definition: definitionOf(scenario, row.metric) ?? {title: row.metric, unit: '', better: 'lower'}, limits: row.limits, scenarios: []};
        if (!entry.scenarios.includes(scenario.id)) entry.scenarios.push(scenario.id);
        limits.set(key, entry);
      }
    }
  }
  return [...limits.values()];
}

/**
 * The page's data from `runs` (results as `read` returns them, in the order named: the first is the baseline of a pair
 * a later run measured again). A run's folder is left out: it is a path on this machine and the page is meant to be shared.
 */
export function reportModel(results, {generated = new Date().toISOString()} = {}) {
  const runs = results.map(run => ({...run, pairs: run.pairs.map(pair => ({...pair, scenarios: pair.scenarios.map(readable)}))}));
  const pairs = runs.flatMap((run, index) => run.pairs.map(pair => ({run: index, ...pair, busy: (pair.facts?.backgroundLoadPercent ?? 0) > BUSY_PERCENT,
    scenarios: pair.scenarios.map(scenario => ({...scenario, status: statusOf(scenario), where: whereLine(scenario)}))})));
  const columns = columnsOf(runs, pairs);
  return {
    schema: REPORT_SCHEMA, generated,
    runs: runs.map(({pairs: list, folder: _folder, ...run}) => ({...run, pairCount: list.length})),
    pairs, columns, rows: rowsOf(pairs, columns), ranking: ranking(pairs, columns), limits: limitsOf(pairs, columns),
    statuses: STATUSES, busyPercent: BUSY_PERCENT,
  };
}
