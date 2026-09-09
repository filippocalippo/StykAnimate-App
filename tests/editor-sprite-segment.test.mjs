import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {createObject, createFrame, emptyDocument} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {builderDrawables} from '../src/editor-builder-style.mjs';
import backend from '../desktop/backend.cjs';

const clone = structuredClone;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
function sprite(start = {x: -7, y: 5}, end = {x: 23, y: -35}) {
  const figure = createImageFigure({dataUrl: png, width: 1, height: 1, name: 'Placed sprite'});
  Object.assign(figure.image_assets[0], {anchor_start: start, anchor_end: end});
  return figure;
}
function fixture({frames = 3, posed = true} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  for (const segment of figure.segments) {segment.segment_id *= 11; segment.parent_id *= 11;}
  const other = {...clone(figure), figure_type_id: 2}; report.figure_types.push(other);
  report.keyframes = Array.from({length: frames}, (_, i) => {
    const object = createObject(figure, 1, 100 + i * 10, 200);
    if (posed) {
      object.angles = object.angles.map(angle => angle + i * .2);
      object.len_flag = object.bend_flag = 1;
      object.lengths = figure.segments.map(segment => segment.length + i * 3);
      object.bends = figure.segments.map(() => i * .1);
    }
    const child = createObject(other, 2, 300, 400);
    child.join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 33};
    return createFrame([object, child], 3);
  });
  const editor = new Editor({demo: false}).load(report); editor.select(1, 2); return editor;
}
const segmentsGeometry = (report, frame) => [...buildGeometry(report, frame).objects.values()].map(object => ({
  root: clone(object.root), segments: object.segments.map(segment => ({start: clone(segment.start), end: clone(segment.end)})),
}));

test('sprite attachment uses the selected tip and integer anchors without changing the source or existing joints', () => {
  const editor = fixture(), source = sprite(), input = clone(source), before = editor.serialize();
  const expected = editor.report.keyframes.map(frame => segmentsGeometry(editor.report, frame)), children = editor.report.keyframes.map(frame => clone(frame.objects[1])), history = editor._undo.length;
  const result = editor.addSpriteSegment(source);
  assert.deepEqual(result, {handleId: 111, segmentIndex: 10, assetIndex: 0});
  assert.deepEqual(source, input); assert.equal(editor.selectedJoint, 10);
  const segment = editor.figure.segments[10], asset = editor.figure.image_assets[0];
  assert.equal(segment.parent_id, 33); assert.equal(segment.length, 50); near(segment.angle_rad, Math.atan2(-40, 30));
  assert.equal(segment.aux_code, 0); assert.equal(segment.flags, 2); assert.equal(segment.is_static, false);
  assert.equal(segment.z_order, 11); assert.equal(asset.anchor_length, 50); near(asset.anchor_angle_rad, segment.angle_rad);
  editor.report.keyframes.forEach((frame, frameIndex) => {
    assert.equal(frame.objects[0].angles.length, 11); near(frame.objects[0].angles[10], segment.angle_rad);
    assert.equal(frame.objects[0].lengths[10], 50); assert.equal(frame.objects[0].bends[10], 0);
    assert.deepEqual(frame.objects[1], children[frameIndex]);
    const actual = segmentsGeometry(editor.report, frame); actual[0].segments.pop(); assert.deepEqual(actual, expected[frameIndex]);
  });
  const rendered = editor.geometry.objects.get(0).segments[10];
  near(rendered.angle - rendered.asset.anchor_angle_rad, 0);
  near(Math.hypot(rendered.end.x - rendered.start.x, rendered.end.y - rendered.start.y), 50);
  assert.equal(editor._undo.length, history + 1); assert.equal(editor.undoLabel, 'Add sprite segment');
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
});

test('native parent-bend interpolation governs the new sprite at an in-between tick', () => {
  const editor = fixture({frames: 2}), source = sprite({x: 0, y: 0}, {x: 10, y: 0});
  editor.report.keyframes.forEach((frame, index) => {
    const object = frame.objects[0]; object.angles = editor.figure.segments.map(segment => segment.angle_rad);
    object.bends = editor.figure.segments.map(() => 0); object.bends[0] = index * 4;
    frame.duration_raw = 10;
  });
  editor._invalidate({timing: true}); editor.seek(5); editor.select(1, 0);
  const before = editor.serialize(); editor.addSpriteSegment(source);
  // Native interpolation wraps the relative child angle before adding the
  // parent's interpolated bend. A constant source tangent can therefore turn
  // at an in-between tick; a pointer preview must not assume angle zero here.
  assert.equal(editor.figure.segments.at(-1).angle_rad, 0);
  assert.ok(editor.report.keyframes.every(frame => frame.objects[0].angles.at(-1) === 0));
  near(editor.geometry.objects.get(0).segments.at(-1).angle, Math.PI);
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after); near(editor.geometry.objects.get(0).segments.at(-1).angle, Math.PI);
});

test('origin selection, explicit parent and angle overrides retain the anchor scale', () => {
  const editor = fixture({posed: false}); editor.select(1, -1);
  editor.addSpriteSegment(sprite()); assert.equal(editor.figure.segments.at(-1).parent_id, 0);
  editor.addSpriteSegment(sprite(), {parentId: 77, angle: .25});
  assert.equal(editor.figure.segments.at(-1).parent_id, 77); assert.equal(editor.figure.segments.at(-1).angle_rad, .25);
  assert.equal(editor.figure.segments.at(-1).length, 50);
  for (const frame of editor.report.keyframes) {
    assert.equal(frame.objects[0].len_flag, 0); assert.deepEqual(frame.objects[0].lengths, []);
    assert.equal(frame.objects[0].bend_flag, 0); assert.deepEqual(frame.objects[0].bends, []);
  }
});

test('sparse existing image IDs are remapped without changing text assets, PNG bytes, or media flags', () => {
  const editor = new Editor({demo: false}); editor.importFigure(sprite());
  const figure = editor.figure, existing = figure.segments[0];
  Object.assign(figure.image_assets[0], {asset_index: 7, table_index: 7, image_index: 7});
  Object.assign(existing, {extra_u16: 7, extra: [7, 1, 1], extra_u8_a: 1, extra_u8_b: 1, image_asset_index: 7, aux_code: 1, flags: 258, is_static: true});
  figure.text_assets = [{asset_index: 7, table_index: 7, kind: 'text', text: 'Retain table'}];
  figure.side_tables = clone([...figure.image_assets, ...figure.text_assets]);
  const before = editor.serialize(), source = sprite({x: 3, y: 4}, {x: 13, y: 4});
  Object.assign(source.image_assets[0], {asset_index: 42, table_index: 42, image_index: 42}); source.segments[0].extra_u16 = 42;
  const result = editor.addSpriteSegment(source);
  assert.equal(result.assetIndex, 1); assert.deepEqual(editor.figure.image_assets.map(asset => [asset.asset_index, asset.table_index, asset.image_index]), [[0, 0, 0], [1, 1, 1]]);
  assert.deepEqual(editor.figure.segments[0].extra, [0, 1, 1]); assert.equal(editor.figure.segments[0].image_asset_index, 0);
  assert.equal(editor.figure.segments[0].aux_code, 1); assert.equal(editor.figure.segments[0].flags, 258);
  assert.deepEqual(editor.figure.segments[1].extra, [1, 0, 0]);
  assert.deepEqual(editor.figure.text_assets, before.figure_types.find(f => f.figure_type_id === figure.figure_type_id).text_assets);
  assert.equal(editor.figure.side_tables, undefined); assert.ok(editor.figure.image_assets.every(asset => asset.data_url === png));
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('retained pose sources and a dirty Simple baseline receive one segment each and undo exactly', () => {
  const editor = fixture(), sourceId = editor.captureFrameSource(editor.frame);
  editor.enableFrameDrafts(); editor.beginFrameDraft({mode: 'add', index: 2}); editor.select(1, 2);
  editor.updateObject({root_x: 777}); const before = editor.serialize(), history = editor._undo.length;
  editor.addSpriteSegment(sprite());
  assert.equal(editor.report.keyframes.length, 3); assert.equal(editor.frameDraft.mode, 'add'); assert.equal(editor.frameDraft.dirty, true);
  assert.equal(editor.frame.objects[0].root_x, 777); assert.equal(editor.report._styk.simpleFrameDraft.baseline.objects[0].root_x, 120);
  for (const frame of [...editor.report.keyframes, editor.getFrameById(sourceId), editor.report._styk.simpleFrameDraft.baseline]) {
    assert.equal(frame.objects[0].angles.length, 11); assert.equal(frame.objects[0].lengths.length, 11); assert.equal(frame.objects[0].bends.length, 11);
  }
  assert.equal(editor._undo.length, history + 1); assert.equal(editor._undo.at(-1).after.frames.filter(frame => frame.sourceId).length, 1);
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
  editor.discardFrameDraft(); assert.equal(editor.frame.objects[0].root_x, 120); assert.equal(editor.figure.segments.length, 11);
});

test('runtime lengths and bends survive conversion to explicit pose vectors', () => {
  const editor = fixture({posed: false});
  for (const frame of editor.report.keyframes) frame.objects[0].runtime_segments = editor.figure.segments.map(segment => ({length: segment.length + 4, bend_rad: .15}));
  editor._invalidate(); const before = editor.serialize(), expected = editor.report.keyframes.map(frame => segmentsGeometry(editor.report, frame));
  editor.addSpriteSegment(sprite());
  editor.report.keyframes.forEach((frame, index) => {
    const object = frame.objects[0]; assert.equal(object.len_flag, 1); assert.equal(object.bend_flag, 1); assert.equal(object.runtime_segments, undefined);
    const actual = segmentsGeometry(editor.report, frame); actual[0].segments.pop(); assert.deepEqual(actual, expected[index]);
  });
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('invalid source, coincident or fractional anchors, parent IDs, and nonfinite angles are atomic', () => {
  const editor = fixture(), before = editor.serialize(), history = editor._undo.length;
  const cases = [
    () => editor.addSpriteSegment(null), () => editor.addSpriteSegment({...sprite(), segments: []}),
    () => editor.addSpriteSegment(sprite({x: 0, y: 0}, {x: 0, y: 0})),
    () => editor.addSpriteSegment(sprite({x: .5, y: 0})),
    () => editor.addSpriteSegment(sprite({x: 2147483648, y: 0})),
    () => editor.addSpriteSegment(sprite({x: 0, y: -2147483649})),
    () => editor.addSpriteSegment(sprite(), {parentId: 2}),
    () => editor.addSpriteSegment(sprite(), {angle: NaN}),
    () => editor.addSpriteSegment(sprite(), {angle: '1'}),
    () => {const source = sprite(); source.image_assets[0].data_url = 'file:///image.png'; return editor.addSpriteSegment(source);},
    () => {const source = sprite(); source.segments[0].extra_u16 = 9; return editor.addSpriteSegment(source);},
  ];
  for (const invoke of cases) {assert.throws(invoke); assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);}
  const empty = new Editor({demo: false}); assert.throws(() => empty.addSpriteSegment(sprite()), /select a figure/i);
});

test('a failed topology validation restores asset-table edits, all pose vectors, selection, and history', () => {
  const editor = fixture(), before = editor.serialize(), history = editor._undo.length, select = editor.selectedJoint;
  const bad = sprite(); bad.image_assets[0].asset_index = bad.image_assets[0].table_index = 0;
  const original = editor._allSourceFrames;
  editor._allSourceFrames = function () {const frames = original.call(this); if (this.figure.segments.length > 10) this.figure.segments.at(-1).thickness = NaN; return frames;};
  assert.throws(() => editor.addSpriteSegment(bad), /thickness/i); editor._allSourceFrames = original;
  assert.deepEqual(editor.serialize(), before); assert.equal(editor.selectedJoint, select); assert.equal(editor._undo.length, history);
});

test('native handle and segment limits are checked before changing the figure', () => {
  const editor = fixture(); editor.figure.segments.at(-1).segment_id = 65535;
  const before = editor.serialize(); assert.throws(() => editor.addSpriteSegment(sprite()), /16-bit/); assert.deepEqual(editor.serialize(), before);
  editor.figure.segments = Array.from({length: 30000}, (_, index) => ({...clone(editor.figure.segments[0]), segment_id: index + 1, parent_id: 0}));
  assert.throws(() => editor.addSpriteSegment(sprite()), /30,000/); assert.equal(editor.figure.segments.length, 30000);
});

test('signed 32-bit anchor extremes are accepted when distinct and stay finite', () => {
  const editor = fixture(); editor.addSpriteSegment(sprite({x: -2147483648, y: -2147483648}, {x: 2147483647, y: 2147483647}));
  assert.ok(Number.isFinite(editor.figure.segments.at(-1).length)); assert.doesNotThrow(() => validateScene(editor.report));
});

test('attached sprites round-trip through actual native PIV and STK writers with integer anchors and PNG bytes', () => {
  const editor = fixture({frames: 2});
  // Sparse native draw orders near the uint16 limit must leave room for another image.
  editor.figure.segments.forEach((segment,index)=>segment.z_order=65526+index);
  const priorOrder=builderDrawables(editor.figure).map(entry=>entry.item.segment_id),before=editor.serialize();
  editor.addSpriteSegment(sprite());
  assert.deepEqual(builderDrawables(editor.figure).slice(0,-1).map(entry=>entry.item.segment_id),priorOrder);
  assert.equal(editor.figure.segments.at(-1).z_order,11);editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
  editor.select(1, 1);
  editor.addSpriteSegment(sprite({x: 12, y: -19}, {x: 22, y: -19}));
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
    result[kind]={'bytes':len(raw),'document':reopened['document']}
print(json.dumps(result))
`;
  const candidate = backend.pythonCandidates()[0];
  const result = spawnSync(candidate.command, [...candidate.args, '-c', python], {cwd: fileURLToPath(new URL('..', import.meta.url)),
    input: JSON.stringify(editor.serialize()), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const outputs = JSON.parse(result.stdout);
  for (const kind of ['piv', 'stk']) {
    const {bytes, document} = outputs[kind]; assert.ok(bytes > 100);
    const figure = document.figure_types.find(figure => figure.image_assets?.length === 2);
    assert.ok(figure); assert.equal(figure.segments.length, 12);
    assert.deepEqual(figure.image_assets.map(asset => [asset.asset_index, asset.table_index]), [[0, 0], [1, 1]]);
    assert.deepEqual(figure.image_assets[0].anchor_start, {x: -7, y: 5}); assert.deepEqual(figure.image_assets[0].anchor_end, {x: 23, y: -35});
    assert.deepEqual(figure.image_assets[1].anchor_start, {x: 12, y: -19}); assert.deepEqual(figure.image_assets[1].anchor_end, {x: 22, y: -19});
    assert.ok(figure.image_assets.every(asset => asset.data_url === png));
    const images = figure.segments.filter(segment => segment.primitive_code === 2);
    assert.deepEqual(images.map(segment => segment.extra_u16), [0, 1]); assert.deepEqual(images.map(segment => segment.parent_id), [3, 2]);
    near(images[0].angle_rad, Math.atan2(-40, 30)); assert.equal(images[0].length, 50);
    for (const frame of document.keyframes) assert.deepEqual(buildGeometry(document, frame).warnings, []);
    if (kind === 'piv') {assert.equal(document.keyframes.length, 2); assert.equal(document.keyframes[0].objects[1].join.target_handle_id, 3);}
  }
});
