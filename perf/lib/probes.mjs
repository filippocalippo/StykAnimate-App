/**
 * The heavy instruments of a profiled pass (docs/PERFORMANCE.md "Timed passes and the profiled pass"): the sampling
 * profiler on every thread of the page, the browser's trace of every process, and the processes' CPU time.
 *
 * They explain a number and they cost time themselves, so a scenario's numbers never come from a pass that carried
 * them: the timed passes run with only the app's own span ring, and one more pass runs with these to say why.
 */
import {processAttribution, profileAttribution, traceAttribution} from './attribution.mjs';

/** Microseconds between samples: 0.5 ms resolves a frame's work at 144 Hz without slowing it noticeably. */
const SAMPLING_INTERVAL = 500;
/**
 * The trace's categories: every thread's tasks, the page's rendering steps, the graphics process's work and the
 * display compositor's. Enough to say which process was busy with what, without recording each function.
 */
const TRACE_CATEGORIES = ['toplevel', 'devtools.timeline', 'gpu', 'viz', 'cc', 'v8'];

/** The name a profiled thread is reported under: the interface, the engine's threads numbered, or the worker's own name. */
function threadNames(app) {
  const names = new Map([[app.page, 'interface']]), counts = new Map();
  for (const target of app.inspector.workersOf(app.page)) {
    const base = target.title === 'styk-engine' ? 'engine thread' : target.title || target.url.split('/').pop() || 'worker';
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    names.set(target.sessionId, `${base} ${count}`);
  }
  return names;
}

/**
 * Starts the instruments on `app`. `stop()` ends them and resolves with what they recorded:
 * {threads: [profileAttribution…], trace: traceAttribution, processes: processAttribution, raw: {profiles, events}}.
 * `raw` is for files (a .cpuprofile per thread, the trace for Perfetto); results keep only the attributions.
 */
export async function startProbes(app, {cpu = true, trace = true} = {}) {
  const {inspector} = app, profiled = new Set(), events = [];
  const profile = async sessionId => {
    try {
      await inspector.send('Profiler.enable', {}, sessionId);
      await inspector.send('Profiler.setSamplingInterval', {interval: SAMPLING_INTERVAL}, sessionId);
      await inspector.send('Profiler.start', {}, sessionId);
      profiled.add(sessionId);
    } catch { /* a target that ended, or one without a profiler */ }
  };
  let stopWatching = () => {};
  if (cpu) {
    await Promise.all([app.page, ...inspector.workersOf(app.page).map(target => target.sessionId)].map(profile));
    // A worker that starts during the pass (an export's, more engine threads) is profiled from its start.
    stopWatching = inspector.onTarget((target, attached) => { if (attached && target.parent === app.page) void profile(target.sessionId); });
  }
  const before = await app.processes().catch(() => []);
  let collecting = () => {}, complete = null;
  if (trace) {
    collecting = inspector.on('Tracing.dataCollected', params => { for (const event of params.value) events.push(event); });
    complete = new Promise(resolve => { const off = inspector.on('Tracing.tracingComplete', () => { off(); resolve(); }); });
    await inspector.send('Tracing.start', {transferMode: 'ReportEvents', traceConfig: {recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES}});
  }
  return {
    async stop() {
      const after = await app.processes().catch(() => []);
      if (trace) { await inspector.send('Tracing.end'); await complete; collecting(); }
      stopWatching();
      const names = threadNames(app), profiles = [];
      for (const sessionId of profiled) {
        const stopped = await inspector.send('Profiler.stop', {}, sessionId).catch(() => null);
        if (stopped?.profile) profiles.push({thread: names.get(sessionId) ?? 'worker (ended)', profile: stopped.profile});
        await inspector.send('Profiler.disable', {}, sessionId).catch(() => {});
      }
      const threads = profiles.map(({thread, profile: taken}) => profileAttribution(taken, thread)).filter(row => row.busyMs >= .5 || row.thread === 'interface');
      return {threads, trace: trace ? traceAttribution(events) : null, processes: processAttribution(before, after), raw: {profiles, events}};
    },
  };
}
