// The existing identity owner refuses before a new definition is published.
import {writeFileSync} from 'node:fs';
import {emptyDocument, createObject, createFrame} from './fixture-kit.mjs';
const out = new URL('../tests/edit/', import.meta.url), uid = 0x7ffffffe;
for (const [mode, editor] of [['native', {}], ['sheet', {layerTimeline: true, propertyChannels: true}]]) {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [createFrame([createObject(figure, uid, 123, 234)], 1)];
  const name = `draw-identity-capacity-${mode}`, filename = `${name}.document.json`;
  writeFileSync(new URL(filename, out), JSON.stringify(document) + '\n');
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: filename, editor, steps: [
    ['@select', null], ['addSegment', {length: 5}], ['undo'], ['redo'],
    ['@select', uid, 1], ['beginDrag', 'Pose figure'], ['rotateJoint', .13], ['@select', null],
    ['addSegments', [{length: 5}, {length: 7}]], ['cancelDrag'], ['undo'], ['redo'],
  ]}, null, 1) + '\n');
}
