import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {evaluatedFrame, timeline, buildGeometry} from '../src/pivot/geometry.mjs';
import {animationRotation, animationOriginOffset, synchronizeAnimationOrigin} from '../src/animation-origin.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import backend from '../desktop/backend.cjs';
const clone = structuredClone;
function fixture({authored = true, easing = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = [7, 99, 301, 502].map((id, i) => ({...clone(base), segment_id: id, parent_id: [0, 7, 7, 301][i],
    length: [78, 43, 31, 26][i], angle_rad: [-.8, .5, -1.2, .2][i], bend_rad: [.2, -.3, .1, -.25][i], z_order: i}));
  figure.segment_count = 4; report.auto_easing = easing;
  report.keyframes = [0, 1, 2, 3].map(i => {
    const object = createObject(figure, 1, 170 + i * 17, 200 - i * 11);
    object.angles = [[-2.8, 2.3, .5, -.8], [2.7, -2.8, -.9, 1.3], [-1.7, .8, 2.4, -.7], [.4, -.6, -2.2, .4]][i];
    object.scale = [.8, 1.7, 1.2, .65][i]; object.len_flag = object.bend_flag = 1;
    object.lengths = [78 + i * 7, 43 - i * 3, 31 + i * 2, 26 + i];
    object.bends = [[.2, -.3, .1, -.25], [-.9, .7, .2, .45], [1.1, -.5, -.6, .3], [.1, .4, .8, -.7]][i];
    return createFrame([object], i === 3 ? 1 : [7, 5, 8][i]);
  });
  const editor = new Editor({demo: false}).load(report); editor.select(1, 0);
  if (authored) editor.addAnimationKeys([['rotation', [-.5, .9, -1.7]], ['scale', [.6, 1.8, .95]], ['x', [183, 277, 221]], ['y', [230, 168, 249]]]
    .flatMap(([property, values]) => [0, 8, 20].map((tick, i) => ({target: {kind: 'figure', uid: 1}, property, tick, value: values[i]}))));
  editor.setOrigin(99); return editor;
}
function sample(report, tick) {
  const rows = timeline(report); let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  return evaluatedFrame(report, index, rows[index].count ? (tick - rows[index].start) / rows[index].count : 0, tick);
}
function pose(report, tick) {const frame = sample(report, tick); return {frame, geometry: buildGeometry(report, frame)};}
function equalGeometry(a, b, tolerance = .0002) {
  for (const [slot, object] of a.geometry.objects) {
    const actual = b.geometry.objects.get(slot); assert.equal(actual.segments.length, object.segments.length);
    const remaining = new Set(actual.segments);
    for (const segment of object.segments) {
      let closest, distance = Infinity;
      for (const candidate of remaining) {
        if (candidate.points.length !== segment.points.length) continue;
        for (const reverse of [false, true]) {
          let maximum = 0;
          for (let i = 0; i < segment.points.length; i++) {const p = segment.points[i], q = candidate.points[reverse ? candidate.points.length - 1 - i : i]; maximum = Math.max(maximum, Math.hypot(p.x - q.x, p.y - q.y));}
          if (maximum < distance) {distance = maximum; closest = candidate;}
        }
      }
      assert.ok(distance < tolerance, `world curve error ${distance}`); remaining.delete(closest);
    }
  }
}
function nativeDeleteExpected(before, after, tick, removed) {
  const frame = clone(sample(before, tick)), figure = before.figure_types[0], keep = figure.segments.flatMap((segment, index) => removed.has(segment.segment_id) ? [] : [index]);
  for (const object of frame.objects) if (object.figure_type_id === figure.figure_type_id) {object.angles = keep.map(i => object.angles[i]); if (object.len_flag) object.lengths = keep.map(i => object.lengths[i]); if (object.bend_flag) object.bends = keep.map(i => object.bends[i]); delete object.runtime_segments;}
  return {frame, geometry: buildGeometry(after, frame)};
}
for (const authored of [false, true]) for (const easing of [false, true]) test(`deleting the original reference retains continuous motion and native branch reconnection (${authored}/${easing})`, () => {
  const editor = fixture({authored, easing}), before = editor.serialize(), oldFigure = before.figure_types[0];
  const reference = editor.figure._styk.animationOrigin.rotationHandleId; editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === reference));
  const history = editor._undo.length; editor.deleteSingleSegment();
  assert.equal(editor._undo.length, history + 1); assert.deepEqual(editor.animationChannels, before._styk.animation?.channels ?? []);
  const support = editor.figure._styk.animationOrigin.support; assert.ok(support); assert.equal(support.bones[support.rotation].handleId, null);
  assert.equal(editor.figure.segments.length, 3); assert.ok(editor.report.keyframes.every(frame => Object.keys(frame.objects[0]._stykAnimationOrigin.ghosts).length === 1));
  for (let i = 0; i <= 200; i++) {
    const tick = i / 10, a = sample(before, tick).objects[0], b = sample(editor.report, tick).objects[0];
    assert.ok(Math.abs(animationRotation(oldFigure, a) - animationRotation(editor.figure, b)) < 1e-10, `tick ${tick}: rotation ${animationRotation(oldFigure, a)} -> ${animationRotation(editor.figure, b)}`);
    equalGeometry(nativeDeleteExpected(before, editor.report, tick, new Set([reference])), pose(editor.report, tick));
  }
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(editor.serialize(), after);
});
test('support survives repeated reroot, new instances, and another destructive edit without rendering ghosts', () => {
  const editor = fixture(), reference = editor.figure._styk.animationOrigin.rotationHandleId;
  editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === reference)); editor.deleteSingleSegment();
  const before = editor.serialize(); editor.setOrigin(502);
  for (let i = 0; i <= 100; i++) equalGeometry(pose(before, i / 5), pose(editor.report, i / 5));
  const object = createObject(editor.figure, 9, 300, 200), offset = animationOriginOffset(editor.figure, object);
  assert.ok(object._stykAnimationOrigin.ghosts); assert.equal(animationRotation(editor.figure, object), 0);
  assert.equal(object._stykAnimationOrigin.x, 300 + offset.x); assert.equal(object._stykAnimationOrigin.y, 200 + offset.y);
  editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === 301)); editor.deleteSingleSegment();
  validateScene(editor.report); assert.equal(editor.geometry.objects.get(0).segments.length, 2);
});
test('deleting an intermediate construction joint translates its branch with the same continuous angular basis', () => {
  const editor = fixture({easing: true}), before = editor.serialize(); editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === 7));
  editor.deleteSingleSegment();
  for (let i = 0; i <= 100; i++) equalGeometry(nativeDeleteExpected(before, editor.report, i / 5, new Set([7])), pose(editor.report, i / 5));
  const current = editor.serialize(), removed = new Set([301, 502]); editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === 301)); editor.deleteSegment();
  for (let i = 0; i <= 100; i++) equalGeometry(nativeDeleteExpected(current, editor.report, i / 5, removed), pose(editor.report, i / 5));
  assert.equal(editor.figure.segments.length, 1); validateScene(editor.report);
});
test('Unsplit after reroot retains pose endpoints and animated transform curves with hidden references', () => {
  const editor = fixture(), before = editor.serialize(); editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === 7));
  const keys = timeline(before).map(row => row.start), endpoints = keys.map(tick => pose(before, tick).geometry.objects.get(0).joints);
  editor.unsplitSegment();
  keys.forEach((tick, index) => {
    const actual = pose(editor.report, tick).geometry.objects.get(0).joints;
    for (const handle of [0, 99, 301, 502]) {const a = endpoints[index].get(handle), b = actual.get(handle); assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < .0002, `tick ${tick} handle ${handle}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);}
  });
  for (let i = 0; i <= 100; i++) {
    const tick = i / 5, a = sample(before, tick).objects[0], b = sample(editor.report, tick).objects[0];
    assert.ok(Math.abs(animationRotation(before.figure_types[0], a) - animationRotation(editor.figure, b)) < 1e-10);
    assert.ok(Math.abs(a._stykAnimationOrigin.x - b._stykAnimationOrigin.x) < 1e-10);
    assert.ok(Math.abs(a._stykAnimationOrigin.y - b._stykAnimationOrigin.y) < 1e-10);
  }
});
test('support splits preserve dense animation after deletion and retain the original reference', () => {
  const editor = fixture(), reference = editor.figure._styk.animationOrigin.rotationHandleId;
  editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === reference)); editor.deleteSingleSegment();
  const before = editor.serialize(), values = Array.from({length: 101}, (_, i) => sample(before, i / 5));
  editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === 301)); editor.splitSegment(.4);
  for (let i = 0; i <= 100; i++) {
    const after = sample(editor.report, i / 5), old = values[i].objects[0];
    assert.ok(Math.abs(animationRotation(editor.figure, after.objects[0]) - animationRotation(before.figure_types[0], old)) < 1e-10);
    const oldEnd = buildGeometry(before, values[i]).objects.get(0).joints.get(301), newEnd = buildGeometry(editor.report, after).objects.get(0).joints.get(301);
    assert.ok(Math.hypot(oldEnd.x - newEnd.x, oldEnd.y - newEnd.y) < .0002);
  }
});
test('independently retimed joined descendants and retained sources follow native deletion without losing their animation anchors', () => {
  const initial = fixture(), report = initial.serialize(), childFigure = {...clone(report.figure_types[0]), figure_type_id: 2}; report.figure_types.push(childFigure);
  report.keyframes.forEach((frame, index) => {
    const child = createObject(childFigure, 2, 0, 0, {scale: .25, angles: childFigure.segments.map(segment => segment.angle_rad + index * .15),
      join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 301}});
    child.object_slot = 1; frame.objects.push(child); frame.object_draw_order = [0, 1];
    const root = buildGeometry(report, frame).objects.get(1).root; child.root_x = root.x; child.root_y = root.y; synchronizeAnimationOrigin(childFigure, child);
  });
  const editor = new Editor({demo: false}).load(report), layer = editor.createLayer('Retimed attached figure'); editor.assignFiguresToLayer([2], layer.id);
  const parent = editor.nativePoseChannel({kind: 'layer', id: 'layer-1'}), child = editor.nativePoseChannel({kind: 'layer', id: layer.id});
  editor.moveAnimationKeys([{channelId: parent.id, keyIds: [parent.keys[1].id]}], 2);
  editor.moveAnimationKeys([{channelId: child.id, keyIds: [child.keys[2].id]}], -1);
  const source = editor.captureFrameSource(sample(editor.report, 4.5)); editor.addAnimationKey({kind: 'layer', id: layer.id}, 'pose', 4, {frameId: source});
  const before = editor.serialize(); editor.select(1, editor.report.figure_types[0].segments.findIndex(segment => segment.segment_id === 7)); editor.deleteSingleSegment();
  for (let i = 0; i <= 100; i++) equalGeometry(nativeDeleteExpected(before, editor.report, i / 5, new Set([7])), pose(editor.report, i / 5));
  assert.ok(editor.report._styk.frameSources[source].objects[0]._stykAnimationOrigin.ghosts);
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(editor.serialize(), after);
  editor.seek(7); editor.select(2); const visible = {frame: clone(editor.selectionFrame), geometry: editor.geometry}; editor.unjoinFigure();
  equalGeometry(visible, {frame: editor.selectionFrame, geometry: editor.geometry});
});
function roundtrip(document, format) {
  const script = "import json,sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path('backend').resolve()))\nimport server\nr=json.loads(sys.stdin.buffer.read().decode('utf-8'));s=server.ProjectStore(server.WORKSPACE);raw,name=s.export(r)\nprint(json.dumps(s.import_bytes(raw,name)['document']))";
  const python = backend.pythonCandidates()[0], result = spawnSync(python.command, [...python.args, '-c', script], {cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify({document, format}), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('native PIV materializes support poses while STYK preserves editable support and exact undo', () => {
  const editor = fixture(), reference = editor.figure._styk.animationOrigin.rotationHandleId;
  editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === reference)); editor.deleteSingleSegment();
  const before = editor.serialize(), styk = roundtrip(before, 'styk'), native = roundtrip(materializePivotDocument(before), 'piv');
  assert.deepEqual(styk.figure_types[0]._styk.animationOrigin, before.figure_types[0]._styk.animationOrigin);
  assert.ok(native.figure_types.every(figure => !figure._styk?.animationOrigin));
  for (let tick = 0; tick <= 20; tick++) {equalGeometry(pose(before, tick), pose(styk, tick)); equalGeometry(pose(before, tick), pose(native, tick), .0005);}
  assert.deepEqual(editor.serialize(), before);
});
