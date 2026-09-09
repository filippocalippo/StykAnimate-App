/** Full-project rig authoring audit; never modifies the supplied native file. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {Editor} from '../src/editor.mjs';
import {isStatic} from '../src/pivot/geometry.mjs';

const filename = process.argv[2] ?? 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const response = await fetch('http://127.0.0.1:47831/api/import?filename=' + encodeURIComponent(filename.split('/').at(-1)),
  {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: await fs.readFile(filename)});
assert.equal(response.status, 200); const imported = await response.json(), report = imported.document;
const editor = new Editor({demo: false}).load(report); editor.selectFrame(report.keyframes.length - 1);
const types = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
const chosen = [...editor.frame.objects].filter(object => types.get(object.figure_type_id).segments.some(isStatic))
  .sort((a, b) => types.get(b.figure_type_id).segments.length - types.get(a.figure_type_id).segments.length)[0];
const figure = types.get(chosen.figure_type_id), index = figure.segments.findIndex(isStatic);
editor.select(chosen.unique_id, index); const original = editor.geometry.objects.get(editor.selectedSlot).segments[index].end;
const otherFrame = editor.report.keyframes[0], definition = editor.figure, oldLength = definition.segments[index].length;
let start = performance.now(); editor.beginRigDrag(); const beginMs = performance.now() - start;
const updates = [], evaluations = [];
for (let i = 0; i < 30; i++) {
  start = performance.now(); editor.editRigJoint(original.x + 10 + i / 10, original.y + 7); updates.push(performance.now() - start);
  start = performance.now(); void editor.geometry; evaluations.push(performance.now() - start);
}
assert.equal(editor.figure, definition); assert.equal(editor.figure.segments[index].length, oldLength);
assert.equal(editor.report.keyframes[0], otherFrame); assert.equal(editor._undo.length, 0);
const expected = editor.geometry.objects.get(editor.selectedSlot).segments[index].end;
start = performance.now(); editor.commitRigDrag(); const commitMs = performance.now() - start;
const current = editor.geometry.objects.get(editor.selectedSlot).segments[index].end;
const error = Math.hypot(current.x - expected.x, current.y - expected.y); assert.ok(error < 0.005, `Preview changed on commit by ${error} pixels.`);
const command = editor._undo.at(-1); assert.equal(command.kind, 'topology');
const artifact = {filename, frames: report.keyframes.length, objects: report.keyframes.reduce((n, frame) => n + frame.objects.length, 0),
  figureType: figure.figure_type_id, figureName: figure.name, figureSegments: figure.segments.length, staticHandle: figure.segments[index].segment_id,
  beginMs, previewModelMs: updates, previewGeometryMs: evaluations, commitMs, previewCommitError: error,
  historyBytes: command.bytes, affectedFrames: command.after.frames.length, affectedObjects: command.after.frames.reduce((n, frame) => n + frame.objects.length, 0)};
await fs.writeFile(new URL('../artifacts/rig-edit-profile.json', import.meta.url), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify(artifact, null, 2));
