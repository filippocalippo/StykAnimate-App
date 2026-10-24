// Remote-time origin gestures, recorded before their command admission opens.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {buildGeometry} from '../../src/pivot/geometry.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
const shown = editor => JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame));
const display = editor => JSON.stringify(snapshotPoseFrame((editor._drag?.motionPath ? editor._drag.display?.frame : null) ?? editor.evaluatedFrame));
const kinds = ['layout', 'offsets', 'support', 'support-pinned', 'support-free', 'saved-layout', 'saved-support'];
for (const kind of kinds) {
  const saved = kind.startsWith('saved-');
  for (const mode of [...(saved ? [] : ['native']), 'sheet', 'autokey-sheet']) {
    const source = saved ? `origin-channels-${kind}-sheet` : `origin-pose-${kind}-${mode === 'native' ? 'native' : 'sheet'}`;
    record(kind, mode, JSON.parse(readFileSync(`${out}/${source}.document.json`, 'utf8')));
  }
}
for (const [kind, folder] of [['saved-layout', 'channels-origin-native'], ['saved-support', 'channels-origin-support-native']]) {
  record(kind, 'native', JSON.parse(readFileSync(new URL(`../crates/styk-eval/tests/fixtures/records/${folder}/report.json`, import.meta.url), 'utf8')));
}

function record(kind, mode, input) {
  for (const frame of [...input.keyframes, ...Object.values(input._styk.frameSources ?? {})]) for (const object of frame.objects) {
    if (object.join) object.join.futurePathJoin = {retained: [7, 4]};
    if (!object._stykAnimationOrigin) {object.futurePathOrdinary = {retained: [8, 2]}; continue;}
    object._stykAnimationOrigin.futurePathPivot = {retained: [5, 9]};
    for (const ghost of Object.values(object._stykAnimationOrigin.ghosts ?? {})) ghost.futurePathGhost = {retained: [3, 6]};
  }
  const name = `origin-motion-${kind}-${mode}`, editor = mode === 'native' ? {} : {...app, autoKey: mode === 'autokey-sheet'}, document = `${name}.document.json`;
  const loaded = mirror(open(input, editor));writeFileSync(`${out}/${document}`, loaded);
  const planning = open(JSON.parse(loaded), editor);planning.autoKey = editor.autoKey ?? false;
  const calls = [], mutations = new Set();let previews = 0;
  const call = (...args) => {
    const before = mirror(planning), frame = display(planning);calls.push(args);
    const result = args[0] === '@frame' ? shown(planning) : planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));
    if (before !== mirror(planning)) mutations.add(args[0]);
    if (args[0] === 'updateMotionPathEdit' && frame !== display(planning)) previews++;
    calls.push(['@frame'], ['@motionFrame']);return result;
  };
  const point = () => {
    const session = planning._drag, frame = session.working, target = session.target;
    const slot = frame.objects.findIndex(object => object.unique_id === target.uid);
    const position = buildGeometry(planning.report, frame).objects.get(slot)?.joints.get(target.handleId);
    if (!position) throw Error(`${name}: no remote-time target point`);
    return {x: position.x, y: position.y};
  };
  const target = (uid, handleId) => {
    const object = planning.evaluatedFrame.objects.find(object => object.unique_id === uid), figure = planning.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
    return {kind: 'node', uid, handleId, joint: handleId === 0 ? -1 : figure.segments.findIndex(segment => Number(segment.segment_id) === handleId)};
  };
  const begin = (uid, handle, tick, options) => {
    if (!call('beginMotionPathEdit', target(uid, handle), tick, ...(options ? [options] : []))) throw Error(`${name}: begin refused`);
    return point();
  };
  const update = (start, dx, dy, options) => call('updateMotionPathEdit', {x: start.x + dx, y: start.y + dy}, ...(options ? [options] : []));
  const history = () => {call('undo');call('redo');};
  const inspect = () => {for (const tick of [0, 3.5, 8]) if (tick < planning.totalTicks) call('@seek', tick);};
  call('@select', 1, 1);call('@seek', 3.5);
  for (const tick of [-1, 3.5, planning.totalTicks]) if (call('beginMotionPathEdit', target(1, 44), tick) !== false) throw Error(`${name}: invalid tick accepted`);
  let start = begin(1, 44, 0, {label: 'Origin remote return'});update(start, 13.25, -8.125);update(start, 0, 0);call('cancelMotionPathEdit');
  start = begin(1, 44, 3, {label: 'Origin remote joint'});update(start, 11.125, -6.25, {isolate: true});update(start, 16.75, 9.125, {stretch: true});call('commitMotionPathEdit');history();inspect();
  call('@seek', 5);start = begin(2, 0, 5);update(start, 9.25, -12.5);call('commitMotionPathEdit');history();
  call('@seek', 4);start = begin(1, 0, 4);update(start, 8.125, -3.25, {movePins: false});update(start, 0, 0);call('cancelMotionPathEdit');
  start = begin(1, 0, 4);update(start, -5.75, 7.125);call('commitMotionPathEdit');history();
  start = begin(1, 44, 4, {falloff: {radius: 3, shape: 'smooth'}});update(start, 10.25, 6.125);call('motionPathFalloff');
  for (const shape of ['linear', 'sharp', 'flat']) {call('setMotionPathFalloff', {radius: 2, shape});call('motionPathFalloff');}
  call('setMotionPathFalloff', null);call('motionPathFalloff');call('cancelMotionPathEdit');
  start = begin(1, 44, 4, {falloff: {radius: 3, shape: 'sharp'}});update(start, -12.25, 9.375, {stretch: true});call('commitMotionPathEdit');history();inspect();
  if (kind.includes('-pinned') || kind.includes('-free')) {
    call('@seek', 5);start = begin(2, 66, 5);update(start, -17.25, 14.125);call('commitMotionPathEdit');history();
    start = begin(2, 66, 5, {falloff: {radius: 2, shape: 'linear'}});update(start, 5.125, -7.25);call('cancelMotionPathEdit');
  }
  call('@seek', 4);start = begin(1, 44, 4);update(start, 3.25, -2.125);
  const before = mirror(planning), frame = shown(planning), live = display(planning);calls.push(['updateMotionPathEdit', {x: 'invalid', y: start.y}]);let error;
  try {planning.updateMotionPathEdit({x: 'invalid', y: start.y});} catch (caught) {error = caught;}
  if (!error || before !== mirror(planning) || frame !== shown(planning) || live !== display(planning)) throw Error(`${name}: invalid preview was not atomic`);
  calls.push(['@frame'], ['@motionFrame']);call('cancelMotionPathEdit');call('commitMotionPathEdit');call('cancelMotionPathEdit');
  if (!mutations.has('commitMotionPathEdit') || previews < 3) throw Error(`${name}: gestures did not mutate document and live display`);
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');
  console.log(`${name}: ${calls.length} steps, ${previews} changed live previews`);
}
