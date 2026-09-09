/** Isolated real-worker CPU diagnostic: copied keys pasted into the existing project. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Editor} from '../src/editor.mjs';
import {emptyDocument} from '../src/demo.mjs';
import backend from '../desktop/backend.cjs';
import {nodeClipboardClient} from '../tests/helpers/clipboard-node-client.mjs';

const source = process.argv[2] ?? 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const output = path.resolve(process.argv[3] ?? 'artifacts/clipboard-akane-wire-cpu.json');
const hashes = () => Object.fromEntries(fs.readdirSync('src', {recursive: true}).filter(name => name.endsWith('.mjs')).sort()
  .map(name => [name, createHash('sha256').update(fs.readFileSync(path.join('src', name))).digest('hex')]));
const runtimeBefore = hashes();
const python = backend.pythonCandidates()[0];
let imported = spawnSync(python.command, [...python.args, '-c', String.raw`
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
p=Path(sys.argv[1]);print(json.dumps(server.ProjectStore(server.WORKSPACE).import_bytes(p.read_bytes(),p.name)['document']))
`, source], {encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024});
if (imported.status !== 0) throw new Error(imported.error?.message ?? imported.stderr);
const document = JSON.parse(imported.stdout); imported = null;
const editor = new Editor({demo: false, historyBytes: Infinity}).load(document), worker = nodeClipboardClient();
const originalRun = worker.run.bind(worker); let lastRoute = null;
worker.run = async (...args) => {
  const result = await originalRun(...args);
  lastRoute = {requestedSparseNativePaste: Boolean(args[0].request.sparseNativePaste),
    returnedSparsePaste: Boolean(result.sparsePaste),
    destinationPosesSent: args[0].report.keyframes.reduce((total, frame) => total + frame.objects.length, 0),
    destinationFiguresSent: args[0].report.figure_types.length,
    destinationBackgroundsSent: args[0].report.backgrounds?.length ?? 0,
    summarizedDestinationFigures: args[0].state?.destinationSummary?.assets?.figures?.count ?? null,
    summarizedDestinationBackgrounds: args[0].state?.destinationSummary?.assets?.backgrounds?.count ?? null,
    returnedReportFrames: result.report?.keyframes?.length ?? 0,
    returnedInsertedFrames: result.sparsePaste?.frames?.length ?? 0};
  return result;
};
editor.setFrameClipboardWorker(worker);
const count = document.keyframes.length, cases = [
  ['dense-one', [count - 1]], ['dense-64', Array.from({length: 64}, (_, i) => count - 64 + i)],
  ['all', document.keyframes.map((_, i) => i)],
];
const results = [], checks = [];
const save = failure => {
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify({date: new Date().toISOString(), source, bytes: fs.statSync(source).size,
    scope: 'Isolated Node worker CPU diagnostic. Excludes import, JSON parse, Editor.load and post-operation equality assertions; includes worker transfer, planner, main staging and commit. The import JSON string is released before measurement; GC is not forced. History byte eviction is disabled only to test later-edit Undo/Redo immutability outside measurement. Event-loop gaps include GC and worker contention. No browser/render/presentation latency measured.',
    results, checks, runtimeBefore, runtimeAfter: hashes(), runtimeStable: JSON.stringify(runtimeBefore) === JSON.stringify(hashes()),
    ...(failure ? {failure: failure.stack} : {})}, null, 2));
};
async function measure(operation) {
  let maxGap = 0, ticks = 0, previous = performance.now();
  const memoryStart = process.memoryUsage(), memoryPeak = {...memoryStart};
  const sample = () => {const current = process.memoryUsage(); for (const key of Object.keys(memoryPeak)) memoryPeak[key] = Math.max(memoryPeak[key], current[key]);};
  const timer = setInterval(() => {const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++; sample();}, 1);
  try {const count = await operation(); await new Promise(resolve => setImmediate(resolve));
    sample(); return {count, eventLoopMaxGapMs: maxGap, eventLoopSamples: ticks, memoryStart, memoryPeak,
      memoryScope: 'RSS includes this Node process and its worker threads; heapUsed/external/arrayBuffers describe the main thread only. Samples are not an exact native allocation peak.', ...editor.lastClipboardTimings, route:lastRoute};
  } finally {clearInterval(timer);}
}
function withoutIdentity(frame) {
  const result = {...frame};
  // The existing native paste planner remaps an absent secondary background to
  // ID zero. Both forms mean no secondary image when the mix is zero.
  if (!result.background_mix && result.background_id_b == null) result.background_id_b = 0;
  if (frame._styk) {const metadata = {...frame._styk}; delete metadata.frameId;
    if (Object.keys(metadata).length) result._styk = metadata; else delete result._styk;}
  return result;
}
try {
  for (const [name, indices] of cases) {
    editor.load(document);
    const row = {name, keys: indices.length, copy: await measure(() => editor.copyFramesAsync(indices))};
    results.push(row); save();
    const clipboard = editor._frameClipboard, previous = editor.report, previousFrames = previous.keyframes.slice();
    row.objects = clipboard.reduce((sum, frame) => sum + frame.objects.length, 0);
    row.pasteExisting = await measure(() => editor.pasteFramesAsync(0));
    assert.equal(row.pasteExisting.route.requestedSparseNativePaste, true);
    assert.equal(row.pasteExisting.route.returnedSparsePaste, true);
    assert.equal(row.pasteExisting.route.destinationPosesSent, 0);
    assert.equal(row.pasteExisting.route.returnedReportFrames, 0);
    assert.equal(row.pasteExisting.count, indices.length);
    assert.equal(editor.report.keyframes.length, count + indices.length);
    for (let i = 0; i < clipboard.length; i++) assert.deepEqual(withoutIdentity(editor.report.keyframes[i]), withoutIdentity(clipboard[i]));
    const pasted = editor.report, inserted = editor.report.keyframes.slice(0, indices.length);
    const assertOriginal = () => {assert.equal(editor.report, previous); assert.equal(editor.report.keyframes.length, previousFrames.length);
      for (let i = 0; i < previousFrames.length; i++) assert.equal(editor.report.keyframes[i], previousFrames[i]);};
    const assertInserted = () => {assert.equal(editor.report.keyframes.length, previousFrames.length + clipboard.length);
      for (let i = 0; i < clipboard.length; i++) assert.deepEqual(withoutIdentity(editor.report.keyframes[i]), withoutIdentity(clipboard[i]));};
    editor.undo(); assertOriginal();
    editor.redo(); assert.equal(editor.report, pasted); assertInserted();
    for (let i = 0; i < inserted.length; i++) assert.equal(editor.report.keyframes[i], inserted[i]);
    const editable = editor.frame.objects.find(object => !object.join);
    if (editable) {
      editor.transaction('Post-paste immutability proof', frame => {frame.objects.find(object => object.unique_id === editable.unique_id).root_x += 1;});
      editor.undo(); assertInserted(); editor.undo(); assertOriginal(); editor.redo(); assertInserted();
    }
    editor.undo(); assertOriginal();
    checks.push(`${name}: inserted native fields equal copied frames after native inactive-background sentinel normalization; Undo/Redo and later-edit Undo preserve exact original frame references and inserted values.`);
    editor.load(emptyDocument());
    row.pasteEmpty = await measure(() => editor.pasteFramesAsync(0));
    assert.equal(row.pasteEmpty.route.returnedSparsePaste, true);
    assert.equal(row.pasteEmpty.count, indices.length);
    checks.push(`${name}: empty-target paste completes with all copied keys.`);
    save(); console.log(JSON.stringify(row));
  }
} catch (error) {save(error); throw error;}
finally {worker.dispose();}
