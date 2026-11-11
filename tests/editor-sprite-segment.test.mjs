import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageFigure} from '../src/media-authoring.mjs';
import {createObject, createFrame, emptyDocument} from '../src/demo.mjs';
import {geometryOfDocument,geometryOfFrame} from './support/engine-geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {builderDrawables} from '../src/editor-builder-style.mjs';
import {exportDocument, importBytes, nodeCodec} from './support/codec.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

const clone = structuredClone;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
function sprite(start = {x: -7, y: 5}, end = {x: 23, y: -35}) {
  const figure = createImageFigure({dataUrl: png, width: 1, height: 1, name: 'Placed sprite'});
  Object.assign(figure.image_assets[0], {anchor_start: start, anchor_end: end});
  return figure;
}
/** `prepare` changes the document before it opens. */
function fixture({frames = 3, posed = true, prepare = null} = {}) {
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
  prepare?.(report);
  const editor = open({demo: false}, report); editor.select(1, 2); return editor;
}
const segmentsGeometry = (editor, frame) => [...geometryOfFrame(editor, frame).objects.values()].map(object => ({
  root: clone(object.root), segments: object.segments.map(segment => ({start: clone(segment.start), end: clone(segment.end)})),
}));

test('sprite attachment uses the selected tip and integer anchors without changing the source or existing joints', () => {
  const editor = fixture(), source = sprite(), input = clone(source), before = editor.serialize();
  const expected = editor.report.keyframes.map(frame => segmentsGeometry(editor, frame)), children = editor.report.keyframes.map(frame => clone(frame.objects[1])), history = editor._undo.length;
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
    const actual = segmentsGeometry(editor, frame); actual[0].segments.pop(); assert.deepEqual(actual, expected[frameIndex]);
  });
  const rendered = editor.geometry.objects.get(0).segments[10];
  near(rendered.angle - rendered.asset.anchor_angle_rad, 0);
  near(Math.hypot(rendered.end.x - rendered.start.x, rendered.end.y - rendered.start.y), 50);
  assert.equal(editor._undo.length, history + 1); assert.equal(editor.undoLabel, 'Add sprite segment');
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
});

test('native parent-bend interpolation governs the new sprite at an in-between tick', () => {
  const editor = fixture({frames: 2, prepare: report => report.keyframes.forEach((frame, index) => {
    const object = frame.objects[0], figure = report.figure_types[0]; object.angles = figure.segments.map(segment => segment.angle_rad);
    object.bends = figure.segments.map(() => 0); object.bends[0] = index * 4;
    frame.duration_raw = 10;
  })}), source = sprite({x: 0, y: 0}, {x: 10, y: 0});
  editor.seek(5); editor.select(1, 0);
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

test('signed 32-bit anchor extremes are accepted when distinct and stay finite', () => {
  const editor = fixture(); editor.addSpriteSegment(sprite({x: -2147483648, y: -2147483648}, {x: 2147483647, y: 2147483647}));
  assert.ok(Number.isFinite(editor.figure.segments.at(-1).length)); assert.doesNotThrow(() => validateScene(editor.report));
});

test('attached sprites round-trip through actual native PIV and STK writers with integer anchors and PNG bytes', async () => {
  // Sparse native draw orders near the uint16 limit must leave room for another image.
  const editor = fixture({frames: 2, prepare: report => report.figure_types[0].segments.forEach((segment,index)=>{segment.z_order=65526+index;})});
  const priorOrder=builderDrawables(editor.figure).map(entry=>entry.item.segment_id),before=editor.serialize();
  editor.addSpriteSegment(sprite());
  assert.deepEqual(builderDrawables(editor.figure).slice(0,-1).map(entry=>entry.item.segment_id),priorOrder);
  assert.equal(editor.figure.segments.at(-1).z_order,11);editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();
  editor.select(1, 1);
  editor.addSpriteSegment(sprite({x: 12, y: -19}, {x: 22, y: -19}));
  const serialized = editor.serialize(), outputs = {};
  for (const kind of ['piv', 'stk']) {
    const codec = nodeCodec(), {bytes, name} = await exportDocument({document: serialized, format: kind, figureTypeId: serialized.figure_types[0].figure_type_id}, {codec});
    outputs[kind] = {bytes: bytes.length, document: (await importBytes(bytes, name, {codec})).document};
  }
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
    for (const frame of document.keyframes) assert.deepEqual(geometryOfDocument(document, frame).warnings, []);
    if (kind === 'piv') {assert.equal(document.keyframes.length, 2); assert.equal(document.keyframes[0].objects[1].join.target_handle_id, 3);}
  }
});
