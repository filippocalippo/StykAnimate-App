/** Native joined-handle edit acceptance: node tests/handle-edit-akane.mjs */
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {editorHandleEditMethods} from '../src/editor-handle-edit.mjs';
import {editorFigureTransformMethods} from '../src/editor-figure-transform.mjs';
Object.assign(Editor.prototype, editorHandleEditMethods);
Object.assign(Editor.prototype, editorFigureTransformMethods);
const filename = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const response = await fetch('http://127.0.0.1:47831/api/import?filename=' + encodeURIComponent(filename.split('/').at(-1)), {
  method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: await fs.readFile(filename),
});
assert.equal(response.status, 200);
const {document: report} = await response.json(), editor = new Editor({demo: false}).load(report);
const frameIndex = report.keyframes.length - 1; editor.seek(editor.timeline[frameIndex].start); editor.select(460616, 0);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const otherFramesHash = () => {
  const digest = createHash('sha256');
  report.keyframes.forEach((frame, index) => { if (index !== frameIndex) digest.update(JSON.stringify(frame)); });
  return digest.digest('hex');
};
const definitionsHash = hash(report.figure_types), otherHash = otherFramesHash(), frameHash = hash(editor.frame);
const initial = editor.geometry, slot = editor.selectedSlot, vertex = editor.figure.segments[0].segment_id;
const original = initial.objects.get(slot).joints.get(vertex), target = {x: original.x + 11, y: original.y - 7};
editor.beginHandleEditDrag(); const changedVertices = editor._drag.handleEdit.states.map(state => [state.slot, state.vertex]);
const allowed = new Set(changedVertices.map(([index, id]) => `${index}:${id}`)), timings = [];
for (let index = 0; index < 40; index++) {
  const started = performance.now(); editor.editHandlePosition(original.x + (index + 1) * 11 / 40, original.y - (index + 1) * 7 / 40);
  void editor.geometry; timings.push(performance.now() - started);
}
let maxFixedError = 0, fixedEndpoints = 0;
for (const [index, g] of initial.objects) for (const [id, point] of g.joints) {
  const after = editor.geometry.objects.get(index).joints.get(id), expected = allowed.has(`${index}:${id}`) ? target : point;
  const error = Math.hypot(after.x - expected.x, after.y - expected.y);
  assert.ok(error < .002, `Unexpected endpoint movement slot${index}/vertex${id}: ${error}`);
  if (!allowed.has(`${index}:${id}`)) { fixedEndpoints++; maxFixedError = Math.max(maxFixedError, error); }
}
editor.commitHandleEditDrag(); assert.equal(hash(report.figure_types), definitionsHash); assert.equal(otherFramesHash(), otherHash);
const editedHash = hash(editor.frame); assert.notEqual(editedHash, frameHash); assert.equal(editor._undo.length, 1);
editor.undo(); assert.equal(hash(editor.frame), frameHash); editor.redo(); assert.equal(hash(editor.frame), editedHash);
editor.beginHandleEditDrag(); editor.editHandlePosition(target.x + 3, target.y + 2); editor.cancelHandleEditDrag();
assert.equal(hash(editor.frame), editedHash);
const beforeTransform = editor.geometry, transformObject = beforeTransform.objects.get(editor.selectedSlot);
const origin = transformObject.root, start = transformObject.segments[0].end, transformTimings = [];
editor.beginFigureHandleDrag(start.x, start.y);
const transformedSlots = new Set(editor._drag.figureHandle.targets.map(item => item.slot));
for (let index = 1; index <= 40; index++) {
  const angle = .6 * index / 40, factor = 1 + .35 * index / 40, dx = start.x-origin.x, dy = start.y-origin.y;
  const began = performance.now();
  editor.transformFigureHandle(origin.x + factor*(dx*Math.cos(angle)-dy*Math.sin(angle)), origin.y + factor*(dx*Math.sin(angle)+dy*Math.cos(angle)));
  void editor.geometry; transformTimings.push(performance.now()-began);
}
let transformMaxError = 0, untransformedVertices = 0;
for (const [index,g] of beforeTransform.objects) for (const [id,point] of g.joints) {
  const dx=point.x-origin.x,dy=point.y-origin.y;
  const expected=transformedSlots.has(index) ? {x:origin.x+1.35*(dx*Math.cos(.6)-dy*Math.sin(.6)),y:origin.y+1.35*(dx*Math.sin(.6)+dy*Math.cos(.6))} : point;
  const actual=editor.geometry.objects.get(index).joints.get(id),error=Math.hypot(actual.x-expected.x,actual.y-expected.y);
  assert.ok(error<.002,`Unexpected transform movement slot${index}/vertex${id}: ${error}`);
  transformMaxError=Math.max(transformMaxError,error); if(!transformedSlots.has(index)) untransformedVertices++;
}
editor.commitFigureHandleDrag(); assert.equal(hash(report.figure_types),definitionsHash); assert.equal(otherFramesHash(),otherHash);
editor.undo(); assert.equal(hash(editor.frame),editedHash); editor.redo();
timings.sort((a,b) => a-b);
transformTimings.sort((a,b)=>a-b);
const result = {filename, frameIndex, objectCount: editor.frame.objects.length, totalFrames: report.keyframes.length,
  actorUid: 460616, vertex, original, target, changedVertices: changedVertices.map(([index,id]) => ({uid: editor.frame.objects[index].unique_id, vertex:id})),
  fixedEndpoints, maxFixedError, allOtherFramesAndDefinitionsUnchanged: true, undoRedoCancelExact: true,
  previewWithGeometryMs: {p50: timings[Math.floor(timings.length*.5)], p95: timings[Math.floor(timings.length*.95)], max:timings.at(-1)},
  altTransform: {affectedFigures: transformedSlots.size,untransformedVertices,transformMaxError,parentAndSiblingsFixed:true,
    previewWithGeometryMs:{p50:transformTimings[Math.floor(transformTimings.length*.5)],p95:transformTimings[Math.floor(transformTimings.length*.95)],max:transformTimings.at(-1)}}};
await fs.writeFile(new URL('../artifacts/handle-edit-akane.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result,null,2));
