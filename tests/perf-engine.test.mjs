// The engine tier's pure parts (perf/engine/README.md): how a scaling run's costs are fitted and where they cross a frame's
// time, how an engine run reads as text, how two engine runs compare, where their results are kept, and that every benchmark
// has what the runner and the reports need. The benchmarks themselves are verified by running them
// (`npm run perf -- engine`, `npm run perf -- engine --scale`).
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {BENCHMARKS, COMMON_METRICS, SCALING_BENCHMARKS, select} from '../perf/engine/benchmarks.mjs';
import {CAPACITY, crossing, growth, line, LIMITS, scaling, SIZES} from '../perf/engine/scaling.mjs';
import {atSpeed, machineSpeed, reference} from '../perf/engine/speed.mjs';
import {capacityLines, engineOverview} from '../perf/engine/summary.mjs';
import {change, compareEngine, comparisonText} from '../perf/lib/compare.mjs';
import {ENGINE_RUNS, ENGINE_SCHEMA, read, SCHEMA, write} from '../perf/lib/result.mjs';
import {spread} from '../src/devtools/stats.mjs';

/** A cost of `perThousand` ms per thousand segments over `fixed` ms, with each round `wobble` apart. */
const cost = (segments, perThousand, fixed = 0, wobble = 0) => [-2, -1, 0, 1, 2].map(step => fixed + segments / 1000 * perThousand + step * wobble);

/** A scaling size as an engine run keeps it: the frame and pose benchmarks' rounds at `segments`. */
function size(segments, {between = .4, cold = .6, step = .05} = {}) {
  const benchmark = (id, metrics) => ({id, layer: '', title: id, error: null, headline: Object.keys(metrics), definitions: {},
    rounds: metrics, metrics: Object.fromEntries(Object.entries(metrics).map(([key, values]) => [key, spread(values)]))});
  return {id: `scale-${segments}`, segmentsPerFrame: segments, figures: segments / 50, frames: 41, scaling: true, benchmarks: [
    benchmark('frame', {cold: cost(segments, cold, .2, .01), key: cost(segments, .3), between: cost(segments, between, .1, .01)}),
    benchmark('edit.pose', {step: cost(segments, step), 'step.whole': cost(segments, step * 1.5, .3, .005)})]};
}

const DEFINITIONS = Object.fromEntries(SCALING_BENCHMARKS.map(benchmark => [benchmark.id, benchmark.metrics]));

test('a scaling run\'s cost is fitted to a line in milliseconds per thousand segments, and its exponent says whether it is linear', () => {
  const straight = line([1, 2, 3, 4], [3, 5, 7, 9]);
  assert.deepEqual(straight, {slope: 2, intercept: 1, r2: 1});
  const linear = growth(SIZES.map(segments => ({segments, value: 2 + segments / 1000 * .5})));
  assert.equal(linear.slope, .5);
  assert.equal(linear.intercept, 2);
  assert.equal(linear.r2, 1);
  assert.equal(linear.verdict, 'linear', 'a fixed cost under the line does not make it look sublinear above 10,000 segments');
  assert.equal(growth(SIZES.map(segments => ({segments, value: (segments / 1000) ** 2}))).verdict, 'superlinear');
  assert.equal(growth(SIZES.map(segments => ({segments, value: Math.sqrt(segments)}))).verdict, 'sublinear');
  assert.equal(growth([{segments: 1000, value: 1}]), null, 'one size fits nothing');
});

test('a limit is crossed between the two measured sizes around it, or said to lie outside them', () => {
  const points = [{segments: 1000, value: 1}, {segments: 10000, value: 10}, {segments: 30000, value: 30}];
  assert.deepEqual(crossing(points, 20), {segments: 20000, bound: 'within'});
  assert.deepEqual(crossing(points, 50), {segments: null, bound: 'above'});
  assert.deepEqual(crossing(points, .5), {segments: null, bound: 'below'});
  assert.deepEqual(crossing([...points].reverse(), 20), {segments: 20000, bound: 'within'}, 'the order the sizes come in does not matter');
});

test('the capacity of one thread is where a cost reaches a frame\'s time, with the spread of the rounds\' own crossings', () => {
  const result = scaling(SIZES.map(segments => size(segments)), DEFINITIONS);
  assert.deepEqual(result.sizes, SIZES);
  const between = result.rows.find(row => row.benchmark === 'frame' && row.metric === 'between');
  assert.equal(between.growth.verdict, 'linear');
  assert.equal(between.points.length, SIZES.length);
  // .1 + .4 ms per thousand segments reaches 16.67 ms at 41,417 segments and 33.33 ms at 83,083.
  assert.ok(Math.abs(between.crossings[0].segments - 41417) <= 1, JSON.stringify(between.crossings));
  assert.ok(Math.abs(between.crossings[1].segments - 83083) <= 1);
  assert.deepEqual(result.capacity.map(row => row.id), CAPACITY.flatMap(wanted => LIMITS.map(({rate}) => `${wanted.benchmark}.${wanted.metric}@${rate}`)));
  const headline = result.capacity[0];
  assert.equal(headline.id, 'frame.between@60');
  assert.equal(headline.segments.median, between.crossings[0].segments, 'a capacity is the crossing the rows give');
  assert.ok(headline.segments.min < headline.segments.median && headline.segments.max > headline.segments.median, 'rounds that differ give it a spread');
  // The pose step never reaches a frame's time within the sizes measured: no figure, and the summary says so.
  const step = result.capacity.find(row => row.id === 'edit.pose.step.whole@60');
  assert.equal(step.bound, 'above');
  assert.equal(step.segments, null);
  assert.match(capacityLines(result).join('\n'), /a pose step runs .*beyond 200,000 segments \(the largest measured\)/);
});

/** An engine run of one workload with one benchmark whose metric `ms` came out as `values`, the machine's `references` taken before its rounds. */
function run(label, values, {error = null, capacity = null, references = null} = {}) {
  const definitions = {ms: {title: 'Engine open', unit: 'ms', better: 'lower', digits: 1, floor: .01}, ...COMMON_METRICS};
  return {schema: ENGINE_SCHEMA, label, rounds: values.length, seconds: 12, processorSeconds: 10, load: {beforePercent: 5, afterPercent: 6},
    build: {commit: 'abc1234', branch: 'perf/engine-tier', dirty: false, engine: {sha256: 'b96c05a6562c', profile: 'wasm'}},
    machine: {cpu: 'A processor', threads: 12, memoryGB: 64, node: 'v24.11.0'},
    workloads: [{id: 'small', figures: 12, segmentsPerFrame: 240, frames: 121, jsonMB: .13, memory: {openMB: .4}, seconds: 3, processorSeconds: 2.5, benchmarks: [
      {id: 'open', layer: 'open', title: 'Open the document', headline: ['ms'], definitions, error, rounds: {ms: values, 'memory.peak': values.map(() => 3)},
        ...(references ? {reference: references} : {}), metrics: error ? {} : {ms: spread(values), 'memory.peak': spread(values.map(() => 3))}}]}],
    scaling: capacity && {sizes: SIZES, rows: [], capacity: [{id: 'frame.between@60', title: 'a frame between keyframes is built within 16.7 ms (60 frames a second)', what: 'a frame between keyframes is built',
      rate: 60, limit: 16.67, bound: 'within', segments: capacity}]}};
}

test('an engine run compared with itself is the same everywhere, and a change beyond the rounds\' noise is named', () => {
  const base = run('base', [10, 10.2, 9.9, 10.1, 10], {capacity: {n: 5, median: 40000, mad: 500, min: 39000, max: 41000}});
  const same = compareEngine(base, base);
  assert.deepEqual(same.counts, {better: 0, worse: 0, same: 3});
  assert.deepEqual(same.missing, []);
  const slower = compareEngine(base, run('head', [12, 12.1, 11.9, 12.2, 12], {capacity: {n: 5, median: 30000, mad: 400, min: 29500, max: 30500}}));
  assert.deepEqual(slower.rows.filter(row => row.verdict === 'worse').map(row => `${row.workload}/${row.scenario} ${row.metric}`), ['small/open ms', 'scaling/capacity frame.between@60']);
  assert.match(comparisonText(slower), /WORSE[\s\S]*engine\/small\s+open/);
  const failed = compareEngine(base, run('head', [], {error: 'it broke'}));
  assert.deepEqual(failed.missing, ['small/open: failed in head']);
  assert.equal(failed.rows.length, 0);
});

test('two runs are counted at one machine speed: a machine slower before every round is not a slower engine', () => {
  const values = [10, 10.2, 9.9, 10.1, 10], references = [2, 2.04, 1.98, 2.02, 2];
  const base = run('base', values, {references}), slower = run('head', values.map(value => value * 1.3), {references: references.map(value => value * 1.3)});
  assert.equal(machineSpeed(base), 2);
  assert.equal(compareEngine(base, slower).counts.worse, 1, 'as measured, the busier machine looks like a slower engine');
  const speed = machineSpeed(base), counted = compareEngine(atSpeed(base, speed), atSpeed(slower, speed));
  assert.deepEqual(counted.counts, {better: 0, worse: 0, same: 2});
  assert.equal(atSpeed(slower, speed).workloads[0].benchmarks[0].metrics['memory.peak'].median, 3, 'sizes are not scaled');
  const regressed = run('head', values.map(value => value * 1.3), {references});
  assert.equal(compareEngine(atSpeed(base, speed), atSpeed(regressed, speed)).counts.worse, 1, 'a slower engine on the same machine still shows');
  assert.equal(atSpeed(run('old', values), speed).referenceMs, undefined, 'a run recorded without references is left as it was');
  assert.ok(reference() > 0, 'the reference work takes a time');
});

test('a metric\'s own floor replaces its unit\'s: an engine timing resolves a microsecond, not a frame', () => {
  const was = {median: .2, mad: .001, min: .199, max: .201}, now = {median: .26, mad: .001, min: .259, max: .261};
  assert.equal(change(was, now, {unit: 'ms', better: 'lower'}).verdict, 'same', 'the app\'s floor for milliseconds is .3 ms');
  assert.equal(change(was, now, {unit: 'ms', better: 'lower', floor: .01}).verdict, 'worse');
});

test('an engine run reads as one page: one thread said plainly, the capacity first, a line per benchmark', () => {
  const text = engineOverview(run('try', [10, 10.2, 9.9, 10.1, 10], {capacity: {n: 5, median: 41417, mad: 500, min: 40000, max: 42000}}));
  assert.match(text, /^StykAnimate engine run "try"/);
  assert.match(text, /ONE THREAD: the engine runs here in Node without its workers/);
  assert.ok(text.indexOf('CAPACITY') < text.indexOf('== small'), 'the capacity comes before the workloads');
  assert.match(text, /a frame between keyframes is built: within 16\.7 ms \(60 frames a second\) up to 41,417 segments/);
  assert.match(text, /open\s+open\s+10\.0 ms ±0\.1\s+peak 3\.0 MB/);
  assert.doesNotMatch(text, /busy with other work/, 'a quiet machine is not called busy');
  assert.match(engineOverview({...run('busy', [1]), load: {beforePercent: 70, afterPercent: 40}}), /busy with other work \(70% of its processor before the run, 40% after\)/);
  assert.match(engineOverview(run('broken', [], {error: 'it broke'})), /open\s+open\s+FAILED: it broke/);
});

test('an engine run is kept in a folder of its own and read back only as an engine run', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'styk-engine-run-'));
  try {
    const result = run('kept', [1, 2, 3]);
    write(result, engineOverview(result), folder);
    const back = read(folder, {root: ENGINE_RUNS, schema: ENGINE_SCHEMA});
    assert.equal(back.label, 'kept');
    assert.deepEqual(back.workloads, result.workloads);
    assert.throws(() => read(folder), new RegExp(`holds a ${ENGINE_SCHEMA} result; this tool reads ${SCHEMA}`));
    assert.throws(() => read('no-such-run', {root: ENGINE_RUNS, schema: ENGINE_SCHEMA}), /under artifacts\/perf\/engine\//);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});

test('every engine benchmark has what the runner and the reports need, and is chosen by id or layer', () => {
  assert.equal(new Set(BENCHMARKS.map(benchmark => benchmark.id)).size, BENCHMARKS.length);
  for (const benchmark of BENCHMARKS) {
    for (const key of ['id', 'layer', 'title', 'description']) assert.ok(benchmark[key], `${benchmark.id} has no ${key}`);
    assert.equal(typeof benchmark.run, 'function', `${benchmark.id} has no run`);
    for (const [key, metric] of Object.entries({...benchmark.metrics, ...COMMON_METRICS})) {
      assert.ok(metric.title && ['lower', 'higher'].includes(metric.better) && Number.isInteger(metric.digits) && typeof metric.unit === 'string', `${benchmark.id} ${key}`);
    }
    assert.ok(benchmark.headline.length && benchmark.headline.every(key => benchmark.metrics[key]), `${benchmark.id}: its headline names its own metrics`);
  }
  assert.ok(SCALING_BENCHMARKS.every(benchmark => BENCHMARKS.includes(benchmark) && Object.values(benchmark.metrics).some(metric => metric.scale)));
  for (const wanted of CAPACITY) assert.ok(SCALING_BENCHMARKS.find(benchmark => benchmark.id === wanted.benchmark)?.metrics[wanted.metric]?.scale, `${wanted.benchmark} ${wanted.metric} is scaled`);
  assert.deepEqual(select([]).map(benchmark => benchmark.id), BENCHMARKS.map(benchmark => benchmark.id));
  assert.deepEqual(select(['edit']).map(benchmark => benchmark.id), ['edit.pose', 'edit.move', 'edit.move-many']);
  assert.deepEqual(select(['files', 'frame']).map(benchmark => benchmark.id), ['frame', 'save', 'export']);
  assert.throws(() => select(['frames']), /No engine benchmark matches "frames"/);
});
