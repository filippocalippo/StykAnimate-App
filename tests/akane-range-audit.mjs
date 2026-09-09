import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';

const filename = process.argv[2] ?? 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const response = await fetch('http://127.0.0.1:47831/api/import?filename=' + encodeURIComponent(filename.split('/').at(-1)), {
  method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: await fs.readFile(filename)});
assert.equal(response.status, 200); const report = (await response.json()).document;
const editor = new Editor({demo: false}).load(report), last = report.keyframes.at(-1);
const uid = last.objects.find(object => object.unique_id === 271591)?.unique_id ?? last.objects.find(object => !object.join).unique_id;
const matching = report.keyframes.flatMap((frame, index) => frame.objects.some(object => object.unique_id === uid) ? [index] : []);
const indices = matching.slice(-10); editor.selectFrame(indices.at(-1)); editor.select(uid);
const references = indices.map(index => {
  const frame = report.keyframes[index]; return {frame, unaffected: frame.objects.find(object => object.unique_id !== uid), angles: frame.objects.find(object => object.unique_id === uid).angles};
});
const measurements = [];
for (const [name, run] of [
  ['appearance', () => editor.updateFiguresInFrames({color_override_raw: 0xff3f8edb}, indices)],
  ['scale', () => editor.scaleFiguresInFrames(1.03, indices, {relative: true})],
  ['mirror', () => editor.mirrorFiguresInFrames('horizontal', indices)],
  ['duplicate', () => editor.duplicateInFrames(indices)],
]) {
  const begin = performance.now(), result = run(), elapsedMs = performance.now() - begin, command = editor._undo.at(-1);
  assert.equal(result.changedFrames, indices.length);
  if (name === 'appearance') indices.forEach((index, i) => {
    assert.equal(report.keyframes[index].objects.find(object => object.unique_id === uid).angles, references[i].angles);
    assert.equal(report.keyframes[index].objects.find(object => object.unique_id === references[i].unaffected.unique_id), references[i].unaffected);
  });
  measurements.push({name, elapsedMs, historyBytes: command.bytes, patchedObjects: command.changes.reduce((sum, change) => sum + change.patches.length, 0)});
  editor.undo();
}
const artifact = {filename, nativeFrames: report.keyframes.length, figureDefinitions: report.figure_types.length, lastFrameObjects: last.objects.length,
  uid, selectedFrames: indices.length, matchingFrames: matching.length, measurements};
await fs.writeFile(new URL('../artifacts/akane-range-audit.json', import.meta.url), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify(artifact, null, 2));
