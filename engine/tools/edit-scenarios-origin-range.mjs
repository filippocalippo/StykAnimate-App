// Animation-origin range and join commands, recorded in the editor before admission.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const decode = value => Array.isArray(value) ? value.map(decode) : value === null || typeof value !== 'object' ? value
  : Object.hasOwn(value, '@array') ? Object.assign(value['@array'].map(decode), {sheetTicks: value.sheetTicks}) : value;
for (const kind of ['layout', 'offsets', 'support', 'saved-layout', 'saved-support']) {
  const saved = kind.startsWith('saved-');
  for (const mode of [...(saved ? [] : ['native']), 'sheet', 'autokey-sheet']) {
    const source = saved ? `origin-channels-${kind}-sheet` : `origin-pose-${kind}-${mode === 'native' ? 'native' : 'sheet'}`;
    const input = JSON.parse(readFileSync(`${out}/${source}.document.json`, 'utf8'));
    for (const frame of [...input.keyframes, ...Object.values(input._styk.frameSources ?? {})]) for (const object of frame.objects) {
      if (object.join) object.join.futureRangeJoin = {retained: [2, 6]};
      if (!object._stykAnimationOrigin) {object.futureRangeOrdinary = {retained: [4, 1]}; continue;}
      object._stykAnimationOrigin.futureRangePivot = {retained: [3, 9]};
      for (const ghost of Object.values(object._stykAnimationOrigin.ghosts ?? {})) ghost.futureRangeGhost = {retained: [8, 5]};
    }
    const name = `origin-range-${kind}-${mode}`, editor = mode === 'native' ? {} : {...app, autoKey: mode === 'autokey-sheet'}, document = `${name}.document.json`;
    const loaded = mirror(open(input, editor));writeFileSync(`${out}/${document}`, loaded);
    const planning = open(JSON.parse(loaded), editor);planning.autoKey = editor.autoKey ?? false;
    const calls = [], mutations = new Set();
    const call = (...args) => {
      const before = mirror(planning);calls.push(args);
      const result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1).map(decode));
      if (before !== mirror(planning)) mutations.add(args[0]);
      calls.push(['@frame']);return result;
    };
    const invalid = (...args) => {
      const before = mirror(planning), frame = JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame));calls.push(args);
      let error;try {planning[args[0]](...args.slice(1).map(decode));} catch (caught) {error = caught;}
      if (!error || before !== mirror(planning) || frame !== JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame))) throw Error(`${name}: invalid ${args[0]} changed document or shown frame`);
      calls.push(['@frame']);
    };
    const select = (uid, handle) => {
      const object = planning.evaluatedFrame.objects.find(object => object.unique_id === uid), figure = planning.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
      call('@select', uid, handle === undefined ? -1 : figure.segments.findIndex(segment => segment.segment_id === handle));
    };
    const indices = mode === 'native' ? [0, 1] : {'@array': [0, 1], sheetTicks: [0, 3, 8]};
    const history = () => {call('undo');call('redo');};
    const inspect = () => {for (const tick of [0, 3.5, 8]) call('@seek', tick);call('@seek', 0);};
    select(1);call('rotateFiguresInFrames', .27, indices, {center: {x: 265.125, y: 180.75}});inspect();history();
    call('mirrorFiguresInFrames', 'vertical', indices);inspect();history();
    call('mirrorFiguresInFrames', 'horizontal', indices);inspect();history();
    call('scaleFiguresInFrames', 1.125, indices, {relative: true});inspect();history();
    call('scaleFiguresInFrames', .85, indices);inspect();history();
    call('resetPoseInFrames', indices);inspect();history();
    call('centerFiguresInFrames', indices);inspect();history();
    select(2);call('detachFiguresInFrames', indices);inspect();history();
    call('joinFiguresInFrames', 1, 55, indices);inspect();history();
    call('@seek', 3.5);call('unjoinFigure');history();call('joinTo', 1, 22);history();call('joinFigure', null);history();call('joinFigure', 1, 55);history();
    select(1);call('beginTranslationDrag');call('moveSelection', 5.25, -3.125);call('cancelDrag');
    call('beginDrag', 'Origin range commits gesture');call('rotateSelection', .13);call('rotateFiguresInFrames', -.19, indices);inspect();history();
    select(1, 44);call('mirrorFiguresInFrames', 'horizontal', indices);inspect();history();select(1);
    call('selectMany', [1, 2]);call('rotateFiguresInFrames', .11, indices);inspect();history();call('resetPoseInFrames', indices);inspect();history();
    if (mode !== 'native') {select(2);call('moveSelectionInFrames', 9.125, -4.75, {'@array': [0, 1], sheetTicks: [8, 0, 3]});inspect();history();call('@seek', 3.5);invalid('moveSelectionInFrames', -3.75, 2.125);call('@seek', 4);call('moveSelectionInFrames', -3.75, 2.125);history();}
    call('@seek', 0);select(1);call('rotateFiguresInFrames', 0, indices);call('scaleFiguresInFrames', 1, indices, {relative: true});call('detachFiguresInFrames', indices);call('undo');call('redo');
    for (const method of ['rotateFiguresInFrames', 'mirrorFiguresInFrames', 'scaleFiguresInFrames', 'resetPoseInFrames', 'centerFiguresInFrames', 'detachFiguresInFrames', 'joinFiguresInFrames', 'unjoinFigure', 'joinTo', 'joinFigure', ...(mode === 'native' ? [] : ['moveSelectionInFrames'])]) if (!mutations.has(method)) throw Error(`${name}: ${method} never changed the document`);
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');
    console.log(`${name}: ${calls.length} steps, ${mutations.size} changed call kinds`);
  }
}
