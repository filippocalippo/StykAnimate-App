#!/usr/bin/env node
// In-between previews built by the editor, sampled by its read-only preview oracle.
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {here, repo, repoUrl, documentOf, limb, open, whole, nextKey, writeProject, writeReference} from './fixture-kit.mjs';
const {createVfx} = await import(`${repoUrl}/src/vfx.mjs`);

function native() {
  const editor = open(documentOf([limb(true), limb()], i => [230 + i * 120, 170]));
  editor.select(2); editor.joinTo(1, 33);
  for (const [dx, turn] of [[75, .8], [-30, -.5], [95, 1.1]]) {
    nextKey(editor, 6); whole(editor).moveSelection(dx, 15); editor.rotateSelection(turn);
  }
  editor.setFrameDuration(1);
  return editor;
}
const samples = [[0, .5], [1, 0], [1, .37], [1, 1], [2, .25], [2, .5], [3, .8]];
const fixtures = {
  'force-linear': () => { const e = native(), document = e.serialize(); document.auto_easing = true; return {document}; },
  'legacy-force-tween': () => { const e = native(), document = e.serialize(); document.version = 4; return {document}; },
  'hidden-and-single-tick': () => { const document = native().serialize(); document.keyframes[0].duration_raw = 1; document.keyframes[1].duration_raw = 0; return {document}; },
  'layer-sheet-single-tick': () => {
    const document = native().serialize(); document.keyframes[0].duration_raw = 1; document.keyframes[1].duration_raw = 0;
    return {document: open(document, {layerTimeline: true}).serialize(), native: false};
  },
  'property-channels': () => {
    const e = native();
    for (const target of [{kind: 'figure', uid: 1}, {kind: 'layer', id: 'layer-1'}]) e.adoptNativePoseTrack(target);
    e.addAnimationKeys([{target: {kind: 'figure', uid: 1}, property: 'x', tick: 0, value: 200}, {target: {kind: 'figure', uid: 1}, property: 'x', tick: 18, value: 450},
      {target: {kind: 'camera'}, property: 'rotation', tick: 0, value: -.2}, {target: {kind: 'camera'}, property: 'rotation', tick: 18, value: .4}]);
    return {document: e.serialize()};
  },
  'layer-sheet': () => { const e = open(native().serialize(), {layerTimeline: true}); e.seek(6); whole(e).moveSelection(50, -30); return {document: e.serialize(), native: false}; },
  'per-figure-overlap': () => {
    const e = open(documentOf([limb(true), limb(), limb()], i => [270 + i * 12, 170]));
    for (const [dx, turn] of [[35, .4], [-20, -.3], [45, .7]]) {
      nextKey(e, 6);
      for (const uid of [1, 2, 3]) { whole(e, uid).moveSelection(dx * uid / 3, 10); e.rotateSelection(turn * uid); }
    }
    e.setFrameDuration(1);
    return {document: e.serialize()};
  },
  'scene-camera': () => {
    const e = native();
    for (let index = 0; index < e.report.keyframes.length; index++) {
      e.selectFrame(index); e.setCameraValues({x: index * 25, y: 12, scale: 1.1, angle_rad: .08});
      e.changeVfxStack({kind: 'scene'}, stack => { const effect = createVfx('blur', 'scene-preview'); effect.params.radius = 4; stack.splice(0, stack.length, effect); });
    }
    return {document: e.serialize()};
  },
};
const args = process.argv.slice(2), outAt = args.indexOf('--out');
if (args.includes('--list')) { console.log(Object.keys(fixtures).join('\n')); process.exit(0); }
const out = path.resolve(outAt < 0 ? `${here}/../crates/styk-eval/tests/fixtures/preview` : args[outAt + 1]);
const names = args.filter((name, i) => !name.startsWith('--') && (outAt < 0 || i !== outAt + 1));
for (const name of names) if (!fixtures[name]) throw new Error(`Unknown fixture ${name}`);
mkdirSync(out, {recursive: true});
for (const name of names.length ? names : Object.keys(fixtures)) {
  const built = fixtures[name]();
  writeReference(writeProject(out, name, built.document, [0], {native: built.native !== false, inbetween: samples, scene: true, camera: true}), name);
}
