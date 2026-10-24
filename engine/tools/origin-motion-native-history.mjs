// Native row-splice history oracle, captured from the existing editor before its Rust owner.
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
import {evaluatedFrame, timeline} from '../../src/pivot/geometry.mjs';
const folder = new URL('../tests/edit/', import.meta.url);
const cases = [], reads = [];
for (const kind of ['layout', 'offsets', 'support', 'support-pinned', 'support-free']) {
  const name = `origin-motion-${kind}-native`;
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder)));
  const editor = open(JSON.parse(readFileSync(new URL(scenario.document, folder))), scenario.editor);
  const initial = {revision: editor._revision, savedRevision: editor._savedRevision, revisionSerial: editor._revisionSerial};
  const history = [];
  scenario.steps.forEach(([method, ...args], index) => {
    if (method.startsWith('@') && !['@seek', '@select'].includes(method)) return;
    const revision = editor._revision;
    try {editor[method === '@seek' ? 'seek' : method === '@select' ? 'select' : method](...args);} catch {return;}
    const command = editor._undo.at(-1);
    if (command && method === 'commitMotionPathEdit' && editor._revision !== revision) {
      const copy = structuredClone(command), bytes = copy.bytes; delete copy.bytes;
      history.push({step: index + 1, bytes, command: copy});
    }
  });
  if (!history.some(entry => entry.command.kind === 'ranges' && entry.command.timing)) throw Error(`${name}: no recorded row split`);
  cases.push({name, initial, history});
  editor.addAnimationKeys([0, 8].map(tick => ({target: {kind: 'figure', uid: 3}, property: 'x', tick, value: 600 + 10 * tick, exactTarget: true, interpolation: 'linear'})));
  editor.seek(3.5);
  const rows = timeline(editor.report), index = rows.findLastIndex(row => row.start <= 3.5), row = rows[index];
  if (row.count !== 1) throw Error(`${name}: missing one-tick read boundary`);
  const shown = snapshotPoseFrame(editor.evaluatedFrame), raw = snapshotPoseFrame(evaluatedFrame(editor.report, index, (3.5 - row.start) / row.count, 3.5));
  if (shown.objects[2].root_x !== 635 || raw.objects[2].root_x !== 635 || JSON.stringify(shown) === JSON.stringify(raw)) throw Error(`${name}: fractional clock was lost or modes coincide`);
  reads.push({name, report: JSON.stringify(editor.report), tick: 3.5, shown: JSON.stringify(shown), raw: JSON.stringify(raw)});
}
writeFileSync(new URL('origin-motion-native-history.json', folder), JSON.stringify(cases) + '\n');
writeFileSync(new URL('origin-motion-native-reads.json', folder), JSON.stringify(reads) + '\n');
console.log(`${cases.length} native motion histories; ${cases.reduce((n, entry) => n + entry.history.length, 0)} recorded commands`);
