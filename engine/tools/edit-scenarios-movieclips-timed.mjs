// Timed movieclip continuations recorded in the real editor before the Rust port.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf, limb, open, nextKey, prune, writeProject, writeReference} from './fixture-kit.mjs';
const folder = fileURLToPath(new URL('../tests/edit/', import.meta.url));
const views = fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-timed-native/', import.meta.url));
mkdirSync(views, {recursive: true});
const write = (name, document, steps) => {
  writeFileSync(`${folder}/${name}.document.json`, JSON.stringify(prune(structuredClone(document)), (key, value) => key === 'runtime_segments' ? undefined : value) + '\n');
  writeFileSync(`${folder}/${name}.scenario.json`, JSON.stringify({name, document: `${name}.document.json`, editor: {}, steps}, null, 1) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${folder}/${name}.scenario.json`, `${folder}/${name}.reference.json`], {stdio: 'inherit'});
  const replay = JSON.parse(readFileSync(`${folder}/${name}.reference.json`, 'utf8'));
  for (const [suffix, step] of [['applied', replay.steps.find(step => step.step > 0 && step.document && !step.error)], ['final', replay.steps.findLast(step => step.document)]]) {
    const document = JSON.parse(step.document), lastSeek = open(structuredClone(document), {propertyChannels: true}).totalTicks - 1;
    // reference.mjs labels the requested tick while Editor.seek clamps to the
    // last playable tick. Only request ticks the actual editor can display.
    const ticks = [0, .25, .75, 1, 1.5, 2, 2.5, 2.75, 3, 3.25, 4, 4.25, 5, 5.75, 6, 6.5, 7, 7.75, 8].filter(tick => tick <= lastSeek);
    const written = writeProject(views, `${name}-${suffix}`, document, ticks, {vfx: true, camera: true, native: true});
    writeReference(written, `${name}-${suffix}`);
  }
};
const legacy = () => {
  const e = open(documentOf([limb(), limb()], i => [180 + i * 170, 150]));
  nextKey(e, 6); e.select(1); e.moveSelection(32.5, -7.25); e.rotateFigure(.175); e.seek(0);
  const figure = e.createMovieclip({start: 0, end: 7, replace: false, name: 'Timed clip'});
  for (const frame of e.report.keyframes) {
    const o = frame.objects.find(o => o.unique_id === 1);
    o.figure_type_id = figure.figure_type_id; o.angles = [.2];
    o._stykMovieclip = {start: 0, end: 7, offset: .25, speed: .8, mode: 'loop', restarts: [{tick: 4, offset: 1.1}], privateMetadata: 'kept'};
  }
  return e;
};
write('clip-playback-all-native', legacy().report, [
  ['@select', 1, -1], ['setMovieclipPlayback', {offset: .875, speed: 1.125, mode: 'hold'}, {allFrames: true}],
  ['@seek', 2.5], ['restartMovieclip'], ['@seek', 3], ['removeMovieclipRestart'],
  ['@seek', 4.25], ['removeMovieclipRestart'], ['undo'], ['undo'], ['redo'], ['redo'],
  ['undo'], ['setMovieclipPlayback', {mode: 'once'}, {allFrames: true}], ['redo'], ['undo'], ['undo'], ['redo'],
]);
{
  const e = legacy(); e.select(1); e.placeMovieclip({end: 8});
  write('clip-playback-sources-native', e.report, [
    ['@select', 1, -1], ['@seek', 2.75], ['setMovieclipPlayback', {offset: 1.25, speed: .625}, {allFrames: true}],
    ['restartMovieclip'], ['@seek', 3], ['removeMovieclipRestart'], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'],
    ['setMovieclipPlayback', {mode: 'single', offset: 2.5}, {allFrames: true}], ['undo'], ['redo'],
  ]);
}
{
  const e = legacy();
  for (const frame of e.report.keyframes) frame.objects.find(o => o.unique_id === 1)._stykMovieclip = {clock: 'presence', start: 0, end: null, offset: .5, speed: .8, mode: 'loop'};
  write('clip-playback-presence-native', e.report, [
    ['@select', 1, -1], ['@seek', 2.5], ['setMovieclipPlayback', {speed: 1.25, mode: 'once'}, {allFrames: true}],
    ['restartMovieclip'], ['setMovieclipPlayback', {start: 2}, {allFrames: true}], ['removeMovieclipRestart'],
    ['undo'], ['undo'], ['redo'], ['redo'], ['setMovieclipPlayback', {speed: .5}, {allFrames: true}], ['undo'], ['redo'],
  ]);
}
write('clip-playback-live-native', legacy().report, [
  ['@select', 1, -1], ['beginTranslationDrag', 'Live clip'], ['moveSelection', 4.5, -2.25],
  ['setMovieclipPlayback', {speed: 0}, {allFrames: true}], ['restartMovieclip'], ['moveSelection', 2, 3], ['cancelDrag'],
  ['@batch', 'Abort timing', [['setMovieclipPlayback', {offset: 2}, {allFrames: true}], ['setMovieclipPlayback', {end: -1}, {allFrames: true}]]],
  ['setMovieclipPlayback', {speed: 1.5}, {allFrames: true}], ['undo'], ['redo'],
]);
