import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {isStatic} from '../src/pivot/geometry.mjs';
import {validateScene, validateObjectChanges} from '../src/pivot/model.mjs';

const filename = process.argv[2] ?? 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const response = await fetch('http://127.0.0.1:47831/api/import?filename=' + encodeURIComponent(filename.split('/').at(-1)),
  {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: await fs.readFile(filename)});
assert.equal(response.status, 200); const imported = await response.json(), report = imported.document;
const types = new Map(report.figure_types.map(f => [f.figure_type_id, f]));
const originalFrameCount = report.keyframes.length, index = originalFrameCount - 1, frame = report.keyframes[index];
const graph = frame.objects.map((object, slot) => {
  let parent = slot, depth = 0; while (frame.objects[parent].join) { parent = frame.objects[parent].join.target_object_slot; depth++; }
  const figure = types.get(object.figure_type_id);
  return {uid: object.unique_id, slot, type: object.figure_type_id, name: figure.name,
    segments: figure.segments.length, static: figure.segments.filter(isStatic).length, depth,
    root: frame.objects[parent].unique_id, join: object.join};
});
report.keyframes = [frame]; const editor = new Editor({demo: false}); editor.load(report);
const deepest = [...graph].sort((a, b) => b.depth - a.depth)[0]; editor.select(deepest.uid);
let start = performance.now(); const geometry = editor.geometry, geometryMs = performance.now() - start;
const translation = editor.resolveTranslationSelection(), affected = new Set(translation.affectedUids);
start = performance.now(); editor.beginTranslationDrag(); const pointerDownMs = performance.now() - start;
assert.equal(editor.geometry, geometry);
start = performance.now(); editor.moveSelection(13, -11, {fromStart: true}); const updateMs = performance.now() - start;
start = performance.now(); editor.commitDrag(); const commitMs = performance.now() - start;
let maxTranslationError = 0;
for (const [slot, original] of geometry.objects) if (original) {
  const moved = affected.has(original.obj.unique_id), current = editor.geometry.objects.get(slot);
  maxTranslationError = Math.max(maxTranslationError, Math.abs(current.root.x - original.root.x - (moved ? 13 : 0)), Math.abs(current.root.y - original.root.y + (moved ? 11 : 0)));
}
assert.ok(maxTranslationError < 0.003, `Translation error ${maxTranslationError}`); editor.undo();
let rotation = null;
for (const item of [...graph].filter(o => o.join).sort((a, b) => b.depth - a.depth)) {
  const parent = editor.frame.objects[item.join.target_object_slot], figure = types.get(parent.figure_type_id), byId = new Map(figure.segments.map((s, i) => [s.segment_id, i]));
  let handle = item.join.target_handle_id;
  while (handle) {
    const joint = byId.get(handle), segment = figure.segments[joint];
    if (!isStatic(segment)) {
      editor.select(parent.unique_id, joint); const before = editor.frame.objects[item.slot].angles.slice();
      start = performance.now(); editor.rotateJoint(0.17); const durationMs = performance.now() - start;
      const child = editor.frame.objects[item.slot];
      child.angles.forEach((angle, i) => assert.ok(Math.abs(angle - before[i] - 0.17) < 1e-10));
      const root = editor.geometry.objects.get(item.slot).root; assert.equal(child.root_x, root.x); assert.equal(child.root_y, root.y);
      rotation = {parentUid: parent.unique_id, jointIndex: joint, nativeHandleId: segment.segment_id, childUid: item.uid, depth: item.depth, durationMs};
      editor.undo(); break;
    }
    handle = segment.parent_id;
  }
  if (rotation) break;
}
const timings = {full: [], scoped: []};
for (let i = 0; i < 5; i++) {
  start = performance.now(); validateScene({...report, keyframes: [editor.frame]}); timings.full.push(performance.now() - start);
  start = performance.now(); validateObjectChanges(report, editor.frame, [deepest.uid]); timings.scoped.push(performance.now() - start);
}
const artifact = {filename, originalFrameCount, auditedFrame: index, figures: types.size, objects: graph.length,
  segments: graph.reduce((n, o) => n + o.segments, 0), staticSegments: graph.reduce((n, o) => n + o.static, 0),
  joinedObjects: graph.filter(o => o.join).length, deepest, translation: {count: affected.size, roots: translation.rootUids, maxTranslationError, pointerDownMs, updateMs, commitMs},
  geometryMs, rotation, validationMs: timings, mostStatic: [...graph].sort((a, b) => b.static - a.static).slice(0, 8)};
await fs.writeFile(new URL('../artifacts/akane-editor-audit.json', import.meta.url), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify(artifact, null, 2));
