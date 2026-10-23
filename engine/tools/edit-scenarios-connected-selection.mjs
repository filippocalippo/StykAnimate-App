// Recorded selection of joined components: graph traversal is independent of candidate eligibility.
import {writeFileSync} from 'node:fs';
import {documentOf, limb, open, prune} from './fixture-kit.mjs';

const out = new URL('../tests/edit/', import.meta.url);
const editor = open(documentOf([limb(), limb(), limb(), limb()]));
editor.select(2); editor.joinTo(1, 33);
editor.select(3); editor.joinTo(2, 22);
const document = prune(editor.report);
writeFileSync(new URL('connected-selection.document.json', out), JSON.stringify(document) + '\n');
for (const [mode, options] of [
  ['native', {}],
  ['sheet', {layerTimeline: true, propertyChannels: true}],
  ['autokey-sheet', {layerTimeline: true, propertyChannels: true, autoKey: true}],
]) {
  const name = `connected-selection-${mode}`;
  const steps = [
    ['select', null], ['selectConnected'], ['selectConnected', 999],
    ['select', 2], ['selectConnected'], ['selectConnected'],
    ['select', 4], ['selectConnected', 2, {add: true}],
    ['selectConnected', 1, {candidates: [3, 3, 999]}],
    ['selectConnected', 2, {candidates: []}],
    ['selectConnected', 4], ['selectConnected', null],
    ['selectConnected', 2, {add: true, candidates: [3, 1]}],
    ['select', 1, 1], ['selectConnected', 1],
    ['selectBranch', 1, 1], ['selectConnected', 2],
    ['select', 1], ['moveSelection', 5, 3], ['selectConnected', 3],
    ['undo'], ['redo'], ['selectConnected', 2],
    ['selectMany', [4, 2]], ['selectConnected', 1, {add: true, candidates: [3, 2]}],
    ['selectConnected', 3, {candidates: [null, '2', 2.5, 4294967298, 2]}],
    ['selectConnected', 1, {candidates: [1, 2, 3]}],
  ];
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: 'connected-selection.document.json', editor: options, steps}, null, 1) + '\n');
}
