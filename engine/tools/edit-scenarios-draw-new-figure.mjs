// A pen stroke with no selected figure, recorded through the real editor owner.
import {readFileSync, writeFileSync} from 'node:fs';
import {open, prune} from './fixture-kit.mjs';
const out = new URL('../tests/edit/', import.meta.url), app = {layerTimeline: true, propertyChannels: true};
function fixture() {
  const document = JSON.parse(readFileSync(new URL('builder.document.json', out), 'utf8'));
  const unused = structuredClone(document.figure_types[0]); unused.figure_type_id = 99; unused.name = 'Retained definition';
  document.figure_types.push(unused);
  document.keyframes = Array.from({length: 3}, (_, i) => {
    const frame = structuredClone(document.keyframes[0]); frame.duration_raw = 6; frame.objects[0].root_x += i * 10; return frame;
  });
  return document;
}
function write(name, document, editor, steps) {
  const filename = `${name}.document.json`;
  writeFileSync(new URL(filename, out), JSON.stringify(document) + '\n');
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: filename, editor, steps}, null, 1) + '\n');
}
const chain = [{type: 'line', length: 31.5, angle: -.19, thickness: 0, start: {x: -5.25, y: 11.75}},
  {type: 'squareLine', length: 20.1, angle: .07}, {type: 'circleClear', length: 0, thickness: 0}];
const steps = [
  ['@select', null], ['addSegments', chain], ['undo'], ['redo'],
  ['@select', null], ['addSegment', {type: 'circleFill', length: 17.25, angle: .23}], ['undo'], ['redo'],
  ['@seek', 7.75], ['@select', null], ['addSegment', {type: 1, length: 3.5, thickness: 1.123456789, start: {x: 450.125, y: -30.25}}], ['undo'], ['redo'],
  ['@select', null], ['addSegments', []], ['addSegments', 'invalid'], ['addSegment', {parentId: 11}],
  ['addSegment', {type: 'image'}], ['addSegment', {length: -1}], ['addSegment', {start: {x: 'invalid', y: 0}}],
  ['addSegments', [{length: 2}, {parentId: 1}]],
  ['addSegments', [{length: 2, parentId: 0}, {length: 7, parentId: 0}]], ['undo'], ['redo'],
  ['@select', null], ['addSegment', {type: 'circleClear', length: 0, thickness: 0}], ['undo'], ['redo'],
];
for (const [mode, editor] of [['native', {}], ['sheet', app]]) write(`draw-new-figure-${mode}`, fixture(), editor, steps);
{
  const e = open(fixture(), app), layer = e.layerForUid(1); e.setLayerLocked(layer, true);
  write('draw-new-figure-locked-sheet', prune(e.serialize()), app, [
    ['@select', null], ['addSegments', chain], ['setLayerLocked', layer, false], ['addSegments', chain], ['undo'], ['redo'],
    ['setLayerVisible', layer, false], ['@select', null], ['addSegment', {length: 4}], ['setLayerVisible', layer, true], ['undo'], ['redo'],
  ]);
}
for (const [mode, editor] of [['native', {}], ['sheet', app]]) write(`draw-new-figure-live-${mode}`, fixture(), editor, [
  ['@select', 1, 1], ['beginDrag', 'Pose figure'], ['rotateJoint', .13], ['@select', null], ['addSegments', chain], ['cancelDrag'], ['undo'], ['redo'],
]);
for (const [mode, editor] of [['native', {}], ['sheet', app]]) {
  write(`draw-new-figure-live-commit-${mode}`, fixture(), editor, [
    ['@select', 1, 1], ['beginDrag', 'Pose figure'], ['rotateJoint', .13], ['@select', null], ['addSegments', chain],
    ['commitDrag'], ['undo'], ['undo'], ['redo'], ['redo'],
    ['@select', null], ['addSegment', {type: 'circle', length: 3.25}], ['undo'], ['redo'],
  ]);
  write(`draw-new-figure-live-unchanged-${mode}`, fixture(), editor, [
    ['@select', 1, 1], ['beginDrag', 'Pose figure'], ['@select', null], ['addSegment', {length: 9.75, angle: -.2}],
    ['@select', null], ['addSegment', {type: 'circleClear', length: 0, thickness: 0}], ['commitDrag'],
    ['undo'], ['undo'], ['redo'], ['redo'],
  ]);
  const e = open(fixture(), editor), layer = e.createLayer('Sketch').id;
  write(`draw-new-figure-active-layer-${mode}`, prune(e.serialize()), editor, [
    ['@select', null], ['addSegments', chain], ['undo'], ['redo'],
    ['setLayerLocked', layer, true], ['@select', null], ['addSegment', {length: 5.25}],
    ['setLayerLocked', layer, false], ['setLayerVisible', layer, false], ['@select', null], ['addSegment', {length: 8.75}],
    ['setLayerVisible', layer, true], ['undo'], ['redo'],
  ]);
}
{
  const editor = {propertyChannels: true}, e = open(fixture(), editor);
  e.addAnimationKey({kind: 'figure', uid: 1}, 'x', 0, 300);
  write('draw-new-figure-native-channels', prune(e.serialize()), editor, [
    ['@select', null], ['addSegments', chain], ['undo'], ['redo'],
    ['@seek', 7.75], ['@select', null], ['addSegment', {length: 3.25}],
  ]);
}
