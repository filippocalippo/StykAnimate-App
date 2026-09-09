import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import inspector from 'node:inspector';

const filename = process.argv[2] ?? 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const response = await fetch('http://127.0.0.1:47831/api/import?filename=' + encodeURIComponent(filename.split('/').at(-1)), {
  method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: await fs.readFile(filename)});
assert.equal(response.status, 200); const report = (await response.json()).document;
const editor = new Editor({demo: false}).load(report); editor.seek(1871); editor.select(460616);
editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
const phases = {}, count = {};
for (const name of ['captureFrameSource', '_registerFrameSources', '_record', 'nativePoseChannel', 'addAnimationKeys', '_invalidate', '_trackLayerCommand']) {
  const original = editor[name]; editor[name] = function(...args) {
    const start = performance.now(); try { return original.apply(this, args); } finally { phases[name] = (phases[name] ?? 0) + performance.now() - start; count[name] = (count[name] ?? 0) + 1; }
  };
}
const session = new inspector.Session(); session.connect();
const post = (method, args = {}) => new Promise((resolve, reject) => session.post(method, args, (error, result) => error ? reject(error) : resolve(result)));
await post('Profiler.enable'); await post('Profiler.start');
const runs = [];
for (let i = 0; i < 3; i++) {
  editor.geometry; for (const key of Object.keys(phases)) { phases[key] = 0; count[key] = 0; }
  const start = performance.now(); editor.beginTranslationDrag(); const began = performance.now(); editor.moveSelection(1, 0); const moved = performance.now();
  const revision = editor.layerRevision; editor.commitDrag(); const committed = performance.now(); editor.geometry; const painted = performance.now();
  runs.push({beginMs: began - start, moveMs: moved - began, commitMs: committed - moved, geometryMs: painted - committed, layerRevisionChanged: editor.layerRevision !== revision,
    historyBytes: editor._undo.at(-1).bytes, phases: {...phases}, calls: {...count}});
}
const {profile} = await post('Profiler.stop'); session.disconnect();
const self = new Map(); (profile.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
const hotspots = profile.nodes.map(node => ({name: node.callFrame.functionName, file: node.callFrame.url.split('/').at(-1), line: node.callFrame.lineNumber + 1, selfMs: self.get(node.id) ?? 0}))
  .sort((a, b) => b.selfMs - a.selfMs).slice(0, 20);
const artifact = {filename, frames: report.keyframes.length, uid: 460616, tick: 1871, runs, hotspots};
const suffix = process.argv[3] ?? 'latest';
await fs.writeFile(new URL(`../artifacts/akane-authored-commit-${suffix}.json`, import.meta.url), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify(artifact, null, 2));
