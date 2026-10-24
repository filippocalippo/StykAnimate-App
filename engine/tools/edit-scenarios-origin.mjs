// Animation-origin gesture recordings, built by the editor before commands are ported.
// Construction changes are fixture setup; these scenarios prove only whole-figure
// gestures and their native/sheet lifecycle, never Set Origin or topology commands.
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {documentOf, limb, open, joint, nextKey, prune} from './fixture-kit.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});
const mirror = editor => JSON.stringify(prune(editor.report), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const steps = [
  ['@select', 1, -1], ['beginTranslationDrag'], ['moveSelection', 32.25, -14.75, {fromStart: true}],
  ['moveSelection', 0, 0, {fromStart: true}], ['commitDrag'],
  ['beginDrag', 'Cancel origin turn'], ['rotateSelection', .37], ['rotateSelection', -.37], ['cancelDrag'],
  ['beginDrag', 'Origin transforms'], ['moveSelection', 13.5, -5.5], ['rotateSelection', .43], ['scaleSelection', 1.125],
  ['mirrorSelection', 'horizontal'], ['mirrorSelection', 'vertical'], ['commitDrag'], ['undo'], ['redo'],
  ['@select', 2, -1], ['beginTranslationDrag'], ['moveSelection', -8.25, 4.125, {fromStart: true}], ['cancelDrag'],
  ['beginDrag', 'Detach origin child'], ['moveSelection', 7.5, -2.5, {detachExternal: true, fromStart: true}],
  ['moveSelection', 0, 0, {detachExternal: true, fromStart: true}], ['commitDrag'], ['undo'], ['redo'], ['undo'],
  ['rotateFigure', -.29], ['mirrorFigure', 'horizontal'], ['scaleSelected', .75], ['resetPose'], ['undo'], ['redo'],
  ['@seek', 3.5], ['@select', 1, -1], ['moveSelection', 4.25, 1.5], ['rotateSelection', .17], ['undo'], ['redo'],
  ['selectMany', [1, 2]], ['rotateSelection', -.21, {center: {x: 300.25, y: 190.5}}],
  ['scaleSelection', 1.25, {center: {x: 310, y: 180}, selectedOnly: true}], ['mirrorSelection', 'vertical'], ['centerFigure'],
  ['resetPose'], ['undo'], ['undo'], ['redo'], ['@seek', 8], ['@select', 1, -1],
  ['scaleSelection', 0], ['resetPose'], ['undo'], ['undo'], ['redo'], ['undo'],
  ['beginDrag', 'Seek commits origin'], ['moveSelection', 2.75, -1.25], ['@seek', 0], ['undo'], ['redo'],
];
for (const kind of ['layout', 'offsets', 'support']) {
  counter = 0;
  const e = open(documentOf([limb(true), limb(), limb()], i => [240 + i * 180, 170]));
  joint(e, 22, 1); e.setOrigin(22);
  if (kind === 'offsets') { joint(e, 11, 1); e.mirrorSegmentBranch('horizontal'); }
  if (kind === 'support') { joint(e, 11, 1); e.deleteSingleSegment({preserveEndpoints: true}); }
  joint(e, 22, 2); e.setOrigin(22); e.select(2); e.joinTo(1, 55);
  nextKey(e, 8); e.select(1); e.rotateSelection(.63); e.moveSelection(22, -11); e.select(2); e.scaleSelected(.9); e.seek(0);
  // Unknown pivot/ghost keys are format data: arithmetic may update known fields,
  // but copy-on-write must keep these intact (reset intentionally restores ghosts).
  for (const frame of e.report.keyframes) for (const object of frame.objects) {
    const origin = object._stykAnimationOrigin;
    if (origin) {
      origin.futurePivot = {label: 'preserved', values: [3, 7]};
      for (const ghost of Object.values(origin.ghosts ?? {})) ghost.futureGhost = {label: 'preserved'};
    } else object.futureOrdinary = {label: 'untouched'};
  }
  const native = `${out}/origin-gestures-${kind}-native.document.json`;
  writeFileSync(native, mirror(e));
  for (const mode of ['native', 'sheet', ...(kind === 'support' ? ['autokey-sheet'] : [])]) {
    const name = `origin-gestures-${kind}-${mode}`, editor = mode === 'native' ? {} : {...app, ...(mode === 'autokey-sheet' ? {autoKey: true} : {})};
    const document = `origin-gestures-${kind}-${mode}.document.json`;
    if (mode !== 'native') writeFileSync(`${out}/${document}`, mirror(open(JSON.parse(mirror(e)), editor)));
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps}, null, 1) + '\n');
  }
}
