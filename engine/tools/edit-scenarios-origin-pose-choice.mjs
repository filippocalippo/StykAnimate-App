// Legal spatial pose-choice/origin documents, built by Editor before Rust admission.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {open, documentOf, createObject, createFrame} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
import {animationRotation} from '../../src/animation-origin.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const shown = editor => JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame));
const read = name => JSON.parse(readFileSync(`${out}/${name}.document.json`, 'utf8'));
const presets = read('pose-presets').figure_types[0]._styk.poseChoices;
function make(kind, origin, joined) {
  const source = read('pose-choices'), figure = source.figure_types[0];
  if (joined) {
    const parent = documentOf([[[11, 0, 65, .4]]]).figure_types[0];parent.figure_type_id = 2;source.figure_types.push(parent);
    for (const frame of source.keyframes) Object.assign(frame, createFrame([...frame.objects, createObject(parent, 2, 220.125, 150.75), createObject(parent, 3, 310.25, 230.125)]));
  }
  const rigs = new Map(figure.segments.map(segment => [segment.segment_id, structuredClone(segment._stykRig)]).filter(([, rig]) => rig));
  const choices = new Map(figure.segments.map(segment => [segment.segment_id, structuredClone(segment._stykPoseChoice)]).filter(([, choice]) => choice));
  for (const segment of figure.segments) {delete segment._stykRig;delete segment._stykPoseChoice;}
  const handle = {...structuredClone(figure.segments[0]), segment_id: 99, parent_id: 0, length: 37.5, angle_rad: -.8, bend_rad: .275, name: 'Origin handle'};
  figure.segments.push(handle);
  for (const frame of source.keyframes) for (const object of frame.objects) if (object.figure_type_id === 1) object.angles.push(handle.angle_rad + .6);
  const editor = open(source);editor.select(1, -1);editor.setOrigin(99);editor.moveBuilderSegment(99, {beforeId: 1});
  if (origin === 'support') {editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === 1));editor.deleteSingleSegment();}
  for (const [id, rig] of rigs) {editor.select(1, editor.figure.segments.findIndex(segment => segment.segment_id === id));editor.setRigBehavior(rig);}
  if (kind !== 'presets') for (const segment of editor.figure.segments) if (choices.has(segment.segment_id)) segment._stykPoseChoice = choices.get(segment.segment_id);
  if (kind !== 'visibility') editor.figure._styk.poseChoices = structuredClone(presets);
  if (joined) {editor.select(1, -1);editor.joinTo(2, 11);editor.select(3, -1);editor.joinTo(1, 4);}
  editor.select(1, -1);editor.setFrameDuration(8);editor.duplicateFrame();editor.selectFrame(1);editor.select(1, -1);
  if (kind !== 'visibility') editor.setPoseChoice('Expression', 2);
  if (kind !== 'presets') editor.setPoseChoice('Eyes', 7);
  editor.selectFrame(0);
  const loaded = JSON.parse(mirror(editor));
  for (const frame of loaded.keyframes) for (const object of frame.objects) if (object._stykAnimationOrigin) {
    Object.assign(object._stykAnimationOrigin, {offsetX: 2.375, offsetY: -1.625, futureChoicePivot: {retained: [8, 3]}});
    for (const ghost of Object.values(object._stykAnimationOrigin.ghosts ?? {})) ghost.futureChoiceGhost = {retained: [7, 4]};
  }
  return loaded;
}
for (const kind of ['visibility', 'presets', 'mixed']) for (const joined of kind === 'mixed' ? [false, true] : [false]) for (const origin of ['layout', 'support']) for (const mode of ['native', 'sheet', 'autokey-sheet']) {
  const options = mode === 'native' ? {} : {layerTimeline: true, propertyChannels: true, autoKey: mode === 'autokey-sheet'};
  const name = `origin-pose-choice-${kind}-${origin}-${mode}${joined ? "-joined" : ""}`, document = `${name}.document.json`, loaded = mirror(open(make(kind, origin, joined), options));
  writeFileSync(`${out}/${document}`, loaded);
  const editor = open(JSON.parse(loaded), options);editor.autoKey = options.autoKey ?? false;
  const calls = [], changes = new Set();let previews = 0;
  const call = (...args) => {
    const before = mirror(editor), frame = shown(editor);calls.push(args);
    let result;try {result = editor[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));} catch (error) {throw Error(`${name} ${args[0]}: ${error.message}`, {cause: error});}
    if (before !== mirror(editor)) changes.add(args[0]);if (args[0] === 'setPoseChoice' && frame !== shown(editor)) previews++;
    calls.push(['@frame']);return result;
  };
  const fail = (...args) => {
    const before = mirror(editor), frame = shown(editor);calls.push(args);let error;
    try {editor[args[0]](...args.slice(1));} catch (caught) {error = caught;}
    if (error?.messageKey !== 'errors.editorSpatial.chooseAnAvailableRigPose' || before !== mirror(editor) || frame !== shown(editor)) throw Error(`${name}: invalid choice changed its frame or error (${error?.messageKey})`);
    calls.push(['@frame']);
  };
  const history = () => {call('undo');call('redo');};
  const inspect = () => {for (const tick of [0, 3.5, 8]) call('@seek', tick);};
  call('@select', 1, -1);call('setPoseChoice', 'Absent group', 2);
  for (const group of kind === 'visibility' ? ['Eyes'] : kind === 'presets' ? ['Expression'] : ['Expression', 'Eyes']) {
    const first = group === 'Eyes' ? 4 : 1, second = group === 'Eyes' ? 7 : 2;
    call('setPoseChoice', group, second);call('setPoseChoice', group, second);history();inspect();
    call('@seek', 3.5);call('beginDrag', 'Origin choice cancel');call('setPoseChoice', group, first);call('setPoseChoice', group, second);call('cancelDrag');
    call('beginDrag', 'Origin choice commit');call('setPoseChoice', group, first);call('setPoseChoice', group, second);call('commitDrag');history();inspect();
    call('beginDrag', 'Origin choice invalid');call('setPoseChoice', group, first);fail('setPoseChoice', group, 9999);call('cancelDrag');
    call('setPoseChoice', group, first);history();call('@seek', 1.25);call('setPoseChoice', group, second);history();
    if (group === 'Eyes') {call('setPoseChoice', group, 0);call('setPoseChoice', group, 10);history();}
    else fail('setPoseChoice', group, 0);
  }
  inspect();
  if (!changes.has('setPoseChoice') || previews < 4) throw Error(`${name}: insufficient choice mutations/live frames`);
  const object = editor.evaluatedFrame.objects[0], rotation = animationRotation(editor.figure, object), ordinary = object.angles[0] - editor.figure.segments[0].angle_rad;
  if (kind !== 'visibility' && rotation === ordinary) throw Error(`${name}: origin choice does not distinguish first-angle arithmetic`);
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor: options, steps: calls}, null, 1) + '\n');
  execFileSync(process.execPath, [fileURLToPath(new URL('./edit-replay.mjs', import.meta.url)), `${out}/${name}.scenario.json`, `${out}/${name}.reference.json`], {stdio: 'inherit'});
  console.log(`${name}: ${calls.length} steps, ${previews} changed choice frames`);
}

// The editor load is also the strict metadata oracle; validation never repairs it.
const schema = read('origin-pose-choice-mixed-support-native'), validation = [];
const bone = figure => figure.segments.find(segment => segment.segment_id === 4);
const first = figure => figure._styk.poseChoices[0].choices[0];
const second = figure => figure._styk.poseChoices[0].choices[1];
for (const [name, change] of [
  ['valid', () => {}],
  ['valid-bom-name', figure => {bone(figure)._stykPoseChoice.label = '\uFEFF Good';}],
  ['valid-nel-name', figure => {bone(figure)._stykPoseChoice.label = '\u0085';}],
  ['valid-80-utf16-name', figure => {bone(figure)._stykPoseChoice.label = '😀'.repeat(40);}],
  ['valid-repeated-visibility-label', figure => {figure.segments.find(segment => segment.segment_id === 7)._stykPoseChoice.label = bone(figure)._stykPoseChoice.label;}],
  ['visibility-null', figure => {bone(figure)._stykPoseChoice = null;}],
  ['visibility-extra', figure => {bone(figure)._stykPoseChoice.extra = true;}],
  ['visibility-empty-name', figure => {bone(figure)._stykPoseChoice.group = '\uFEFF\t ';}],
  ['visibility-82-utf16-name', figure => {bone(figure)._stykPoseChoice.label = '😀'.repeat(41);}],
  ['visibility-numeric-string', figure => {bone(figure)._stykPoseChoice.shown = '27';}],
  ['visibility-negative', figure => {bone(figure)._stykPoseChoice.hidden = -1;}],
  ['visibility-same-length', figure => {bone(figure)._stykPoseChoice.hidden = bone(figure)._stykPoseChoice.shown;}],
  ['visibility-zero-definition-length', figure => {bone(figure).length = 0;}],
  ['groups-null', figure => {figure._styk.poseChoices = null;}],
  ['groups-empty', figure => {figure._styk.poseChoices = [];}],
  ['group-extra', figure => {figure._styk.poseChoices[0].extra = true;}],
  ['group-name-collision', figure => {figure._styk.poseChoices[0].name = 'Eyes';}],
  ['choice-extra', figure => {first(figure).extra = true;}],
  ['choice-id-string', figure => {first(figure).id = '1';}],
  ['choice-id-fractional', figure => {first(figure).id = 1.5;}],
  ['choice-id-duplicate', figure => {second(figure).id = first(figure).id;}],
  ['choice-label-duplicate', figure => {second(figure).label = first(figure).label;}],
  ['choice-binding-signature', figure => {second(figure).angles.pop();}],
  ['choice-empty-bindings', figure => {first(figure).angles = [];first(figure).lengths = [];}],
  ['choice-pair-shape', figure => {first(figure).angles[0].push(1);}],
  ['choice-reference-string', figure => {first(figure).angles[0][0] = String(first(figure).angles[0][0]);}],
  ['choice-reference-ordinary', figure => {first(figure).angles[0][0] = 99;}],
  ['choice-reference-duplicate', figure => {first(figure).angles.push(first(figure).angles[0]);}],
  ['choice-value-null', figure => {first(figure).angles[0][1] = null;}],
  ['choice-value-nonfinite', figure => {first(figure).angles[0][1] = Infinity;}],
  ['choice-length-negative', figure => {first(figure).lengths[0][1] = -1;}],
]) {
  const document = structuredClone(schema);change(document.figure_types[0]);let caught;
  try {open(document);} catch (error) {caught = error;}
  const expected = name.startsWith('valid') ? null : name.startsWith('visibility-') ? 'errors.rigPoseChoices.aPoseChoiceNeedsASpatialBoneNames' : 'Invalid native rig pose choices.';
  const error = caught?.messageKey ?? caught?.message ?? null;
  if (error !== expected) throw Error(`choice schema ${name}: expected ${expected}, got ${error}`);
  validation.push({name, figure: document.figure_types[0], error, ...(name === 'choice-value-nonfinite' ? {specialNumber: 'Infinity'} : {})});
}
writeFileSync(`${out}/origin-pose-choice.validation.json`, JSON.stringify(validation) + '\n');
console.log(`origin choice schema: ${validation.length} actual load outcomes`);
