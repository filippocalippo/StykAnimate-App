/**
 * A run's result on disk (docs/PERFORMANCE.md "Results"): one folder per run under artifacts/perf/runs/.
 *
 *   result.json   everything measured: the machine, the build, and per pair of environment and workload every
 *                 scenario's metrics, frames, spans and attribution;
 *   summary.txt   the same as a page of text an agent or a person reads first;
 *   raw/          with --raw: per scenario the app's own trace and the browser's (both open at ui.perfetto.dev) and a
 *                 .cpuprofile per thread (Chrome's developer tools open them).
 *
 * The folder's name is the run's label. `resolve` finds a run by label, by path, or `latest`.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ROOT} from './app.mjs';

export const SCHEMA = 'styk-perf/1';
export const RUNS = path.join(ROOT, 'artifacts', 'perf', 'runs');

const git = (...args) => { try { return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch { return null; } };

/** The checkout a run measured: commit, branch, whether files differ from the commit, and the engine build in use. */
export function build() {
  let engine = null;
  try { const info = JSON.parse(readFileSync(path.join(ROOT, 'src', 'engine', 'pkg', 'build-info.json'), 'utf8')); engine = {profile: info.profile, sha256: info.sha256?.slice(0, 12) ?? null, wasmBytes: info.wasmBytes}; } catch { /* no engine build */ }
  return {commit: git('rev-parse', '--short', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: Boolean(git('status', '--porcelain', '--untracked-files=no')), engine,
    version: JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version};
}

/** The machine a run ran on. No name, user or path: results are meant to be shared. */
export function machine() {
  const cpus = os.cpus();
  return {platform: process.platform, arch: process.arch, release: os.release(), cpu: cpus[0]?.model?.trim() ?? '', threads: cpus.length, memoryGB: Math.round(os.totalmem() / 2 ** 30), node: process.version};
}

/**
 * How busy the machine is with everything else, as the share of its processor in use over `ms`: other programs take
 * time from the app and make a run's numbers worse and noisier. A run records it before each launch.
 */
export async function backgroundLoad(ms = 500) {
  const snapshot = () => os.cpus().reduce((sum, cpu) => { const total = Object.values(cpu.times).reduce((a, b) => a + b, 0); return {idle: sum.idle + cpu.times.idle, total: sum.total + total}; }, {idle: 0, total: 0});
  const before = snapshot();
  await new Promise(resolve => setTimeout(resolve, ms));
  const after = snapshot(), total = after.total - before.total;
  return total > 0 ? Math.round((1 - (after.idle - before.idle) / total) * 100) : null;
}

/** A label for a run started now: the local date and time. */
export const timeLabel = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;

/** A file-name-safe form of a scenario or pair id. */
const slug = text => String(text).replace(/[^\w.-]+/g, '-');

/**
 * Writes `result` (the run) into its folder and returns the folder. Raw recordings a scenario carries (`trace`, `raw`)
 * go to files under raw/ and leave the JSON.
 */
export function write(result, summary, directory = path.join(RUNS, slug(result.label))) {
  mkdirSync(directory, {recursive: true});
  for (const pair of result.pairs) {
    for (const scenario of pair.scenarios) {
      const name = `${slug(pair.environment.id)}_${slug(pair.workload.id)}_${slug(scenario.id)}`;
      if (!scenario.trace && !scenario.raw) continue;
      const raw = path.join(directory, 'raw');
      mkdirSync(raw, {recursive: true});
      if (scenario.trace) writeFileSync(path.join(raw, `${name}.app-trace.json`), scenario.trace);
      if (scenario.raw?.events?.length) writeFileSync(path.join(raw, `${name}.browser-trace.json`), JSON.stringify({traceEvents: scenario.raw.events}));
      for (const {thread, profile} of scenario.raw?.profiles ?? []) writeFileSync(path.join(raw, `${name}.${slug(thread)}.cpuprofile`), JSON.stringify(profile));
      delete scenario.trace; delete scenario.raw;
    }
  }
  writeFileSync(path.join(directory, 'result.json'), `${JSON.stringify(result)}\n`);
  writeFileSync(path.join(directory, 'summary.txt'), summary);
  return directory;
}

/** The newest run's folder, or null when there is none. */
export function latest() {
  if (!existsSync(RUNS)) return null;
  const runs = readdirSync(RUNS).map(name => path.join(RUNS, name)).filter(folder => existsSync(path.join(folder, 'result.json')));
  return runs.sort((a, b) => statSync(path.join(b, 'result.json')).mtimeMs - statSync(path.join(a, 'result.json')).mtimeMs)[0] ?? null;
}

/** The folder of the run `name`: `latest`, a label under artifacts/perf/runs/, or a path to a folder or a result.json. */
export function resolve(name = 'latest') {
  const candidates = name === 'latest' ? [latest()] : [path.join(RUNS, name), path.resolve(name), path.dirname(path.resolve(name))];
  const found = candidates.find(folder => folder && existsSync(path.join(folder, 'result.json')));
  if (!found) throw new Error(name === 'latest' ? 'No run has been recorded yet: `npm run perf -- run` records one.' : `No run named ${JSON.stringify(name)}: give a label under artifacts/perf/runs/ or a folder with a result.json.`);
  return found;
}

/** Reads the run `name` (see `resolve`). */
export function read(name) {
  const folder = resolve(name), result = JSON.parse(readFileSync(path.join(folder, 'result.json'), 'utf8'));
  if (result.schema !== SCHEMA) throw new Error(`${folder} holds a ${result.schema ?? 'different'} result; this tool reads ${SCHEMA}.`);
  return {...result, folder};
}
