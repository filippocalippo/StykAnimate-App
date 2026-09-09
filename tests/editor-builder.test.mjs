import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {editorBuilderMethods, segmentBranchIndices} from '../src/editor-builder.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import backend from '../desktop/backend.cjs';
import {createImageFigure} from '../src/media-authoring.mjs';

Object.assign(Editor.prototype, editorBuilderMethods);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
const blank = () => { const editor = new Editor({demo: false}); editor.addFigure(); editor.markSaved(); return editor; };
const sparse = editor => {
  const figure = editor.figure;
  for (const segment of figure.segments) { segment.segment_id *= 11; segment.parent_id *= 11; }
  return figure;
};

test('polygons follow sparse native handle IDs, include origin and preserve existing poses', () => {
  const editor = blank(); sparse(editor);
  const poses = structuredClone(editor.report.keyframes), frame = editor.frame, objects = frame.objects;
  const polygon = editor.addPolygon([0, 11, 33, 0], {color: '#0d99ff', opacity: 0.4});
  assert.deepEqual(polygon.segment_ids, [0, 11, 33]); assert.deepEqual(polygon.color_rgb, [13, 153, 255]);
  assert.equal(polygon.alpha_raw, 153); assert.equal(polygon.z_order, 0);
  assert.equal(editor.frame, frame); assert.equal(editor.frame.objects, objects); assert.deepEqual(editor.report.keyframes, poses);
  const geometry = editor.geometry, fill = geometry.drawables.find(s => s.type === 'poly');
  assert.equal(fill.points.length, 3);
  near(fill.points[0].x, geometry.objects.get(0).root.x);
  const document = editor.serialize(); assert.doesNotThrow(() => validateScene(document));
  assert.equal(editor._undo.at(-1).kind, 'figure'); assert.equal(editor.undoLabel, 'Create polygon');
  editor.undo(); assert.equal(editor.figure.polyfills.length, 0); editor.redo(); assert.deepEqual(editor.serialize(), document);
});

test('polygon edits and deletion are undoable and reject invalid geometry atomically', () => {
  const editor = blank(); editor.addPolygon([0, 1, 3]); const old = structuredClone(editor.figure);
  const history = editor._undo.length;
  for (const ids of [[1, 2], [1, 1, 2, 3], [0, 1, 999], [0, 1, 0]]) assert.throws(() => editor.addPolygon(ids), /polygon|handles/i);
  assert.throws(() => editor.updatePolygon(0, {color: '#oops'}), /color/i);
  assert.throws(() => editor.updatePolygon(0, {opacity: 2}), /opacity/i);
  assert.deepEqual(editor.figure, old); assert.equal(editor._undo.length, history);
  editor.updatePolygon(0, {handleIds: [0, 7, 9], color: [200, 90, 20], opacity: 0.75, zOrder: 99});
  assert.deepEqual(editor.figure.polyfills[0].segment_ids, [0, 7, 9]);
  assert.equal(editor.figure.polyfills[0].z_order_runtime_raw, 98);
  editor.removePolygon(0); assert.equal(editor.figure.polyfills.length, 0);
  editor.undo(); assert.deepEqual(editor.figure.polyfills[0].segment_ids, [0, 7, 9]);
  editor.undo(); assert.deepEqual(editor.figure, old);
});

test('figure styles edit only their reusable definition across every animation keyframe', () => {
  const editor = new Editor(), frames = editor.report.keyframes;
  const poses = structuredClone(frames), old = structuredClone(editor.figure);
  editor.updateFigureStyle({name: 'Ink walker', outlineWidth: 2.5, outlineColor: '#ff8000', outlineOpacity: 0.8});
  assert.equal(editor.figure.name, 'Ink walker'); assert.equal(editor.report.keyframes, frames); assert.deepEqual(frames, poses);
  const style = editor.figure.segment_decode.global_style;
  assert.equal(style.outline_thickness, 2.5); assert.equal(style.u30, 51);
  assert.equal(new Float32Array(new Uint32Array([style.u28]).buffer)[0], 2.5);
  editor.undo(); assert.deepEqual(editor.figure, old);
  assert.throws(() => editor.updateFigureStyle({outlineWidth: -1}), /outline/i);
  assert.deepEqual(editor.figure, old);
});

test('round caps, square caps, circle fills, gradients and static flags survive serialization', () => {
  const editor = blank(); editor.select(editor.selectedUid, 0);
  editor.updateSegmentStyle({color: '#ff0000', opacity: 0.25, thickness: 7, static: true, gradient: {color: '#0000ff', opacity: 0.5}, shape: 'squareLine'});
  const segment = editor.figure.segments[0];
  assert.equal(segment.primitive_code, 6); assert.equal(segment.flags, 262); assert.equal(segment.segment_kind, 'squareLine');
  assert.equal(segment.transparency, 191); assert.deepEqual(segment.secondary, {rgb: [0, 0, 255], a: 128}); assert.equal(segment.is_static, true);
  for (const [shape, code] of [['circle', 1], ['circleFill', 3], ['circleClear', 4], ['line', 0]]) {
    editor.convertSegment(shape); assert.equal(editor.figure.segments[0].primitive_code, code);
  }
  const doc = editor.serialize(); assert.doesNotThrow(() => validateScene(doc));
  const history = editor._undo.length, before = structuredClone(editor.figure);
  assert.throws(() => editor.updateSegmentStyle({gradient: {color: [1, 2, 999]}}), /color/i);
  assert.throws(() => editor.updateSegmentStyle({static: 1}), /static/i);
  assert.throws(() => editor.convertSegment('text'), /line|circle/i);
  assert.equal(editor._undo.length, history); assert.deepEqual(editor.figure, before);
  editor.updateSegmentStyle({gradient: null, static: false}); assert.equal(editor.figure.segments[0].secondary, null);
  assert.equal(editor.figure.segments[0].flags, 0);
});

test('duplicating a sparse branch preserves posed lengths, bends, internal fills and external joins', () => {
  const editor = blank(), figure = sparse(editor);
  editor.addPolygon([0, 77, 88], {color: '#abcdef'});
  editor.object.len_flag = 1; editor.object.lengths = figure.segments.map(s => s.length * 1.2);
  editor.object.bend_flag = 1; editor.object.bends = figure.segments.map(() => 0.2);
  editor.object.angles = editor.object.angles.map(a => a + 0.4);
  const parentUid = editor.selectedUid; editor.addFigure(); const childUid = editor.selectedUid;
  editor.joinTo(parentUid, 88); editor.select(parentUid, 6); editor.addFrame(); editor.select(parentUid, 6);
  const before = editor.serialize(), original = structuredClone(editor.object);
  const result = editor.duplicateSegmentBranch({angleOffset: 0.35});
  assert.deepEqual(result.handleIds, [111, 112]); assert.equal(result.selectedHandleId, 111);
  assert.equal(editor.figure.segments.length, 12); assert.equal(editor.selectedJoint, 10);
  assert.equal(editor.figure.segments[10].parent_id, 0); assert.equal(editor.figure.segments[11].parent_id, 111);
  assert.deepEqual(editor.figure.polyfills[1].segment_ids, [0, 111, 112]);
  for (const frame of editor.report.keyframes) {
    const obj = frame.objects.find(o => o.unique_id === parentUid), child = frame.objects.find(o => o.unique_id === childUid);
    near(obj.angles[10], original.angles[6] + 0.35); near(obj.lengths[11], original.lengths[7]); near(obj.bends[10], original.bends[6]);
    assert.equal(child.join.target_handle_id, 88);
    assert.doesNotThrow(() => buildGeometry(editor.report, frame));
  }
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
});

test('branch copies retain one embedded media table and cannot orphan assets by shape conversion', () => {
  const editor = new Editor({demo: false});
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
  editor.importFigure(createImageFigure({dataUrl, width: 1, height: 1, name: 'Pixel'}));
  editor.select(editor.selectedUid, 0); editor.duplicateSegmentBranch();
  assert.equal(editor.figure.image_assets.length, 1); assert.equal(editor.figure.image_assets[0].data_url, dataUrl);
  assert.equal(editor.figure.segments.length, 2); assert.equal(editor.figure.segments[1].extra_u16, 0);
  assert.equal(editor.geometry.drawables.filter(s => s.type === 'image').length, 2);
  const before = editor.serialize(), history = editor._undo.length;
  assert.throws(() => editor.convertSegment('circle'), /media type/);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
});

test('30,000 reverse-ordered joints use linear branch discovery without recursion', () => {
  const count = 30000; let reads = 0;
  const segments = Array.from({length: count}, (_, i) => {
    const id = count - i;
    return {segment_id: id, get parent_id() { reads++; return id - 1; }};
  });
  const indices = segmentBranchIndices(segments, 1);
  assert.equal(indices.length, count); assert.equal(indices[0], 0); assert.equal(indices.at(-1), count - 1);
  assert.ok(reads <= count * 2, `Expected linear hierarchy reads; observed ${reads}.`);
  assert.deepEqual(segmentBranchIndices(segments, count - 1), [0, 1]);
  assert.deepEqual(segmentBranchIndices([{segment_id: 9, parent_id: 3}, {segment_id: 7, parent_id: 0}, {segment_id: 3, parent_id: 0}], 3), [0, 2]);
});

test('branch duplication supports the full native 30,000-segment figure capacity', () => {
  const editor = blank(), count = 15000, figure = editor.figure, base = figure.segments[0];
  figure.segments = Array.from({length: count}, (_, i) => {
    const id = count - i; return {...base, segment_id: id, parent_id: id - 1, z_order: id};
  });
  figure.segment_count = count; editor.object.angles = figure.segments.map(s => s.angle_rad);
  editor.select(editor.selectedUid, count - 1);
  const result = editor.duplicateSegmentBranch({angleOffset: 0});
  assert.equal(editor.figure.segments.length, 30000); assert.equal(editor.object.angles.length, 30000);
  assert.equal(result.handleIds.length, count); assert.equal(result.selectedHandleId, 30000);
  assert.equal(editor.figure.segments[15000].segment_id, 15001);
  assert.equal(editor.figure.segments[15000].parent_id, 15002);
  assert.equal(editor.figure.segments.at(-1).parent_id, 0);
  assert.doesNotThrow(() => validateScene(editor.report));
  const history = editor._undo.length;
  assert.throws(() => editor.duplicateSegmentBranch(), /30,000/); assert.equal(editor._undo.length, history);
  editor.undo(); assert.equal(editor.figure.segments.length, 15000); assert.equal(editor.object.angles.length, 15000);
  editor.redo(); assert.equal(editor.figure.segments.length, 30000);
});

test('new polygons and authored segment styles roundtrip through the actual PIV and STK writers', () => {
  const editor = blank(); sparse(editor); editor.select(editor.selectedUid, 6);
  editor.addPolygon([0, 77, 88], {color: '#0d99ff', opacity: 0.4});
  editor.updateFigureStyle({name: 'Builder export', outlineWidth: 1.25, outlineColor: '#ff8000', outlineOpacity: 0.8});
  editor.updateSegmentStyle({shape: 'squareLine', static: true, gradient: {color: '#0000ff', opacity: 0.6}});
  editor.duplicateSegmentBranch({angleOffset: 0.2});
  const python = String.raw`
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path('backend').resolve()))
import server
document=json.load(sys.stdin)
store=server.ProjectStore(server.WORKSPACE)
result={}
for kind in ('piv','stk'):
    raw,name=store.export({'document':document,'format':kind,'figureTypeId':document['figure_types'][0]['figure_type_id']})
    reopened=store.import_bytes(raw,name)
    figure=next(f for f in reopened['document']['figure_types'] if len(f.get('polyfills',[]))==2)
    result[kind]={'bytes':len(raw),'figure':figure}
print(json.dumps(result))
`;
  const candidate = backend.pythonCandidates()[0];
  const result = spawnSync(candidate.command, [...candidate.args, '-c', python], {cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(editor.serialize()), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const outputs = JSON.parse(result.stdout);
  for (const kind of ['piv', 'stk']) {
    const {figure, bytes} = outputs[kind]; assert.ok(bytes > 100);
    assert.equal(figure.segments.length, 12); assert.equal(figure.polyfills.length, 2);
    assert.deepEqual(figure.polyfills[0].color_rgb, [13, 153, 255]); assert.equal(figure.polyfills[0].alpha_raw, 153);
    assert.deepEqual(figure.polyfills[0].segment_ids, [0, 7, 8]); assert.deepEqual(figure.polyfills[1].segment_ids, [0, 11, 12]);
    assert.equal(figure.segments[6].primitive_code, 6); assert.equal(figure.segments[10].primitive_code, 6);
    assert.deepEqual(figure.segments[10].secondary, {rgb: [0, 0, 255], a: 102});
    assert.equal(figure.segment_decode.global_style.outline_thickness, 1.25); assert.equal(figure.segment_decode.global_style.u30, 51);
  }
});
