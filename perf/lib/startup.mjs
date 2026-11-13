/**
 * Starting the app, measured (docs/PERFORMANCE.md "Startup"): from the process's launch to the editor being ready,
 * with the milestones on the way.
 *
 * A source checkout loads about 370 modules one by one, which a packaged app never does: it starts from a bundle
 * (docs/APP-START.md). So startup is measured on a bundle built from this checkout (`npm run app:bundle`), each launch a
 * fresh process on a fresh profile. Every other scenario runs from the sources, where a profile can name the module a
 * function is in.
 */
import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import {launch, ROOT} from './app.mjs';
import {aggregate, judge} from './metrics.mjs';

/** Builds the bundle this checkout's packaged app would start from; resolves with its folder. */
export async function buildBundle() {
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'scripts', 'build-app.mjs')], {cwd: ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  return path.join(ROOT, 'build', 'app');
}

export const START = Object.freeze({
  id: 'app.start', area: 'startup', title: 'Start the app', kind: 'operation',
  description: 'A fresh process on a fresh profile, from launch to the editor ready for input: the desktop shell, the page and its scripts, the engine and its first threads, the stage\'s graphics device.',
  judge: {metric: 'duration', limits: [1500, 3000, 6000]},
  metrics: {
    'start.shell': {title: 'Launch to the page starting to load', unit: 'ms', better: 'lower', digits: 0},
    'start.firstPaint': {title: 'Launch to the first pixels', unit: 'ms', better: 'lower', digits: 0},
    'start.engine': {title: 'Loading the engine', unit: 'ms', better: 'lower', digits: 0},
    'start.page': {title: 'Page start to ready', unit: 'ms', better: 'lower', digits: 0},
    'start.scripts': {title: 'Page and scripts loading', unit: 'ms', better: 'lower', digits: 0},
    'start.interface': {title: 'Building the interface', unit: 'ms', better: 'lower', digits: 0},
    'start.stage': {title: 'Stage and graphics device', unit: 'ms', better: 'lower', digits: 0},
    'start.blocked': {title: 'Interface thread blocked by long tasks', unit: 'ms', better: 'lower', digits: 0},
  },
});

/**
 * Launches the app `launches` times as `environment`, from `bundle` (null: from the sources), and returns the
 * `app.start` scenario's result, shaped as the runner's results are.
 */
export async function measureStartup(environment, {launches = 3, bundle = null, log = () => {}} = {}) {
  const result = {...START, definitions: START.metrics, grade: null, judged: null, passes: 0, metrics: {}, detail: null, attribution: null, notes: [bundle ? 'Measured on the bundle a packaged app starts from.' : 'Measured from the sources: a packaged app starts faster.',
    // The inspector slows a page only once it can attach to it, which is after the launch.
    ...(environment.cpuSlowdown > 1 ? [`The launch ran at this machine's full speed: the processor slowdown of this environment (${environment.cpuSlowdown}×) starts once the page is running.`] : [])], error: null};
  delete result.judge;
  const values = [];
  try {
    for (let index = 0; index < launches; index++) {
      const app = await launch(environment, {bundle});
      try {
        const page = await app.request('startup');
        // The page's own clock starts when it begins to load; the process started before that.
        const shell = page.timeOrigin - app.timings.startedTime;
        const phase = name => page.phases.find(step => step.name === name)?.ms ?? NaN;
        values.push({duration: shell + page.readyMs, 'start.shell': shell, 'start.firstPaint': shell + (page.firstContentfulPaintMs ?? page.firstPaintMs ?? NaN), 'start.engine': page.engineLoadMs ?? NaN,
          'start.page': page.readyMs, 'start.scripts': phase('page and scripts'), 'start.interface': phase('interface'), 'start.stage': phase('stage and graphics device'), 'start.blocked': page.longTasks.ms});
        // The first launch's steps, in order, for the report: the desktop shell first, then the page's own.
        if (!index) result.detail = {phases: [{name: 'desktop shell', startMs: 0, ms: Math.round(shell)}, ...page.phases.map(step => ({...step, startMs: Math.round(shell + step.startMs)}))]};
      } finally { await app.close(); }
      result.passes++;
    }
  } catch (error) { result.error = String(error?.message ?? error).split('\n')[0].slice(0, 500); }
  result.metrics = aggregate(values);
  result.judged = judge([START.judge], result.metrics, START.metrics);
  result.grade = result.judged.grade;
  log(`${environment.id} app.start: ${result.error ? `FAILED ${result.error}` : `${result.grade} ${Math.round(result.metrics.duration?.median)} ms`}`);
  return result;
}
