// Set Origin recordings built before extending the native command implementation.
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {documentOf, limb, open, joint, nextKey} from './fixture-kit.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const steps = [
  ['@select', 1, 1], ['setOrigin'], ['undo'], ['redo'], ['setOrigin', 22], ['setOrigin', 55], ['undo'], ['redo'],
  ['setOrigin', 0], ['setOrigin', 22], ['setOrigin', 44], ['undo'], ['undo'], ['redo'], ['redo'],
  ['beginTranslationDrag'], ['moveSelection', 3.25, -7.5], ['setOrigin', 55], ['undo'], ['undo'], ['redo'], ['redo'],
  ['@seek', 3.5], ['@select', 1, -1], ['setOrigin', 22], ['undo'], ['redo'], ['setOrigin', 55],
  ['@seek', 8], ['@select', 2, -1], ['setOrigin', 22], ['undo'], ['redo'], ['setOrigin', 55], ['undo'], ['redo'],
  ['@select', 1, -1], ['setOrigin', 44], ['rotateFigure', .31], ['scaleSelected', .85], ['undo'], ['undo'], ['undo'], ['redo'], ['redo'], ['redo'],
  ['@seek', 0], ['setOrigin', 22], ['undo'], ['redo'],
];
for (const kind of ['new', 'layout', 'offsets', 'support']) {
  counter = 0;
  const document = documentOf([limb(true), limb(true), limb()], i => [240 + i * 180, 170]);
  for (const figure of document.figure_types.slice(0, 2)) {
    figure.segments[0].bend_rad = .35;
    figure.segments[1].bend_rad = -.23;
    figure.segments[0].secondary = {rgb: [40, 130, 210], a: 51, futureSecondary: true};
    figure.segments[0].color_alpha = .7;
    figure.segments[0].paint = {type: 'linear', angle: 17, stops: [{offset: 0, color: [230, 60, 20], opacity: .7}, {offset: .35, color: [120, 40, 80], opacity: .8}, {offset: 1, color: [40, 130, 210], opacity: .8}], futurePaint: true};
    figure.segments[1].paint = {type: 'radial', angle: 41, stops: [{offset: 0, color: [230, 60, 20], opacity: 1}, {offset: 1, color: [40, 130, 210], opacity: .8}]};
    figure.segments[1]._sticknodes = {kind: 'segment', reversed: false, futureShape: true};
    figure.polyfills = [{polyfill_id: 1, segment_ids: [0, 22, 55], color_rgb: [10, 35, 65], alpha_raw: 0, z_order: 0, _stykSurface: {basis: [0, 22, 55], depth: [0, 55], side: 'front', futureSurface: true}}];
  }
  const e = open(document);
  if (kind !== 'new') {
    joint(e, 22, 1); e.setOrigin(22);
    if (kind === 'offsets') { joint(e, 11, 1); e.mirrorSegmentBranch('horizontal'); }
    if (kind === 'support') { joint(e, 11, 1); e.deleteSingleSegment({preserveEndpoints: true}); }
    joint(e, 22, 2); e.setOrigin(22);
  }
  e.select(2); e.joinTo(1, 55);
  nextKey(e, 8); e.select(1); e.rotateSelection(.63); e.moveSelection(22, -11); e.select(2); e.scaleSelected(.9); e.seek(0);
  for (const figure of e.report.figure_types) {
    if (figure._styk?.animationOrigin) {
      figure._styk.animationOrigin.futureOrigin = {preserved: [5, 9]};
      for (const bone of figure._styk.animationOrigin.support?.bones ?? []) bone.futureBone = {preserved: true};
    }
  }
  for (const frame of e.report.keyframes) for (const object of frame.objects) {
    const figure = e.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
    if (object.figure_type_id <= 2) {
      object.bend_flag = 1; object.bends = figure.segments.map((segment, index) => (segment.bend_rad ?? 0) + (index === 2 ? .09 : 0));
      object.len_flag = 1; object.lengths = figure.segments.map((segment, index) => segment.length * (index === 2 ? 1.125 : 1));
      object._stykStyle = {segments: {22: {color: 0x123456, gradientColor: 0xabc123, opacity: .6, gradientOpacity: .8, futureStyle: true}, 11: {paint: {type: 'diamond', angle: -49, stops: [{offset: 0, color: [40, 90, 120], opacity: .6}, {offset: 1, color: [180, 30, 10], opacity: .9}]}}}};
      object._sticknodesShapes = {22: {kind: 'segment', reversed: false, futureShape: [2, 8]}};
    }
    if (object._stykAnimationOrigin) {
      object._stykAnimationOrigin.futurePivot = {preserved: [3, 7]};
      for (const ghost of Object.values(object._stykAnimationOrigin.ghosts ?? {})) ghost.futureGhost = {preserved: true};
    } else object.futureOrdinary = {preserved: true};
  }
  e.report._styk.frameSources = {...e.report._styk.frameSources, 'unused-origin-source': structuredClone(e.report.keyframes[0])};
  e.report._styk.frameSources['unused-origin-source']._styk = {frameId: 'unused-origin-source'};
  e.report._styk.frameSources['unused-origin-source'].futureSource = {preserved: true};
  for (const mode of ['native', 'sheet']) {
    const name = `origin-reroot-${kind}-${mode}`, editor = mode === 'native' ? {} : app;
    const file = `${name}.document.json`;
    writeFileSync(`${out}/${file}`, mode === 'native' ? mirror(e) : mirror(open(JSON.parse(mirror(e)), editor)));
    // The retained-support fixture has lost handle 11, hence one fewer construction segment.
    const calls = structuredClone(steps); calls[0][2] = e.report.figure_types[0].segments.findIndex(segment => segment.segment_id === 22);
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document: file, editor, steps: calls}, null, 1) + '\n');
  }
}

// A command list built with the actual editor's evolving native handle table:
// static joint indices must follow splits/deletions/reordering in the recording.
for (const kind of ['layout', 'offsets', 'support']) for (const mode of ['native', 'sheet']) {
  const {readFileSync} = await import('node:fs');
  const document = `origin-reroot-${kind}-${mode}.document.json`, editor = mode === 'native' ? {} : app;
  const planning = open(JSON.parse(readFileSync(`${out}/${document}`, 'utf8')), editor), calls = [];
  const call = (...args) => { calls.push(args); planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1)); };
  const select = handle => call('@select', 1, planning.report.figure_types[0].segments.findIndex(segment => segment.segment_id === handle));
  call('@select', 1, -1); call('setOrigin', 55);
  select(44); call('mirrorSegmentBranch', 'horizontal'); call('undo'); call('redo');
  select(44); call('mirrorSegment', 'vertical'); call('undo'); call('redo');
  select(44); call('splitSegment', .35); call('undo'); call('redo');
  select(66); call('splitSegmentBranch', .6); call('undo'); call('redo');
  select(66); call('splitBuilderSegments', {branch: false, fraction: .4}); call('undo'); call('redo');
  call('unsplitSegment'); call('undo'); call('redo');
  select(44); call('deleteSingleSegment', {preserveEndpoints: true}); call('undo'); call('redo');
  select(33); call('deleteSingleSegment', {preserveEndpoints: false}); call('undo'); call('redo'); call('undo');
  select(66); call('deleteSegment', {branch: false}); call('undo'); call('redo'); call('undo');
  select(66); call('deleteSegment', {branch: true}); call('undo'); call('redo'); call('undo');
  call('addSegment', {parentId: 55, length: 27.125, angle: .19}); call('undo'); call('redo');
  call('addSegments', [{parentId: 55, length: 31.25, angle: .27, bend: -.17}, {parentId: 55, length: 25.5, angle: -.39}]); call('undo'); call('redo');
  call('moveBuilderSegment', 33, {parentId: 55, beforeId: 66}); call('undo'); call('redo');
  select(66); call('duplicateSegment', {axis: 'horizontal'}); call('undo'); call('redo');
  select(66); call('duplicateSegmentBranch', {axis: 'vertical'}); call('undo'); call('redo');
  const replacement = structuredClone(planning.report.figure_types[0]);
  delete replacement._styk.animationOrigin;
  replacement.segments = replacement.segments.map((segment, index) => ({...segment, length: segment.length * (index % 2 ? .9 : 1.1), angle_rad: segment.angle_rad + .13, bend_rad: (segment.bend_rad ?? 0) - .07}));
  call('replaceFigureDefinition', 1, replacement); call('undo'); call('redo');
  call('@seek', 3.5); call('@select', 1, -1); call('setOrigin', 22); call('undo'); call('redo');
  call('rotateFigure', .21); call('scaleSelected', .9); call('resetPose'); call('undo'); call('redo');
  const name = `origin-topology-${kind}-${mode}`;
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');
}
