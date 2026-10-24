// Native builder numeric token gestures; the exported JS helper owns every replay step.
import {readFileSync, writeFileSync} from 'node:fs';
import {open, prune} from './fixture-kit.mjs';
const out = new URL('../tests/edit/', import.meta.url);
const doc = () => JSON.parse(readFileSync(new URL('builder.document.json', out), 'utf8'));
const make = name => {
  const document = doc();
  document.figure_types[0].segment_z_raw = [10, 30, 20, 50, 40, 70, 60];
  document.figure_types[0].poly_z_raw = [25, 35, 45];
  // The first gesture must create and then remove an absent outline parent on cancel.
  delete document.figure_types[0].segment_decode;
  writeFileSync(new URL(`${name}.document.json`, out), JSON.stringify(document) + '\n');
  return `${name}.document.json`;
};
const steps = [
  ['@select', 1, 1], ['@nativeCan', 'segment_gradient_opacity'], ['@nativeGet', 'thickness'],
  ['@nativeBegin', 'outline_width'], ['@nativePreview', 3.125], ['@nativeCancel'], ['@nativeCancel'], ['@nativePreview', 4],
  ['@nativeBegin', 'outline_opacity'], ['@nativePreview', 33.33333333], ['@nativePreview', 80], ['@nativeCommit'], ['undo'], ['redo'],
  ['@nativeBegin', 'thickness'], ['@nativePreview', 2.123456789], ['@nativePreview', 1001.25], ['@nativeCommit'], ['undo'], ['redo'],
  ['@nativeBegin', 'segment_opacity'], ['@nativePreview', 40], ['@nativePreview', 120], ['@nativePreview', 60], ['@nativeCommit'], ['undo'], ['redo'],
  ['@nativeBegin', 'segment_gradient_opacity'], ['@nativePreview', 12.5], ['@nativeCancel'],
  ['@nativeBegin', 'thickness', {branch: true}], ['@nativePreview', 19.25], ['@nativePreview', 19.25], ['@nativeCommit'], ['undo'], ['redo'],
  ['@nativeBegin', 'segment_opacity', {branch: true}], ['@nativePreview', 25], ['@nativePreview', 80], ['@nativeCancel'],
  ['@nativeBegin', 'segment_gradient_opacity', {branch: true}], ['@nativePreview', 31], ['@nativeCommit'], ['undo'], ['redo'],
  ['@select', 1, -1], ['@nativeCan', 'thickness'], ['@nativeGet', 'thickness'],
  ['@nativeBegin', 'polygon_1_opacity'], ['@nativePreview', 40], ['@nativeCommit'], ['undo'], ['redo'],
  ['@select', 1, 0], ['beginDrag', 'Pose figure'], ['rotateJoint', .2], ['@nativeBegin', 'thickness'], ['@nativePreview', 7.25], ['@nativeCommit'], ['undo'], ['undo'], ['redo'], ['redo'],
  ['@nativeBegin', 'thickness'], ['@nativePreview', 11], ['@select', 1, 3], ['@nativePreview', 12], ['@nativeCancel'],
  ['@nativeBegin', 'thickness'], ['@nativePreview', 10], ['@nativeBegin', 'outline_width'], ['@nativePreview', 9, 12], ['@nativePreview', 2.5], ['@nativeCancel'],
  ['@nativeBegin', 'outline_width'], ['@nativeCommit'], ['@nativeCommit'],
  ['@nativeBegin', 'thickness', {branch: true}], ['@nativePreview', 4], ['@nativePreview', 0], ['@nativePreview', 4], ['@nativeCancel'],
];
const order = [
  ['@select', 1, 0], ['@nativeGet', 'segment_z_order'], ['@nativeBegin', 'segment_z_order', {branch: true}],
  ['@nativePreview', 8], ['@nativePreview', 2], ['@nativePreview', 0], ['@nativePreview', 2.5], ['@nativeCommit'], ['undo'], ['redo'],
  ['@nativeBegin', 'polygon_1_z_order'], ['@nativePreview', 10], ['@nativePreview', 2], ['@nativeCancel'],
  ['@nativeBegin', 'segment_z_order'], ['@nativePreview', 9], ['@nativePreview', 4], ['@nativeCommit'], ['undo'], ['redo'],
];
for (const [suffix, editor, more] of [['native', {}, order], ['sheet', {layerTimeline: true}, []]]) {
  const name = `native-builder-token-${suffix}`;
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: make(name), editor, steps: [...steps, ...more]}, null, 1) + '\n');
}
for (const kind of ['locked', 'origin']) {
  const name = `native-builder-token-${kind}`, e = open(doc());
  e.select(1, 1);
  if (kind === 'locked') e.setLayerLocked(e.layerForUid(1), true);
  else e.setOrigin(22);
  writeFileSync(new URL(`${name}.document.json`, out), JSON.stringify(prune(e.serialize())) + '\n');
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: `${name}.document.json`, editor: {}, steps: [
    ['@select', 1, 1], ['@nativeBegin', 'thickness', {branch: true}], ['@nativePreview', 23.25], ['@nativeCommit'], ['undo'], ['redo'],
    ['@nativeBegin', 'segment_opacity', {branch: true}], ['@nativePreview', 50], ['@nativeCancel'],
  ]}, null, 1) + '\n');
}
