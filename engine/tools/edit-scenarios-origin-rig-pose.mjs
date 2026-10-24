// Legal 2D rig/origin combinations built and replayed by the editor before admission.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open, joint} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const shown = editor => JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame));
for (const kind of ['layout', 'offsets', 'support', 'saved-layout', 'saved-support']) {
  const saved = kind.startsWith('saved-');
  for (const mode of [...(saved ? [] : ['native']), 'sheet', 'autokey-sheet']) {
    const editor = mode === 'native' ? {} : {...app, autoKey: mode === 'autokey-sheet'};
    const base = open(JSON.parse(readFileSync(`${out}/origin-rig-${kind}-${mode}.document.json`, 'utf8')), editor);
    joint(base, 44, 1);base.enableSmartStretch(true);
    joint(base, 55, 1);base.setAngleLock('world');
    base.addConnector(33, 66, {position: .4});
    const name = `origin-rig-pose-${kind}-${mode}`, document = `${name}.document.json`, loaded = mirror(base);
    writeFileSync(`${out}/${document}`, loaded);
    const planning = open(JSON.parse(loaded), editor);planning.autoKey = editor.autoKey ?? false;
    const calls = [], mutations = new Set();let previews = 0;
    const call = (...args) => {
      const before = mirror(planning), frame = shown(planning);calls.push(args);
      let result;try {result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));}
      catch (error) {throw Error(`${name} ${args[0]}: ${error.message}`, {cause: error});}
      if (before !== mirror(planning) || frame !== shown(planning)) mutations.add(args[0]);
      if (frame !== shown(planning) && !['@select', '@seek', 'undo', 'redo'].includes(args[0])) previews++;
      calls.push(['@frame']);return result;
    };
    const select = (handle, uid = 1) => {
      const object = planning.evaluatedFrame.objects.find(object => object.unique_id === uid), figure = planning.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
      call('@select', uid, figure.segments.findIndex(segment => Number(segment.segment_id) === handle));
    };
    const tip = () => {const point = planning.geometry.objects.get(planning.selectedSlot).segments[planning.selectedJoint].end;return [point.x, point.y];};
    const history = () => {call('undo');call('redo');};
    const inspect = () => {for (const tick of [0, 3.5, 8]) call('@seek', tick);};
    select(44);call('@seek', 3.5);let start = tip();call('beginDrag', 'Origin rig posing return');call('poseJoint', start[0]+17.125, start[1]-11.25, {stretch: true, snap: false});call('poseJoint', ...start, {snap: false});call('cancelDrag');
    start = tip();call('poseJoint', start[0]+21.25, start[1]-13.125, {stretch: true, snap: false});history();call('rotateJoint', .23);history();start = tip();call('bendJoint', start[0]+9.125, start[1]+17.75, {stretch: true, snap: false});history();inspect();
    select(44);start = tip();call('poseJoint', start[0]+12.125, start[1]-6.25, {isolate: true, stretch: true, snap: false});history();call('rotateJoint', .11, {isolate: true});history();
    select(55);start = tip();call('poseJoint', start[0]+18.375, start[1]-8.25, {stretch: true, snap: false});history();call('rotateJoint', .31);call('bendJoint', start[0]-11.125, start[1]+7.25, {snap: false});
    const connector = planning.report.figure_types.find(figure => figure.figure_type_id === 1).segments.find(segment => segment._stykRig?.connector).segment_id;
    select(connector);start = tip();call('beginDrag', 'Origin connector cancel');call('slideConnector', start[0]+8.125, start[1]-5.25);call('setConnectorPosition', .65);call('cancelDrag');
    call('setConnectorPosition', .75);history();start = tip();call('slideConnector', start[0]-7.25, start[1]+9.125);history();start = tip();call('bendJoint', start[0]+9.125, start[1]-8.375, {snap: false});history();
    select(44);start = tip();call('beginRigDrag', {reposition: true});call('editRigJoint', start[0]+15.25, start[1]-10.125);call('editRigJoint', ...start);call('cancelRigDrag');
    start = tip();call('beginRigDrag', {reposition: false});call('editRigJoint', start[0]-9.125, start[1]+12.75, {stretch: true});call('commitRigDrag');history();inspect();
    select(44);start = tip();call('beginRigDrag', {reposition: true});call('editRigJoint', start[0]+11.125, start[1]+8.25);call('commitRigDrag');history();
    call('@seek', 3.5);select(44);start = tip();call('beginRigDrag', {bend: true});call('bendJoint', start[0]+7.125, start[1]-14.25, {snap: false});call('commitRigDrag');history();inspect();
    call('@seek', 0);select(55);start = tip();call('editRigJoint', start[0]+10.125, start[1]+6.25, {stretch: true});history();
    select(44);start = tip();call('beginFigureHandleDrag', ...start);call('transformFigureHandle', start[0]+16.125, start[1]-19.25, {ctrlKey: true});call('transformFigureHandle', ...start);call('cancelFigureHandleDrag');
    start = tip();call('beginFigureHandleDrag', ...start);call('transformFigureHandle', start[0]-11.375, start[1]+13.125, {shiftKey: true});call('commitFigureHandleDrag');history();inspect();
    select(44);start = tip();call('beginFigureHandleDrag', ...start, {rotate: false});call('transformFigureHandle', start[0]+8.25, start[1]-7.125);call('cancelFigureHandleDrag');
    start = tip();call('beginFigureHandleDrag', ...start, {scale: false});call('transformFigureHandle', start[0]-7.125, start[1]+8.25);call('commitFigureHandleDrag');history();
    select(44);start = tip();const groupJoint = planning.selectedJoint;call('selectMany', [2, 1]);call('beginFigureHandleDrag', ...start, {joint: groupJoint});call('transformFigureHandle', start[0]+13.125, start[1]-9.25, {joint: groupJoint});call('commitFigureHandleDrag');history();
    call('beginFigureHandleDrag', ...start, {joint: groupJoint});call('transformFigureHandle', start[0]-5.125, start[1]+7.25, {joint: groupJoint});call('transformFigureHandle', ...start, {joint: groupJoint});call('cancelFigureHandleDrag');
    select(saved ? 33 : 55, 2);call('rotateJoint', .17);history();
    select(44);call('beginDrag', 'Origin rig invalid preview');start = tip();call('poseJoint', start[0]+6.125, start[1]-4.25, {snap: false});const before = mirror(planning), frame = shown(planning);calls.push(['poseJoint', 'invalid', start[1]]);
    let error;try {planning.poseJoint('invalid', start[1]);} catch (caught) {error = caught;}
    if (!error || before !== mirror(planning) || frame !== shown(planning)) throw Error(`${name}: invalid posing changed its live frame`);
    calls.push(['@frame']);call('cancelDrag');
    for (const method of ['poseJoint', 'rotateJoint', 'bendJoint', 'setConnectorPosition', 'slideConnector', 'editRigJoint', 'commitRigDrag', 'transformFigureHandle']) if (!mutations.has(method)) throw Error(`${name}: ${method} never changed the document`);
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');
    console.log(`${name}: ${calls.length} steps, ${previews} changed live frames`);
  }
}

// The direct connector command also needs its ordinary-document dispatch recorded.
for (const mode of ['native', 'sheet']) {
  const input = JSON.parse(readFileSync(`${out}/rig.document.json`, 'utf8'));input.keyframes[0].duration_raw = 8;
  const editor = mode === 'native' ? {} : app, name = `slide-connector-direct-${mode}`, document = `${name}.document.json`;
  const loaded = mirror(open(input, editor));writeFileSync(`${out}/${document}`, loaded);
  const planning = open(JSON.parse(loaded), editor), calls = [];
  const call = (...args) => {calls.push(args);const result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));calls.push(['@frame']);return result;};
  const connector = planning.report.figure_types[0].segments.findIndex(segment => segment._stykRig?.connector);
  const tip = () => {const point = planning.geometry.objects.get(planning.selectedSlot).segments[planning.selectedJoint].end;return [point.x, point.y];};
  call('@select', 1, -1);call('slideConnector', 100.25, 200.125);call('@select', 1, 0);call('slideConnector', 100.25, 200.125);
  call('@select', 1, connector);let start = tip();call('beginDrag', 'Direct connector cancel');call('slideConnector', start[0]+18.125, start[1]-12.25);call('slideConnector', ...start);call('cancelDrag');
  start = tip();const before = shown(planning);call('slideConnector', start[0]-23.25, start[1]+17.125);if (before === shown(planning)) throw Error(`${name}: direct command never changed the pose`);call('undo');call('redo');
  call('@seek', 3.5);start = tip();call('beginDrag', 'Direct connector invalid');call('slideConnector', start[0]+12.125, start[1]-8.25);
  const saved = mirror(planning), frame = shown(planning);calls.push(['slideConnector', 'invalid', start[1]]);let error;
  try {planning.slideConnector('invalid', start[1]);} catch (caught) {error = caught;}
  if (!error || saved !== mirror(planning) || frame !== shown(planning)) throw Error(`${name}: invalid direct pointer changed its live frame`);
  calls.push(['@frame']);call('commitDrag');call('undo');call('redo');
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');console.log(`${name}: ${calls.length} steps`);
}
