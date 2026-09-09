import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {Editor} from '../src/editor.mjs';
import {cameraValues} from '../src/editor-camera.mjs';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';

const clone = value => structuredClone(value);
const near = (a, b, epsilon = 0.001) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const pointNear = (a, b) => { near(a.x, b.x); near(a.y, b.y); };
function fixture() {
  const editor = new Editor({demo: false}); editor.addFigure(); const root = editor.selectedUid;
  const child = editor.duplicateFigure().unique_id; editor.joinTo(root, 4);
  const grandchild = editor.duplicateFigure().unique_id; editor.joinTo(child, 2);
  editor.select(root); editor.duplicateFrame(); editor.moveSelection(45, 20);
  editor.duplicateFrame(); editor.moveSelection(70, -35); editor.selectFrame(0); editor.select(child, 7);
  editor.report.keyframes[0].camera = {is_default: false, x: 40, y: -20, scale: 0.5, angle_rad: 0.3};
  editor.report.keyframes[1].camera = {is_default: false, x: 100, y: 30, scale: 2, angle_rad: -0.5};
  editor._invalidate(); editor.markSaved();
  return {editor, root, child, grandchild};
}
function cameraAt(editor, index) { return cameraValues(evaluatedFrame(editor.report, index, 0, editor.timeline[index].start).camera); }
function projectedJoints(editor, index) {
  const frame = editor.report.keyframes[index], matrix = cameraMatrix({report: editor.report, frame});
  return new Map([...buildGeometry(editor.report, frame).objects.values()].map(entry => [entry.obj.unique_id,
    new Map([...entry.joints].map(([id, point]) => [id, {x: matrix[0] * point.x + matrix[2] * point.y + matrix[4], y: matrix[1] * point.x + matrix[3] * point.y + matrix[5]}]))]));
}

test('absolute camera range values change only entered channels with small atomic history', () => {
  const {editor} = fixture(), before = editor.serialize(), frames = editor.report.keyframes.map(frame => frame.objects), history = editor._undo.length;
  assert.equal(editor.setCameraValues({x: 250}, [0, 2]), 2);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.camera.x), [250, 100, 250]);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.camera.y), [-20, 30, 0]);
  assert.equal(editor._undo.length, history + 1); assert.equal(editor._undo.at(-1).kind, 'camera');
  assert.ok(editor._undo.at(-1).bytes < 3000);
  for (const [index, objects] of frames.entries()) assert.equal(editor.report.keyframes[index].objects, objects);
  editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.equal(editor.frame.camera.x, 250);
});

test('relative camera range motion preserves differences and multiplies scale', () => {
  const {editor} = fixture(), baseline = editor.report.keyframes.map(frame => clone(frame.camera));
  editor.transformCamera({x: 10, y: -4, angle_rad: 0.2, scale: 0.5}, [0, 1]);
  for (const index of [0, 1]) {
    const a = baseline[index], b = editor.report.keyframes[index].camera;
    near(b.x, a.x + 10); near(b.y, a.y - 4); near(b.angle_rad, a.angle_rad + 0.2); near(b.scale, a.scale * 0.5);
  }
  assert.deepEqual(editor.report.keyframes[2].camera, baseline[2]);
});

test('camera clipboard crosses documents, paste/reset ranges retain figure identity', () => {
  const {editor} = fixture(), copied = editor.copyCamera(); copied.x = 999;
  editor.newDocument(); const uid = editor.selectedUid; editor.duplicateFrame();
  assert.equal(editor.pasteCamera([0, 1]), 2);
  for (const frame of editor.report.keyframes) { assert.equal(frame.camera.x, 40); assert.equal(frame.objects[0].unique_id, uid); }
  editor.resetCamera([0, 1]); assert.ok(editor.report.keyframes.every(frame => frame.camera.is_default));
  editor.undo(); assert.equal(editor.frame.camera.x, 40);
});

test('100 camera pointer previews create one history entry; cancel restores all selected cameras', () => {
  const {editor} = fixture(), before = editor.serialize(), count = editor._undo.length, objectArrays = editor.report.keyframes.map(frame => frame.objects);
  editor.beginCameraDrag({indices: [0, 1]});
  for (let i = 1; i <= 100; i++) editor.updateCameraDrag({x: i / 10, y: -i / 20, scale: 1 + i / 1000});
  assert.equal(editor._undo.length, count); assert.ok(editor.dirty); assert.equal(editor._drag.before.length, 0);
  near(editor.frame.camera.x, 50); near(editor.report.keyframes[1].camera.scale, 2.2);
  assert.ok(editor.commitDrag()); assert.equal(editor._undo.length, count + 1);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.beginCameraDrag({indices: [0, 1]}); editor.updateCameraDrag({x: 20}); editor.cancelDrag();
  assert.deepEqual(editor.serialize(), before);
  for (const [index, objects] of objectArrays.entries()) assert.equal(editor.report.keyframes[index].objects, objects);
});

test('invalid camera batch/gesture is rejected atomically and cannot poison history', () => {
  const {editor} = fixture(), before = editor.serialize(), count = editor._undo.length;
  assert.throws(() => editor.transformCamera({scale: 0}, [0, 1]), /positive/);
  assert.throws(() => editor.setCameraValues({x: Infinity}, [0, 1]), /finite/);
  assert.throws(() => editor.setCameraValues({scale: 1e-50}, [0, 1]), /native rendering range/);
  assert.throws(() => editor.setCameraValues({root_x: 3}), /Unknown/);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, count);
  editor.beginCameraDrag(); editor.updateCameraDrag({x: 5});
  assert.throws(() => editor.updateCameraDrag({scale: -1}), /positive/);
  assert.equal(editor.dragging, false); assert.deepEqual(editor.serialize(), before);
});

test('center camera follows matching selected UIDs and preserves the untouched axis, angle and scale', () => {
  const {editor, child} = fixture(); editor.select(child);
  const before = editor.report.keyframes.map(frame => clone(frame.camera));
  const centers = editor.report.keyframes.map(frame => {
    const entry = [...buildGeometry(editor.report, frame).objects.values()].find(entry => entry.obj.unique_id === child);
    return entry.root.x + 5;
  });
  assert.equal(editor.centerCamera('x', [0, 1, 2], {boundsOf: entry => ({minX: entry.root.x, maxX: entry.root.x + 10, minY: entry.root.y, maxY: entry.root.y + 20})}), 3);
  for (let i = 0; i < 3; i++) {
    const camera = editor.report.keyframes[i].camera; near(camera.x + editor.report.canvas_width / 2, centers[i]);
    assert.equal(camera.y, before[i].y); assert.equal(camera.scale, before[i].scale); assert.equal(camera.angle_rad, before[i].angle_rad);
  }
  editor.selectMany([]); assert.equal(editor.centerCamera(), 0);
});

test('align canvas fits native aspect ratio in current pan/zoom and retains each camera rotation', () => {
  const {editor} = fixture();
  editor.alignCameraToView({x: -100, y: 40, scale: 2, width: 1000, height: 700}, [0, 1]);
  for (const index of [0, 1]) { const c = editor.report.keyframes[index].camera; near(c.x, -180); near(c.y, -115); near(c.scale, 1000 / 960 / 2); }
  assert.equal(editor.report.keyframes[0].camera.angle_rad, 0.3); assert.equal(editor.report.keyframes[1].camera.angle_rad, -0.5);
});

test('apply camera preserves projected joined/curved poses, artwork style and background, with undo', () => {
  const {editor, child} = fixture(); editor.select(child, 2); editor.updateSegment({bend_rad: 0.4});
  const before = editor.serialize(), projected = [0, 1].map(index => projectedJoints(editor, index));
  const definitions = clone(editor.report.figure_types), backgrounds = clone(editor.report.backgrounds);
  assert.equal(editor.applyCameraToFigures([0, 1]), 2);
  for (const index of [0, 1]) {
    assert.ok(editor.report.keyframes[index].camera.is_default);
    for (const entry of buildGeometry(editor.report, editor.report.keyframes[index]).objects.values()) {
      for (const [id, point] of entry.joints) pointNear(point, projected[index].get(entry.obj.unique_id).get(id));
      if (entry.obj.join) pointNear({x: entry.obj.root_x, y: entry.obj.root_y}, entry.root);
    }
  }
  assert.deepEqual(editor.report.figure_types, definitions); assert.deepEqual(editor.report.backgrounds, backgrounds);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('Locate moves an entire joined component and every selected figure by the same offset', () => {
  const {editor, child} = fixture(); editor.selectFrame(1); editor.select(child, 7);
  const extra = editor.addFigure().unique_id; editor.selectMany([extra, child]); editor.selectedJoint = 7;
  const before = editor.serialize(), previous = buildGeometry(editor.report, editor.report.keyframes[0]);
  const source = editor.geometry, target = [...previous.objects.values()].find(entry => entry.obj.unique_id === child).joints.get(8);
  const active = [...source.objects.values()].find(entry => entry.obj.unique_id === child).joints.get(8), dx = target.x - active.x, dy = target.y - active.y;
  assert.ok(editor.locateHandle(-1, {uid: child, jointIndex: 7}));
  for (const entry of editor.geometry.objects.values()) {
    const old = [...source.objects.values()].find(old => old.obj.unique_id === entry.obj.unique_id);
    pointNear(entry.root, {x: old.root.x + dx, y: old.root.y + dy});
  }
  pointNear(editor.geometry.objects.get(editor.selectedSlot).joints.get(8), target);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('Locate uses immediate stored neighbors including hidden keys and native handle IDs, with safe missing targets', () => {
  const {editor, child} = fixture(); editor.report.keyframes[1].duration_raw = 0; editor._invalidate({timing: true});
  editor.selectFrame(2); editor.select(child, 0);
  const target = buildGeometry(editor.report, editor.report.keyframes[1]).objects.get(editor.selectedSlot).joints.get(1);
  assert.ok(editor.locateHandle(-1, {handleId: 1})); pointNear(editor.geometry.objects.get(editor.selectedSlot).joints.get(1), target);
  assert.equal(editor.locateHandle(1), false);
  assert.equal(editor.locateHandle(-1, {handleId: 999999}), false);
  editor.locateHandle(-1, {handleId: 1, editMode: true});
  pointNear(editor.geometry.objects.get(editor.selectedSlot).joints.get(1), target);
  editor.selectFrame(0); assert.equal(editor.locateHandle(-1), false);
});

test('Locate matches a sparse native handle ID when the neighbor uses a differently ordered definition', () => {
  const {editor, child} = fixture();
  const document = editor.serialize();
  for (const figure of document.figure_types) for (const segment of figure.segments) {
    segment.segment_id *= 13; segment.parent_id *= 13;
  }
  for (const frame of document.keyframes) for (const object of frame.objects) if (object.join) object.join.target_handle_id *= 13;
  const reordered = clone(document.figure_types[0]); reordered.figure_type_id = 7; reordered.segments.reverse(); document.figure_types.push(reordered);
  const previous = document.keyframes[0].objects.find(object => object.unique_id === child);
  previous.figure_type_id = 7; previous.angles.reverse();
  editor.load(document); editor.selectFrame(1); editor.select(child, 7);
  const target = buildGeometry(document, document.keyframes[0]).objects.get(previous.object_slot).joints.get(104);
  assert.ok(editor.locateHandle(-1)); pointNear(editor.geometry.objects.get(editor.selectedSlot).joints.get(104), target);
});

test('camera Locate changes only the selected camera channel', () => {
  const {editor} = fixture(); editor.selectFrame(1);
  editor.locateCamera(-1, 'position'); assert.equal(editor.frame.camera.x, 40); assert.equal(editor.frame.camera.y, -20);
  assert.equal(editor.frame.camera.scale, 2); assert.equal(editor.frame.camera.angle_rad, -0.5);
  editor.locateCamera(-1, 'rotation'); assert.equal(editor.frame.camera.angle_rad, 0.3); assert.equal(editor.frame.camera.scale, 2);
});

test('authored camera range commands key composed values, preserve other tracks and undo atomically', () => {
  const {editor} = fixture();
  editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 1000, interpolation: 'hold'}, {target: {kind: 'camera'}, property: 'x', tick: 2, value: 2000},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff778899}]);
  const before = editor.serialize(), count = editor._undo.length, raw = editor.report.keyframes.map(frame => clone(frame.camera));
  assert.equal(editor.transformCamera({x: 7, scale: 2}, [0, 2]), 2);
  assert.equal(cameraAt(editor, 0).x, 1007); assert.equal(cameraAt(editor, 2).x, 2007);
  assert.equal(cameraAt(editor, 0).scale, 1); assert.equal(cameraAt(editor, 2).scale, 2);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.camera), raw);
  assert.equal(editor._undo.length, count + 1); assert.equal(editor.animationChannel({kind: 'camera'}, 'x').keys[0].interpolation, 'constant');
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.setCameraValues({x: 450}, [0, 2]); assert.equal(cameraAt(editor, 0).x, 450); assert.equal(cameraAt(editor, 2).x, 450);
});

test('authored camera multi-property preview commits once and cancel retains original keys by identity', () => {
  const {editor} = fixture(); editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 1000, interpolation: 'hold'}]);
  const before = editor.serialize(), animation = editor.report._styk.animation, count = editor._undo.length;
  editor.beginCameraDrag({indices: [0, 1]});
  for (let i = 1; i <= 30; i++) editor.updateCameraDrag({x: i, angle_rad: i / 100});
  assert.equal(cameraAt(editor, 0).x, 1030); near(cameraAt(editor, 1).angle_rad, -0.2);
  assert.equal(editor._undo.length, count); assert.ok(editor.commitDrag()); assert.equal(editor._undo.length, count + 1);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  const restored = editor.report._styk.animation;
  editor.beginCameraDrag({indices: [0, 1]}); editor.updateCameraDrag({x: 25}); editor.cancelDrag();
  assert.equal(editor.report._styk.animation, restored); assert.deepEqual(editor.serialize(), before);
  assert.equal(animation.channels[0].keys[0].value, 1000);
  editor.beginCameraDrag(); editor.updateCameraDrag({x: 20}); editor.updateCameraDrag({x: 0}); assert.equal(editor.commitDrag(), false);
});

test('authored camera current-point editing retains an inbetween tick instead of changing the native key start', () => {
  const {editor} = fixture(); editor.report.keyframes[0].duration_raw = 10; editor._invalidate({timing: true});
  editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 0}, {target: {kind: 'camera'}, property: 'x', tick: 10, value: 100}]);
  editor.seek(5); editor.beginCameraDrag(); assert.equal(editor.tick, 5);
  editor.updateCameraDrag({x: 25}); assert.equal(editor.evaluatedFrame.camera.x, 75);
  editor.commitDrag(); assert.equal(editor.tick, 5);
  const keys = editor.animationChannel({kind: 'camera'}, 'x').keys;
  assert.equal(keys.find(key => key.tick === 0).value, 0); assert.equal(keys.find(key => key.tick === 5).value, 75);
  editor.undo(); assert.equal(editor.evaluatedFrame.camera.x, 50);
  editor.setCameraValues({x: 200}); assert.equal(editor.tick, 5); assert.equal(editor.evaluatedFrame.camera.x, 200);
});

test('no-op native camera drags preserve an omitted camera field exactly', () => {
  const {editor} = fixture(); delete editor.frame.camera; editor._invalidate();
  const count = editor._undo.length;
  editor.beginCameraDrag(); editor.updateCameraDrag({x: 0}); assert.equal(editor.commitDrag(), false);
  assert.equal('camera' in editor.frame, false); assert.equal(editor._undo.length, count);
});

test('authored camera baking preserves native poses and can be undone', () => {
  const {editor} = fixture(); editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 10}]);
  const before = editor.serialize(), native = clone(editor.report.keyframes); assert.equal(editor.applyCameraToFigures(), 1);
  assert.deepEqual(editor.report.keyframes, native); assert.equal(editor.evaluatedFrame.camera.x, 0);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('camera edits and baked joined poses roundtrip through the actual native PIV writer', () => {
  const {editor} = fixture(); editor.setCameraValues({x: 135, angle_rad: 0.6}, [0, 1]); editor.applyCameraToFigures([1]);
  const document = editor.serialize();
  const script = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
store=server.ProjectStore(server.WORKSPACE)
data,name=store.export({'document':json.load(sys.stdin),'format':'piv'})
print(json.dumps(store.import_bytes(data,name)['document']))
`;
  const python = backend.pythonCandidates()[0], result = spawnSync(python.command, [...python.args, '-c', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(document), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const imported = JSON.parse(result.stdout);
  for (const index of [0, 1, 2]) {
    const a = cameraValues(document.keyframes[index].camera), b = cameraValues(imported.keyframes[index].camera);
    for (const field of ['x', 'y', 'scale', 'angle_rad']) near(a[field], b[field]);
    const original = buildGeometry(document, document.keyframes[index]), reopened = buildGeometry(imported, imported.keyframes[index]);
    const byUid = new Map([...reopened.objects.values()].map(entry => [entry.obj.unique_id, entry]));
    for (const entry of original.objects.values()) for (const [id, point] of entry.joints) pointNear(point, byUid.get(entry.obj.unique_id).joints.get(id));
  }
});
