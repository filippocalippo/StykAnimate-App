/** Serial, reproducible audit driver; does not replace production implementations.
 * node scripts/benchmark-codebase-sweep.mjs [label] [kernels|evidence]
 * Detailed output stays local; the audit's reviewed evidence summary is committed.
 */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {performanceSourceHashes} from './performance-source-hashes.mjs';

const label = process.argv[2] ?? 'codebase-sweep', mode = process.argv[3] ?? 'kernels';
assert.match(label, /^[a-zA-Z0-9_-]+$/);
assert.ok(['kernels', 'evidence'].includes(mode));
if (mode === 'evidence') {
  // Collect this audit's fixed recorded runs; never substitute newly generated
  // samples into the report silently. A later audit should use its own dates.
  const base = 'artifacts/codebase-sweep/sweep-20261001', later = base + '-r2';
  const read = async name => JSON.parse(await readFile(name, 'utf8'));
  const evidence = {at: new Date().toISOString(), scope: 'Codebase performance sweep, 1 October 2026',
    benchmarkSources: {}, developmentSourceHashes: await performanceSourceHashes(),
    environment: {node: process.version, cpu: os.cpus()[0].model, ramBytes: os.totalmem(),
      platform: process.platform, release: os.release(), releaseRuntimeMismatch: 'Node 24.16.0 and Python 3.11.15; release CI pins Node 24.11.0/Python 3.12.9'},
    measurements: {}};
  for (const name of ['benchmark-codebase-sweep.mjs', 'benchmark-codec-topology-sweep.py',
    'benchmark-layer-sheet-sweep.mjs',
    'benchmark-localization-sweep.mjs'])
    evidence.benchmarkSources[`scripts/${name}`] = createHash('sha256').update(await readFile(`scripts/${name}`)).digest('hex');
  for (const name of ['animation-modes', 'animation-locality', 'builder', 'node-selection',
    'rig-constraints', 'movieclips', 'telemetry', 'connected-transactions'])
    evidence.measurements[name] = await read(`${base}/${name}.json`);
  evidence.measurements.audio = await read(`${base}/audio/benchmark.json`);
  evidence.measurements.animationMemory = await read(`${base}/animation-memory/memory.json`);
  evidence.measurements.layerSheet = await read('artifacts/performance-sweep/layer-sheet/sweep-20261001.json');
  evidence.measurements.layerSheetSourceCheck = await read(`${later}/layer-sheet-source-check.json`);
  evidence.measurements.localization = await read('artifacts/performance-sweep/sweep-20261001-r2/localization.json');
  evidence.measurements.stkTopology = await read(`${later}/stk-topology.json`);
  evidence.measurements.browser = await read(`${later}/browser.json`);
  evidence.measurements.browserSourceCheck = await read(`${later}/browser-source-check.json`);
  evidence.measurements.browserSourceHashes = await read(`${later}/browser-source-before.json`);
  evidence.measurements.shell = await read('artifacts/shell-startup/sweep-20261001-r2/report.json');
  evidence.verification = await read(`${later}/verification.json`);
  evidence.measurements.desktop = await Promise.all([30, 300].map(async figures => ({figures,
    report: await read(`artifacts/performance-goal/sweep-20261001-r2-${figures}/report.json`)})));
  // Full hashes appear once where many reports certify the same bytes. Keep
  // per-run differences explicitly; never flatten differing source versions.
  for (const item of evidence.measurements.desktop) {
    const version = item.report.sourceHashes;
    item.report.sourceDifferencesFromDevelopment = Object.keys(version).filter(name => version[name] !== evidence.developmentSourceHashes[name]);
    item.report.recordedSourceHashes = Object.fromEntries(item.report.sourceDifferencesFromDevelopment.map(name => [name, version[name]]));
    delete item.report.sourceHashes;
    for (const row of item.report.rows) {
      const sum = processes => processes?.reduce((bytes, process) => bytes + (process.memory?.workingSetSize ?? 0), 0);
      row.summedWorkingSetKiB = {startup: sum(row.baseline?.processes), imported: sum(row.processes), playback: sum(row.playbackProcesses)};
      delete row.baseline?.processes; delete row.processes; delete row.playbackProcesses;
      // Preserve playback time-series working set evidence, not process PIDs.
      for (const sample of row.playbackMemorySamples ?? []) for (const process of sample.processes ?? []) delete process.pid;
    }
  }
  evidence.limitations = ['No production implementation was changed. Prototype results are operation-specific.',
    'Concurrent unrelated renderer/drawing/timeline/VFX development is preserved. Per-run hashes and source differences identify measurement states.',
    'No private dense PIV corpus, packaged release, second GPU, active marketing site or deployed D1 database was measured.',
    'Local logs include failed first attempts; those are excluded from valid benchmark conclusions and documented in the audit.'];
  const filename = 'artifacts/codebase-sweep/evidence.json';
  await mkdir(path.dirname(filename), {recursive: true});
  const clean = JSON.stringify(evidence, null, 2).replaceAll(JSON.stringify(process.cwd()).slice(1, -1), '<repo>').replaceAll(process.cwd(), '<repo>')
    .replaceAll(process.cwd().replaceAll('\\', '/'), '<repo>');
  await writeFile(filename, clean + '\n');
  console.log(`Evidence: ${filename}`);
  process.exit(0);
}
const output = path.resolve('artifacts/codebase-sweep', label);
await mkdir(output, {recursive: true});
const before = await performanceSourceHashes();
const report = {at: new Date().toISOString(), label, mode,
  environment: {node: process.version, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(), platform: process.platform, os: os.release()},
  head: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  initialStatus: execFileSync('git', ['status', '--short'], {encoding: 'utf8'}),
  sourceHashes: before, rows: [],
  limitations: ['Development working tree; OS caches and other workstation activity uncontrolled.',
    'Jobs run serially. Kernel timings, readiness, GPU completion and physical display latency differ.',
    'Synthetic fixtures certify these workloads only; private dense artwork corpus is unavailable on this host.']};
async function run(name, args, env = {}) {
  const started = performance.now(), log = path.join(output, `${name}.log`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: process.cwd(), windowsHide: true,
      env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
  await writeFile(log, result.stdout + '\nSTDERR\n' + result.stderr);
  report.rows.push({name, args, env, elapsedMs: performance.now() - started,
    exitCode: result.code, signal: result.signal, log: path.basename(log)});
  await writeFile(path.join(output, `manifest-${mode}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.rows.at(-1)));
}
{
  const jobs = [
    ['animation-modes', ['--expose-gc', 'scripts/benchmark-animation-modes.mjs', label]],
    ['animation-locality', ['--expose-gc', 'scripts/benchmark-animation-locality.mjs', '.', path.join(output, 'animation-locality.json')]],
    ['animation-memory', ['--expose-gc', 'scripts/benchmark-animation-memory.mjs'], {STYK_BENCH_OUT: path.join(output, 'animation-memory')}],
    ['connected-transactions', ['scripts/benchmark-connected-transactions.mjs']],
    ['builder', ['scripts/benchmark-builder.mjs', label]],
    ['node-selection', ['scripts/benchmark-node-selection.mjs']],
    ['rig-constraints', ['--expose-gc', 'scripts/benchmark-rig-constraints.mjs']],
    ['movieclips', ['scripts/benchmark-movieclips.mjs']],
    ['audio', ['scripts/benchmark-audio.mjs'], {STYK_BENCH_OUT: path.join(output, 'audio')}],
    ['telemetry', ['scripts/benchmark-telemetry.mjs']],
  ];
  for (const [name, args, env] of jobs) await run(name, args, env);
  for (const [name, source] of Object.entries({
    'animation-modes': `artifacts/animation-mode-performance/${label}.json`,
    'connected-transactions': 'artifacts/connected-editing/transactions/report.json',
    builder: `artifacts/builder-performance/${label}.json`,
    'node-selection': 'artifacts/join-selection/benchmark.json',
    'rig-constraints': 'artifacts/rig-constraints/benchmark.json',
    movieclips: 'artifacts/movieclips/performance.json', telemetry: 'artifacts/telemetry-performance.json',
  })) {
    if (report.rows.find(row => row.name === name)?.exitCode === 0)
      await writeFile(path.join(output, `${name}.json`), await readFile(source));
  }
}
const after = await performanceSourceHashes();
report.changedSourcePaths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]);
await writeFile(path.join(output, `manifest-${mode}.json`), JSON.stringify(report, null, 2));
assert.deepEqual(report.changedSourcePaths, [], 'Sources changed during measurement.');
if (report.rows.some(row => row.exitCode !== 0)) process.exitCode = 1;
