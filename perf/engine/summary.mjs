/**
 * An engine run as text (perf/engine/README.md "Reading a run"): one screen an agent or a person reads first. The header
 * says what the numbers are (one thread's costs), the capacity figures come next, then per workload one line per benchmark
 * (its first headline metric with its spread, the others after it), then the scaling table. Plain text, no colour.
 */
import {format} from '../lib/metrics.mjs';

const pad = (text, width) => String(text).padEnd(width);
const thousands = value => Math.round(value).toLocaleString('en');
/** A cost in a table cell: three figures at most. */
const cell = value => (!Number.isFinite(value) ? '–' : value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : thousands(value));

/** One capacity as a phrase: "up to 46,000 segments", or why there is no figure. */
function reach(capacity, sizes) {
  if (capacity.segments) return `up to ${thousands(capacity.segments.median)} segments`;
  if (capacity.bound === 'above') return `beyond ${thousands(Math.max(...sizes))} segments (the largest measured)`;
  if (capacity.bound === 'below') return `not even at ${thousands(Math.min(...sizes))} segments (the smallest measured)`;
  return 'not measured';
}

/** The capacity lines of a scaling run: per cost, its reach within a frame at 60 and at 30 frames a second. */
export function capacityLines(scaling) {
  if (!scaling?.capacity.length) return [];
  const lines = ['CAPACITY of one thread (the scaling run: figures of 50 segments):'], seen = new Set();
  for (const row of scaling.capacity) {
    if (seen.has(row.what)) continue;
    seen.add(row.what);
    const limits = scaling.capacity.filter(other => other.what === row.what);
    lines.push(`  ${row.what}: ${limits.map(other => `within ${other.limit.toFixed(1)} ms (${other.rate} frames a second) ${reach(other, scaling.sizes)}`).join('; ')}`);
  }
  return lines;
}

/** One benchmark as a line: id, layer, its first headline metric with its spread, the rest, and the memory peak. */
function benchmarkLine(benchmark) {
  if (benchmark.error) return `   ${pad(benchmark.id, 10)} ${pad(benchmark.layer, 23)} FAILED: ${benchmark.error}`;
  const {metrics, definitions} = benchmark, [first, ...rest] = benchmark.headline.filter(key => metrics[key]);
  const shown = key => format(key, metrics[key]?.median, definitions);
  const lead = first ? `${shown(first)} ±${format(first, metrics[first].mad, definitions).replace(/ .*$/, '')}` : '–';
  const others = rest.map(key => `${key} ${shown(key)}`);
  if (metrics['memory.peak']) others.push(`peak ${shown('memory.peak')}`);
  return `   ${pad(benchmark.id, 10)} ${pad(benchmark.layer, 23)} ${pad(lead, 18)} ${others.join(' · ')}`;
}

/** The scaling table: per scaled metric its median at each size, its slope, its growth and where it crosses a frame's time. */
function scalingLines(scaling) {
  const lines = ['== Scaling: figures of 50 segments, 41 frames; the median cost at each size (ms) of one thread',
    `   ${pad('', 26)} ${scaling.sizes.map(size => thousands(size).padStart(8)).join('')}   ${pad('per 1,000', 10)} ${pad('growth', 26)} ${scaling.rows[0]?.crossings.map(row => pad(`${row.limit.toFixed(1)} ms at`, 12)).join('') ?? ''}`];
  for (const row of scaling.rows) {
    const growth = row.growth ? `${row.growth.verdict ?? '–'}${row.growth.exponent !== null ? ` (exponent ${row.growth.exponent.toFixed(2)})` : ''}` : '–';
    const crossings = row.crossings.map(found => pad(found.bound === 'within' ? thousands(found.segments) : found.bound === 'above' ? 'beyond' : found.bound === 'below' ? 'below' : '–', 12)).join('');
    lines.push(`   ${pad(`${row.benchmark} ${row.metric}`, 26)} ${row.points.map(point => cell(point.median).padStart(8)).join('')}   ${pad(row.growth ? `${cell(row.growth.slope)} ms` : '–', 10)} ${pad(growth, 26)} ${crossings}`);
  }
  return lines;
}

/** The whole engine run on a page. */
export function engineOverview(result) {
  const {build, machine, load} = result;
  const lines = [`StykAnimate engine run "${result.label}"`,
    `${build.commit ?? 'no commit'}${build.dirty ? ' + uncommitted changes' : ''} (${build.branch ?? '?'}), engine build ${build.engine?.sha256 ?? '?'} (${build.engine?.profile ?? '?'}) · ${machine.cpu}, ${machine.threads} threads, ${machine.memoryGB} GB · Node ${machine.node}`,
    'ONE THREAD: the engine runs here in Node without its workers, so every number is what one thread costs. The app spreads playback,',
    'opening and saving over its worker threads, and draws the stage on the graphics card, which is not measured here (perf/engine/README.md).',
    `${result.rounds} round${result.rounds === 1 ? '' : 's'} after a warm-up per benchmark; the median of the rounds ± their median deviation; ${Math.round(result.seconds)} s in all, ${Math.round(result.processorSeconds ?? 0)} s of processor time.`];
  if (result.referenceMs) lines.push(`The machine's speed: a fixed piece of JavaScript took ${result.referenceMs.toFixed(2)} ms a round (perf/engine/speed.mjs); engine-compare counts two runs at one speed.`);
  const busy = Math.max(load?.beforePercent ?? 0, load?.afterPercent ?? 0);
  if (busy > 20) lines.push(`The machine was busy with other work (${load.beforePercent}% of its processor before the run, ${load.afterPercent}% after): the numbers are slower and noisier than on a quiet machine.`);
  lines.push('');
  const capacity = capacityLines(result.scaling);
  if (capacity.length) lines.push(...capacity, '');
  for (const workload of result.workloads.filter(row => !row.scaling)) {
    lines.push(`== ${workload.id}: ${thousands(workload.figures)} figures (${thousands(workload.segmentsPerFrame)} segments a frame), ${workload.frames} frames, ${workload.jsonMB} MB of JSON; `
      + `the engine holds ${workload.memory.openMB} MB once it is open (${workload.seconds} s, ${workload.processorSeconds} s of processor time)`, ...workload.benchmarks.map(benchmarkLine), '');
  }
  if (result.scaling) lines.push(...scalingLines(result.scaling), '');
  lines.push('Every metric with its spread and rounds: result.json. Two runs compared: npm run perf -- engine-compare <base> [head].');
  return `${lines.join('\n')}\n`;
}
