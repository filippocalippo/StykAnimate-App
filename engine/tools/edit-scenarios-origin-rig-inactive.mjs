// Inactive connector descriptors survive Editor.load and keep ordinary joint semantics.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
for (const [kind, value] of [['null', null], ['false', false], ['zero', 0]]) for (const mode of ['native', 'sheet', 'autokey-sheet']) {
  const source = JSON.parse(readFileSync(`${out}/origin-rig-pose-support-${mode}.document.json`, 'utf8'));
  const connector = source.figure_types[0].segments.find(segment => segment._stykRig?.connector);
  connector._stykRig.connector = value;
  const options = mode === 'native' ? {} : {layerTimeline: true, propertyChannels: true, autoKey: mode === 'autokey-sheet'};
  const name = `origin-rig-inactive-connector-${kind}-${mode}`, document = `${name}.document.json`;
  const loaded = mirror(open(source, options));writeFileSync(`${out}/${document}`, loaded);
  const editor = open(JSON.parse(loaded), options);editor.autoKey = options.autoKey ?? false;
  const calls = [];let changed = 0;
  const call = (...args) => {
    const before = mirror(editor);calls.push(args);
    editor[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));
    changed += before !== mirror(editor);calls.push(['@frame']);
  };
  const joint = editor.report.figure_types[0].segments.findIndex(segment => segment.segment_id === connector.segment_id);
  const tip = () => {const point = editor.geometry.objects.get(editor.selectedSlot).segments[editor.selectedJoint].end;return [point.x, point.y];};
  call('@select', 1, joint);call('@seek', 3.5);let start = tip();
  call('beginDrag', 'Inactive connector cancel');call('poseJoint', start[0]+18.125, start[1]-12.25, {stretch: true, snap: false});call('poseJoint', ...start, {snap: false});call('cancelDrag');
  start = tip();call('poseJoint', start[0]+9.125, start[1]+8.25, {stretch: true, snap: false});call('undo');call('redo');
  call('rotateJoint', .23);call('undo');call('redo');start = tip();call('bendJoint', start[0]-7.125, start[1]+11.25, {snap: false});call('undo');call('redo');
  call('slideConnector', 450.125, 250.25);call('setConnectorPosition', .7);
  for (const tick of [0, 3.5, 8]) call('@seek', tick);
  const shown = JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame));if (changed < 6 || !shown) throw Error(`${name}: no meaningful posing`);
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor: options, steps: calls}, null, 1) + '\n');
  console.log(`${name}: ${calls.length} steps, ${changed} document changes`);
}
