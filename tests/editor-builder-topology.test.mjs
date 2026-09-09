import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame, defaultFigure} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import backend from '../desktop/backend.cjs';

const near = (actual, expected, tolerance = 8e-5) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const nearPoint = (actual, expected) => {near(actual.x, expected.x); near(actual.y, expected.y);};
function fixture() {
  const report = emptyDocument(), base = defaultFigure().segments[0];
  report.figure_types[0].segments = [
    {...base, segment_id: 30, parent_id: 20, length: 24, angle_rad: -.5, bend_rad: .2},
    {...base, segment_id: 40, parent_id: 0, length: 35, angle_rad: 2.1},
    {...base, segment_id: 20, parent_id: 10, length: 48, angle_rad: .4, bend_rad: .6},
    {...base, segment_id: 10, parent_id: 0, length: 55, angle_rad: -.3, bend_rad: .2},
  ];
  report.figure_types[0].polyfills = [{polyfill_id: 1, segment_ids: [0, 10, 20, 40], color_rgb: [80, 100, 200], z_order: 0},
    {polyfill_id: 2, segment_ids: [0, 10, 40], color_rgb: [220, 80, 100], z_order: 0}];
  report.figure_types.push({...defaultFigure(2), segments: [{...base, segment_id: 1, parent_id: 0, length: 15, angle_rad: 1.1}]});
  report.keyframes = [0, 1].map(i => createFrame([
    createObject(report.figure_types[0], 1, 180 + 35 * i, 150, {scale: .8 + i * .3,
      angles: report.figure_types[0].segments.map(segment => segment.angle_rad + i * .25), len_flag: 1,
      lengths: report.figure_types[0].segments.map(segment => segment.length * (1 + i * .2)), bend_flag: 1,
      bends: report.figure_types[0].segments.map(segment => (segment.bend_rad ?? 0) + i * .1)}),
    createObject(report.figure_types[1], 2, 0, 0, {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 20}}),
    createObject(report.figure_types[1], 3, 0, 0, {join: {target_object_slot: 1, target_unique_id: 2, target_handle_id: 1}}),
    createObject(report.figure_types[1], 4, 0, 0, {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 10}}),
  ], 4));
  const editor = new Editor({demo: false}).load(report); editor.select(1, 3); editor.captureFrameSource(editor.report.keyframes[1]); return editor;
}
const geometry = (editor, frame) => buildGeometry(editor.report, frame);
function roundtrip(editor) {
  const python = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
payload=json.load(sys.stdin); doc=payload['document']; store=server.ProjectStore(server.WORKSPACE); out={}
for kind in ('piv','stk'):
 raw,name=store.export({'document':doc,'format':kind,'figureTypeId':payload['figureTypeId']})
 out[kind]=store.import_bytes(raw,name)['document']
print(json.dumps(out))
`;
  const candidate = backend.pythonCandidates()[0], result = spawnSync(candidate.command, [...candidate.args, '-c', python], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify({document: editor.serialize(), figureTypeId: editor.figure.figure_type_id}), encoding: 'utf8', windowsHide: true, maxBuffer: 6 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr); return JSON.parse(result.stdout);
}

test('plain builder Delete removes only one sparse segment and reconnects every posed branch', () => {
  const editor = fixture(), before = structuredClone(editor.serialize()), frames = editor._allSourceFrames(), geometries = frames.map(frame => geometry(editor, frame));
  const history = editor._undo.length; assert.equal(editor.deleteSingleSegment(), true); assert.equal(editor._undo.length, history + 1);
  assert.deepEqual(editor.figure.segments.map(s => s.segment_id), [30, 40, 20]); assert.equal(editor.figure.segments[2].parent_id, 0);
  assert.deepEqual(editor.figure.polyfills.map(poly => poly.segment_ids), [[0, 20, 40]]);
  frames.forEach((frame, index) => {
    const old = geometries[index], next = geometry(editor, frame), first = old.objects.get(0), shift = {x: first.root.x - first.joints.get(10).x, y: first.root.y - first.joints.get(10).y};
    for (const id of [20, 30]) nearPoint(next.objects.get(0).joints.get(id), {x: first.joints.get(id).x + shift.x, y: first.joints.get(id).y + shift.y});
    nearPoint(next.objects.get(0).joints.get(40), first.joints.get(40));
    assert.equal(frame.objects[3].join, null); nearPoint(next.objects.get(3).root, old.objects.get(3).root);
    for (const slot of [1, 2]) nearPoint({x: frame.objects[slot].root_x, y: frame.objects[slot].root_y}, next.objects.get(slot).root);
  });
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: editor._allSourceFrames()}));
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(editor.serialize(), after);
});
test('Unsplit preserves every surviving endpoint with curved posed lengths and retained sources', () => {
  const editor = fixture(), frames = editor._allSourceFrames(), before = frames.map(frame => geometry(editor, frame));
  editor.unsplitSegment();
  frames.forEach((frame, index) => {
    const after = geometry(editor, frame);
    for (const id of [0, 20, 30, 40]) nearPoint(after.objects.get(0).joints.get(id), before[index].objects.get(0).joints.get(id));
    for (const slot of [1, 2, 3]) nearPoint(after.objects.get(slot).root, before[index].objects.get(slot).root);
    assert.equal(frame.objects[0].len_flag, 1); assert.equal(frame.objects[0].angles.length, 3);
  });
  const native = roundtrip(editor);
  for (const kind of ['piv', 'stk']) {const saved = native[kind].figure_types.find(f => f.polyfills?.length === 1); assert.equal(saved?.segments.length, 3, JSON.stringify(native[kind].figure_types.map(f => ({id:f.figure_type_id,segments:f.segments.length,polys:f.polyfills?.length}))));}
  const nativeHandle = new Map([[0, 0], ...editor.figure.segments.map(s => s.segment_id).sort((a,b) => a-b).map((id, i) => [id, i + 1])]);
  for (let i = 0; i < 2; i++) {
    const reopened = buildGeometry(native.piv, native.piv.keyframes[i]);
    for (const id of [0, 20, 30, 40]) nearPoint(reopened.objects.get(0).joints.get(nativeHandle.get(id)), before[i].objects.get(0).joints.get(id));
  }
});
test('straight Split then Unsplit restores the original endpoints, lengths and native handle IDs', () => {
  const editor = new Editor({demo: false}); editor.addFigure(); editor.select(editor.selectedUid, 0);
  const original = editor.figure.segments.map(s => ({...s})), joints = new Map(editor.geometry.objects.get(0).joints);
  editor.splitSegment(); const midpoint = editor.figure.segments[editor.selectedJoint].segment_id; assert.notEqual(midpoint, original[0].segment_id);
  editor.unsplitSegment(); assert.deepEqual(editor.figure.segments.map(s => s.segment_id), original.map(s => s.segment_id));
  near(editor.figure.segments[0].length, original[0].length);
  for (const [id, point] of joints) nearPoint(editor.geometry.objects.get(0).joints.get(id), point);
});

test('native Ctrl+Delete merges tangent same-direction arcs, while corners and opposite bends keep their shape', () => {
  for (const [bendA, bendB, corner, expected] of [[.6, .4, 0, 1], [-.6, -.4, 0, -1], [.6, -.4, 0, -.4], [.6, .4, .03, .4], [3.2, 3.2, 0, 3.2]]) {
    const report = emptyDocument(), figure = report.figure_types[0], base = defaultFigure().segments[0];
    figure.segments = [{...base, segment_id: 10, parent_id: 0, angle_rad: .2, bend_rad: bendA, length: 30},
      {...base, segment_id: 20, parent_id: 10, angle_rad: .2 + bendA + corner, bend_rad: bendB, length: 20}];
    figure.segment_count = 2;
    report.keyframes = [createFrame([createObject(figure, 1, 150, 200)], 1)];
    const editor = new Editor({demo: false}).load(report); editor.select(1, 0);
    const endpoint = editor.geometry.objects.get(0).joints.get(20); editor.unsplitSegment();
    near(editor.figure.segments[0].bend_rad, expected); near(editor.object.bends[0], expected);
    nearPoint(editor.geometry.objects.get(0).joints.get(20), endpoint);
    const after = editor.serialize(); editor.undo(); assert.equal(editor.figure.segments.length, 2); editor.redo(); assert.deepEqual(editor.serialize(), after);
  }
});
test('failed Unsplit is atomic and mirror retains runtime-only native lengths and bends', () => {
  const editor = fixture();
  for (const frame of editor._allSourceFrames()) {
    frame.objects[0].len_flag = frame.objects[0].bend_flag = 0;
    frame.objects[0].lengths = frame.objects[0].bends = [];
    frame.objects[0].runtime_segments = editor.figure.segments.map(segment => ({length: segment.length * 1.3, bend_rad: .4}));
  }
  editor.mirrorSegmentBranch();
  for (const frame of editor._allSourceFrames()) {
    const object = frame.objects[0]; assert.equal(object.len_flag, 1); assert.equal(object.bend_flag, 1);
    near(object.lengths[0], 24 * 1.3); near(object.bends[0], -.4); near(object.bends[1], .4); assert.equal(object.runtime_segments, undefined);
  }
  editor.undo(); editor.report.keyframes[0].objects[0].runtime_segments[2].bend_rad = 2 * Math.PI;
  const before = editor.serialize(), history = editor._undo.length;
  assert.throws(() => editor.unsplitSegment(), /full-circle/); assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
});
test('single-segment mirror moves descendants without rotating them; branch mirror reflects their full poses', () => {
  for (const branch of [false, true]) for (const axis of ['horizontal', 'vertical']) {
    const editor = fixture(), frames = editor._allSourceFrames(), before = frames.map(frame => geometry(editor, frame)), snapshots = frames.map(frame => structuredClone(frame.objects[0]));
    editor.mirrorSegment(axis, {branch});
    frames.forEach((frame, index) => {
      const old = before[index].objects.get(0), next = geometry(editor, frame).objects.get(0), pivot = old.root;
      const reflect = p => axis === 'horizontal' ? {x: 2 * pivot.x - p.x, y: p.y} : {x: p.x, y: 2 * pivot.y - p.y};
      nearPoint(next.joints.get(10), reflect(old.joints.get(10)));
      for (const id of [20, 30]) {
        if (branch) nearPoint(next.joints.get(id), reflect(old.joints.get(id)));
        else {const delta = {x: next.joints.get(10).x - old.joints.get(10).x, y: next.joints.get(10).y - old.joints.get(10).y}; nearPoint(next.joints.get(id), {x: old.joints.get(id).x + delta.x, y: old.joints.get(id).y + delta.y});}
      }
      nearPoint(next.joints.get(40), old.joints.get(40));
      if (!branch) for (const i of [0, 1, 2]) assert.equal(frame.objects[0].angles[i], snapshots[index].angles[i]);
      for (const slot of [1, 2, 3]) nearPoint({x: frame.objects[slot].root_x, y: frame.objects[slot].root_y}, geometry(editor, frame).objects.get(slot).root);
    });
    assert.equal(editor.figure.segments[3].angle_rad, axis === 'horizontal' ? -Math.PI + .3 : .3);
  }
});
test('media mirror toggles only the native mirror byte and retains image assets through PIV/STK', () => {
  const editor = new Editor({demo: false}), figure = createImageFigure({dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', width: 1, height: 1, name: 'Mirror image'});
  editor.importFigure(figure); editor.select(editor.selectedUid, 0);
  const asset = editor.figure.image_assets[0], reverse = editor.figure.segments[0].extra_u8_a, source = structuredClone(editor.serialize());
  editor.mirrorSegmentBranch(); assert.equal(editor.figure.image_assets[0], asset); assert.equal(editor.figure.segments[0].extra_u8_b, 1); assert.equal(editor.figure.segments[0].extra_u8_a, reverse);
  editor.undo(); assert.deepEqual(editor.serialize(), source); editor.redo();
  assert.throws(() => editor.deleteSingleSegment(), /at least one/);
  const saved = roundtrip(editor);
  for (const kind of ['piv', 'stk']) {const reopened = saved[kind].figure_types.find(f => f.image_assets?.length); assert.equal(reopened.segments[0].extra_u8_b, 1); assert.equal(reopened.image_assets.length, 1);}
});
test('30,000 reverse-ordered segments mirror as a branch without recursion or quadratic scans', () => {
  const editor = new Editor({demo: false}); editor.addFigure(); const base = editor.figure.segments[0], count = 30000;
  editor.figure.segments = Array.from({length: count}, (_, i) => ({...base, segment_id: count - i, parent_id: count - i - 1, length: 1}));
  editor.object.angles = editor.figure.segments.map(s => s.angle_rad); editor.select(editor.selectedUid, count - 1);
  editor.mirrorSegmentBranch(); assert.equal(editor.figure.segments.length, count);
  assert.ok(editor.object.angles.every(angle => angle === -Math.PI / 2)); editor.undo(); assert.equal(editor.figure.segments.length, count);
});
