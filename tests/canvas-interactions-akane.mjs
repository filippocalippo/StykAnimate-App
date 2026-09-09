/** Real source regression: node tests/canvas-interactions-akane.mjs */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.mjs';
import { getPivotHandles, pickCanvasHandle } from '../src/canvas-interactions.mjs';

const filename = process.argv[2] || 'C:/Users/aleri/Downloads/16 Akane vs Akato Segundo round (3).piv';
const response = await fetch('http://127.0.0.1:47831/api/import?filename=' + encodeURIComponent(filename.split('/').at(-1)), {
  method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await fs.readFile(filename),
});
assert.equal(response.status, 200);
const { document: report } = await response.json(), frameIndex = report.keyframes.length - 1;
report.keyframes = [report.keyframes[frameIndex]];
const editor = new Editor({ demo: false }); editor.load(report);
const geometry = editor.geometry, candidates = [];
const prepareStarted = performance.now(), handles = getPivotHandles(geometry, { frame: editor.frame });
const descriptorPreparationMs = performance.now() - prepareStarted, timings = [];
for (const child of geometry.objects.values()) {
  if (!child?.obj.join) continue;
  const parent = geometry.objects.get(child.obj.join.target_object_slot);
  const target = parent?.segments.find(segment => segment.seg.segment_id === child.obj.join.target_handle_id);
  if (!target || target.static) continue;
  const started = performance.now();
  const hit = pickCanvasHandle(geometry, child.root, { handles, radius: 4 });
  timings.push(performance.now() - started);
  assert.equal(hit.action, 'pose', `Attached origin ${child.obj.unique_id} incorrectly started group translation.`);
  candidates.push({ childUid: child.obj.unique_id, parentUid: parent.obj.unique_id, nativeHandleId: target.seg.segment_id,
    point: child.root, selectedActorUid: hit.g.obj.unique_id, selectedJointIndex: hit.joint, selectedHandleId: hit.id, action: hit.action });
}
assert.ok(candidates.length > 0, 'The native fixture contains no dynamic attachment regressions.');
const chosen = candidates.find(item => item.parentUid === 460616) || candidates[0];
const before = new Map(editor.frame.objects.map(object => [object.unique_id, { x: object.root_x, y: object.root_y, angles: object.angles.slice() }]));
editor.select(chosen.selectedActorUid, chosen.selectedJointIndex); editor.rotateJoint(.17);
const affected = [];
for (const object of editor.frame.objects) {
  const previous = before.get(object.unique_id);
  if (object.root_x !== previous.x || object.root_y !== previous.y || object.angles.some((angle, index) => angle !== previous.angles[index])) affected.push(object.unique_id);
  if (!object.join) {
    assert.equal(object.root_x, previous.x, `Posing attachment moved assembly origin ${object.unique_id}.`);
    assert.equal(object.root_y, previous.y, `Posing attachment moved assembly origin ${object.unique_id}.`);
  }
}
assert.ok(affected.length > 0); assert.ok(affected.length < editor.frame.objects.length);
const selectedChild = geometry.objects.get(editor.frame.objects.findIndex(object => object.unique_id === chosen.childUid));
const oldSelectedJoint = [...selectedChild.segments].reverse().find(segment => !segment.static && Math.hypot(segment.end.x - chosen.point.x, segment.end.y - chosen.point.y) < 4)?.index ?? -1;
timings.sort((a, b) => a - b);
const result = { filename, frameIndex, objectCount: editor.frame.objects.length, attachmentCases: candidates,
  descriptorPreparationMs, handleCount: handles.length,
  pickMs: { p50: timings[Math.floor(timings.length * .5)], p95: timings[Math.floor(timings.length * .95)], max: timings.at(-1) },
  branchTest: { ...chosen, oldSelectedJoint, oldAction: oldSelectedJoint < 0 ? 'connected-translation' : 'pose', affectedUids: affected, allFreeOriginsUnchanged: true },
  nativeEvidence: ['native-static/joined-handle-routing.md', 'native-static/handle-size.md'],
  limitation: 'Uses native decoded geometry and pose propagation, with hit order verified from the supplied executable. This test does not claim a newly recorded native UI drag.' };
await fs.writeFile(new URL('../artifacts/canvas-interactions-akane.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ frameIndex, objectCount: editor.frame.objects.length, testedAttachments: candidates.length, descriptorPreparationMs, handleCount: handles.length, pickMs: result.pickMs, branchTest: result.branchTest }, null, 2));
