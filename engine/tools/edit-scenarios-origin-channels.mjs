// Origin property editing on the app's exposure sheet, including saved channels.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const poseJSON = editor => JSON.stringify(editor.evaluatedFrame.objects.map(object => Object.fromEntries(['root_x', 'root_y', 'scale', 'angles', 'len_flag', 'lengths', 'bend_flag', 'bends', '_stykAnimationOrigin'].filter(key => key in object).map(key => [key, object[key]]))));
const figure = uid => ({kind: 'figure', uid});
for (const kind of ['layout', 'offsets', 'support', 'saved-layout', 'saved-support']) {
  const saved = kind.startsWith('saved-');
  const source = saved ? `../crates/styk-eval/tests/fixtures/records/channels-origin${kind.endsWith('support') ? '-support' : ''}/report.json` : `../tests/edit/origin-pose-${kind}-sheet.document.json`;
  const input = JSON.parse(readFileSync(new URL(source, import.meta.url), 'utf8'));
  for (const frame of [...input.keyframes, ...Object.values(input._styk.frameSources ?? {})]) for (const object of frame.objects) {
    if (!object._stykAnimationOrigin) continue;
    object._stykAnimationOrigin.futureChannelPivot = {retained: [7, 2]};
    for (const ghost of Object.values(object._stykAnimationOrigin.ghosts ?? {})) ghost.futureChannelGhost = {retained: [6, 3]};
  }
  for (const autoKey of [false, true]) {
    const name = `origin-channels-${kind}-${autoKey ? 'autokey-' : ''}sheet`, editor = {...app, autoKey}, document = `${name}.document.json`;
    const loaded = mirror(open(structuredClone(input), editor)); writeFileSync(`${out}/${document}`, loaded);
    const planning = open(JSON.parse(loaded), editor); planning.autoKey = autoKey;
    const calls = [], mutations = new Set();
    const call = (...args) => {
      const before = poseJSON(planning), documentBefore = mirror(planning); calls.push(args);
      const result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));
      if (before !== poseJSON(planning) || documentBefore !== mirror(planning)) mutations.add(args[0]);
      calls.push(['@frame']);
      return result;
    };
    const invalidPreview = value => {
      const before = JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame)), documentBefore = mirror(planning);
      calls.push(['previewAnimationEdit', value]);
      let error;
      try { planning.previewAnimationEdit(value); } catch (caught) { error = caught; }
      if (!error || before !== JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame)) || documentBefore !== mirror(planning)) throw Error(`${name}: invalid preview changed the displayed pose or document`);
      calls.push(['@frame']);
    };
    const select = (uid, handle) => {
      const object = planning.evaluatedFrame.objects.find(object => object.unique_id === uid);
      const definition = planning.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
      call('@select', uid, handle === undefined ? -1 : definition.segments.findIndex(segment => segment.segment_id === handle));
    };
    select(1); call('beginTranslationDrag'); call('moveSelection', 7.25, -3.5, {fromStart: true}); call('moveSelection', 0, 0, {fromStart: true}); call('cancelDrag');
    call('beginDrag', 'Origin saved transforms'); call('rotateSelection', .23); call('scaleSelection', 1.125); call('mirrorSelection', 'horizontal'); call('commitDrag'); call('undo'); call('redo');
    call('rotateFigure', -.17); call('mirrorFigure', 'vertical'); call('scaleSelected', .85); call('centerFigure'); call('resetPose'); call('undo'); call('redo');
    select(2); call('beginTranslationDrag'); call('moveSelection', -4.5, 2.75); call('commitDrag'); call('undo'); call('redo');
    call('selectMany', [1, 2]); call('rotateSelection', .13, {center: {x: 280.25, y: 190.75}}); call('undo'); call('redo');
    call('@seek', 4); select(1, 44); const tip = planning.geometry.objects.get(planning.selectedSlot).segments[planning.selectedJoint].end;
    call('beginDrag', 'Origin channel pose'); call('poseJoint', tip.x + 9.125, tip.y - 7.5, {stretch: true, snap: false}); call('rotateJoint', .11); call('bendJoint', tip.x + 4, tip.y + 8, {snap: false}); call('commitDrag'); call('undo'); call('redo');
    select(1); call('beginAnimationEdit', figure(1), 'rotation'); call('previewAnimationEdit', -.4); call('previewAnimationEdit', .73); invalidPreview('not-a-number'); invalidPreview({}); call('commitAnimationEdit'); call('undo'); call('redo');
    call('beginAnimationEdit', figure(1), 'scale'); call('previewAnimationEdit', 1.4); invalidPreview(-1); invalidPreview(1000001); call('cancelAnimationEdit');
    const initial = planning.animationValue(figure(1), 'scale'); call('beginAnimationEdit', figure(1), 'scale'); call('previewAnimationEdit', initial * .75); call('previewAnimationEdit', initial); call('commitAnimationEdit');
    select(2); call('beginAnimationEdit', figure(2), 'x'); call('previewAnimationEdit', 355.125); call('commitAnimationEdit'); call('undo'); call('redo');
    call('beginAnimationEdit', figure(2), 'rotation', {exactTarget: true}); call('previewAnimationEdit', -.37); call('commitAnimationEdit'); call('undo'); call('redo');
    call('@seek', 3.5); select(1); call('moveSelection', 4.125, -2.75); call('undo'); call('redo'); call('@seek', 8);
    call('addAnimationKeys', [{target: figure(1), property: 'x', tick: 8, value: 260.25}, {target: figure(1), property: 'rotation', tick: 8, value: .52}, {target: figure(2), property: 'y', tick: 8, value: 195.75}]); call('undo'); call('redo');
    call('addAnimationKey', figure(2), 'scale', 9, .91); call('undo'); call('redo');
    call('addAnimationKeys', [{target: figure(1), property: 'rotation'}, {target: figure(2), property: 'x'}]); call('undo'); call('redo');
    call('@seek', 0); call('beginAnimationEdit', figure(1), 'rotation'); call('previewAnimationEdit', .38); call('undo'); call('redo');
    for (const method of ['moveSelection', 'rotateSelection', 'scaleSelection', 'mirrorSelection', 'poseJoint', 'rotateJoint', 'bendJoint', 'previewAnimationEdit', 'addAnimationKeys', 'addAnimationKey']) if (!mutations.has(method)) throw Error(`${name}: ${method} never changed the document or visible pose`);
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');
    console.log(`${name}: ${calls.length} editor steps, ${mutations.size} changed call kinds`);
  }
}
