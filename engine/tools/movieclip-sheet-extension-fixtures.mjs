// Actual editor next-keyframe extensions, recorded before the worker port.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf, limb, open, nextKey, writeProject, writeReference} from './fixture-kit.mjs';
const folder = fileURLToPath(new URL('../tests/movieclip-sheet-extension/', import.meta.url));
const views = fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-sheet-extension/', import.meta.url));
mkdirSync(folder, {recursive: true}); mkdirSync(views, {recursive: true});
const app = {layerTimeline: true, propertyChannels: true};
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);
const base = ({presence = false, gaps = true} = {}) => {
  const e = open(documentOf([limb(), limb(), limb()], i => [180 + i * 170, 150]));
  for (let index = 0; index < 4; index++) { e.selectFrame(index); nextKey(e, 4); e.select(1); e.moveSelection(9.5, -3.25); }
  e.seek(0); e.select(2);
  const figure = e.createMovieclip({uids: [2], start: 0, end: 17, replace: false, name: 'Next-keyframe clip'});
  for (const frame of e.report.keyframes) {
    const object = frame.objects.find(o => o.unique_id === 2);
    object.figure_type_id = figure.figure_type_id; object.angles = [.2]; object.futurePose = {kept: [1, 2, 3]};
    object._stykMovieclip = presence ? {clock: 'presence', start: 0, end: null, offset: .5, speed: .8, mode: 'loop'} :
      {start: 0, end: 17, offset: .25, speed: .8, mode: 'loop', restarts: [{tick: 8, offset: 1.1}]};
  }
  if (gaps) for (const index of [1, 3]) { e.selectFrame(index); e.select(2); e.deleteFigure(); }
  return open(structuredClone(e.report), app);
};
const write = (name, e, steps) => {
  const document = json(e.report);
  writeFileSync(`${folder}/${name}.document.json`, document + '\n');
  writeFileSync(`${folder}/${name}.scenario.json`, JSON.stringify({name, document: `${name}.document.json`, editor: app, steps}, null, 1) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${folder}/${name}.scenario.json`, `${folder}/${name}.reference.json`], {stdio: 'inherit'});
  const reference = JSON.parse(readFileSync(`${folder}/${name}.reference.json`, 'utf8'));
  const applied = reference.steps.find(step => step.call?.[0] === 'addMovieclipToNextKeyframes' && step.document && !step.error) ?? reference.steps[0];
  for (const [suffix, step] of [['applied', applied], ['final', reference.steps.findLast(step => step.document)]]) {
    const document = JSON.parse(step.document), last = open(structuredClone(document), app).totalTicks - 1;
    const ticks = [0, .25, .75, 1.5, 2.25, 3.75, 4, 4.25, 5.75, 7.5, 8, 8.25, 9.75, 11.5, 12, 12.25, 13.75, 15.5, 16].filter(tick => tick <= last);
    writeReference(writeProject(views, `${name}-${suffix}`, document, ticks, {vfx: true, camera: true, scene: true}), `${name}-${suffix}`);
  }
};
const standard = [['@select', 2, -1], ['@seek', 2.25], ['addMovieclipToNextKeyframes', 3], ['@seek', 5.75], ['@select', 2, -1], ['addMovieclipToNextKeyframes', 9],
  ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']];
write('extend-imported', base(), standard);
write('extend-presence', base({presence: true}), standard);
{
  const e = base(); e.select(2); e._prepareSheetMovieclips();
  write('extend-authored', e, standard);
}
{
  const e = base(); e.createLayer('Second'); e.assignFiguresToLayer([2], 'layer-2');
  write('extend-layer2', e, [['@select', 2, -1], ['@seek', 2.25], ['addMovieclipToNextKeyframes', 3], ['@seek', 5.75], ['undo'], ['redo'], ['undo'], ['setLayerColor', ['layer-2'], 'blue'], ['redo']]);
}
write('extend-noop', base({gaps: false}), [['@select', 2, -1], ['@seek', 2.25], ['addMovieclipToNextKeyframes', 3], ['@seek', 16], ['addMovieclipToNextKeyframes', 9], ['undo'], ['redo']]);
{
  const e = base(); e.setLayerLocked('layer-1', true);
  write('extend-locked', e, [['@select', 2, -1], ['addMovieclipToNextKeyframes', 3], ['setLayerLocked', 'layer-1', false], ['addMovieclipToNextKeyframes', 1], ['undo'], ['redo']]);
}
write('extend-live-errors', base(), [['@select', 1, -1], ['beginTranslationDrag', 'Other figure'], ['moveSelection', 4.5, -2.25], ['@select', 2, -1],
  ['addMovieclipToNextKeyframes', 0], ['addMovieclipToNextKeyframes', .5], ['addMovieclipToNextKeyframes', -1], ['addMovieclipToNextKeyframes', 1],
  ['@select', 1, -1], ['moveSelection', 2, 1], ['cancelDrag'], ['undo'], ['redo']]);
{
  const e = base({presence: true});
  const typeId = e.report.keyframes[0].objects.find(o => o.unique_id === 2).figure_type_id;
  e.report.keyframes[0]._styk.movieclipContinuations = [{uid: 9, typeId, playback: {clock: 'presence', offset: .2, speed: .75, mode: 'loop'}, futureStep: 'kept'}];
  write('extend-continuations', open(structuredClone(e.report), app), standard);
}
