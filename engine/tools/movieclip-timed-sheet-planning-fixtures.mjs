// Real editor calls and their owning layer-sheet publication payloads, recorded
// before the borrowed Rust worker planners. No alternate pose evaluator.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {documentOf, limb, open, nextKey, writeProject, writeReference} from './fixture-kit.mjs';
const out = fileURLToPath(new URL('../tests/movieclip-timed-sheet/', import.meta.url));
const views = fileURLToPath(new URL('../crates/styk-eval/tests/fixtures/movieclip-timed-sheet/', import.meta.url));
mkdirSync(out, {recursive: true});
mkdirSync(views, {recursive: true});
const app = {layerTimeline: true, propertyChannels: true};
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);
const base = (dense = false) => {
  const e = open(documentOf([limb(), limb(), dense ? Array.from({length: 1024}, (_, i) => [i + 1, 0, 30 + i % 5, .2 + i % 4 * .3]) : limb()], i => [180 + i * 170, 150]));
  nextKey(e, 6); e.select(1); e.moveSelection(32.5, -7.25); e.rotateFigure(.175); e.seek(0);
  if (dense) for (let i = 0; i < 14; i++) { e.selectFrame(e.report.keyframes.length - 1); nextKey(e, 6); e.select(1); e.moveSelection(3.5, -2); }
  e.seek(0);
  const figure = e.createMovieclip({start: 0, end: 7, replace: false, name: 'Timed worker clip'});
  for (const frame of e.report.keyframes) {
    const o = frame.objects.find(o => o.unique_id === 1);
    o.figure_type_id = figure.figure_type_id; o.angles = [.2];
    o._stykMovieclip = {start: 0, end: 7, offset: .25, speed: .8, mode: 'loop', restarts: [{tick: 4, offset: 1.1}]};
    o.futurePose = {kept: [1, 2, 3]};
  }
  return open(structuredClone(e.report), app);
};
const write = (name, e, steps) => {
  const document = json(e.report);
  writeFileSync(`${out}/${name}.document.json`, document + '\n');
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document: `${name}.document.json`, editor: app, steps}, null, 1) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${out}/${name}.scenario.json`, `${out}/${name}.reference.json`], {stdio: 'inherit'});
  const recorded = JSON.parse(readFileSync(`${out}/${name}.reference.json`, 'utf8'));
  const editor = open(JSON.parse(document), app), payloads = [];
  let step = 0;
  const record = editor._record.bind(editor);
  editor._record = command => {
    if (command.kind === 'layer-sheet') {
      const tracks = Object.fromEntries(Object.entries(command.after.tracks).filter(([id, track]) => track !== command.before.tracks[id]));
      payloads.push({step, payload: {plan: {sheet: {...command.after, tracks}, trackOrder: Object.keys(command.after.tracks), layers: command.afterLayers,
        sources: Object.fromEntries(command.frameSourceChanges.map(source => [source.id, source.after.value])), nextFrame: editor._nextFrameIdentity}}});
    }
    return record(command);
  };
  for (const call of steps) {
    step++;
    const [name, ...args] = call;
    try { editor[name === '@seek' ? 'seek' : name === '@select' ? 'select' : name](...structuredClone(args)); } catch {}
    if (recorded.steps[step].document && recorded.steps[step].document !== json(editor.report)) throw new Error(`${name}: recording/probe document differs`);
  }
  writeFileSync(`${out}/${name}.payloads.json`, json(payloads) + '\n');
  const applied = recorded.steps.find(step => ['_prepareSheetMovieclips', 'sheetApplyChannels'].includes(step.call?.[0]) && step.document && !step.error) ?? recorded.steps[0];
  for (const [suffix, step] of [['applied', applied], ['final', recorded.steps.findLast(step => step.document)]]) {
    const document = JSON.parse(step.document), lastSeek = open(structuredClone(document), app).totalTicks - 1;
    const ticks = [0, .25, .75, 1.5, 2, 2.25, 2.75, 3.5, 4.25, 5, 5.75, 6, 6.5, 7, 8, 9].filter(tick => tick <= lastSeek);
    writeReference(writeProject(views, `${name}-${suffix}`, document, ticks, {vfx: true, camera: true, scene: true}), `${name}-${suffix}`);
  }
};
write('prepare-imported', base(), [['@seek', 2.25], ['@select', 1, -1], ['_prepareSheetMovieclips'], ['undo'], ['redo'], ['_prepareSheetMovieclips'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
write('prepare-dense', base(true), [['@seek', 2.25], ['@select', 1, -1], ['_prepareSheetMovieclips'], ['undo'], ['redo'], ['_prepareSheetMovieclips'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
{
  const e = base(); e.createLayer('Second'); e.assignFiguresToLayer([2, 3], 'layer-2');
  write('prepare-multilayer', e, [['@seek', 3.5], ['selectMany', [1, 2, 3]], ['_prepareSheetMovieclips'], ['undo'], ['redo'], ['@select', 2, -1], ['_prepareSheetMovieclips']]);
}
{
  const e = base(); e.setLayerLocked('layer-1', true);
  write('prepare-locked', e, [['@select', 1, -1], ['_prepareSheetMovieclips'], ['setLayerLocked', 'layer-1', false], ['_prepareSheetMovieclips'], ['undo'], ['undo'], ['redo'], ['redo']]);
}
{
  const e = base(); e.select(1); e._prepareSheetMovieclips();
  write('prepare-noop', e, [['@select', 1, -1], ['_prepareSheetMovieclips'], ['@select', null, -1], ['_prepareSheetMovieclips'], ['undo'], ['redo']]);
}
const prepared = () => { const e = base(); e.select(1); e._prepareSheetMovieclips(); return e; };
const pose = (e, extra = {}) => ({id: 'figure:1:pose', target: {kind: 'figure', uid: 1}, property: 'pose',
  keys: e.report._styk.layerSheet.tracks['layer-1'].keys.map(key => ({id: key.id, tick: key.tick, interpolation: key.interpolation, value: structuredClone(key.value)})), ...extra});
{
  const e = prepared(), channel = pose(e, {movieclipCurve: true, clipEnd: 10, orderAnchor: 1});
  channel.keys = channel.keys.map(key => ({...key, tick: key.tick + 2}));
  write('channels-timing', e, [['@select', 1, -1], ['sheetApplyChannels', [channel], 'Set movieclip timing'], ['@seek', 2.75], ['undo'], ['redo'], ['@seek', 8], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
}
{
  const e = prepared(), channel = pose(e, {useBasePose: true, maskedRanges: [[2, 4]], movieclipCurve: true, clipEnd: 9});
  write('channels-masked', e, [['@select', 1, -1], ['sheetApplyChannels', [channel], 'Break apart frame', {preserveDuration: true}], ['@seek', 3.5], ['undo'], ['redo'], ['@seek', 5.25], ['undo'], ['redo']]);
}
{
  const e = prepared(); for (const tick of [0, 6]) e.sheetInsertKey(['scene', 'camera'], tick);
  const channel = (target, property, values) => ({id: `${target.kind}:${target.uid ?? ''}:${property}`, target, property,
    keys: [{id: 'hidden', tick: -1, hidden: true, interpolation: 'linear', value: values[0]}, {id: 'first', tick: 2, interpolation: 'linear', value: values[0]}, {id: 'last', tick: 5, interpolation: 'linear', value: values[1]}]});
  const channels = [channel({kind: 'figure', uid: 1}, 'opacity', [.3, .8]), channel({kind: 'figure', uid: 1}, 'x', [220.25, 250.75]), channel({kind: 'camera'}, 'scale', [1.1, 1.4]), channel({kind: 'scene'}, 'color', [0x112233, 0x778899])];
  write('channels-scalar-fixed', e, [['@seek', 2.25], ['@select', 1, -1], ['sheetApplyChannels', channels, 'Set movieclip timing'], ['@seek', 4.25], ['undo'], ['redo'], ['undo'], ['redo']]);
}
{
  const e = prepared(), invalid = pose(e, {movieclipCurve: true, clipEnd: 1.5}), valid = pose(e, {movieclipCurve: true, clipEnd: 7});
  write('channels-live-errors', e, [['@select', 2, -1], ['beginTranslationDrag', 'Other figure'], ['moveSelection', 4.5, -2.25],
    ['sheetApplyChannels', [invalid], 'Set movieclip timing'], ['moveSelection', 2, 1], ['cancelDrag'],
    ['sheetApplyChannels', [valid], 'Set movieclip timing'], ['undo'], ['redo'], ['undo'], ['setLayerColor', ['layer-1'], 'blue'], ['redo']]);
}
