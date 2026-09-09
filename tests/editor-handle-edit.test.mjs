import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {editorHandleEditMethods} from '../src/editor-handle-edit.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import backend from '../desktop/backend.cjs';

Object.assign(Editor.prototype, editorHandleEditMethods);
const near = (a, b, tolerance = 2e-4) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const pointNear = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
function fixture({curved = false, joined = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = [
    {...base, segment_id: 11, parent_id: 0, length: 100, angle_rad: 0, aux_code: 1, bend_rad: curved ? .7 : 0},
    {...base, segment_id: 22, parent_id: 11, length: 50, angle_rad: Math.PI / 2, aux_code: 0, bend_rad: curved ? -.4 : 0},
    {...base, segment_id: 33, parent_id: 22, length: 30, angle_rad: 0, aux_code: 0},
    {...base, segment_id: 44, parent_id: 0, length: 70, angle_rad: Math.PI, aux_code: 0},
  ];
  figure.segment_count = 4;
  const objects = [createObject(figure, 1, 100, 100)];
  if (joined) {
    objects.push(createObject(figure, 2, 200, 100, {join: {target_object_slot: 0, target_handle_id: 11}}));
    objects.push(createObject(figure, 3, 200, 100, {join: {target_object_slot: 1, target_handle_id: 0}}));
    objects.push(createObject(figure, 4, 300, 100, {join: {target_object_slot: 1, target_handle_id: 11}}));
  }
  report.keyframes = [createFrame(objects, 2), createFrame([createObject(figure, 1, 300, 200)], 1)];
  const editor = new Editor({demo: false}).load(report); editor.select(1, 0); return editor;
}

test('Handle Edit repositions a static joint in one pose without mutating definitions or another frame', () => {
  const editor = fixture(), original = structuredClone(editor.report), initial = editor.geometry.objects.get(0);
  const definition = editor.figure, otherFrame = editor.report.keyframes[1], target = {x: 225, y: 115};
  assert.equal(editor.poseJoint(target.x, target.y), false);
  editor.beginHandleEditDrag();
  for (let i = 0; i < 60; i++) editor.editHandlePosition(200 + i, 115);
  editor.editHandlePosition(target.x, target.y);
  assert.equal(editor._undo.length, 0);
  const preview = editor.geometry.objects.get(0);
  pointNear(preview.joints.get(11), target);
  for (const id of [0, 22, 33, 44]) pointNear(preview.joints.get(id), initial.joints.get(id));
  editor.commitHandleEditDrag();
  assert.equal(editor.figure, definition); assert.deepEqual(editor.report.figure_types, original.figure_types);
  assert.equal(editor.report.keyframes[1], otherFrame); assert.deepEqual(otherFrame, original.keyframes[1]);
  assert.equal(editor._undo.length, 1); assert.equal(editor._undo[0].kind, 'objects');
  editor.undo(); assert.deepEqual(editor.frame, original.keyframes[0]);
  editor.redo(); pointNear(editor.geometry.objects.get(0).joints.get(11), target);
});

test('free origin reposition holds all segment endpoints fixed and does not change scales', () => {
  const editor = fixture({curved: true}), initial = editor.geometry.objects.get(0);
  editor.select(1, -1); editor.editHandlePosition(120, 85);
  pointNear(editor.geometry.objects.get(0).root, {x: 120, y: 85});
  for (const segment of initial.segments) pointNear(editor.geometry.objects.get(0).joints.get(segment.seg.segment_id), segment.end);
  assert.equal(editor.object.scale, 1);
});

test('joined parent handle adjusts incident child roots while preserving all other endpoints', () => {
  const editor = fixture({joined: true}), initial = editor.geometry;
  const target = {x: 220, y: 130}; editor.editHandlePosition(target.x, target.y);
  const after = editor.geometry;
  for (const [slot, g] of initial.objects) for (const [id, point] of g.joints) {
    const moved = slot === 0 && id === 11 || [1, 2].includes(slot) && id === 0;
    pointNear(after.objects.get(slot).joints.get(id), moved ? target : point);
  }
  for (const slot of [1, 2]) pointNear({x: editor.frame.objects[slot].root_x, y: editor.frame.objects[slot].root_y}, target);
  editor.select(2, -1); assert.equal(editor.beginHandleEditDrag(), false, 'An attached origin has no independent handle');
});

test('normal Handle Edit retains incident bends, while bend mode preserves tangents at the moved vertex', () => {
  for (const bend of [false, true]) {
    const editor = fixture({curved: true}), initial = editor.geometry.objects.get(0);
    const target = {x: initial.joints.get(11).x + 20, y: initial.joints.get(11).y - 10};
    editor.editHandlePosition(target.x, target.y, {bend});
    const after = editor.geometry.objects.get(0);
    pointNear(after.joints.get(11), target);
    for (const id of [0, 22, 33, 44]) pointNear(after.joints.get(id), initial.joints.get(id));
    if (bend) {
      near(after.segments[0].angle + after.segments[0].bend, initial.segments[0].angle + initial.segments[0].bend);
      near(after.segments[1].angle, initial.segments[1].angle);
    } else for (const index of [0, 1]) near(after.segments[index].bend, initial.segments[index].bend);
  }
});

test('cancel, exact pointer return, and option switches keep one reversible gesture', () => {
  const editor = fixture({curved: true, joined: true}), before = structuredClone(editor.report), point = editor.geometry.objects.get(0).joints.get(11);
  editor.beginHandleEditDrag(); editor.editHandlePosition(225, 115, {bend: true});
  editor.editHandlePosition(225, 115, {bend: false}); editor.editHandlePosition(point.x, point.y);
  assert.equal(editor.commitHandleEditDrag(), false); assert.deepEqual(editor.report, before);
  assert.equal(editor._undo.length, 0); assert.equal(editor.dirty, false);
  editor.beginHandleEditDrag(); editor.editHandlePosition(225, 115); editor.cancelHandleEditDrag();
  assert.deepEqual(editor.report, before); assert.equal(editor.dirty, false);
});

test('invalid coordinates, zero scale, and full-circle degeneracy cannot partially edit a pose', () => {
  const editor = fixture(), before = structuredClone(editor.report);
  assert.throws(() => editor.editHandlePosition(NaN, 0), /finite/); assert.deepEqual(editor.report, before);
  editor.object.scale = 0; assert.throws(() => editor.beginHandleEditDrag(), /scale/); assert.equal(editor._drag, null);
  editor.object.scale = 1; editor.figure.segments[0].bend_rad = Math.PI * 2; editor._invalidate();
  const circle = structuredClone(editor.report);
  assert.throws(() => editor.editHandlePosition(120, 100), /full-circle/); assert.deepEqual(editor.report, circle);
});

test('composed authored pose edits create one key while all imported native frames remain unchanged', () => {
  const editor = fixture({joined: true}); editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  editor.seek(0); editor.select(1, 0);
  const frames = structuredClone(editor.report.keyframes), definitions = structuredClone(editor.report.figure_types);
  const before = editor.geometry.objects.get(0).joints.get(11), history = editor._undo.length;
  editor.beginHandleEditDrag(); editor.editHandlePosition(before.x + 15, before.y - 8);
  assert.deepEqual(editor.report.keyframes, frames); editor.commitHandleEditDrag();
  assert.deepEqual(editor.report.keyframes, frames); assert.deepEqual(editor.report.figure_types, definitions);
  assert.equal(editor._undo.length, history + 1); assert.equal(editor._undo.at(-1).kind, 'animation');
  pointNear(editor.geometry.objects.get(0).joints.get(11), {x: before.x + 15, y: before.y - 8});
  editor.undo(); pointNear(editor.geometry.objects.get(0).joints.get(11), before);
  editor.redo(); pointNear(editor.geometry.objects.get(0).joints.get(11), {x: before.x + 15, y: before.y - 8});
});

test('pose-only lengths and bends survive native PIV export while STK defaults remain unchanged', () => {
  const editor = fixture({curved: true, joined: true}), definitions = structuredClone(editor.report.figure_types);
  const point = editor.geometry.objects.get(0).joints.get(11), target = {x: point.x + 12, y: point.y - 7};
  editor.editHandlePosition(target.x, target.y, {bend: true});
  const python = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
document=json.load(sys.stdin); store=server.ProjectStore(server.WORKSPACE); result={}
for kind in ('piv','stk'):
 raw,name=store.export({'document':document,'format':kind,'figureTypeId':1})
 result[kind]=store.import_bytes(raw,name)['document']
print(json.dumps(result))
`;
  const candidate = backend.pythonCandidates()[0];
  const exported = spawnSync(candidate.command, [...candidate.args, '-c', python], {cwd: fileURLToPath(new URL('..', import.meta.url)),
    input: JSON.stringify(editor.serialize()), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(exported.status, 0, exported.error?.message || exported.stderr);
  const output = JSON.parse(exported.stdout), geometry = buildGeometry(output.piv, output.piv.keyframes[0]);
  pointNear(geometry.objects.get(0).segments[0].end, target);
  for (const kind of ['piv','stk']) {
    const figure = output[kind].figure_types.find(value => value.segments.length === 4);
    for (const [index, segment] of figure.segments.entries()) {
      near(segment.length, definitions[0].segments[index].length);
      near(segment.angle_rad, definitions[0].segments[index].angle_rad);
      near(segment.bend_rad, definitions[0].segments[index].bend_rad);
    }
  }
});
