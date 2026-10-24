// Sequential timed commands are recorded from the actual editor before the
// worker-only Rust orchestration. Publication payloads come from its _record.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf, limb, open, nextKey, writeProject, writeReference} from './fixture-kit.mjs';
import {normalizeFrame} from '../../src/pivot/structure.mjs';
const folder = fileURLToPath(new URL('../tests/movieclip-timed-sheet-commands/', import.meta.url));
const views = fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-timed-sheet-commands/', import.meta.url));
mkdirSync(folder, {recursive: true}); mkdirSync(views, {recursive: true});
const app = {layerTimeline: true, propertyChannels: true};
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);
const base = (gap = false) => {
  const e = open(documentOf([limb(), limb(), limb()], i => [180 + i * 170, 150]));
  nextKey(e, 6); e.select(1); e.moveSelection(32.5, -7.25); e.rotateFigure(.175); e.seek(0);
  if (gap) { e.selectFrame(1); nextKey(e, 6); e.select(1); e.moveSelection(-16.25, 9.5); e.seek(0); }
  const figure = e.createMovieclip({start: 0, end: 7, replace: false, name: 'Timed sequential clip'});
  for (const frame of e.report.keyframes) {
    const object = frame.objects.find(o => o.unique_id === 1);
    object.figure_type_id = figure.figure_type_id; object.angles = [.2];
    object._stykMovieclip = {start: 0, end: gap ? 13 : 7, offset: .25, speed: .8, mode: 'loop', restarts: [{tick: 4, offset: 1.1}], futurePlayback: 'kept'};
    object.futurePose = {kept: [1, 2, 3]};
  }
  if (gap) {
    e.report.keyframes[1].objects = e.report.keyframes[1].objects.filter(o => o.unique_id !== 1);
    normalizeFrame(e.report.keyframes[1]);
  }
  return open(structuredClone(e.report), app);
};
const write = (name, e, steps) => {
  const document = json(e.report);
  writeFileSync(`${folder}/${name}.document.json`, document + '\n');
  writeFileSync(`${folder}/${name}.scenario.json`, JSON.stringify({name, document: `${name}.document.json`, editor: app, steps}, null, 1) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${folder}/${name}.scenario.json`, `${folder}/${name}.reference.json`], {stdio: 'inherit'});
  const reference = JSON.parse(readFileSync(`${folder}/${name}.reference.json`, 'utf8'));
  const editor = open(JSON.parse(document), app), payloads = []; let step = 0;
  const record = editor._record.bind(editor);
  editor._record = command => {
    if (command.kind === 'layer-sheet') {
      const tracks = Object.fromEntries(Object.entries(command.after.tracks).filter(([id, track]) => track !== command.before.tracks[id]));
      payloads.push({step, label: command.label, payload: {plan: {sheet: {...command.after, tracks}, trackOrder: Object.keys(command.after.tracks), layers: command.afterLayers,
        sources: Object.fromEntries(command.frameSourceChanges.map(source => [source.id, source.after.value])), nextFrame: editor._nextFrameIdentity}}});
    }
    return record(command);
  };
  for (const [method, ...args] of steps) {
    step++;
    try { editor[method === '@seek' ? 'seek' : method === '@select' ? 'select' : method](...structuredClone(args)); } catch {}
    if (reference.steps[step].document && reference.steps[step].document !== json(editor.report)) throw new Error(`${name} step${step}: probe differs`);
  }
  writeFileSync(`${folder}/${name}.payloads.json`, json(payloads) + '\n');
  const applied = reference.steps.find(step => ['setMovieclipPlayback', 'placeMovieclip', 'splitMovieclip'].includes(step.call?.[0]) && step.document && !step.error);
  for (const [suffix, step] of [['applied', applied], ['final', reference.steps.findLast(step => step.document)]]) {
    const document = JSON.parse(step.document), last = open(structuredClone(document), app).totalTicks - 1;
    const ticks = [0, .25, .75, 1, 1.5, 2, 2.25, 2.75, 3, 3.5, 4, 4.25, 5, 5.75, 6, 6.5, 7, 8, 9, 10].filter(tick => tick <= last);
    writeReference(writeProject(views, `${name}-${suffix}`, document, ticks, {vfx: true, camera: true, scene: true}), `${name}-${suffix}`);
  }
};
write('playback-imported', base(), [['@select', 1, -1], ['@seek', 2.25], ['setMovieclipPlayback', {speed: 1.125, offset: .875, mode: 'hold'}, {allFrames: true}],
  ['restartMovieclip'], ['@seek', 3], ['removeMovieclipRestart'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
{
  const e = base(); e.select(1); e._prepareSheetMovieclips();
  write('playback-authored', e, [['@select', 1, -1], ['@seek', 2.75], ['setMovieclipPlayback', {mode: 'single', offset: 2.5}, {allFrames: true}],
    ['restartMovieclip'], ['@seek', 3], ['removeMovieclipRestart'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo']]);
}
write('place-imported', base(), [['@select', 1, -1], ['@seek', 2.25], ['placeMovieclip', {start: 1, end: 9}, {move: true}], ['@seek', 4.5],
  ['placeMovieclip', {start: 0, end: 10}], ['@seek', 6.5], ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
{
  const e = base(); e.select(1); e._prepareSheetMovieclips();
  write('place-authored', e, [['@select', 1, -1], ['@seek', 2.75], ['placeMovieclip', {start: 2, end: 10}, {move: true}], ['@seek', 4.5],
    ['placeMovieclip', {start: 1, end: 8}], ['undo'], ['undo'], ['redo'], ['redo'], ['@seek', 5.25]]);
}
write('split-imported', base(), [['@select', 1, -1], ['@seek', 2.25], ['splitMovieclip', 3], ['@seek', 4.25], ['placeMovieclip', {start: 4, end: 9}, {move: true}],
  ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
{
  const e = base(); e.createLayer('Second'); e.assignFiguresToLayer([1], 'layer-2'); e.select(1); e._prepareSheetMovieclips();
  write('split-authored-layer', e, [['@select', 1, -1], ['@seek', 2.75], ['splitMovieclip', 3], ['@seek', 4.25], ['splitMovieclip', 5],
    ['undo'], ['undo'], ['redo'], ['redo'], ['@seek', 5.75], ['undo'], ['setLayerColor', ['layer-2'], 'blue'], ['redo']]);
}
write('timing-live-errors', base(), [['@select', 2, -1], ['beginTranslationDrag', 'Other figure'], ['moveSelection', 4.5, -2.25], ['@select', 1, -1],
  ['setMovieclipPlayback', {speed: 0}, {allFrames: true}], ['placeMovieclip', {start: 1.5}], ['splitMovieclip', 2.5], ['@select', 2, -1], ['moveSelection', 2, 1], ['cancelDrag'],
  ['@select', 1, -1], ['setMovieclipPlayback', {speed: .5}, {allFrames: true}], ['undo'], ['redo']]);
write('timing-membership-gap', base(true), [['@select', 1, -1], ['@seek', 2.75], ['placeMovieclip', {start: 1, end: 15}, {move: true}],
  ['@seek', 4.5], ['splitMovieclip', 5], ['@seek', 13], ['undo'], ['undo'], ['redo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
{
  const e = base(); e.select(1); e._prepareSheetMovieclips();
  const keys = e.report._styk.layerSheet.tracks['layer-1'].keys;
  keys.splice(1, 0, {...structuredClone(keys[0]), id: 'hidden-influence', tick: 1, hidden: true});
  write('timing-hidden-authored', e, [['@select', 1, -1], ['@seek', 2.25], ['placeMovieclip', {start: 1, end: 9}, {move: true}],
    ['@seek', 3.5], ['splitMovieclip', 4], ['undo'], ['undo'], ['redo'], ['redo'], ['@seek', 5.25]]);
}
write('timing-live-accepted', base(), [['@select', 2, -1], ['beginTranslationDrag', 'Other figure'], ['moveSelection', 4.5, -2.25], ['@select', 1, -1],
  ['setMovieclipPlayback', {speed: .625}, {allFrames: true}], ['@select', 2, -1], ['moveSelection', 2, 1], ['cancelDrag'],
  ['undo'], ['redo'], ['@select', 1, -1], ['placeMovieclip', {end: 9}], ['undo'], ['redo']]);
{
  const e = base(); e.setLayerLocked('layer-1', true);
  write('timing-locked', e, [['@select', 1, -1], ['setMovieclipPlayback', {speed: .625}, {allFrames: true}],
    ['placeMovieclip', {start: 1, end: 9}, {move: true}], ['splitMovieclip', 3], ['setLayerLocked', 'layer-1', false],
    ['placeMovieclip', {start: 1, end: 9}, {move: true}], ['undo'], ['undo'], ['redo'], ['redo']]);
}
