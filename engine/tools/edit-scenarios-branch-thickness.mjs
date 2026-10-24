// Branch thickness increments, recorded in the owning editor before the Rust port.
import {readFileSync, writeFileSync} from 'node:fs';
import {open, prune} from './fixture-kit.mjs';
const out = new URL('../tests/edit/', import.meta.url);
const app = {layerTimeline: true, propertyChannels: true};
const document = () => JSON.parse(readFileSync(new URL('builder.document.json', out), 'utf8'));
function fixture() {
  const doc = document(), values = [0, .009, 999.9, 42.123456789, .01, 1000, .100000003];
  doc.figure_types[0].segments.forEach((segment, index) => {segment.thickness = values[index]; segment.visible = values[index] > .01 || segment.primitive_code > 0;});
  doc.keyframes[0].objects[0]._stykStyle = {segments: {11: {thickness: 6.10000013}, 22: {thickness: .0101}, 77: {thickness: 998.9}}};
  return doc;
}
const steps = [
  ['@select', 1, 1], ['changeBranchThickness', .1000000001], ['changeBranchThickness', -.1100000001], ['undo'], ['redo'],
  ['changeBranchThickness', 1e8], ['changeBranchThickness', 1], ['changeBranchThickness', -1e8], ['changeBranchThickness', 0], ['undo'], ['redo'],
  ['@select', 1, 0], ['changeBranchThickness', .005], ['changeBranchThickness', .005], ['undo'], ['redo'],
  ['@select', 1, 3], ['changeBranchThickness', -42.123456788], ['undo'], ['redo'],
  ['@select', 1, 6], ['beginDrag', 'Pose figure'], ['rotateJoint', .17], ['changeBranchThickness', 2.123456789], ['undo'], ['undo'], ['redo'], ['redo'],
  ['beginDrag', 'Pose figure'], ['rotateJoint', -.21], ['changeBranchThickness', 'invalid'], ['cancelDrag'],
  ['@select', 1, -1], ['changeBranchThickness', 4], ['changeBranchThickness', null], ['@select', null], ['changeBranchThickness', 4],
];
for (const [mode, editor] of [['native', {}], ['sheet', app]]) {
  const name = `branch-thickness-${mode}`, filename = `${name}.document.json`;
  writeFileSync(new URL(filename, out), JSON.stringify(fixture()) + '\n');
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: filename, editor, steps}, null, 1) + '\n');
}
{
  const name = 'branch-thickness-locked-sheet', e = open(fixture(), app);
  const layer = e.layerForUid(1), filename = `${name}.document.json`;
  e.setLayerLocked(layer, true);
  writeFileSync(new URL(filename, out), JSON.stringify(prune(e.serialize())) + '\n');
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: filename, editor: app, steps: [
    ['@select', 1, 1], ['changeBranchThickness', 3], ['setLayerLocked', layer, false], ['changeBranchThickness', 3],
    ['setLayerVisible', layer, false], ['changeBranchThickness', 4], ['setLayerVisible', layer, true], ['changeBranchThickness', -2], ['undo'], ['redo'],
  ]}, null, 1) + '\n');
}
for (const [mode, editor] of [['sheet', app], ['native', {}]]) {
  const name = `branch-thickness-origin-${mode}`, e = open(fixture(), editor), filename = `${name}.document.json`;
  e.select(1, 1); e.setOrigin(22);
  writeFileSync(new URL(filename, out), JSON.stringify(prune(e.serialize())) + '\n');
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: filename, editor, steps: [
    ['@select', 1, 1], ['changeBranchThickness', .15], ['changeBranchThickness', -.15], ['undo'], ['redo'],
  ]}, null, 1) + '\n');
}
