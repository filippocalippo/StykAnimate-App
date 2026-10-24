#!/usr/bin/env node
// Summarises engine benchmark runs (scripts/engine-benchmark.mjs) as Markdown tables:
// the median of every run of a configuration, with its range and run count.
//
//   node scripts/engine-bench-summary.mjs <label> [--against <label>] [--bench <dir>]
//
// Reads artifacts/engine-rust/bench/<label>/<config>/<file>/run-*.json. With --against,
// each cell shows the other label's median next to this one's (before → after).
// Runs the driver marked busy (the machine never became idle) are listed, not hidden.
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const label = args[0];
if (!label || label.startsWith('--')) { console.error('usage: node scripts/engine-bench-summary.mjs <label> [--against <label>]'); process.exit(2); }
const bench = path.resolve(option('--bench') ?? 'artifacts/engine-rust/bench');
const against = option('--against');

const CONFIGS = ['electron-gpu-t1', 'electron-canvas-t1', 'web-chromium-gpu-t1', 'web-webkit-gpu-t1', 'electron-gpu-t4', 'electron-canvas-t4', 'web-chromium-gpu-t1-touch'];
const CONFIG_NAMES = {'electron-gpu-t1': 'Electron, WebGPU', 'electron-canvas-t1': 'Electron, no WebGPU', 'web-chromium-gpu-t1': 'Web, Chromium',
  'web-webkit-gpu-t1': 'Web, WebKit', 'electron-gpu-t4': 'Electron, WebGPU, 4× throttle', 'electron-canvas-t4': 'Electron, no WebGPU, 4× throttle',
  'web-chromium-gpu-t1-touch': 'Web, Chromium, phone touch'};
/** [column, unit, read(run)] — what each table shows, in workload order. */
const METRICS = [
  ['Open', 'ms', r => r.workloads.open?.ms],
  ['First frame', 'ms', r => r.workloads.open?.firstFrame?.ms],
  ['Playback wall / nominal', '×', r => r.workloads.playback?.wallOverNominal],
  ['Playback gap p95', 'ms', r => r.workloads.playback?.tickGaps?.p95],
  ['Playback gap max', 'ms', r => r.workloads.playback?.tickGaps?.max],
  ['Gaps > 2 intervals', '', r => r.workloads.playback?.tickGapsOver2Intervals],
  ['Playback long tasks', '', r => r.workloads.playback?.longTasks?.count],
  ['Scrub latency p95', 'ms', r => r.workloads.scrub?.latencyMs?.p95],
  ['Scrub long tasks', '', r => r.workloads.scrub?.longTasks?.count],
  ['Zoom latency p95', 'ms', r => r.workloads.zoom?.latencyMs?.p95],
  ['Pan latency p95', 'ms', r => r.workloads.pan?.latencyMs?.p95],
  ['Zoom + pan long tasks', '', r => sum(r.workloads.zoom?.longTasks?.count, r.workloads.pan?.longTasks?.count)],
  ['Joint drag latency p95', 'ms', r => r.workloads.drag?.latencyMs?.p95],
  ['Drag long tasks', '', r => r.workloads.drag?.longTasks?.count],
  ['Brush latency p95', 'ms', r => r.workloads.draw?.latencyMs?.p95],
  ['Onion toggle p50', 'ms', r => r.workloads.onion?.actionToFrameMs?.p50],
  ['PNG export', 'frames/s', r => r.workloads['export-png']?.framesPerSecond],
  ['GIF export', 'frames/s', r => r.workloads['export-gif']?.framesPerSecond],
  ['Video export', 'frames/s', r => r.workloads['export-video']?.framesPerSecond],
  ['Peak resident', 'MiB', r => r.workloads.memory?.peakRssMiB],
  ['GPU memory', 'MiB', r => r.workloads.memory?.gpuMemoryMiB],
  ['Load at start (1 min)', '', r => r.host?.loadStart?.[0]],
];
const sum = (...values) => values.some(v => v === undefined || v === null) ? undefined : values.reduce((a, b) => a + b, 0);

function runs(of, config, file) {
  const folder = path.join(bench, of, config, file);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^run-\d+\.json$/.test(name)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)))
    .map(name => ({name, ...JSON.parse(readFileSync(path.join(folder, name), 'utf8'))}));
}
function median(values) {
  const sorted = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return {median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, min: sorted[0], max: sorted.at(-1), n: sorted.length};
}
const format = v => v === null || v === undefined ? '–' : Number.isInteger(v) || Math.abs(v) >= 100 ? String(Math.round(v)) : Math.abs(v) >= 10 ? v.toFixed(1) : String(+v.toFixed(2));
const cell = stats => !stats ? '–' : stats.n === 1 ? `${format(stats.median)} (1 run)` : stats.min === stats.max ? format(stats.median) : `${format(stats.median)} (${format(stats.min)}–${format(stats.max)})`;

const root = path.join(bench, label);
if (!existsSync(root)) { console.error(`no runs under ${root}`); process.exit(1); }
const files = [...new Set(readdirSync(root).flatMap(config => {
  const folder = path.join(root, config);
  try { return readdirSync(folder).filter(name => name !== 'cold-start' && existsSync(path.join(folder, name, 'run-1.json'))); } catch { return []; }
}))].sort();
const lines = [];
const busy = [];
for (const file of files) {
  const configs = CONFIGS.filter(config => runs(label, config, file).length);
  if (!configs.length) continue;
  const first = runs(label, configs[0], file)[0];
  lines.push(`#### ${first.file?.name ?? file}`, '');
  lines.push(`| Metric | ${configs.map(config => CONFIG_NAMES[config] ?? config).join(' | ')} |`, `| --- |${configs.map(() => ' ---: |').join('')}`);
  for (const [name, unit, read] of METRICS) {
    const cells = configs.map(config => {
      const mine = median(runs(label, config, file).map(read));
      if (!against) return cell(mine);
      const theirs = median(runs(against, config, file).map(read));
      return `${theirs ? format(theirs.median) : '–'} → ${mine ? format(mine.median) : '–'}`;
    });
    lines.push(`| ${name}${unit ? ` (${unit})` : ''} | ${cells.join(' | ')} |`);
  }
  lines.push(`| Runs | ${configs.map(config => runs(label, config, file).length).join(' | ')} |`, '');
  for (const config of configs) for (const run of runs(label, config, file)) if (run.host?.busy) busy.push(`${config}/${file}/${run.name}`);
}
// Cold start and bundle size are runs of their own.
const cold = runs(label, 'electron-gpu-t1', 'cold-start');
if (cold.length) {
  lines.push('#### Cold start (Electron, WebGPU, editor view)', '', '| Metric | Value |', '| --- | ---: |');
  lines.push(`| Ready (ms) | ${cell(median(cold.map(r => r.coldStart?.readyMs)))} |`, `| First paint (ms) | ${cell(median(cold.map(r => r.coldStart?.firstPaintMs)))} |`, `| Runs | ${cold.length} |`, '');
}
const bundle = existsSync(path.join(root, 'bundle-size')) ? readdirSync(path.join(root, 'bundle-size')).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(path.join(root, 'bundle-size', n), 'utf8'))).at(-1) : null;
if (bundle?.bundle) {
  const mib = n => (n / 1048576).toFixed(1);
  lines.push('#### Web build size', '', '| Part | Files | Bytes (MiB) | Brotli 5 (MiB) |', '| --- | ---: | ---: | ---: |');
  for (const [part, group] of Object.entries(bundle.bundle.groups)) lines.push(`| ${part} | ${group.files} | ${mib(group.bytes)} | ${mib(group.brotli5)} |`);
  lines.push('');
}
if (busy.length) lines.push(`Runs that started on a busy machine (load ≥ threshold after 10 minutes of waiting): ${busy.join(', ')}.`, '');
console.log(lines.join('\n'));
