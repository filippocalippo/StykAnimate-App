// Actual-editor origin angle-lock/reference recordings precede Rust admission.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const shown = editor => JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame));
for (const kind of ['layout', 'offsets', 'support', 'saved-layout', 'saved-support']) {
  const saved = kind.startsWith('saved-');
  for (const mode of [...(saved ? [] : ['native']), 'sheet', 'autokey-sheet']) {
    const input = JSON.parse(readFileSync(`${out}/origin-rig-${kind}-${mode}.document.json`, 'utf8'));
    for (const figure of input.figure_types) {
      const staticParent = figure.segments.find(segment => segment.segment_id === 44);
      if (staticParent) staticParent.aux_code |= 1;
    }
    const editor = mode === 'native' ? {} : {...app, autoKey: mode === 'autokey-sheet'};
    const name = `origin-angle-lock-${kind}-${mode}`, document = `${name}.document.json`;
    const loaded = mirror(open(input, editor));writeFileSync(`${out}/${document}`, loaded);
    const planning = open(JSON.parse(loaded), editor);planning.autoKey = editor.autoKey ?? false;
    const calls = [], mutations = new Map(), errors = new Set();
    const call = (...args) => {
      const before = mirror(planning);calls.push(args);
      let result;
      try {result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));}
      catch (error) {throw Error(`${name} ${args[0]}: ${error.message}`, {cause: error});}
      if (before !== mirror(planning)) mutations.set(args[0], (mutations.get(args[0]) ?? 0) + 1);
      calls.push(['@frame']);return result;
    };
    const fail = (key, ...args) => {
      const before = mirror(planning), frame = shown(planning);calls.push(args);
      let caught;try {planning[args[0]](...args.slice(1));} catch (error) {caught = error;}
      if (caught?.messageKey !== key || before !== mirror(planning) || frame !== shown(planning)) throw Error(`${name}: ${args[0]} failed to preserve its frame or error (${caught?.messageKey})`);
      errors.add(key);calls.push(['@frame']);
    };
    const select = (handle, uid = 1) => {
      const object = planning.evaluatedFrame.objects.find(object => object.unique_id === uid), figure = planning.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
      call('@select', uid, figure.segments.findIndex(segment => segment.segment_id === handle));
    };
    const history = () => {call('undo');call('redo');};
    const inspect = () => {for (const tick of [0, 3.5, 8]) call('@seek', tick);};
    select(55);call('@seek', 3.5);
    call('beginTranslationDrag');call('moveSelection', 7.125, -4.25);call('setAngleLock', 'figure');history();inspect();
    call('setAngleLock', 'figure');call('setAngleLock', 'world');
    fail('errors.editorRigConstraints.chooseAParentAngleLockFirst', 'setSecondaryAngleReference', 33);
    call('setAngleLock', 'parent');
    if (planning.figure.segments[planning.selectedJoint]._stykRig.angleLock.reference !== 22) throw Error(`${name}: parent lock did not skip its static parent`);
    call('setSecondaryAngleReference', 33);history();inspect();
    call('setRigBehavior', {angleLock: {space: 'authored', multiplier: -.375, futureAngleMetadata: {retained: [7, 2]}}});
    call('@seek', 3.5);call('setSecondaryAngleReference', 33);history();inspect();
    call('setRigBehavior', {angleLock: {space: 'rendered', multiplier: .625, secondary: {reference: 33, restAngle: -.375, multiplier: -.25, futureSecondaryMetadata: {retained: [6, 8]}}}});
    call('@seek', 1.25);call('setSecondaryAngleReference', 0);call('setSecondaryAngleReference', 33);history();
    fail('errors.editorRigConstraints.chooseAnExistingSecondAngleReference', 'setSecondaryAngleReference', 9999);
    fail('errors.editorRigConstraints.chooseAnExistingSecondAngleReference', 'setSecondaryAngleReference', '33');
    fail('errors.rigConstraints.thisRigWouldDependOnItselfChooseAnchors', 'setSecondaryAngleReference', 66);
    fail('errors.rigConstraints.chooseAValidAngleLock', 'setAngleLock', 'unknown');
    fail('errors.cameraMotion.mustBeBetweenAnd', 'setRigBehavior', {angleLock: {multiplier: 11}});
    call('setAngleLock', 'off');call('setAngleLock', 'off');history();
    select(33);fail('errors.editorRigConstraints.thisJointHasNoMovableParentUseWorld', 'setAngleLock', 'parent');
    call('setAngleLock', 'world');history();call('setAngleLock', 'off');
    select(saved ? 33 : 55, 2);call('setAngleLock', 'figure');history();inspect();
    call('setAngleLock', 'parent');call('setSecondaryAngleReference', saved ? 11 : 33);history();inspect();call('setAngleLock', 'off');history();
    select(55);call('setAngleLock', 'figure');call('setRigBehavior', {angleLock: {space: 'authored', multiplier: -.5}});history();inspect();call('setAngleLock', 'off');
    call('beginTranslationDrag');call('moveSelection', -3.125, 5.75);
    const undo = planning._undo.length;calls.push(['setRigBehavior', {angleLock: {mode: 'figure', angle: 0, restAngle: 0, multiplier: 11}}]);
    let invalid;try {planning.setRigBehavior({angleLock: {mode: 'figure', angle: 0, restAngle: 0, multiplier: 11}});} catch (error) {invalid = error;}
    if (invalid?.messageKey !== 'errors.cameraMotion.mustBeBetweenAnd' || planning.dragging || planning._undo.length !== undo + 1) throw Error(`${name}: invalid proposed rig did not commit the existing translation first`);
    calls.push(['@frame']);history();inspect();
    for (const method of ['setAngleLock', 'setSecondaryAngleReference', 'setRigBehavior']) if (!mutations.has(method)) throw Error(`${name}: ${method} never changed a document`);
    if (errors.size < 5) throw Error(`${name}: insufficient invalid/reference coverage`);
    writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');
    execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${out}/${name}.scenario.json`, `${out}/${name}.reference.json`], {stdio: 'inherit'});
    console.log(`${name}: ${calls.length} steps, mutations ${JSON.stringify([...mutations])}, ${errors.size} distinct failures`);
  }
}
