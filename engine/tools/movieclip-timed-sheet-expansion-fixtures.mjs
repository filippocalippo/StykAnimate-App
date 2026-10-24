// Editor-built timed sheet conversion/unique continuations, before Rust edits.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf, limb, open, nextKey, writeProject, writeReference} from './fixture-kit.mjs';
const folder = fileURLToPath(new URL('../tests/movieclip-timed-sheet-expansion/', import.meta.url));
const views = fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-timed-sheet-expansion/', import.meta.url));
mkdirSync(folder, {recursive: true}); mkdirSync(views, {recursive: true});
const app = {layerTimeline: true, propertyChannels: true};
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);
const base = ({nested = false, joined = false} = {}) => {
  const e = open(documentOf([limb(), limb(), limb()], i => [180 + i * 170, 150]));
  nextKey(e, 6); e.select(1); e.moveSelection(32.5, -7.25); e.rotateFigure(.175); e.seek(0);
  let figure = e.createMovieclip({start: 0, end: 7, replace: false, name: 'Timed expansion clip'});
  const assign = () => { for (const frame of e.report.keyframes) {
    const object = frame.objects.find(o => o.unique_id === 1);
    object.figure_type_id = figure.figure_type_id; object.angles = [.2];
    object._stykMovieclip = {start: 0, end: 7, offset: .25, speed: .8, mode: 'loop', restarts: [{tick: 4, offset: 1.1}], futurePlayback: 'kept'};
    object.futurePose = {kept: [1, 2, 3]};
  }};
  assign();
  if (nested) { e.select(1); figure = e.createMovieclip({start: 0, end: 7, replace: false, name: 'Nested timed clip'}); assign(); }
  if (joined) for (let index = 0; index < e.report.keyframes.length; index++) { e.selectFrame(index); e.select(1); e.joinTo(2, 11); }
  return open(structuredClone(e.report), app);
};
const write = (name, e, steps) => {
  const document = json(e.report);
  writeFileSync(`${folder}/${name}.document.json`, document + '\n');
  writeFileSync(`${folder}/${name}.scenario.json`, JSON.stringify({name, document: `${name}.document.json`, editor: app, steps}, null, 1) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${folder}/${name}.scenario.json`, `${folder}/${name}.reference.json`], {stdio: 'inherit'});
  const reference = JSON.parse(readFileSync(`${folder}/${name}.reference.json`, 'utf8'));
  const applied = reference.steps.find(step => ['breakApartMovieclip', 'makeMovieclipUnique'].includes(step.call?.[0]) && step.document && !step.error);
  for (const [suffix, step] of [['applied', applied], ['final', reference.steps.findLast(step => step.document)]]) {
    const document = JSON.parse(step.document), last = open(structuredClone(document), app).totalTicks - 1;
    const ticks = [0, .25, .75, 1, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 4.25, 5, 5.25, 5.75, 6].filter(tick => tick <= last);
    writeReference(writeProject(views, `${name}-${suffix}`, document, ticks, {vfx: true, camera: true, scene: true}), `${name}-${suffix}`);
  }
};
const breaks = [['@select', 1, -1], ['@seek', 2.25], ['breakApartMovieclip'], ['@seek', 4.25], ['@select', 1, -1], ['breakApartMovieclip'],
  ['@seek', 5.75], ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']];
write('break-imported', base(), breaks);
{
  const e = base(); e.select(1); e._prepareSheetMovieclips();
  write('break-authored', e, breaks);
}
{
  const e = base(); e.createLayer('Second'); e.assignFiguresToLayer([1], 'layer-2');
  write('break-layer2', e, [['@select', 1, -1], ['@seek', 2.75], ['breakApartMovieclip'], ['@seek', 4.25], ['@select', 1, -1], ['breakApartMovieclip'], ['undo'], ['undo'], ['redo'], ['redo'], ['@seek', 5.75]]);
}
write('break-nested', base({nested: true}), breaks);
write('break-joined', base({joined: true}), breaks);
const unique = [['@select', 1, -1], ['@seek', 2.25], ['makeMovieclipUnique'], ['setMovieclipPlayback', {speed: .625}, {allFrames: true}],
  ['@seek', 4.25], ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']];
write('unique-imported', base(), unique);
{
  const e = base(); e.select(1); e._prepareSheetMovieclips();
  write('unique-authored', e, unique);
}
{
  const e = base(); e.setLayerLocked('layer-1', true);
  write('expansion-locked', e, [['@select', 1, -1], ['makeMovieclipUnique'], ['@seek', 2.25], ['breakApartMovieclip'], ['setLayerLocked', 'layer-1', false], ['breakApartMovieclip'], ['undo'], ['undo'], ['redo'], ['redo']]);
}
