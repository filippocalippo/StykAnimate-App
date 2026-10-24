/** Compare the production export worker with a committed control on identical
 * read-only projects. Excludes drawing publication, browser UI, IPC and disk. */
import {readFile, writeFile, mkdir, readdir, mkdtemp} from 'node:fs/promises';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {Worker as NodeWorker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = path.join(root, 'artifacts', 'document-saving-2026-10-01');
const files = ['src/document-export.mjs', 'src/document-export-worker.mjs'];
const median = values => { const sorted = [...values].sort((a, b) => a - b), half = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2; };

if (!isMainThread) {
  globalThis.self = {postMessage: value => parentPort.postMessage(value), addEventListener(type, listener) {
    if (type === 'message') parentPort.on('message', data => listener({data}));
  }};
  await import(workerData.target);
} else if (process.argv.includes('--child')) {
  const args = JSON.parse(process.argv.at(-1));
  // The control commit's own container codec is in the runtime for its worker; the project is opened with this tree's.
  const {openDocument} = await import(pathToFileURL(path.join(root, 'tests/support/native-files.mjs')).href);
  const {expandPoseSequencesSteps} = await import(pathToFileURL(path.join(args.runtime, 'src/pose-sequence-storage.mjs')).href);
  const {DocumentExporter} = await import(args.exporter);
  const raw = await readFile(args.filename), report = await openDocument(raw, 'styk', {verifySource: false}), seen = new Set();
  function expand(document) {
    if (seen.has(document)) return; seen.add(document);
    for (const step of expandPoseSequencesSteps(document)) void step;
    for (const figure of document.figure_types ?? []) if (figure._styk?.movieclip?.document) expand(figure._styk.movieclip.document);
    if (document._styk?.movieclipSource?.document) expand(document._styk.movieclipSource.document);
  }
  expand(report);
  const terminations = [], workers = [];
  class WorkerFacade extends EventTarget {
    constructor(url) {
      super(); this.started = performance.now(); workers.push(this);
      this.worker = new NodeWorker(new URL(import.meta.url), {workerData: {target: url.href}});
      this.worker.on('message', data => {
        this.firstAckMs ??= performance.now() - this.started;
        const event = new Event('message'); event.data = data; this.dispatchEvent(event);
      });
      this.worker.on('error', error => { const event = new Event('error', {cancelable: true}); event.message = error.message; this.dispatchEvent(event); });
    }
    postMessage(value, transfer) { this.worker.postMessage(value, transfer); }
    terminate() { if (!this.terminated) { this.terminated = true; terminations.push(this.worker.terminate()); } }
  }
  globalThis.Worker = WorkerFacade;
  const exporter = new DocumentExporter({baseURL: 'http://127.0.0.1:47831'}), runs = [];
  for (let i = 0; i < 4; i++) {
    if (i === 3) {
      const object = report.keyframes?.find(frame => frame.objects?.length)?.objects[0];
      if (object) object.root_x += .125;
      report.benchmarkOpaqueMetadata = {exactFractionalEdit: .125};
    }
    const start = performance.now(), blob = await exporter.export(report, {name: 'Read-only saving benchmark'});
    const bytes = new Uint8Array(await blob.arrayBuffer());
    runs.push({mode: i === 0 ? 'cold' : i === 3 ? 'small-edit' : 'unchanged', wallMs: performance.now() - start,
      bytes: bytes.length, sha256: hash(bytes), firstAckMs: workers.at(-1).firstAckMs, ...exporter.lastTimings});
  }
  exporter.dispose(); await Promise.all(terminations);
  console.log(JSON.stringify({label: args.label, variant: args.variant, inputBytes: raw.length, inputSha256: hash(raw),
    workersCreated: workers.length, peakProcessRssKiB: process.resourceUsage().maxRSS, runs}));
} else {
  const control = process.argv.find(value => value.startsWith('--control='))?.slice(10);
  if (!control || !/^[a-f0-9]{8,40}$/.test(control)) throw new Error('Pass --control=<commit SHA> for the comparison.');
  await mkdir(output, {recursive: true});
  // Both variants import one immutable dependency graph. Other editing tasks
  // cannot change their runtime between pairs on the shared workstation.
  const runtime = await mkdtemp(path.join(output, 'runtime-')), runtimeHashes = {};
  async function capture(relative) {
    await mkdir(path.join(runtime, relative), {recursive: true});
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
      const filename = path.join(relative, entry.name);
      if (entry.isDirectory()) await capture(filename);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(root, filename));
        await writeFile(path.join(runtime, filename), bytes);
        runtimeHashes[filename.replaceAll('\\', '/')] = hash(bytes);
      }
    }
  }
  await capture('src'); await capture('vendor');
  // A control from before the Rust container module brings its own JavaScript container codec.
  if (spawnSync('git', ['cat-file', '-e', `${control}:src/native-container.mjs`], {cwd: root}).status === 0) files.push('src/native-container.mjs');
  const controlDir = path.join(runtime, 'control'); await mkdir(controlDir, {recursive: true});
  const controlHashes = {}, currentHashes = {}, adaptedControlHashes = {};
  for (const file of files) {
    const original = execFileSync('git', ['show', `${control}:${file}`], {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    controlHashes[file] = hash(original); currentHashes[file] = runtimeHashes[file];
    const adapted = original.replace(/(['"])(\.{1,2}\/[^'"\r\n]+\.mjs)\1/g, (match, quote, relative) => {
      const target = path.resolve(root, path.dirname(file), relative);
      const controlled = files.find(candidate => path.join(root, candidate) === target);
      return JSON.stringify(pathToFileURL(controlled ? path.join(controlDir, path.basename(controlled)) : path.join(runtime, path.relative(root, target))).href);
    });
    adaptedControlHashes[file] = hash(adapted);
    await writeFile(path.join(controlDir, path.basename(file)), adapted);
  }
  // Pass your own projects with --input=<label>=<project path>.
  const fixtures = [];
  for (const argument of process.argv.filter(value => value.startsWith('--input='))) {
    const match = /^--input=([a-z0-9-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error('Use --input=<label>=<project path>, with a lowercase label.');
    fixtures.push([match[1], path.resolve(match[2])]);
  }
  const selected = process.argv.find(value => value.startsWith('--sample='))?.slice(9), results = [];
  const pairs = Number(process.argv.find(value => value.startsWith('--pairs='))?.slice(8) ?? 1);
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 10) throw new Error('Choose 1 to 10 benchmark pairs.');
  if (selected && !fixtures.some(([label]) => label === selected)) throw new Error('The selected fixture is unavailable.');
  for (const [label, filename] of fixtures) {
    if (selected && label !== selected) continue;
    for (let pair = 0; pair < pairs; pair++) {
      for (const variant of pair % 2 ? ['current', 'control'] : ['control', 'current']) {
        const exporter = pathToFileURL(variant === 'control' ? path.join(controlDir, 'document-export.mjs') : path.join(runtime, files[0])).href;
        const result = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify({label, filename, exporter, variant, runtime})], {cwd: root, windowsHide: true});
          let stdout = '', stderr = '';
          child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
          child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`${label}/${variant}: ${stderr || stdout || `exit ${code}`}`)));
        });
        result.pair = pair; results.push(result); console.log(JSON.stringify(result));
        await writeFile(path.join(output, `comparison${selected ? '-' + selected : ''}.json`), JSON.stringify({control, controlHashes, adaptedControlHashes, currentHashes, runtime, runtimeHashes,
          harnessSha256: hash(await readFile(fileURLToPath(import.meta.url))), node: process.version, nodeOptions: process.env.NODE_OPTIONS ?? '',
          cpu: os.cpus()[0].model, measuredAt: new Date().toISOString(), results}, null, 2) + '\n');
      }
      const rows = results.slice(-2), before = rows.find(row => row.variant === 'control'), after = rows.find(row => row.variant === 'current');
      assert.equal(before.inputSha256, after.inputSha256);
      for (let i = 0; i < before.runs.length; i++) assert.equal(before.runs[i].sha256, after.runs[i].sha256, `${label} run ${i} output changed`);
      console.log(JSON.stringify({label, unchangedReductionPercent: 100 * (1 - median(after.runs.slice(1, 3).map(run => run.wallMs)) / median(before.runs.slice(1, 3).map(run => run.wallMs))),
        editedReductionPercent: 100 * (1 - after.runs[3].wallMs / before.runs[3].wallMs)}));
      for (const file of files) assert.equal(currentHashes[file], hash(await readFile(path.join(root, file))), `${file} changed during benchmark`);
    }
  }
  for (const file of files) assert.equal(currentHashes[file], hash(await readFile(path.join(root, file))), `${file} changed during benchmark`);
}
