// Runs benchmark-app.mjs round by round over a list of files and sides, then summarizes. docs/performance/APP-BENCHMARK.md.
//   node scripts/benchmark-app-run.mjs --sides=main=<checkout>,now=. [--runs=3] [--out=<dir>] [--config=<file.json>]
//        [--only=step,step] [--small=<file>] [--exe=<label>=<packaged executable>] [--no-draw] [--no-free] [file ...]
// Each round runs, for every file and then the drawing and document-free steps, every side in turn, one app at a time, so
// a busy moment on the machine lands on all sides alike. The files are private and never part of the repository: they come
// from the command line and from a JSON file (`--config=` or the STYK_BENCH_CONFIG environment variable):
//   {"files": ["C:/path/a.piv", "..."], "small": "C:/path/small.piv", "sides": {"main": "C:/path/checkout"}}
// `--sides=` overrides the config's sides; with neither, the one side is this checkout, labelled `now`.
// A side's label names its results (`main`, `baseline`, `now`, ...). `--exe=<label>=<path>` runs that side's packaged
// executable instead of its checkout (the checkout still supplies the driver). Output defaults to artifacts/benchmark-app/.
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const flag = name => args.includes(`--${name}`);
const configPath = option('config') ?? process.env.STYK_BENCH_CONFIG ?? null;
const config = configPath ? JSON.parse(readFileSync(path.resolve(configPath), 'utf8')) : {};
const files = [...(config.files ?? []), ...args.filter(a => !a.startsWith('--'))];
const small = option('small') ?? config.small ?? null;
const sides = option('sides') ? Object.fromEntries(option('sides').split(',').map(pair => { const i = pair.indexOf('='); return [pair.slice(0, i), pair.slice(i + 1)]; }))
  : config.sides ?? {now: appRoot};
const executables = Object.fromEntries(args.filter(a => a.startsWith('--exe=')).map(a => { const v = a.slice(6), i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; }));
const runs = Number(option('runs') ?? 3);
const only = option('only')?.split(',') ?? null;
const out = path.resolve(option('out') ?? path.join(appRoot, 'artifacts', 'benchmark-app', new Date().toISOString().replace(/[:.]/g, '-')));
const DOC_STEPS = ['idle', 'playCold', 'playWarm', 'scrub', 'jump', 'step', 'poseDrag', 'moveDrag', 'flicker', 'save', 'draws', 'zoomPan', 'select', 'timelineInspector', 'onion', 'export', 'tabs', 'open'];
const FREE_STEPS = ['empty', 'home'];
const wants = names => !only || only.some(name => names.includes(name));
const doDoc = files.length > 0 && wants(DOC_STEPS), doDraw = !flag('no-draw') && wants(['draw']), doFree = !flag('no-free') && wants(FREE_STEPS);
if (!doDoc && !doDraw && !doFree) { console.error('Nothing to run: give files (or a config) and check --only.'); process.exit(2); }
for (const f of files) if (!existsSync(f)) { console.error(`Missing file: ${f}`); process.exit(2); }

mkdirSync(out, {recursive: true});
const log = path.join(out, 'progress.log'), detail = path.join(out, 'bench.log');
const note = text => { const line = `${new Date().toTimeString().slice(0, 5)} ${text}`; console.log(line); appendFileSync(log, `${line}\n`); };
const run = (label, scenarioArgs, round, timeoutMs) => {
  const checkout = path.resolve(sides[label]);
  const extra = [...(only ? [`--only=${only.join(',')}`] : []), ...(small ? [`--small=${small}`] : []), ...(executables[label] ? [`--executable=${executables[label]}`] : [])];
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'benchmark-app.mjs'), label, checkout, path.join(out, `run${round}`), ...scenarioArgs, ...extra],
    {cwd: appRoot, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true});
  appendFileSync(detail, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  note(`round ${round} ${label} ${scenarioArgs.slice(0, 2).map(a => path.basename(a)).join(' ')}: exit ${result.status ?? result.signal} (${Math.round((Date.now() - started) / 1000)} s)`);
};
for (let round = 0; round < runs; round++) {
  if (doDoc) for (const file of files) for (const label of Object.keys(sides)) run(label, ['doc', path.resolve(file), '1', ...((!only || only.includes('save')) ? ['--save'] : [])], round, 1800000);
  if (doDraw) for (const label of Object.keys(sides)) run(label, ['draw', '1'], round, 900000);
  if (doFree) for (const label of Object.keys(sides)) run(label, ['free', '1'], round, 900000);
}
// One folder per round keeps the file names unique; the summary reads them all from one.
const all = path.join(out, 'all');
mkdirSync(all, {recursive: true});
for (const dir of readdirSync(out).filter(d => /^run\d+$/.test(d))) for (const f of readdirSync(path.join(out, dir))) copyFileSync(path.join(out, dir, f), path.join(all, `${dir}--${f}`));
const summary = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'benchmark-app-summary.mjs'), all, ...Object.keys(sides)], {cwd: appRoot, encoding: 'utf8', maxBuffer: 1 << 26});
process.stderr.write(summary.stderr ?? '');
note(`done: ${path.join(all, 'summary.md')}`);
