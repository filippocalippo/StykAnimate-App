/**
 * Runs scenarios against one launch of the app and returns what they measured (docs/PERFORMANCE.md "How a run works").
 *
 * One launch per pair of environment and workload: the app starts, the workload's document opens (that is the `open`
 * scenario), then every scenario runs in the same app, each starting from the same resting state.
 *
 * A scenario runs as timed passes, then one profiled pass:
 *   timed      only the app's own recorders run (the span ring and the frame recorder, src/devtools/): the numbers;
 *   profiled   the sampling profiler on every thread and the browser's trace run too (probes.mjs): the explanation.
 * The profiled pass's own numbers are not reported, because its instruments slow what they watch.
 */
import {performance} from 'node:perf_hooks';
import {breakdownMegabytes} from '../../src/devtools/memory.mjs';
import {round} from '../../src/devtools/stats.mjs';
import {launch} from './app.mjs';
import {createInput, paths} from './input.mjs';
import {aggregate, captureMetrics, defaultJudge, format, judge} from './metrics.mjs';
import {startProbes, threadNames} from './probes.mjs';
import {backgroundLoad, BUSY_PERCENT} from './result.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const megabytes = bytes => (Number.isFinite(bytes) ? round(bytes / 1048576, 1) : null);

/** Rejects when `work` takes longer than `ms`: a scenario that hangs ends as its own failure, not the run's. */
function within(ms, what, work) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s.`)), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * What a scenario is handed (perf/scenarios/README.md): the app, input, and the reads scenarios share. Everything a
 * scenario does to the app goes through here or through `app`.
 */
function createContext(app, workload, facts) {
  const context = {
    app, workload, facts, paths, sleep, input: createInput(app),
    request: (op, args, detail) => app.request(op, args, detail),
    evaluate: (fn, argument) => app.evaluate(fn, argument),
    /** The stage's rectangle in window pixels, with its centre. */
    async stage() { const {stage} = await app.request('state'); return {...stage, centre: {x: stage.x + stage.width / 2, y: stage.y + stage.height / 2}}; },
    /** The document, playback and view now (`state` of the control channel). */
    state: () => app.request('state'),
    /** Waits until the frame on show is the document's current state. */
    settle: (timeoutMs = 15000) => app.request('settle', {timeoutMs}),
    /**
     * The rectangle of the first visible element matching `selector`, in window pixels, with its centre. Throws,
     * naming the selector, when nothing visible matches: a scenario aims at what is there, never at a guessed place.
     */
    async rect(selector) {
      const found = await app.evaluate(wanted => {
        for (const element of document.querySelectorAll(wanted)) {
          const box = element.getBoundingClientRect();
          if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden') return {x: box.left, y: box.top, width: box.width, height: box.height};
        }
        return null;
      }, selector);
      if (!found) throw new Error(`Nothing visible matches ${JSON.stringify(selector)}.`);
      return {...found, centre: {x: found.x + found.width / 2, y: found.y + found.height / 2}};
    },
    /** Clicks the middle of the first visible element matching `selector`, with real input. */
    async press(selector, options) { const {centre} = await context.rect(selector); await context.input.click(centre.x, centre.y, options); },
    /**
     * Waits until `test(argument)` is truthy in the page and returns its value; throws after `timeoutMs` saying what
     * was awaited (`what`: "the export dialog").
     */
    async until(test, {argument = null, timeoutMs = 10000, what = 'the condition'} = {}) {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const value = await app.evaluate(test, argument);
        if (value) return value;
        if (performance.now() > deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}.`);
        await sleep(25);
      }
    },
    /**
     * Waits for a recovery copy that is due, so that it is not written inside the next measured stretch. An edit (or a
     * save or export started with unsaved changes) starts the app's autosave timer, and 2.5 s later it writes the whole
     * project from a worker, wherever the run has got to by then. This waits until the timer has fired and the copy is
     * written. An edit that was undone leaves nothing due, and the wait is then no wait. At most half a minute.
     */
    async recoveryQuiet() {
      await app.evaluate(async () => {
        const {styk} = globalThis, before = styk.state.lastExport, until = performance.now() + 30000;
        // No timer: nothing is due (a project with unsaved changes whose copy was already written stays as it is).
        if (!styk.state.recoveryTimer) return;
        const pause = () => new Promise(resolve => setTimeout(resolve, 20));
        // The timer fires (it sets itself again while something keeps the app busy), then the write replaces `lastExport`;
        // a timer that finds nothing unsaved writes nothing.
        while (styk.state.recoveryTimer && performance.now() < until) await pause();
        while (styk.editor.dirty && styk.state.lastExport === before && performance.now() < until) await pause();
      });
    },
    /**
     * The resting state every scenario starts from: nothing playing, nothing covering the stage, no recovery copy about
     * to be written, the first frame, nothing selected, the whole scene in view.
     */
    async rest() {
      await app.quiet();
      await context.recoveryQuiet();
      await app.evaluate(() => { const {styk} = globalThis; if (styk.state.playing) styk.actions.play(); styk.editor.select(null); if (styk.editor.tick !== 0) styk.editor.seek(0); styk.fit(); });
      await context.settle();
    },
  };
  return context;
}

/** One measured stretch: the app's capture around `scenario.run`. Returns the capture's full summary and what `run` returned. */
async function capture(app, scenario, context, state, {label, series, writes = false}) {
  await app.request('trace.start', {label, writes});
  let extra = null, failure = null;
  const started = performance.now();
  try {
    extra = await scenario.run(context, state);
    // The picture that answers the last input belongs to the scenario: the capture ends when it is on show.
    if (scenario.settle !== false) await context.settle();
  } catch (error) { failure = error; }
  const wallMs = performance.now() - started;
  const stopped = await app.request('trace.stop', {series}, 'full');
  if (failure) throw failure;
  return {summary: stopped.summary, extra: extra ?? {}, wallMs, pages: stopped.pages};
}

/**
 * Every thread of the page as its inspector session counts it (`Runtime.getHeapUsage`): its heap in use and committed,
 * and the array buffers it holds outside the heap (`backingStorageSize`). The names are the profiled pass's.
 */
export async function threadHeaps(app) {
  const names = threadNames(app);
  const read = async (sessionId, name) => {
    // A worker that ends while it is asked (the drawing workers end when idle) never answers: it is left out after two seconds.
    const usage = await Promise.race([app.inspector.send('Runtime.getHeapUsage', {}, sessionId), sleep(2000).then(() => null)]).catch(() => null);
    return usage ? {thread: name, name: name.replace(/ \d+$/, ''), interface: sessionId === app.page, usedBytes: usage.usedSize, totalBytes: usage.totalSize, backingBytes: usage.backingStorageSize ?? null} : null;
  };
  return (await Promise.all([...names].map(([sessionId, name]) => read(sessionId, name)))).filter(Boolean);
}

/**
 * The memory of the page, the engine and the app's processes now, in megabytes, with the page's memory by owner
 * (`owners`: src/devtools/memory.mjs `breakdownMegabytes`): what every part holds and what is left unexplained.
 */
async function memoryNow(app) {
  const [memory, processes, threads] = await Promise.all([app.request('memory'), app.processes().catch(() => []), threadHeaps(app).catch(() => [])]);
  const byType = {};
  for (const row of processes) {
    const type = {Browser: 'browser', Tab: 'page', renderer: 'page', GPU: 'graphics'}[row.type] ?? 'other';
    const bytes = row.privateBytes ?? row.workingSetBytes;
    if (Number.isFinite(bytes)) byType[type] = (byType[type] ?? 0) + bytes;
  }
  const total = Object.values(byType).reduce((sum, bytes) => sum + bytes, 0);
  const split = await app.request('memory.breakdown', {threads, processBytes: byType.page ?? null}).catch(() => null);
  return {jsHeap: megabytes(memory.jsHeap?.usedBytes), engine: megabytes(memory.engine?.liveBytes), enginePeak: megabytes(memory.engine?.peakBytes), engineReserved: megabytes(memory.engineMemoryBytes),
    frameCache: megabytes(memory.engine?.frameCacheBytes), gpu: megabytes(memory.gpuTotalBytes ?? memory.gpuBytes), page: megabytes(byType.page), graphics: megabytes(byType.graphics), browser: megabytes(byType.browser), total: total ? megabytes(total) : null,
    ...(split ? {owners: breakdownMegabytes(split)} : {})};
}

/** The engine's threads as one row: their layers, modules and functions added up, with each thread's busy time. */
function mergeThreads(threads) {
  const engine = threads.filter(row => row.thread.startsWith('engine thread')), others = threads.filter(row => !row.thread.startsWith('engine thread'));
  if (engine.length < 2) return threads;
  const sum = (lists, key, value) => {
    const totals = new Map();
    for (const list of lists) for (const row of list) { const kept = totals.get(row[key]) ?? {...row, [value]: 0}; kept[value] += row[value]; totals.set(row[key], kept); }
    return [...totals.values()].map(row => ({...row, [value]: round(row[value], 1)})).sort((a, b) => b[value] - a[value]);
  };
  const merged = {thread: `engine threads (${engine.length})`, sampledMs: round(engine.reduce((total, row) => total + row.sampledMs, 0), 1), busyMs: round(engine.reduce((total, row) => total + row.busyMs, 0), 1),
    perThreadBusyMs: engine.map(row => row.busyMs), layers: sum(engine.map(row => row.layers), 'id', 'ms'), modules: sum(engine.map(row => row.modules), 'name', 'ms').slice(0, 20),
    functions: sum(engine.map(row => row.functions.map(fn => ({...fn, key: `${fn.name}|${fn.where}`}))), 'key', 'selfMs').slice(0, 25).map(({key: _key, ...fn}) => fn)};
  return [others.find(row => row.thread === 'interface'), merged, ...others.filter(row => row.thread !== 'interface')].filter(Boolean);
}

/**
 * Runs one scenario: `passes` timed passes and, with `profile`, one profiled pass. Never throws: a scenario that fails
 * is a result with `error`, and the app is brought back to rest for the next one.
 */
async function runScenario(app, scenario, context, {passes, profile, raw}) {
  const criteria = [scenario.judge ?? defaultJudge(scenario.kind)].flat();
  const result = {id: scenario.id, area: scenario.area, title: scenario.title, kind: scenario.kind, description: scenario.description ?? '',
    grade: null, judged: null, passes: 0, metrics: {}, definitions: scenario.metrics ?? {}, detail: null, attribution: null, notes: [], error: null};
  let state;
  try {
    await context.rest();
    const skip = await scenario.when?.(context);
    if (typeof skip === 'string') { result.skipped = skip; return result; }
    const timeout = scenario.timeoutMs ?? 120000;
    state = await within(timeout, `${scenario.id}: setup`, Promise.resolve(scenario.setup?.(context)));
    const values = [], count = scenario.passes ?? passes;
    for (let pass = 0; pass < count; pass++) {
      const taken = await within(timeout, `${scenario.id}: pass ${pass + 1}`, capture(app, scenario, context, state, {label: scenario.id, series: pass === 0}));
      // The capture's own numbers, then what the scenario timed itself, then what it reads out of the capture.
      const own = {...captureMetrics(taken.summary), ...taken.extra.metrics, ...await scenario.measure?.(context, state, taken.summary)};
      // An operation's time is what the scenario timed itself, or the capture's own length.
      if (scenario.kind === 'operation' && own.duration === undefined) own.duration = taken.summary.ms;
      values.push(own);
      if (pass === 0) {
        const {summary} = taken;
        result.detail = {ms: summary.ms, frames: summary.frames, inputs: summary.inputs, series: summary.series ?? null, shown: summary.shown ?? null, spans: summary.spans.slice(0, 30), slowest: summary.slowest.slice(0, 8),
          boundary: summary.boundary?.slice(0, 20) ?? null, preparation: summary.preparation ?? null, counters: summary.counters};
        if (taken.extra.notes) result.notes.push(...taken.extra.notes);
        if (raw) result.trace = await readTrace(app, taken.pages);
      }
      await within(timeout, `${scenario.id}: reset`, Promise.resolve(scenario.reset?.(context, state)));
      result.passes++;
    }
    result.metrics = aggregate(values);
    result.judged = judge(criteria, result.metrics, result.definitions);
    result.grade = result.judged.grade;
    if (profile && scenario.profile !== false) {
      const probes = await startProbes(app);
      let repeats = 0, failure = null, written = null;
      try {
        // An operation is over in milliseconds, too few samples to say anything: it repeats, with its reset, until the
        // profilers have watched a second and a half of it.
        const enough = performance.now() + (scenario.kind === 'operation' ? 1500 : 0);
        do {
          const taken = await within(timeout, `${scenario.id}: profiled pass`, capture(app, scenario, context, state, {label: `${scenario.id} (profiled)`, series: false, writes: true}));
          // Which interface elements the scenario rewrote: the first time through says it.
          written ??= taken.summary.writes ?? null;
          await within(timeout, `${scenario.id}: reset`, Promise.resolve(scenario.reset?.(context, state)));
          repeats++;
        } while (performance.now() < enough && repeats < 12);
      } catch (error) { failure = error; }
      const recorded = await probes.stop();
      if (failure) throw failure;
      result.attribution = {repeats, threads: mergeThreads(recorded.threads), browser: recorded.trace, processes: recorded.processes, writes: written};
      if (raw) result.raw = recorded.raw;
    }
  } catch (error) {
    result.error = String(error?.message ?? error).split('\n')[0].slice(0, 500);
    await app.request('trace.stop').catch(() => {});
  } finally {
    if (state !== undefined) await Promise.resolve(scenario.teardown?.(context, state)).catch(error => result.notes.push(`teardown: ${error.message}`));
  }
  return result;
}

/** The app's own trace of the last capture (Chrome trace JSON for Perfetto), read page by page. */
async function readTrace(app, pages) {
  let text = '';
  for (let page = 0; page < pages; page++) text += (await app.request('trace.read', {page})).text;
  return text;
}

/**
 * Runs `scenarios` for one environment and one workload: launches the app, opens the workload's document through the
 * `open` scenario, runs the rest, closes the app. `open` is the scenario that opens `context.workload.file`
 * (perf/scenarios/files.mjs); it runs first whenever the workload has a document.
 *
 * Returns {environment, workload, facts, startup, scenarios, memory, error}. Never throws for a scenario; an app that
 * cannot start or dies is `error` on the pair, with what had been measured until then.
 */
export async function runPair({environment, workload, scenarios, open, passes = 3, profile = true, raw = false, experiment = null, parameters = null, log = () => {}}) {
  const pair = {environment: {id: environment.id, title: environment.title, description: environment.description}, workload: {id: workload.id, title: workload.title, description: workload.description, ...workload.measured},
    facts: null, startup: null, scenarios: [], memory: [], error: null};
  let app = null;
  try {
    // What else the machine is doing takes time from the app: the pair records it, and a busy machine is said so.
    const busy = await backgroundLoad();
    if (busy > BUSY_PERCENT) log(`the machine is busy with other work (${busy}% of its processor): expect slower and noisier numbers`);
    app = await launch(environment, {log});
    // An experiment's script runs once, before anything is measured (perf/lib/experiment.mjs).
    if (experiment) await app.evaluate(experiment.source);
    // The display's period is measured while the app rests: every frame of the run is judged against it.
    const display = await app.request('display.period');
    const facts = await app.request('environment');
    pair.facts = {host: app.kind, browser: app.inspector.browser, renderer: facts.renderer, engine: facts.engine, display: {periodMs: round(display.periodMs, 2), hz: round(1000 / display.periodMs, 0)},
      window: facts.window, reports: facts.navigator, asked: facts.asked, cpuSlowdown: environment.cpuSlowdown ?? 1, slowedTargets: app.slowed.length, backgroundLoadPercent: busy};
    if (experiment) pair.facts.experiment = {name: experiment.name, sha256: experiment.sha256};
    if (parameters) pair.facts.parameters = parameters;
    pair.startup = {readyMs: app.timings.readyMs, inspectorMs: app.timings.inspectorMs};
    const context = createContext(app, workload, pair.facts);
    pair.memory.push({after: 'start', ...await memoryNow(app)});
    const list = workload.builtin || !open ? scenarios.filter(scenario => scenario !== open) : [open, ...scenarios.filter(scenario => scenario !== open)];
    for (const scenario of list) {
      const started = performance.now();
      const result = await runScenario(app, scenario, context, {passes, profile, raw});
      pair.scenarios.push(result);
      // A checkpoint that cannot be read in half a minute is left empty: it never holds the run up.
      pair.memory.push({after: scenario.id, ...await within(30000, 'the memory checkpoint', memoryNow(app)).catch(() => ({}))});
      log(`${environment.id}/${workload.id} ${scenario.id}: ${result.error ? `FAILED ${result.error}` : result.skipped ? `skipped (${result.skipped})` : `${result.grade ?? '–'}, ${result.judged?.decided} ${format(result.judged?.decided, result.judged?.value, result.definitions)}`} (${Math.round((performance.now() - started) / 100) / 10} s)`);
      if (scenario === open && result.error) throw new Error(`The workload did not open: ${result.error}`);
      if (app.inspector.closed) throw new Error('The app closed during the run.');
    }
    // The engine starts the rest of its threads with the first document: what it ended with is what the scenarios ran on.
    pair.facts.engine = (await app.request('environment')).engine;
    // A parameter the app never read was misspelt, or belongs to code these scenarios did not reach.
    if (parameters) {
      const read = new Set((await app.request('params.list')).rows.map(row => row.name));
      pair.facts.unreadParameters = Object.keys(parameters).filter(name => !read.has(name));
    }
  } catch (error) {
    pair.error = String(error?.message ?? error).split('\n')[0].slice(0, 500);
    log(`${environment.id}/${workload.id}: ${pair.error}`);
  } finally { await app?.close().catch(() => {}); }
  return pair;
}
