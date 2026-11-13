// The performance runner's pure parts (docs/PERFORMANCE.md): which layer a function belongs to, how a profile and a
// trace become an attribution, how metrics are graded and compared, how a latency is read out of a capture, and that the
// generated workloads are the same documents everywhere. The runner itself is verified by running it
// (`npm run perf -- run quick`), which needs a window.
import assert from 'node:assert/strict';
import test from 'node:test';
import {ENVIRONMENTS} from '../perf/environments.mjs';
import {processAttribution, profileAttribution, traceAttribution} from '../perf/lib/attribution.mjs';
import {change, compare} from '../perf/lib/compare.mjs';
import {paths} from '../perf/lib/input.mjs';
import {seekLatency, shownTicks} from '../perf/lib/latency.mjs';
import {displayName, layerOf, LAYERS, rustModule} from '../perf/lib/layers.mjs';
import {aggregate, captureMetrics, defaultJudge, format, grade, judge, LIMITS} from '../perf/lib/metrics.mjs';
import {SCENARIOS, select} from '../perf/scenarios/index.mjs';
import {CORE, launches, SUITES} from '../perf/suites.mjs';
import {document as build, measure, scaled, workload, WORKLOADS} from '../perf/workloads.mjs';

const wasm = functionName => ({functionName, url: 'styk-app://app/src/engine/pkg/styk_engine_bg.wasm'});
const script = (functionName, file) => ({functionName, url: `styk-app://app/src/${file}`, lineNumber: 9});

test('a function belongs to one layer: a JavaScript module by its path, an engine function by its crate, a parked thread to idle', () => {
  const layers = Object.fromEntries([
    [script('loop', 'app.mjs'), 'app'], [script('draw', 'layer-timeline.mjs'), 'timeline'], [script('getPivotHandles', 'canvas-interactions.mjs'), 'canvas'],
    [script('render', 'inspector-view.mjs'), 'inspector'], [script('place', 'shell/dock-host.mjs'), 'shell'], [script('patch', 'editor.mjs'), 'editor'],
    [script('drawEdit', 'engine/engine-stage.mjs'), 'engine-interface'], [script('getStringFromWasm0', 'engine/pkg/styk_engine.js'), 'binding'], [script('timed', 'devtools/early.js'), 'tools'],
    [script('stroke', 'drawing-controller.mjs'), 'drawing'], [script('run', 'export-flow.mjs'), 'export'], [script('other', 'something-new.mjs'), 'interface-other'],
    [wasm('styk_eval[30fd614d899501a1]::geometry::build_object'), 'engine-eval'], [wasm('<styk_edit[aaaaaaaaaaaaaaaa]::session::Session>::call'), 'engine-edit'],
    [wasm('<styk_alloc[a8028a0bce19ac18]::wasm::GrowAhead as core[8d8d0c3c88249b01]::alloc::global::GlobalAlloc>::alloc'), 'engine-memory'], [wasm('memcpy'), 'engine-memory'],
    [wasm('core[8d8d0c3c88249b01]::ptr::drop_glue::<styk_eval[30fd614d899501a1]::geometry::Scene>'), 'engine-eval'], [wasm('<alloc[eddc4579fb4d62d8]::raw_vec::RawVecInner>::finish_grow'), 'engine-std'],
    [wasm('serde_json[bbbbbbbbbbbbbbbb]::de::from_str'), 'engine-json'], [wasm('wgpu_core[cccccccccccccccc]::device::queue::write_buffer'), 'engine-render'], [wasm('wasm-to-js'), 'engine-binding'],
    [wasm('wasm-function[8586]'), 'engine-other'], [wasm('<std[ffc7df3265e32aa1]::sys::sync::condvar::futex::Condvar>::wait_timeout'), 'idle'],
    [{functionName: '(idle)', url: ''}, 'idle'], [{functionName: '(garbage collector)', url: ''}, 'browser-gc'], [{functionName: '(program)', url: ''}, 'browser-native'], [{functionName: 'drawImage', url: ''}, 'browser-builtin'],
  ].map(([frame, layer]) => [`${frame.functionName} ${frame.url.split('/').pop()}`, [layerOf(frame), layer]]));
  for (const [name, [actual, expected]] of Object.entries(layers)) assert.equal(actual, expected, name);
  // Every layer a function can land in has a title and a group for the tables.
  for (const [, [actual]] of Object.entries(layers)) assert.ok(LAYERS[actual]?.title && LAYERS[actual].group, actual);
  assert.equal(displayName('styk_eval[30fd614d899501a1]::geometry::build_object'), 'styk_eval::geometry::build_object');
  assert.equal(rustModule('<styk_eval[30fd614d899501a1]::drawlist::Ctx>::brush'), 'styk_eval::drawlist');
  assert.equal(rustModule('drawImage'), null);
});

test('a processor profile becomes time per layer, per engine module and per function with its callers, idle left out', () => {
  // root → loop (app) → build_object (engine); and (idle). Samples in microseconds.
  const profile = {
    nodes: [
      {id: 1, callFrame: {functionName: '(root)', url: ''}, children: [2, 4]},
      {id: 2, callFrame: script('loop', 'app.mjs'), children: [3]},
      {id: 3, callFrame: wasm('styk_eval[30fd614d899501a1]::geometry::build_object')},
      {id: 4, callFrame: {functionName: '(idle)', url: ''}},
    ],
    samples: [2, 3, 3, 4, 4, 4], timeDeltas: [1000, 2000, 3000, 4000, 4000, 2000],
  };
  const taken = profileAttribution(profile, 'interface');
  assert.deepEqual([taken.thread, taken.sampledMs, taken.busyMs], ['interface', 16, 6]);
  assert.deepEqual(taken.layers.map(row => [row.id, row.ms, row.group]), [['engine-eval', 5, 'engine'], ['app', 1, 'interface']]);
  assert.deepEqual(taken.modules, [{name: 'styk_eval::geometry', ms: 5}]);
  assert.deepEqual(taken.functions[0], {name: 'styk_eval::geometry::build_object', layer: 'engine-eval', where: 'src/engine/pkg/styk_engine_bg.wasm', selfMs: 5, callers: ['loop']});
  assert.equal(taken.functions[1].where, 'src/app.mjs:10');
});

test('the browser\'s trace becomes busy time per thread and what the interface thread and the graphics process did, each event counted for its own time', () => {
  const event = (pid, tid, name, ts, dur, tdur = dur) => ({ph: 'X', pid, tid, name, ts, dur, tdur});
  const events = [
    {ph: 'M', name: 'process_name', pid: 1, args: {name: 'Renderer'}}, {ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: {name: 'CrRendererMain'}},
    {ph: 'M', name: 'process_name', pid: 2, args: {name: 'GPU Process'}}, {ph: 'M', name: 'thread_name', pid: 2, tid: 1, args: {name: 'CrGpuMain'}},
    {ph: 'M', name: 'thread_name', pid: 2, tid: 2, args: {name: 'GpuVSyncThread'}}, {ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: {name: 'DedicatedWorker thread'}},
    // The interface thread: one 10 ms task holding 4 ms of script and 3 ms of paint (so 3 ms of its own), then a 2 ms style recalculation.
    event(1, 1, 'ThreadControllerImpl::RunTask', 0, 10000), event(1, 1, 'FunctionCall', 1000, 4000), event(1, 1, 'Paint', 6000, 3000), event(1, 1, 'UpdateLayoutTree', 20000, 2000),
    // The graphics process: 6 ms rasterizing the interface, 1 ms of the stage's commands; its vertical-sync thread only waits.
    event(2, 1, 'RasterDecoderImpl::DoRasterCHROMIUM', 0, 6000, 5000), event(2, 1, 'WebGPU', 7000, 1000), event(2, 2, 'ThreadControllerImpl::RunTask', 0, 30000, 10),
    event(1, 2, 'ThreadControllerImpl::RunTask', 0, 500),
  ];
  const taken = traceAttribution(events);
  assert.equal(taken.windowMs, 30);
  assert.deepEqual(taken.threads.map(row => [row.role, row.busyMs, row.cpuMs]), [['interface thread', 12, 12], ['graphics main', 7, 6], ['worker', .5, .5]]);
  assert.deepEqual(Object.fromEntries(taken.interface.map(row => [row.id, row.ms])), {script: 4, paint: 3, other: 3, style: 2});
  assert.deepEqual(Object.fromEntries(taken.graphics.map(row => [row.id, row.ms])), {interface: 6, stage: 1});
  assert.deepEqual([taken.counts.styleRecalculations, taken.counts.paints, taken.counts.interfaceRasters], [1, 1, 1]);
});

test('processor time by process is what each used between two reads, with the memory at the end', () => {
  const before = [{pid: 1, type: 'Tab', cpuSeconds: 1, privateBytes: 100}, {pid: 2, type: 'GPU', cpuSeconds: 2, privateBytes: 50}];
  const after = [{pid: 1, type: 'Tab', cpuSeconds: 1.5, privateBytes: 120}, {pid: 2, type: 'GPU', cpuSeconds: 2.1, privateBytes: 60}, {pid: 3, type: 'Utility', cpuSeconds: .01, privateBytes: 5}];
  assert.deepEqual(processAttribution(before, after).map(row => [row.type, row.cpuMs, row.privateBytes]), [['page', 500, 120], ['graphics', 100, 60], ['service', 10, 5]]);
});

test('a grade comes from fixed limits, in the metric\'s direction; a scenario is as good as its worst criterion', () => {
  assert.deepEqual([10, 17, 30, 90, 200].map(ms => grade(ms, LIMITS.frame)), ['good', 'good', 'fair', 'poor', 'bad']);
  assert.deepEqual([99, 90, 60, 10].map(percent => grade(percent, [97, 85, 50], 'higher')), ['good', 'fair', 'poor', 'bad']);
  assert.equal(grade(NaN, LIMITS.frame), null);
  // A smooth drag whose picture trails the hand is not good.
  const metrics = aggregate([{'frame.felt': 8, 'input.p95': 120}, {'frame.felt': 9, 'input.p95': 100}]);
  const judged = judge(defaultJudge('gesture'), metrics);
  assert.deepEqual([judged.grade, judged.decided, judged.value, judged.criteria.map(row => row.grade)], ['poor', 'input.p95', 110, ['good', 'poor']]);
  // Playback has no input: the criterion it did not measure is left out, not failed.
  assert.deepEqual(judge(defaultJudge('gesture'), aggregate([{'frame.felt': 40}])).criteria.map(row => row.metric), ['frame.felt']);
  assert.deepEqual(defaultJudge('operation').map(row => row.metric), ['duration']);
  assert.deepEqual([format('duration', 1234.4), format('frames.late', 3.21), format('frame.felt', NaN), format('x.y', 2, {'x.y': {unit: 'fps', digits: 0}})], ['1,234 ms', '3.2%', '–', '2 fps']);
});

test('a capture\'s summary becomes the metrics every scenario reports', () => {
  const summary = {ms: 2000, frames: {count: 100, felt: 12.5, p50: 7, p95: 20, worst: 90, perSecond: 50, lateShare: .05, work: {mean: 3, p95: 9}, phases: {handlers: {mean: 1}, script: {mean: 1.5}, render: {mean: .5}}},
    inputs: {count: 40, p50: 9, p95: 30}, spans: [{name: 'paint', count: 60}, {name: 'long task', count: 2, worst: 120}], boundary: [{calls: 10, totalMs: 4}, {calls: 5, totalMs: 1}], preparation: {frames: 8, msPerFrame: 2.5}};
  const values = captureMetrics(summary);
  assert.deepEqual([values['frame.felt'], values['frames.late'], values['work.script'], values['input.p95'], values['paints.perSecond'], values['longTasks.count'], values['longTasks.longest'], values['engine.calls'], values['engine.ms'], values['prepare.msPerFrame']],
    [12.5, 5, 1.5, 30, 30, 2, 120, 15, 5, 2.5]);
  // A capture without frames or inputs (an operation that finished within a frame) reports what it has.
  assert.deepEqual(Object.keys(captureMetrics({ms: 5, frames: {count: 0}, inputs: {count: 0}, spans: [], boundary: null, preparation: null})).sort(), ['longTasks.count', 'longTasks.longest', 'paints.perSecond']);
});

test('a change counts only beyond the runs\' own noise, and a run compared with itself is the same everywhere', () => {
  const spread = (median, min = median, max = median, mad = 0) => ({median, min, max, mad, n: 3});
  const ms = {unit: 'ms', better: 'lower'};
  assert.equal(change(spread(10), spread(10.2), ms).verdict, 'same', 'under five percent');
  assert.equal(change(spread(10), spread(12), ms).verdict, 'worse');
  assert.equal(change(spread(10), spread(8), ms).verdict, 'better');
  assert.equal(change(spread(10, 8, 14), spread(13, 12, 14), ms).verdict, 'same', 'inside twice the wider spread');
  assert.equal(change(spread(.2), spread(.4), ms).verdict, 'same', 'under what a timer resolves');
  assert.equal(change(spread(90), spread(99), {unit: '%', better: 'higher'}).verdict, 'better');
  assert.equal(change(spread(10), {median: null}, ms), null);
  const scenario = (id, felt) => ({id, title: id, metrics: aggregate([{'frame.felt': felt, duration: 5}]), definitions: {}, judged: {criteria: [{metric: 'frame.felt'}]}});
  const run = (label, felt, extra = []) => ({label, pairs: [{environment: {id: 'gpu'}, workload: {id: 'small'}, scenarios: [scenario('canvas.pan', felt), ...extra]}]});
  const same = compare(run('a', 10), run('a', 10));
  assert.deepEqual([same.counts, same.missing], [{better: 0, worse: 0, same: 2}, []]);
  const slower = compare(run('a', 10), run('b', 30, [scenario('canvas.zoom', 9)]));
  assert.deepEqual([slower.counts.worse, slower.rows.find(row => row.verdict === 'worse').metric, slower.rows.find(row => row.verdict === 'worse').judged], [1, 'frame.felt', true]);
  assert.deepEqual(slower.missing, ['gpu/small/canvas.zoom: only in b']);
});

test('a key press\'s latency is the wait for a picture of its frame or a later one, and an unanswered press waits to the end', () => {
  // Three presses at 0, 50 and 100 ms from tick 0. The stage shows tick 1 at 30 ms, skips tick 2 and shows tick 3 at 180 ms.
  const shown = {at: [30, 180], tick: [1, 3], prepared: [0, 1], inputs: [0, 50, 100]};
  assert.deepEqual(seekLatency(shown, {firstTick: 0, lastTick: 3, endMs: 400}), {count: 3, p50: 80, p95: 130, worst: 130, unanswered: 0});
  // A fourth press whose frame never showed counts for the time to the capture's end.
  const waits = seekLatency({...shown, inputs: [0, 50, 100, 150]}, {firstTick: 0, lastTick: 9, endMs: 400});
  assert.deepEqual([waits.unanswered, waits.worst], [1, 250]);
  assert.deepEqual(shownTicks(shown), {pictures: 2, ticks: 2, prepared: 1});
});

test('gesture paths start where they say and a circle comes back to its start', () => {
  const circle = paths.circle({x: 100, y: 100}, 50), close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(circle(0).x, 150) && close(circle(0).y, 100) && close(circle(1).x, 150) && close(circle(1).y, 100) && close(circle(.5).x, 50));
  assert.deepEqual(paths.line({x: 0, y: 0}, {x: 10, y: 20})(.5), {x: 5, y: 10});
  const sweep = paths.sweep({x: 10, y: 10}, 70, 45);
  assert.deepEqual(sweep(0), {x: 10, y: 10});
  assert.ok(Math.hypot(sweep(1).x - 10, sweep(1).y - 10) > 40, 'a drag ends away from where it began');
});

test('a generated workload is the same document every time, with the figures, segments and frames it says', () => {
  for (const id of ['small', 'medium']) {
    const spec = workload(id), first = build(spec), again = build(spec), facts = measure(spec);
    assert.equal(JSON.stringify(first), JSON.stringify(again), `${id} is deterministic`);
    assert.equal(first.keyframes[0].objects.length, facts.figures);
    assert.equal(first.keyframes[0].objects.length * first.figure_types[0].segments.length, facts.segmentsPerFrame);
    assert.equal(first.keyframes.reduce((ticks, frame) => ticks + frame.duration_raw, 0), facts.frames);
    // Every object is posed on every frame with one angle per segment, and the figures move between keyframes.
    for (const frame of first.keyframes) for (const object of frame.objects) assert.equal(object.angles.length, spec.segments);
    assert.notDeepEqual(first.keyframes[0].objects[0].angles, first.keyframes[1].objects[0].angles);
    assert.deepEqual(first.keyframes[0].object_draw_order_unique_ids, first.keyframes[0].objects.map(object => object.unique_id));
  }
  assert.equal(measure(scaled(20000)).segmentsPerFrame, 20000);
  assert.throws(() => build(WORKLOADS.starter), /nothing to build/);
  assert.throws(() => workload('huge'), /one of starter, small/);
});

test('scenarios have what the runner and the reports need, and suites name things that exist', () => {
  const ids = new Set();
  for (const scenario of SCENARIOS) {
    assert.match(scenario.id, /^[a-z]+\.[a-z-]+$/, scenario.id);
    assert.ok(!ids.has(scenario.id), `${scenario.id} is listed once`);
    ids.add(scenario.id);
    assert.ok(scenario.area && scenario.title && scenario.description?.length > 40, `${scenario.id} says what it does`);
    assert.ok(['gesture', 'operation'].includes(scenario.kind), scenario.id);
    assert.equal(typeof scenario.run, 'function', scenario.id);
    // A scenario is judged on metrics it defines or the runner gives, against three ascending or descending limits.
    for (const criterion of [scenario.judge ?? defaultJudge(scenario.kind)].flat()) assert.equal(criterion.limits.length, 3, `${scenario.id} judges ${criterion.metric} against three limits`);
  }
  assert.deepEqual(select(['canvas']).map(scenario => scenario.area), ['canvas', 'canvas', 'canvas']);
  assert.deepEqual(select(['pose.drag-joint']).map(scenario => scenario.id), ['pose.drag-joint']);
  assert.throws(() => select(['nothing-like-this']), /No scenario matches/);
  for (const [id, suite] of Object.entries(SUITES)) {
    assert.ok(suite.description && suite.passes >= 1 && suite.parts.length, id);
    for (const launch of launches(suite.parts)) {
      assert.ok(ENVIRONMENTS[launch.environment], `${id}: ${launch.environment}`);
      assert.ok(WORKLOADS[launch.workload], `${id}: ${launch.workload}`);
      assert.ok(select(launch.scenarios).length, `${id}: ${launch.environment}/${launch.workload} runs something`);
    }
  }
  // The core scenarios are single scenarios, each named once.
  assert.deepEqual(select(CORE).map(scenario => scenario.id).sort(), [...CORE].sort());
});

test('a suite\'s parts become one launch per pair of environment and workload, with every scenario a part asks of it', () => {
  const parts = [{environments: ['gpu'], workloads: ['medium'], scenarios: ['canvas']}, {environments: ['gpu', 'software'], workloads: ['small', 'medium'], scenarios: ['pose.drag-joint']},
    {environments: ['software'], workloads: ['small'], scenarios: []}];
  assert.deepEqual(launches(parts), [
    {environment: 'gpu', workload: 'medium', scenarios: ['canvas', 'pose.drag-joint']},
    {environment: 'gpu', workload: 'small', scenarios: ['pose.drag-joint']},
    // A pair one part runs in full runs in full, whatever the others name.
    {environment: 'software', workload: 'small', scenarios: []},
    {environment: 'software', workload: 'medium', scenarios: ['pose.drag-joint']},
  ]);
});
