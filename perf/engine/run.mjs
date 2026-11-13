/**
 * Runs the engine tier (perf/engine/README.md): the benchmarks of benchmarks.mjs on each workload, in this process, with
 * the engine loaded as the unit tests load it (tests/support/engine-node.mjs: the shipped WebAssembly, no worker threads).
 *
 * Every workload's document is opened in an editor the engine owns (the app's own path: src/editor.mjs and
 * src/engine/engine-owner.mjs) and every benchmark is set up and warmed up on it; then the rounds run interleaved (round 1
 * of every benchmark of every workload, then round 2, …), so that a change in what else the machine does spreads over every
 * benchmark's rounds and shows in their spread instead of moving one benchmark's median. A round repeats its benchmark until it has measured
 * about 25 ms (a batch, for calls of a fraction of a millisecond) and reports the mean of its repetitions; the metrics
 * are the median of the rounds with their spread (src/devtools/stats.mjs). Before every round the machine's speed is
 * taken (speed.mjs), so that two runs can be compared at one speed.
 */
import {performance} from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
import {round} from '../../src/devtools/stats.mjs';
import {Editor} from '../../src/editor.mjs';
import {ENGINE_TILE_SIDE} from '../../src/engine/engine-export.mjs';
import {makeExportDocument, makeProjectFile} from '../../src/engine/engine-document-export.mjs';
import {installEngineOwner, snapshotDocument} from '../../src/engine/engine-owner.mjs';
import {EXPORT_MAX_PIXELS} from '../../src/export-sampling.mjs';
import {engineBindings, nodeEngine} from '../../tests/support/engine-node.mjs';
import {aggregate} from '../lib/metrics.mjs';
import {backgroundLoad, build, ENGINE_SCHEMA, machine} from '../lib/result.mjs';
import {document as buildDocument, measure as measureWorkload} from '../workloads.mjs';
import {COMMON_METRICS} from './benchmarks.mjs';
import {scaling} from './scaling.mjs';
import {machineSpeed, reference} from './speed.mjs';

const MB = 1048576;
/** The editor as the app makes it (src/app.mjs): property channels and a layer sheet for every document. */
const EDITOR_OPTIONS = Object.freeze({demo: false, propertyChannels: true, layerTimeline: true});
/**
 * Work a benchmark does before it is measured, at least one repetition: V8 compiles the engine's WebAssembly quickly first
 * and again for speed once a function has run enough, and the interface's JavaScript the same way, so first runs are slower.
 * The second figure ends a warm-up whose repetitions are cheap to measure but dear to prepare (a session needs a fresh open).
 */
const WARM_MS = 200, WARM_WALL_MS = 500;
/** What a round measures at least, by repeating its benchmark, and the most a round may take with its preparation. */
const ROUND_MS = 25, ROUND_WALL_MS = 250, MOST_REPEATS = 50;

/**
 * The garbage collector, when it can be had (a flag set at run time): run before each workload's round so that collecting
 * what the rounds before left does not land in a measurement (once per benchmark cost seconds with every workload open).
 * Null when the runtime does not allow it.
 */
const collect = (() => {
  try { v8.setFlagsFromString('--expose-gc'); return vm.runInNewContext('gc'); } catch { return null; }
})();

/**
 * Records the calls into the engine that `measure` makes: each call's name (a session call with the editor's method,
 * `call:poseJoint`; a read with its kind, `query:frame`, `packet:geometry`), its time and, for a session call, the length of
 * its answer (the patch that crosses to the interface). The developer tools' boundary meter (src/devtools/boundary.mjs)
 * counts calls per name for a capture; a benchmark needs each call of one measured stretch with the size of its answer.
 * Outside `measure` a wrapped method costs one test.
 */
function recorder({EditSession, EngineHandle, OpenedDocument}) {
  let calls = null;
  const named = {call: 'call', call_with_document: 'call', query: 'query', query_packet: 'packet'};
  const wrap = (type, key) => {
    const original = type.prototype[key], label = `${type.name}.${key}`;
    type.prototype[key] = function recorded(...args) {
      if (!calls) return original.apply(this, args);
      const started = performance.now(), answer = original.apply(this, args), ms = performance.now() - started;
      calls.push({name: named[key] ? `${named[key]}:${args[0]}` : label, ms, bytes: named[key] === 'call' && typeof answer === 'string' ? answer.length : 0});
      return answer;
    };
  };
  for (const key of ['call', 'call_with_document', 'query', 'query_packet', 'activate', 'snapshot']) wrap(EditSession, key);
  wrap(EngineHandle, 'open_document_now');
  wrap(OpenedDocument, 'start_session');
  /**
   * Runs `work` and returns {value, ms, calls, engineMs, bytes, engine(name)}: what it returned, its whole time, each call it made
   * into the engine, their time together, the length of the session calls' answers, and the time of the calls called `name`.
   */
  return work => {
    const outer = calls;
    calls = [];
    const started = performance.now();
    let value, taken;
    try { value = work(); } finally { taken = calls; calls = outer; }
    const ms = performance.now() - started;
    if (outer) outer.push(...taken);
    return {value, ms, calls: taken, engineMs: taken.reduce((total, call) => total + call.ms, 0), bytes: taken.reduce((total, call) => total + call.bytes, 0),
      engine: name => taken.filter(call => call.name === name).reduce((total, call) => total + call.ms, 0)};
  };
}

/** The ticks of a generated workload: its keyframes and one in the middle of each stretch between two (`hold` ticks apart). */
function ticksOf(spec) {
  const keys = Array.from({length: spec.keyframes}, (_, index) => index * spec.hold);
  const between = spec.hold > 1 ? keys.slice(0, -1).map(tick => tick + Math.floor(spec.hold / 2)) : keys;
  return {keys, between};
}

/** A document opened in an editor the engine owns, as the app opens one: {editor, owner}. The owner is released by whoever opened it. */
function openOwned(text, name) {
  const editor = new Editor(EDITOR_OPTIONS);
  editor.load(text, name);
  const owner = installEngineOwner(editor, {verify: false});
  if (!owner.ready()) { owner.release(); throw new Error(`The engine did not start a session on ${name}.`); }
  return {editor, owner};
}

/** Lets the engine finish its queued work (without workers it runs only when asked): it drops there what an older publication held. */
function idle(engine) { while (engine.handle.step()) { /* one unit at a time */ } }

/** Runs one repetition of `benchmark` from its preparation to its reset; returns its metrics and how long the measured part and the whole took. */
async function repetition(benchmark, context, state) {
  const began = performance.now();
  await benchmark.prepare?.(context, state);
  const started = performance.now(), values = await benchmark.run(context, state), measured = performance.now() - started;
  await benchmark.reset?.(context, state);
  return {values, measured, wall: performance.now() - began};
}

/**
 * Processor time this process has used, in seconds. Beside the wall time of a stretch it says how much of a processor the
 * run had: on a busy machine the engine waits for its turn, and every number is slower by about that share.
 */
const processorSeconds = () => { const used = process.cpuUsage(); return (used.user + used.system) / 1e6; };

/** The mean of each metric over a round's repetitions. */
function meanOf(list) {
  const keys = new Set(list.flatMap(values => Object.keys(values)));
  return Object.fromEntries([...keys].map(key => [key, list.reduce((total, values) => total + (values[key] ?? 0), 0) / list.length]));
}

/** Adds the wall and processor time `work` takes to `clock` ({seconds, processorSeconds}) and returns what it returned. */
async function timed(clock, work) {
  const started = performance.now(), processor = processorSeconds();
  try { return await work(); } finally { clock.seconds += (performance.now() - started) / 1000; clock.processorSeconds += processorSeconds() - processor; }
}

/**
 * Opens the workload `spec` in an editor the engine owns, sets up and warms up `benchmarks` on it and sizes their rounds:
 * the workload's entry for `roundOf` and `finish`. A benchmark that fails here is reported and left out of the rounds.
 */
async function openWorkload(spec, benchmarks, {engine, app, measure, log}) {
  const measured = measureWorkload(spec), clock = {seconds: 0, processorSeconds: 0};
  const result = {id: spec.id, title: spec.title, description: spec.description, figures: measured.figures, segmentsPerFrame: measured.segmentsPerFrame, frames: measured.frames,
    jsonMB: null, memory: {}, benchmarks: [], seconds: null, processorSeconds: null};
  const entry = {spec, result, clock, runs: [], opened: [], spare: null, context: null};
  await timed(clock, async () => {
    const text = JSON.stringify(buildDocument(spec)), before = engine.memory().liveBytes;
    result.jsonMB = round(text.length / MB, 2);
    const {editor, owner} = openOwned(text, spec.title);
    entry.opened.push(owner);
    // What the engine holds for this workload once it is open (the run's other workloads are open beside it).
    result.memory.openMB = round((engine.memory().liveBytes - before) / MB, 1);
    /** The editor the open benchmark loaded last, which the session benchmark starts a session on; at most one is kept, its opening let go of when replaced. */
    const spare = entry.spare = {editor: null, give(next) { spare.editor?._opening?.dispose(); spare.editor = next; }, take() { const taken = spare.editor; spare.editor = null; return taken; }};
    entry.context = {engine, app, measure, spec, measured, text, name: spec.title, editor, owner, editorOptions: EDITOR_OPTIONS, ticks: ticksOf(spec), spare,
      /** Makes `which` (the workload's own document by default) the engine's document in a new publication, the previous one's frames let go of. */
      publish(which = owner) { which.activate(); idle(engine); },
      /** Opens another document of the workload's kind (`spec` changed) in an editor of its own: {editor, owner}, released with the workload. */
      open(other) { const made = openOwned(JSON.stringify(buildDocument(other)), other.title); entry.opened.push(made.owner); return made; }};
  });
  for (const benchmark of benchmarks) {
    const row = {id: benchmark.id, layer: benchmark.layer, title: benchmark.title, description: benchmark.description, headline: benchmark.headline,
      definitions: {...benchmark.metrics, ...COMMON_METRICS}, repeats: 0, warmup: 0, metrics: {}, rounds: {}, reference: [], error: null, seconds: 0, processorSeconds: 0};
    result.benchmarks.push(row);
    const run = {benchmark, row, state: undefined, values: []};
    entry.runs.push(run);
    await timed(row, async () => {
      try {
        // A benchmark without a setup still gets a state of its own to keep what a repetition prepares.
        run.state = (await benchmark.setup?.(entry.context)) ?? {};
        // Warm up, and size a round from what a repetition took.
        let measuredMs = 0, wallMs = 0;
        do {
          const once = await repetition(benchmark, entry.context, run.state);
          measuredMs += once.measured; wallMs += once.wall; row.warmup++;
        } while (measuredMs < WARM_MS && wallMs < WARM_WALL_MS && row.warmup < MOST_REPEATS);
        const each = measuredMs / row.warmup, eachWall = wallMs / row.warmup;
        row.repeats = Math.max(1, Math.min(MOST_REPEATS, Math.ceil(ROUND_MS / Math.max(each, .001)), Math.floor(ROUND_WALL_MS / Math.max(eachWall, .001))));
      } catch (error) { row.error = failure(error); log(`${spec.id} ${benchmark.id}: ${row.error}`); await teardown(run, entry.context); }
    });
  }
  return entry;
}

/**
 * One round of every benchmark of the workload `entry` that has not failed: its repetitions' mean, with the memory the round
 * added and the machine's speed just before it.
 */
async function roundOf(entry, {engine, log}) {
  await timed(entry.clock, () => collect?.());
  for (const run of entry.runs) {
    if (run.row.error) continue;
    await timed(run.row, async () => {
      try {
        // Every round starts from the workload's document freshly published, with nothing a round before prepared or queued
        // still held: the memory the round adds is its own. (The allocator's count of what is handed out and its peak are
        // kept apart and can differ by a little: what a round frees below the start counts as nothing added.)
        entry.context.publish();
        const machine = reference();
        engine.handle.reset_memory_peak();
        const held = engine.memory().liveBytes, list = [];
        for (let repeat = 0; repeat < run.row.repeats; repeat++) list.push((await repetition(run.benchmark, entry.context, run.state)).values);
        run.values.push({...meanOf(list), 'memory.peak': Math.max(0, engine.memory().peakBytes - held) / MB});
        run.row.reference.push(round(machine, 4));
      } catch (error) { run.row.error = failure(error); log(`${entry.spec.id} ${run.benchmark.id}: ${run.row.error}`); }
    });
  }
}

/** Tears the workload `entry` down, lets go of its documents and makes its rounds its result: per metric the median and spread, and each round's value. */
async function finish(entry) {
  await timed(entry.clock, async () => {
    if (entry.context) for (const run of entry.runs) await teardown(run, entry.context);
    entry.spare?.give(null);
    for (const owner of entry.opened) owner.release();
  });
  for (const {row, values} of entry.runs) {
    row.metrics = aggregate(values);
    row.rounds = Object.fromEntries(Object.keys(row.metrics).map(key => [key, values.map(value => round(value[key], 4))]));
    row.seconds = round(row.seconds, 2); row.processorSeconds = round(row.processorSeconds, 2);
  }
  const {result, clock} = entry;
  result.seconds = round(clock.seconds + result.benchmarks.reduce((total, row) => total + row.seconds, 0), 1);
  result.processorSeconds = round(clock.processorSeconds + result.benchmarks.reduce((total, row) => total + row.processorSeconds, 0), 1);
  return result;
}

/**
 * Runs `benchmarks` on every workload of `specs` for `rounds` rounds and returns the workloads' results. All are opened and
 * warmed up first, then the rounds run interleaved: round 1 of every benchmark of every workload, then round 2, … so a
 * burst of other work on the machine falls on every workload's rounds alike and widens their spread instead of moving one
 * workload's median (run one size after another, a scaling run read one size's burst as a bend in the curve). Each
 * workload's result says what it holds, the engine's memory for it once open, and per benchmark its metrics, its rounds,
 * how many repetitions a round made, and its error when it failed (a benchmark that fails is left out of the rounds that
 * follow; the others go on).
 */
export async function runWorkloads(specs, benchmarks, {rounds, engine, app, measure, log = () => {}}) {
  const entries = [];
  try {
    for (const spec of specs) {
      entries.push(await openWorkload(spec, benchmarks, {engine, app, measure, log}));
      log(`${spec.id}: opened and warmed up`);
    }
    for (let index = 0; index < rounds; index++) {
      for (const entry of entries) await roundOf(entry, {engine, log});
      log(`round ${index + 1} of ${rounds} done`);
    }
  } finally {
    for (const entry of entries) await finish(entry);
  }
  return entries.map(entry => entry.result);
}

const failure = error => String(error?.message ?? error).split('\n')[0].slice(0, 500);
async function teardown(run, context) {
  if (run.tornDown) return;
  run.tornDown = true;
  try { await run.benchmark.teardown?.(context, run.state); } catch (error) { run.row.error ??= `teardown: ${failure(error)}`; }
}

/** The engine, loaded once (no worker threads), with what the benchmarks call besides it and the recorder of their calls into it. */
export async function loadEngine() {
  const {engine} = await nodeEngine(), bindings = await engineBindings();
  const app = {Editor, installEngineOwner, snapshotDocument, makeProjectFile, makeExportDocument, ExportRenderer: bindings.ExportRenderer, EXPORT_MAX_PIXELS, ENGINE_TILE_SIDE};
  return {engine, app, measure: recorder({EditSession: bindings.EditSession, EngineHandle: bindings.EngineHandle, OpenedDocument: bindings.OpenedDocument})};
}

/**
 * The whole engine run: `workloads` (definitions of perf/workloads.mjs) with `benchmarks`, then with `scale` the scaling
 * sizes (`scaled` definitions) with `scaleBenchmarks`. Returns the result (schema styk-perf-engine/1).
 */
export async function runEngine({label, workloads, benchmarks, scaled = [], scaleBenchmarks = [], rounds, log = () => {}}) {
  const started = performance.now(), processor = processorSeconds(), loadBefore = await backgroundLoad();
  if (loadBefore > 20) log(`the machine is busy with other work (${loadBefore}% of its processor): expect slower and noisier numbers`);
  const loaded = await loadEngine(), {engine} = loaded;
  reference();
  const result = {schema: ENGINE_SCHEMA, label, at: new Date().toISOString(), rounds, seconds: null, processorSeconds: null, build: build(), machine: machine(),
    load: {beforePercent: loadBefore, afterPercent: null}, engine: {threads: 1, workers: engine.workers, memoryMaximumMB: round(engine.memoryMaximumBytes / MB, 0), garbageCollected: Boolean(collect)},
    workloads: [], scaling: null};
  if (workloads.length) {
    log(`${workloads.map(spec => spec.id).join(', ')}: ${benchmarks.length} benchmarks, ${rounds} rounds`);
    result.workloads.push(...await runWorkloads(workloads, benchmarks, {...loaded, rounds, log}));
  }
  if (scaled.length) {
    log(`scaling over ${scaled.map(spec => spec.figures * spec.segments).join(', ')} segments: ${scaleBenchmarks.map(benchmark => benchmark.id).join(', ')}, ${rounds} rounds`);
    const sizes = (await runWorkloads(scaled, scaleBenchmarks, {...loaded, rounds, log})).map(done => ({...done, scaling: true}));
    result.workloads.push(...sizes);
    result.scaling = scaling(sizes, Object.fromEntries(scaleBenchmarks.map(benchmark => [benchmark.id, benchmark.metrics])));
  }
  result.referenceMs = round(machineSpeed(result), 4);
  result.load.afterPercent = await backgroundLoad();
  result.seconds = round((performance.now() - started) / 1000, 1);
  result.processorSeconds = round(processorSeconds() - processor, 1);
  return result;
}
