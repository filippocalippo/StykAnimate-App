/** Fresh-process startup comparison with identical captured dependencies.
 * Only the three localization-owning core modules differ between graphs.
 * Snapshot preparation, process creation, and GC are outside import timing. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

const ref = process.argv[2] ?? '35ebad9b', output = process.argv[3];
if (!output) throw new Error('Usage: node scripts/benchmark-worker-startup.mjs <control-ref> <output.json> [samples=5]');
if (!/^[a-f0-9]{7,40}$/i.test(ref)) throw new Error('The frozen control reference must be a commit hash.');
const samples = Number(process.argv[4] ?? 5);
if (!Number.isInteger(samples) || samples < 3 || samples > 20) throw new Error('Choose 3 to 20 samples.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = process.cwd(), git = args => execFileSync('git', args, {encoding: 'utf8'}).trim();
const controlCommit = git(['rev-parse', `${ref}^{commit}`]), objectFormat = git(['rev-parse', '--show-object-format']);
const gitBlob = bytes => createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const snapshotRoot = path.resolve('artifacts/performance-improvements/control-workers', controlCommit, `${Date.now()}-${randomUUID()}`);
const production = path.join(snapshotRoot, 'production'), control = path.join(snapshotRoot, 'control');
const frozenOwners = ['src/keyframe-easing.mjs', 'src/export-sampling.mjs', 'src/movieclip-drawings.mjs'];
const benchmarkFile = 'scripts/benchmark-worker-startup.mjs';
const roots = ['document-export-worker.mjs'];
async function treeHashes(directory) {
  const result = {};
  async function visit(relative) {
    for (const entry of (await readdir(path.join(directory, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(directory, file));
        result[file.replaceAll('\\', '/')] = {sha256: sha(bytes), gitBlob: gitBlob(bytes), bytes: bytes.length};
      } else throw new Error(`Unsupported source entry in the snapshot: ${file}`);
    }
  }
  await visit('src'); await visit('vendor'); return result;
}
const sourceChanges = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter(file => before[file]?.sha256 !== after[file]?.sha256);
async function prepareSnapshots(liveBefore) {
  // Each pair receives the same captured bytes, even if an unrelated live file
  // changes while preparation runs. Only the measured owner bytes must remain
  // identical to the live source throughout the comparison.
  for (const file of Object.keys(liveBefore)) {
    const bytes = await readFile(path.join(root, file));
    for (const directory of [production, control]) {
      const captured = path.join(directory, file);
      await mkdir(path.dirname(captured), {recursive: true});
      await writeFile(captured, bytes, {flag: 'wx'});
    }
  }
  const ownerBlobIds = Object.fromEntries(frozenOwners.map(file => [file, git(['rev-parse', `${controlCommit}:${file}`])]));
  for (const file of frozenOwners) {
    const bytes = execFileSync('git', ['show', `${controlCommit}:${file}`]);
    assert.equal(gitBlob(bytes), ownerBlobIds[file], `Git returned different bytes for ${file}.`);
    await writeFile(path.join(control, file), bytes);
  }
  const captured = {production: await treeHashes(production), control: await treeHashes(control)};
  const liveAfterPreparation = await treeHashes(root);
  assert.deepEqual(Object.keys(captured.control), Object.keys(captured.production), 'Snapshot files must agree.');
  assert.deepEqual(Object.keys(captured.production), Object.keys(liveBefore), 'All captured source files must be recorded.');
  for (const [file, fingerprint] of Object.entries(captured.control)) {
    if (frozenOwners.includes(file)) assert.equal(fingerprint.gitBlob, ownerBlobIds[file], `Frozen owner differs from Git: ${file}`);
    else assert.deepEqual(fingerprint, captured.production[file], `Shared dependency differs between isolated graphs: ${file}`);
  }
  for (const file of frozenOwners) {
    assert.deepEqual(captured.production[file], liveBefore[file], `Owner changed while capturing the snapshot: ${file}`);
    assert.deepEqual(liveAfterPreparation[file], liveBefore[file], `Live owner changed during snapshot preparation: ${file}`);
  }
  return {...captured, liveAfterPreparation, ownerBlobIds,
    preparationLiveSourceChanges: sourceChanges(liveBefore, liveAfterPreparation),
    capturedDependencyDifferences: sourceChanges(liveBefore, captured.production)};
}
const benchmarkHash = sha(await readFile(path.join(root, benchmarkFile)));
const measuredHead = git(['rev-parse', 'HEAD']);
const liveBefore = await treeHashes(root), snapshots = await prepareSnapshots(liveBefore);
const sources = [...frozenOwners.map(file => file.slice(4)), ...roots];
const hashes = Object.fromEntries(sources.map(file => [file, snapshots.production[`src/${file}`].sha256]));
const controlHashes = Object.fromEntries(sources.map(file => [file, snapshots.control[`src/${file}`].sha256]));
const rows = [];
for (const module of roots) for (let sample = 0; sample < samples; sample++) {
  for (const mode of sample % 2 ? ['production', 'control'] : ['control', 'production']) {
    const source = pathToFileURL(path.join(mode === 'control' ? control : production, 'src', module)).href;
    const script = `globalThis.self={addEventListener(){},postMessage(){}};
      globalThis.gc();const before=process.memoryUsage(),start=performance.now();
      await import(${JSON.stringify(source)});const importMs=performance.now()-start;
      globalThis.gc();const after=process.memoryUsage();
      console.log(JSON.stringify({importMs,retainedHeapBytes:after.heapUsed-before.heapUsed,arrayBufferBytes:after.arrayBuffers-before.arrayBuffers}));`;
    const measured = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {encoding: 'utf8'}));
    assert.ok(Number.isFinite(measured.importMs) && measured.importMs >= 0, `Invalid import measurement for ${module}.`);
    assert.ok(Number.isFinite(measured.retainedHeapBytes) && Number.isFinite(measured.arrayBufferBytes), `Invalid memory measurement for ${module}.`);
    rows.push({module, sample, mode, ...measured});
  }
}
const capturedAfter = {production: await treeHashes(production), control: await treeHashes(control)};
assert.deepEqual(capturedAfter.production, snapshots.production, 'Captured production graph changed during timing.');
assert.deepEqual(capturedAfter.control, snapshots.control, 'Captured control graph changed during timing.');
const liveAfter = await treeHashes(root);
for (const file of frozenOwners) assert.deepEqual(liveAfter[file], liveBefore[file], `Live owner changed during timing: ${file}`);
assert.equal(sha(await readFile(path.join(root, benchmarkFile))), benchmarkHash, 'Benchmark code changed during the comparison.');
const median = numbers => numbers.toSorted((a, b) => a - b)[Math.floor(numbers.length / 2)];
const summary = Object.fromEntries(roots.map(module => [module, Object.fromEntries(['control', 'production'].map(mode => {
  const measured = rows.filter(row => row.module === module && row.mode === mode);
  return [mode, {medianImportMs: median(measured.map(row => row.importMs)), medianRetainedHeapBytes: median(measured.map(row => row.retainedHeapBytes))}];
}))]));
await mkdir(path.dirname(output), {recursive: true});
await writeFile(output, JSON.stringify({measuredAt: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model,
  controlRef: ref, controlCommit, hashes, controlHashes, summary, rows,
  git: {head: measuredHead},
  benchmark: {file: benchmarkFile, sha256: benchmarkHash},
  control: {directory: path.relative(root, control).replaceAll('\\', '/'), frozenOwners,
    method: 'Capture current src/vendor into two immutable graphs; replace only the three localization-owning core modules with verified Git bytes in the control.',
    gitObjectFormat: objectFormat, ownerBlobIds: snapshots.ownerBlobIds},
  production: {directory: path.relative(root, production).replaceAll('\\', '/')},
  settings: {samples, workerRoots: roots, freshNodeProcesses: true, gcOutsideTiming: true, counterbalanced: true},
  sourceTrees: {liveBefore, liveAfterPreparation: snapshots.liveAfterPreparation,
    production: snapshots.production, control: snapshots.control, liveAfter},
  sourceChanges: {duringPreparation: snapshots.preparationLiveSourceChanges,
    capturedDependencyDifferences: snapshots.capturedDependencyDifferences,
    duringTiming: sourceChanges(snapshots.liveAfterPreparation, liveAfter)},
  guards: {frozenOwnersMatchGit: true, sharedFilesByteIdentical: Object.keys(snapshots.production).length - frozenOwners.length,
    allCapturedTreesUnchanged: true, productionOwnersMatchLive: true, liveOwnersUnchanged: true, benchmarkUnchanged: true},
  limitations: ['Fresh Node processes approximate worker module preparation, not Electron worker startup or rendering latency.',
    'Identical self event-handler stub in both conditions; no worker messages or pixel work executed.',
    'Forced GC occurs outside import timing; retained heap is a Node-process difference, not total application or Chromium memory.',
    'Counterbalanced process starts; OS cache and other workstation tasks are uncontrolled.',
    'Only the three localization-owning modules differ between immutable captured graphs; shared dependencies are the same current captured bytes.',
    'Unrelated live source changes are recorded, not attributed to the measured worker import; only the captured graphs execute in the children.']}, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify(summary));
