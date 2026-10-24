// Rig-tool origin lifecycle on ordinary 2D definitions: editor recordings precede admission.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const shown = editor => JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame));
for (const kind of ['layout', 'offsets', 'support', 'saved-layout', 'saved-support']) {
  const saved = kind.startsWith('saved-');
  for (const mode of [...(saved ? [] : ['native']), 'sheet', 'autokey-sheet']) {
    const input = JSON.parse(readFileSync(`${out}/origin-range-${kind}-${mode}.document.json`, 'utf8'));
    for (const frame of [...input.keyframes, ...Object.values(input._styk.frameSources ?? {})]) for (const object of frame.objects) {
      if (object.join) object.join.futureRigJoin = {retained: [6, 3]};
      if (!object._stykAnimationOrigin) {object.futureRigOrdinary = {retained: [8, 4]}; continue;}
      object._stykAnimationOrigin.futureRigPivot = {retained: [7, 1]};
      for (const ghost of Object.values(object._stykAnimationOrigin.ghosts ?? {})) ghost.futureRigGhost = {retained: [5, 2]};
    }
    const name = `origin-rig-${kind}-${mode}`, editor = mode === 'native' ? {} : {...app, autoKey: mode === 'autokey-sheet'}, document = `${name}.document.json`;
    const loaded = mirror(open(input, editor));writeFileSync(`${out}/${document}`, loaded);
    const planning = open(JSON.parse(loaded), editor);planning.autoKey = editor.autoKey ?? false;
    const calls = [], mutations = new Set();let previews = 0;
    const call = (...args) => {
      const before = mirror(planning), frame = shown(planning);calls.push(args);
      let result;
      try {result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));}
      catch (error) {throw Error(`${name} ${args[0]}: ${error.message}`, {cause: error});}
      if (before !== mirror(planning)) mutations.add(args[0]);
      if (args[0] === 'editRigJoint' && frame !== shown(planning)) previews++;
      calls.push(['@frame']);return result;
    };
    const select = (handle, uid = 1) => {
      const object = planning.evaluatedFrame.objects.find(object => object.unique_id === uid), figure = planning.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
      call('@select', uid, figure.segments.findIndex(segment => Number(segment.segment_id) === handle));
    };
    const tip = () => {const point = planning.geometry.objects.get(planning.selectedSlot).segments[planning.selectedJoint].end;return [point.x, point.y];};
    const history = () => {call('undo');call('redo');};
    const inspect = () => {for (const tick of [0, 3.5, 8]) call('@seek', tick);};
    select(44);call('@seek', 3.5);let start = tip();call('beginRigDrag', {label: 'Origin rig return'});call('editRigJoint', start[0]+12.125, start[1]-8.75);call('editRigJoint', ...start);call('commitRigDrag');
    start = tip();call('beginRigDrag', {reposition: false});call('editRigJoint', start[0]-9.25, start[1]+14.125, {stretch: true});call('cancelRigDrag');
    start = tip();call('beginRigDrag', {reposition: true});call('editRigJoint', start[0]+16.125, start[1]+11.375);call('commitRigDrag');history();inspect();
    select(55);start = tip();call('beginRigDrag', {reposition: false});call('editRigJoint', start[0]-15.75, start[1]+9.125, {isolate: true});call('editRigJoint', start[0]+7.625, start[1]-12.25, {stretch: true});call('commitRigDrag');history();inspect();
    call('@seek', 3.5);select(44);start = tip();call('beginRigDrag', {bend: true});call('bendJoint', start[0]+11.125, start[1]-17.75, {stretch: true, snap: false});call('commitRigDrag');history();inspect();
    call('@seek', 0);select(33);start = tip();call('editRigJoint', start[0]+9.125, start[1]-4.75, {reposition: false, stretch: true});history();
    select(saved ? 33 : 55, 2);start = tip();call('beginRigDrag', {reposition: true});call('editRigJoint', start[0]-6.125, start[1]+8.375);call('cancelRigDrag');
    start = tip();call('beginRigDrag', {bend: true});call('bendJoint', start[0]-13.125, start[1]+9.75, {snap: false});call('cancelRigDrag');
    select(44);start = tip();call('beginRigDrag');call('editRigJoint', start[0]+5.25, start[1]-2.125);const before = mirror(planning), frame = shown(planning);calls.push(['editRigJoint', 'invalid', start[1]]);
    let error;try {planning.editRigJoint('invalid', start[1]);} catch (caught) {error = caught;}
    if (!error || !planning._drag || before !== mirror(planning) || frame !== shown(planning)) throw Error(`${name}: invalid rig coordinates did not preserve the live edit`);
    calls.push(['@frame']);call('cancelRigDrag');call('commitRigDrag');call('cancelRigDrag');
    select(44);call('beginTranslationDrag');call('moveSelection', 4.125, -3.25);start = tip();call('beginRigDrag');call('editRigJoint', start[0]+7.125, start[1]+5.75);call('commitRigDrag');history();
    for (const method of ['editRigJoint', 'commitRigDrag']) if (!mutations.has(method)) throw Error(`${name}: ${method} never changed a document`);
    if (previews < 3) throw Error(`${name}: insufficient live previews`);
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');
    console.log(`${name}: ${calls.length} steps, ${previews} live previews`);
  }
}
