// Record the actual app callback owner before Rust consumes its measurements.
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {documentOf, limb, open, nextKey, prune} from './fixture-kit.mjs';
import {createVfx} from '../../src/vfx.mjs';
const out = fileURLToPath(new URL('../tests/edit/', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const bounds = {boundsOf: {'@boundsCallback': 'app'}};
const constant = value => ({boundsOf: {'@boundsCallback': 'constant', value}});
const write = (name, editor, steps, document = 'measured-bounds.document.json') => writeFileSync(`${out}${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');
const editor = open(documentOf([limb(true), limb(), limb()], i => [140 + i * 170, 130 + i * 50]));
editor.select(2); editor.joinTo(1, 33); nextKey(editor, 6); editor.select(1); editor.moveSelection(30, -15);
editor.select(3); editor.moveSelection(-35, 40);
const doc = prune(editor.report);
doc.figure_types[0].segments.push({...doc.figure_types[0].segments[0], segment_id: 99, parent_id: 0, length: 530, angle_rad: -.2, visible: false});
doc.figure_types[0].segment_count++;
for (const frame of doc.keyframes) frame.objects[0].angles.push(-.2);
writeFileSync(`${out}measured-bounds.document.json`, JSON.stringify(doc) + '\n');
const center = [
  ['selectMany', [2, 3]], ['centerCamera', 'both', [0, 1], bounds], ['undo'], ['redo'], ['@seek', 3],
  ['centerCamera', 'x', {'@array': [0], sheetTicks: [4, 1, 4]}, bounds], ['undo'],
  ['beginCameraDrag'], ['updateCameraDrag', {x: 9}], ['centerCamera', 'y', [0], bounds], ['undo'], ['redo'],
  ['beginDrag', 'Move figures'], ['moveSelection', 5, -3], ['centerCamera', 'both', [0], bounds], ['undo'], ['redo'],
  ['centerCamera', 'bogus', [0], bounds], ['centerCamera', 'both', [99], bounds],
  ['centerCamera', 'both', [0], constant(null)], ['centerCamera', 'both', [0], constant({x: 2, y: 3, width: 9, height: 10})],
  ['centerCamera', 'both', [0], constant({minX: 9, minY: 3, maxX: 2, maxY: 7})], ['undo'],
  ['beginAnimationEdit', {kind: 'figure', uid: 3}, 'scale'], ['previewAnimationEdit', 1.2], ['centerCamera', 'x', [0], bounds], ['undo'], ['undo'],
  ['selectMany', []], ['centerCamera', 'both', [99], bounds],
];
write('camera-center-measured-sheet', app, center);
const align = [
  ['selectMany', [2, 3]], ...['x', 'y'].flatMap(axis => ['start', 'center', 'end'].flatMap(edge => [['alignFiguresInFrames', axis, edge, {'@array': [0], sheetTicks: [0, 3, 6]}, bounds], ['undo']])),
  ['@seek', 3], ['alignSelection', 'x', 'center', bounds], ['undo'], ['redo'],
  ['beginDrag'], ['moveSelection', 8, 2], ['alignSelection', 'y', 'end', bounds], ['undo'], ['redo'],
  ['alignFiguresInFrames', 'x', 'start', [0], {...bounds, ticks: [1, 4], uids: [1, 3]}], ['undo'],
  ['alignFiguresInFrames', 'z', 'start', [0], bounds], ['alignFiguresInFrames', 'x', 'bogus', [0], bounds],
  ['alignFiguresInFrames', 'x', 'start', [0], {...bounds, ticks: [1.5]}],
  ['alignFiguresInFrames', 'x', 'start', [0], constant({minX: 2, minY: 1, maxX: 0, maxY: 3})],
  ['alignSelection', 'x', 'start', constant(null)], ['alignSelection', 'y', 'end', constant({x: 1, y: 2, width: 0, height: 4})], ['undo'],
  ['selectMany', [1, 2]], ['alignSelection', 'x', 'start', bounds], ['alignFiguresInFrames', 'y', 'end', [0], bounds],
  ['selectMany', [2, 3]], ['beginAnimationEdit', {kind: 'figure', uid: 3}, 'scale'], ['previewAnimationEdit', .8], ['alignFiguresInFrames', 'x', 'end', [0], bounds], ['undo'], ['undo'],
  ['selectMany', []], ['alignFiguresInFrames', 'x', 'center', [0], bounds],
];
write('figure-align-measured-sheet', app, align);
write('figure-align-measured-native', {}, [
  ['selectMany', [2, 3]], ...['x', 'y'].flatMap(axis => ['start', 'center', 'end'].flatMap(edge => [['alignFiguresInFrames', axis, edge, [0, 1], bounds], ['undo']])),
  ['@seek', 3], ['alignSelection', 'x', 'center', bounds], ['undo'], ['redo'],
  ['beginDrag'], ['moveSelection', 8, 2], ['alignSelection', 'y', 'end', bounds], ['undo'], ['redo'],
  ['alignFiguresInFrames', 'z', 'start', [0], bounds], ['alignFiguresInFrames', 'x', 'bogus', [0], bounds],
  ['alignSelection', 'x', 'start', constant(null)], ['selectMany', [1, 2]], ['alignSelection', 'x', 'start', bounds],
]);
// Media anchors, reflection, live drawing bounds, hidden strokes and animated effect padding.
const media = structuredClone(doc), figure = media.figure_types[2];
figure.segments[0] = {...figure.segments[0], primitive_code: 2, segment_type: 'image', segment_kind: 'image', thickness: 0, extra_u16: 0, extra_u8_a: 0, extra_u8_b: 1};
figure.image_assets = [{kind: 'image', asset_index: 0, table_index: 0, data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII=',
  anchor_start: {x: -3, y: 5}, anchor_end: {x: 17, y: 9}, anchor_length: Math.hypot(20, 4), anchor_angle_rad: Math.atan2(4, 20), display_width: 83, display_height: 37}];
figure.segment_decode = {global_style: {u28: new Uint32Array(new Float32Array([2.5]).buffer)[0]}};
for (const [index, frame] of media.keyframes.entries()) {
  const blur = createVfx('blur', 'measured-blur'); blur.params.radius = index ? 12 : 5;
  const glow = createVfx('glow', 'measured-glow'); glow.params.radius = 7;
  frame.objects[2]._stykVfx = {figure: [blur], '3/11': [glow]};
}
writeFileSync(`${out}measured-bounds-media.document.json`, JSON.stringify(media) + '\n');
write('camera-center-media-sheet', app, [
  ['selectMany', [1, 3]], ['centerCamera', 'both', [0, 1], bounds], ['undo'],
  ['alignFiguresInFrames', 'x', 'end', [0, 1], bounds], ['undo'],
  ['centerCamera', 'x', [0], {boundsOf: {'@boundsCallback': 'app', resources: {drawingBounds: {x: -13, y: 7, width: 52, height: 81}}}}], ['undo'],
  ['centerCamera', 'y', [0], {boundsOf: {'@boundsCallback': 'app', resources: {vfxBounds: false}}}], ['undo'],
], 'measured-bounds-media.document.json');
