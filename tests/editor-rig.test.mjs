import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {editorRigMethods} from '../src/editor-rig.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import backend from '../desktop/backend.cjs';

Object.assign(Editor.prototype, editorRigMethods);
const near = (a, b, tolerance = 2e-4) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const pointNear = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
function fixture() {
  const document = emptyDocument(), figure = document.figure_types[0], base = figure.segments[0];
  figure.segments = [
    {...base, segment_id: 11, parent_id: 0, length: 100, angle_rad: 0, aux_code: 1},
    {...base, segment_id: 22, parent_id: 11, length: 50, angle_rad: Math.PI / 2, aux_code: 1},
    {...base, segment_id: 33, parent_id: 22, length: 30, angle_rad: 0, aux_code: 0},
    {...base, segment_id: 44, parent_id: 0, length: 70, angle_rad: Math.PI, aux_code: 0},
  ];
  figure.segment_count = 4;
  document.keyframes = [createFrame([createObject(figure, 1, 100, 100)], 2), createFrame([createObject(figure, 1, 200, 200)], 1)];
  document.keyframes[1].objects[0].angles = figure.segments.map(s => s.angle_rad + 0.6);
  const editor = new Editor({demo: false}).load(document); editor.select(1, 0); return editor;
}

test('static construction joints reposition while every other visible joint stays fixed', () => {
  const editor = fixture(), initial = editor.geometry.objects.get(0), target = {x: 225, y: 115};
  assert.equal(editor.poseJoint(target.x, target.y), false, 'Normal posing must reject a static handle');
  editor.beginRigDrag(); editor.editRigJoint(target.x, target.y);
  const preview = editor.geometry.objects.get(0);
  pointNear(preview.joints.get(11), target);
  for (const id of [0, 22, 33, 44]) pointNear(preview.joints.get(id), initial.joints.get(id));
  editor.commitRigDrag(); const committed = editor.geometry.objects.get(0);
  for (const id of [0, 11, 22, 33, 44]) pointNear(committed.joints.get(id), preview.joints.get(id));
  assert.equal(editor._undo.length, 1); assert.equal(editor._undo[0].kind, 'topology');
  editor.undo(); for (const [id, point] of initial.joints) pointNear(editor.geometry.objects.get(0).joints.get(id), point);
  editor.redo(); pointNear(editor.geometry.objects.get(0).joints.get(11), target);
});

test('pointer previews retain the reusable definition, other frames and history until commit', () => {
  const editor = fixture(), figure = editor.figure, otherFrame = editor.report.keyframes[1], otherObject = otherFrame.objects[0];
  const originalFigure = structuredClone(figure), originalOther = structuredClone(otherFrame);
  editor.beginRigDrag();
  for (let i = 0; i < 100; i++) editor.editRigJoint(200 + i / 10, 120);
  assert.equal(editor.figure, figure); assert.deepEqual(figure, originalFigure);
  assert.equal(editor.report.keyframes[1], otherFrame); assert.equal(otherFrame.objects[0], otherObject); assert.deepEqual(otherFrame, originalOther);
  assert.equal(editor._undo.length, 0); assert.equal(editor.dirty, true);
  editor.commitRigDrag(); assert.equal(editor._undo.length, 1);
  for (let i = 0; i < figure.segments.length; i++) near(editor.report.keyframes[1].objects[0].angles[i] - editor.figure.segments[i].angle_rad, 0.6);
});

test('rotate branch allows static handles and strict isolation leaves descendant angles unchanged', () => {
  const editor = fixture(), initial = editor.serialize();
  editor.beginRigDrag({reposition: false}); editor.editRigJoint(100, 200, {reposition: false, isolate: true});
  near(editor.object.angles[0], Math.PI / 2); near(editor.object.angles[1], initial.keyframes[0].objects[0].angles[1]);
  near(editor.object.angles[2], initial.keyframes[0].objects[0].angles[2]);
  editor.commitRigDrag(); near(editor.figure.segments[0].angle_rad, Math.PI / 2); editor.undo();
  editor.beginRigDrag({reposition: false}); editor.editRigJoint(100, 250, {stretch: true});
  near(editor.object.lengths[0], 150);
  for (const i of [0, 1, 2]) near(editor.object.angles[i] - initial.keyframes[0].objects[0].angles[i], Math.PI / 2);
  near(editor.object.angles[3], initial.keyframes[0].objects[0].angles[3]);
  editor.commitRigDrag(); near(editor.figure.segments[0].length, 150);
});

test('cancel and pointer return produce no history or dirty state; gesture option changes restore lengths', () => {
  const editor = fixture(), initial = editor.serialize(), origin = editor.geometry.objects.get(0).segments[0].end;
  editor.beginRigDrag(); editor.editRigJoint(225, 115); editor.editRigJoint(origin.x, origin.y); editor.commitRigDrag();
  assert.equal(editor.dirty, false); assert.equal(editor._undo.length, 0); assert.deepEqual(editor.serialize(), initial);
  editor.beginRigDrag(); editor.editRigJoint(225, 115); editor.cancelRigDrag();
  assert.deepEqual(editor.serialize(), initial); assert.equal(editor.dirty, false);
  editor.beginRigDrag(); editor.editRigJoint(225, 115); editor.editRigJoint(100, 250, {reposition: false, stretch: true});
  near(editor.object.lengths[0], 150); near(editor.object.lengths[1], 50); editor.cancelRigDrag();
  assert.throws(() => editor.editRigJoint(NaN, 100), /finite/); assert.deepEqual(editor.serialize(), initial);
});

test('curved incident segments preserve their bends and fixed endpoints during repositioning', () => {
  const editor = fixture(); editor.figure.segments[0].bend_rad = 0.7; editor.figure.segments[1].bend_rad = -0.4;
  editor._invalidate(); const initial = editor.geometry.objects.get(0), target = {x: initial.joints.get(11).x + 20, y: initial.joints.get(11).y - 10};
  editor.editRigJoint(target.x, target.y);
  const geometry = editor.geometry.objects.get(0); pointNear(geometry.joints.get(11), target);
  for (const id of [0, 22, 33, 44]) pointNear(geometry.joints.get(id), initial.joints.get(id));
  assert.equal(editor.figure.segments[0].bend_rad, 0.7); assert.equal(editor.figure.segments[1].bend_rad, -0.4);
});

test('nested attachments retain canonical root coordinates, identities and undo after reusable rig edits', () => {
  const editor = fixture(); const parent = editor.selectedUid;
  editor.addFigure(); const child = editor.selectedUid; editor.joinTo(parent, 11);
  editor.addFigure(); const grandchild = editor.selectedUid; editor.joinTo(child, 22);
  editor.select(parent, 0); const before = editor.serialize();
  editor.beginRigDrag(); editor.editRigJoint(225, 115); const preview = editor.geometry;
  editor.commitRigDrag(); const geometry = editor.geometry;
  for (const uid of [child, grandchild]) {
    const object = editor.frame.objects.find(o => o.unique_id === uid), point = geometry.objects.get(object.object_slot).root;
    pointNear(object ? {x: object.root_x, y: object.root_y} : {}, point);
    assert.ok(object.join); assert.equal(object.unique_id, uid);
  }
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('rig position and reusable definition survive real native PIV and STK exports', () => {
  const editor = fixture(); editor.editRigJoint(225, 115); const figure = editor.figure;
  const python = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
document=json.load(sys.stdin); store=server.ProjectStore(server.WORKSPACE); result={}
for kind in ('piv','stk'):
 raw,name=store.export({'document':document,'format':kind,'figureTypeId':1})
 reopened=store.import_bytes(raw,name)['document']
 f=next(f for f in reopened['figure_types'] if len(f.get('segments',[]))==4)
 result[kind]={'figure':f,'document':reopened}
print(json.dumps(result))
`;
  const candidate = backend.pythonCandidates()[0], result = spawnSync(candidate.command, [...candidate.args, '-c', python], {cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(editor.serialize()), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const output = JSON.parse(result.stdout);
  for (const kind of ['piv', 'stk']) for (let i = 0; i < 4; i++) {
    near(output[kind].figure.segments[i].angle_rad, figure.segments[i].angle_rad);
    near(output[kind].figure.segments[i].length, figure.segments[i].length);
  }
  const document = output.piv.document, geometry = buildGeometry(document, document.keyframes[0]);
  pointNear(geometry.objects.get(0).segments[0].end, {x: 225, y: 115});
});
