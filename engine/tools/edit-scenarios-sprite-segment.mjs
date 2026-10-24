// Embedded sprite attachment, recorded through the real topology owner before porting.
import {readFileSync, writeFileSync} from 'node:fs';
import {open, createObject, createFrame, prune} from './fixture-kit.mjs';
import {createImageFigure} from '../../src/media-authoring.mjs';
const out = new URL('../tests/edit/', import.meta.url);
const app = {layerTimeline: true, propertyChannels: true};
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
function sprite(start = {x: -7, y: 5}, end = {x: 23, y: -35}) {
  const figure = createImageFigure({dataUrl: png, width: 1, height: 1, name: 'Placed sprite'});
  Object.assign(figure.image_assets[0], {anchor_start: start, anchor_end: end});
  return figure;
}
function fixture() {
  const doc = JSON.parse(readFileSync(new URL('builder.document.json', out), 'utf8'));
  const figure = doc.figure_types[0], child = {...structuredClone(figure), figure_type_id: 2};
  doc.figure_types.push(child);
  doc.keyframes = Array.from({length: 3}, (_, i) => {
    const object = createObject(figure, 1, 110 + i * 17, 180);
    object.len_flag = object.bend_flag = 1;
    object.lengths = figure.segments.map(segment => segment.length + i * 3);
    object.bends = figure.segments.map(() => i * .1);
    object.angles = object.angles.map(angle => angle + i * .2);
    const joined = createObject(child, 2, 300, 220);
    joined.join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: 33};
    return createFrame([object, joined], 6);
  });
  figure.segment_z_raw = figure.segments.map((_, i) => 65526 + i);
  figure.poly_z_raw = [65534, 65531, 65529];
  figure.segments.forEach((s, i) => s.z_order = 65526 + i);
  figure.polyfills.forEach((p, i) => p.z_order = [65534, 65531, 65529][i]);
  return doc;
}
function write(name, doc, editor, steps) {
  const filename = `${name}.document.json`, scenario = {name, document: doc, editor, steps};
  writeFileSync(new URL(filename, out), JSON.stringify(doc) + '\n');
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({...scenario, document: filename}, null, 1) + '\n');
}
const badAnchor = sprite({x: .5, y: 0}), badData = sprite(), mismatch = sprite(), cel = sprite();
badData.image_assets[0].data_url = 'file:///image.png'; mismatch.segments[0].extra_u16 = 9;
cel._styk = {drawing: {version: 2}};
const steps = [
  ['@select', 1, 2], ['addSpriteSegment', sprite()], ['undo'], ['redo'],
  ['@seek', 7], ['@select', 1, -1], ['addSpriteSegment', sprite({x: 3, y: 4}, {x: 13, y: 4})], ['undo'], ['redo'],
  ['addSpriteSegment', sprite(), {parentId: 77, angle: .123456789}], ['undo'], ['redo'],
  ['@select', 1, 1], ['beginDrag', 'Pose figure'], ['rotateJoint', .17], ['addSpriteSegment', sprite()], ['undo'], ['undo'], ['redo'], ['redo'],
  ['beginDrag', 'Pose figure'], ['rotateJoint', -.2], ['addSpriteSegment', badAnchor], ['cancelDrag'],
  ['addSpriteSegment', null], ['addSpriteSegment', {...sprite(), segments: []}], ['addSpriteSegment', sprite({x: 0, y: 0}, {x: 0, y: 0})],
  ['addSpriteSegment', badData], ['addSpriteSegment', mismatch], ['addSpriteSegment', cel],
  ['addSpriteSegment', sprite(), {parentId: 999}], ['addSpriteSegment', sprite(), {angle: 'bad'}],
  ['addSpriteSegment', sprite({x: -2147483648, y: -2147483648}, {x: 2147483647, y: 2147483647})], ['undo'], ['redo'],
  ['@select', null], ['addSpriteSegment', sprite()],
];
for (const [mode, editor] of [['native', {}], ['sheet', app]]) write(`sprite-segment-${mode}`, fixture(), editor, steps);
{
  const e = open(fixture()); e.captureFrameSource(e.frame);
  write('sprite-segment-retained-native', e.serialize(), {}, [
    ['@select', 1, 2], ['addSpriteSegment', sprite()], ['undo'], ['redo'], ['@seek', 8], ['addSpriteSegment', sprite(), {parentId: 0, angle: 0}], ['undo'], ['redo'],
  ]);
}
{
  const e = open(fixture()), image = sprite(); e.importFigure(image);
  const figure = e.figure, segment = figure.segments[0];
  Object.assign(figure.image_assets[0], {asset_index: 7, table_index: 7, image_index: 7, sprite_index: 7});
  Object.assign(segment, {extra_u16: 7, extra: [7, 1, 1], extra_u8_a: 1, extra_u8_b: 1, image_asset_index: 7, sprite_index: 7, aux_code: 1, flags: 258, is_static: true});
  figure.text_assets = [{asset_index: 7, table_index: 7, kind: 'text', text: 'Retain table'}];
  figure.side_tables = structuredClone([...figure.image_assets, ...figure.text_assets]);
  const source = sprite();
  Object.assign(source.image_assets[0], {asset_index: 42, table_index: 42, image_index: 42, sprite_index: 42, pivot: {x: -7, y: 5}, endpoint: {x: 23, y: -35}, record_offset: 111, source_size: 999, data_uri: 'old-bitmap', data_base64: 'old-encoded'});
  source.segments[0].extra_u16 = 42;
  write('sprite-segment-sparse-native', e.serialize(), {}, [
    ['@select', e.selectedUid, 0], ['addSpriteSegment', source], ['undo'], ['redo'], ['addSpriteSegment', sprite(), {angle: 0}], ['undo'], ['redo'],
  ]);
}
for (const kind of ['locked', 'origin']) {
  const e = open(fixture(), app); e.select(1, 2);
  const layer = e.layerForUid(1);
  if (kind === 'locked') e.setLayerLocked(layer, true); else e.setOrigin(33);
  write(`sprite-segment-${kind}-sheet`, prune(e.serialize()), app, kind === 'locked' ? [
    ['@select', 1, 2], ['addSpriteSegment', sprite()], ['setLayerLocked', layer, false], ['addSpriteSegment', sprite()],
    ['setLayerVisible', layer, false], ['addSpriteSegment', sprite()], ['setLayerVisible', layer, true], ['undo'], ['redo'],
  ] : [['@select', 1, 2], ['addSpriteSegment', sprite()], ['undo'], ['redo']]);
}
{
  const e = open(fixture()); e.select(1, 2); e.setOrigin(33);
  write('sprite-segment-origin-native', e.serialize(), {}, [['@select', 1, 2], ['addSpriteSegment', sprite()], ['undo'], ['redo']]);
}
