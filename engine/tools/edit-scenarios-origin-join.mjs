// Single-frame origin joins: recorded errors, live drags, branch selection and redo drops.
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const out = fileURLToPath(new URL('../tests/edit', import.meta.url));
const app = {layerTimeline: true, propertyChannels: true};
const mirror = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value) + '\n';
for (const kind of ['layout', 'offsets', 'support', 'saved-layout', 'saved-support']) for (const mode of ['native', 'sheet', 'autokey-sheet']) {
  if (kind.startsWith('saved-') && mode === 'native') continue;
  const name = `origin-join-${kind}-${mode}`, document = `${name}.document.json`, editor = mode === 'native' ? {} : {...app, autoKey: mode === 'autokey-sheet'};
  const loaded = mirror(open(JSON.parse(readFileSync(`${out}/origin-range-${kind}-${mode}.document.json`, 'utf8')), editor));writeFileSync(`${out}/${document}`, loaded);
  const planning = open(JSON.parse(loaded), editor);planning.autoKey = editor.autoKey ?? false;
  const calls = [], mutations = new Set();
  const call = (...args) => {const before = mirror(planning);calls.push(args);const result = planning[args[0] === '@select' ? 'select' : args[0] === '@seek' ? 'seek' : args[0]](...args.slice(1));if (before !== mirror(planning)) mutations.add(args[0]);calls.push(['@frame']);return result;};
  const invalid = (...args) => {const before = mirror(planning), frame = JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame));calls.push(args);let error;try {planning[args[0]](...args.slice(1));} catch (caught) {error = caught;}if (!error || before !== mirror(planning) || frame !== JSON.stringify(snapshotPoseFrame(planning.evaluatedFrame))) throw Error(`${name}: invalid join changed document or frame`);calls.push(['@frame']);};
  const history = () => {call('undo');call('redo');};
  call('@seek', 3.5);call('@select', 2, 0);call('beginTranslationDrag');call('moveSelection', 8.25, -4.125);call('unjoinFigure');history();
  call('beginTranslationDrag');call('moveSelection', -3.75, 2.125);call('joinTo', 1, 22);history();
  call('joinTo', 1, 22);call('joinFigure', 1, 55);history();call('joinFigure', null);history();
  call('undo');call('joinTo', 1, 22);call('redo');
  call('@select', 1, -1);call('beginTranslationDrag');call('moveSelection', 6.125, -2.75);
  invalid('joinTo', 1, 22);invalid('joinTo', 2, 22);invalid('joinFigure', 999, 0);invalid('joinTo', 2, 999);call('cancelDrag');
  call('@select', 2, -1);call('beginTranslationDrag');call('moveSelection', -2.125, 1.375);call('cancelDrag');call('joinFigure', 1, 55);history();
  call('@select', null, -1);call('joinTo', 1, 22);call('unjoinFigure');call('joinFigure', null);
  for (const method of ['joinTo', 'joinFigure', 'unjoinFigure']) if (!mutations.has(method)) throw Error(`${name}: ${method} never mutated`);
  writeFileSync(`${out}/${name}.scenario.json`, JSON.stringify({name, document, editor, steps: calls}, null, 1) + '\n');console.log(`${name}: ${calls.length} steps`);
}
