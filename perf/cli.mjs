// StykAnimate performance tools (docs/PERFORMANCE.md).
//
//   npm run perf -- run [suite] [--env gpu,software] [--workload small,stress] [--scenario canvas,pose.drag-joint]
//                       [--passes 3] [--no-profile] [--no-startup] [--raw] [--label <name>]
//   npm run perf -- list                       scenarios, workloads, environments and suites
//   npm run perf -- show [run] [scenario] [--env <id>] [--workload <id>]
//   npm run perf -- compare <base run> [head run] [--all] [--fail-on-worse]
//   npm run perf -- engine [--workload small,medium,large,stress] [--scale] [--benchmark open,frame] [--rounds 5] [--label <name>]
//   npm run perf -- engine-compare <base engine run> [head engine run] [--all] [--fail-on-worse]
//
// `run` starts this checkout's app on scratch data, in a window off-screen, once per pair of environment and workload,
// and writes artifacts/perf/runs/<label>/ (result.json, summary.txt). `show` prints a run's summary, or one scenario in
// full: its metrics, its frames by phase, its spans and where the profiled pass found the time, thread by thread.
// `compare` says what changed between two runs beyond their own noise (the head defaults to the latest run).
// `engine` is the engine tier (perf/engine/README.md): the engine by itself in Node on one thread, no window, an answer in
// seconds; it writes artifacts/perf/engine/<label>/. `engine-compare` is `compare` for two of those.
// A run is `latest`, a label, or a folder. Exit codes: 0 done, 1 a scenario failed, a pair did not complete, or
// `--fail-on-worse` found something worse; 2 usage.
import {performance} from 'node:perf_hooks';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ENVIRONMENTS, environment} from './environments.mjs';
import {compare, comparisonText} from './lib/compare.mjs';
import {compareEngine} from './lib/compare.mjs';
import {build, machine, read, SCHEMA, timeLabel, write} from './lib/result.mjs';
import {ENGINE_RUNS, ENGINE_SCHEMA, slug} from './lib/result.mjs';
import {BENCHMARKS, SCALING_BENCHMARKS, select as selectBenchmarks} from './engine/benchmarks.mjs';
import {SIZES} from './engine/scaling.mjs';
import {engineOverview} from './engine/summary.mjs';
import {runPair} from './lib/run.mjs';
import {buildBundle, measureStartup} from './lib/startup.mjs';
import {explain, overview} from './lib/summary.mjs';
import {open, SCENARIOS, select} from './scenarios/index.mjs';
import {SUITES, suite as suiteNamed} from './suites.mjs';
import {measure, workload, WORKLOADS} from './workloads.mjs';
import {scaled} from './workloads.mjs';

class Usage extends Error {}

/** Splits arguments into words and `--name value` options; `flags` names the options that take no value. */
function parse(argv, flags = []) {
  const words = [], options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) { words.push(argument); continue; }
    const [name, inline] = argument.slice(2).split('=');
    if (flags.includes(name)) options[name] = true;
    else if (inline !== undefined) options[name] = inline;
    else if (index + 1 < argv.length) options[name] = argv[++index];
    else throw new Usage(`--${name} needs a value.`);
  }
  return {words, options};
}
const list = text => String(text).split(',').map(part => part.trim()).filter(Boolean);

async function run(argv) {
  const {words, options} = parse(argv, ['no-profile', 'no-startup', 'raw']);
  if (words.length > 1) throw new Usage('`run` takes one suite name; scenarios go in --scenario.');
  const plan = suiteNamed(words[0] ?? 'quick');
  const environments = (options.env ? list(options.env) : plan.environments).map(environment);
  const workloads = (options.workload ? list(options.workload) : plan.workloads).map(workload);
  const scenarios = select(options.scenario ? list(options.scenario) : plan.scenarios);
  const passes = Number(options.passes ?? plan.passes);
  if (!Number.isInteger(passes) || passes < 1 || passes > 20) throw new Usage('--passes is 1 to 20.');
  const label = options.label ?? timeLabel(), profile = !options['no-profile'], started = performance.now();
  const log = text => console.error(`[perf] ${text}`);
  log(`${environments.length} environment${environments.length === 1 ? '' : 's'} × ${workloads.length} workload${workloads.length === 1 ? '' : 's'} × ${scenarios.length} scenarios, ${passes} timed pass${passes === 1 ? '' : 'es'}${profile ? ' + 1 profiled' : ''}`);
  // Startup is the launch itself: measured apart, on the bundle a packaged app starts from, when the run covers every scenario.
  const measuresStartup = !options['no-startup'] && !options.scenario;
  const bundle = measuresStartup ? await buildBundle().catch(error => { log(`The bundle did not build (${String(error.message).split(/\r?\n/)[0]}): startup is measured from the sources.`); return null; }) : null;
  const pairs = [];
  for (const chosen of environments) {
    const started = measuresStartup && chosen.host === 'desktop' ? await measureStartup(chosen, {launches: Math.max(3, passes), bundle, log}) : null;
    for (const spec of workloads) {
      const pair = await runPair({environment: chosen, workload: {...spec, measured: measure(spec)}, scenarios, open, passes, profile, raw: Boolean(options.raw), log});
      // The environment's startup is shown with its first workload.
      if (started && spec === workloads[0]) pair.scenarios.unshift(started);
      pairs.push(pair);
    }
  }
  const result = {schema: SCHEMA, label, at: new Date().toISOString(), suite: words[0] ?? 'quick', passes, profile, seconds: (performance.now() - started) / 1000, build: build(), machine: machine(), pairs};
  const text = overview(result), folder = write(result, text);
  process.stdout.write(text);
  console.log(`Written to ${folder}`);
  return pairs.some(pair => pair.error || pair.scenarios.some(scenario => scenario.error)) ? 1 : 0;
}

function show(argv) {
  const {words, options} = parse(argv);
  // One word that names a scenario means the latest run.
  const named = words.length === 1 && SCENARIOS.some(scenario => scenario.id === words[0] || scenario.id.includes(words[0]));
  const result = read(named ? 'latest' : words[0] ?? 'latest'), wanted = named ? words[0] : words[1];
  if (!wanted) { process.stdout.write(overview(result)); return 0; }
  let found = 0;
  for (const pair of result.pairs) {
    if ((options.env && pair.environment.id !== options.env) || (options.workload && pair.workload.id !== options.workload)) continue;
    for (const scenario of pair.scenarios) {
      if (scenario.id !== wanted && !scenario.id.includes(wanted)) continue;
      process.stdout.write(`${found++ ? '\n' : ''}${explain(pair, scenario)}`);
    }
  }
  if (!found) throw new Usage(`The run "${result.label}" has no scenario matching ${JSON.stringify(wanted)}${options.env || options.workload ? ' for that environment and workload' : ''}.`);
  return 0;
}

function catalogue() {
  const lines = ['Scenarios (npm run perf -- run --scenario <id or area>):'];
  for (const scenario of SCENARIOS) lines.push(`  ${scenario.id.padEnd(24)} ${scenario.title}`);
  lines.push('', 'Workloads (--workload):', ...Object.values(WORKLOADS).map(spec => `  ${spec.id.padEnd(24)} ${spec.description}`));
  lines.push('', 'Environments (--env):', ...Object.values(ENVIRONMENTS).map(spec => `  ${spec.id.padEnd(24)} ${spec.description}`));
  lines.push('', 'Suites (npm run perf -- run <suite>):', ...Object.entries(SUITES).map(([id, plan]) => `  ${id.padEnd(24)} ${plan.description}`));
  lines.push('', 'Engine benchmarks (npm run perf -- engine --benchmark <id or layer>; one thread in Node, no window):',
    ...BENCHMARKS.map(benchmark => `  ${benchmark.id.padEnd(24)} ${`[${benchmark.layer}]`.padEnd(26)} ${benchmark.title}${SCALING_BENCHMARKS.includes(benchmark) ? ' (also in --scale)' : ''}`));
  console.log(lines.join('\n'));
  return 0;
}

function compared(argv) {
  const {words, options} = parse(argv, ['all', 'fail-on-worse']);
  if (!words.length) throw new Usage('`compare` needs the run to compare against: npm run perf -- compare <base run> [head run].');
  const result = compare(read(words[0]), read(words[1] ?? 'latest'), {all: Boolean(options.all)});
  process.stdout.write(comparisonText(result, {all: Boolean(options.all)}));
  return options['fail-on-worse'] && result.counts.worse ? 1 : 0;
}

/** The engine tier: the default workloads (or --workload), with --scale the scaling sizes too (alone, unless --workload is given). */
async function engine(argv) {
  const {words, options} = parse(argv, ['scale']);
  if (words.length) throw new Usage('`engine` takes no words: workloads go in --workload, benchmarks in --benchmark.');
  const rounds = Number(options.rounds ?? 5);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Usage('--rounds is 1 to 20.');
  const benchmarks = selectBenchmarks(options.benchmark ? list(options.benchmark) : []);
  const workloads = options.workload || !options.scale ? list(options.workload ?? 'small,medium,large,stress').map(workload) : [];
  if (workloads.some(spec => spec.builtin)) throw new Usage('The engine tier measures generated documents: --workload is small, medium, large or stress.');
  const scaleBenchmarks = options.scale ? SCALING_BENCHMARKS.filter(benchmark => benchmarks.includes(benchmark)) : [];
  if (options.scale && !scaleBenchmarks.length) throw new Usage(`--scale measures ${SCALING_BENCHMARKS.map(benchmark => benchmark.id).join(', ')}: --benchmark names none of them.`);
  const label = options.label ?? timeLabel(), log = text => console.error(`[perf engine] ${text}`);
  // Loaded here: the runner brings the editor and the engine, which the other commands do not need.
  const {runEngine} = await import('./engine/run.mjs');
  const result = await runEngine({label, workloads, benchmarks, scaled: scaleBenchmarks.length ? SIZES.map(scaled) : [], scaleBenchmarks, rounds, log});
  const text = engineOverview(result), folder = write(result, text, path.join(ENGINE_RUNS, slug(label)));
  process.stdout.write(text);
  console.log(`Written to ${folder}`);
  return result.workloads.some(row => row.benchmarks.some(benchmark => benchmark.error)) ? 1 : 0;
}

function engineCompared(argv) {
  const {words, options} = parse(argv, ['all', 'fail-on-worse']);
  if (!words.length) throw new Usage('`engine-compare` needs the engine run to compare against: npm run perf -- engine-compare <base> [head].');
  const from = {root: ENGINE_RUNS, schema: ENGINE_SCHEMA}, result = compareEngine(read(words[0], from), read(words[1] ?? 'latest', from));
  process.stdout.write(comparisonText(result, {all: Boolean(options.all)}));
  return options['fail-on-worse'] && result.counts.worse ? 1 : 0;
}

const COMMANDS = {run, show, compare: compared, list: catalogue};
COMMANDS.engine = engine;
COMMANDS['engine-compare'] = engineCompared;

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') { console.log('Usage: npm run perf -- <run|list|show|compare|engine|engine-compare> …  (docs/PERFORMANCE.md; the engine tier: perf/engine/README.md)'); return command ? 0 : 2; }
  if (!COMMANDS[command]) throw new Usage(`Unknown command ${JSON.stringify(command)}: one of ${Object.keys(COMMANDS).join(', ')}.`);
  return COMMANDS[command](rest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (error) {
    console.error(error instanceof Usage ? error.message : error?.stack ?? error);
    process.exit(error instanceof Usage ? 2 : 1);
  }
}
