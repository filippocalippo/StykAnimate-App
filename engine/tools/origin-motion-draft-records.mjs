// Actual transient native draft display. Keep insertion-order scalar keys while
// pose tracks sample their own sorted copy; no finalized document oracle changes.
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';
const folder = new URL('../tests/edit/', import.meta.url), entries = [];
for (const kind of ['layout', 'support']) {
  const name = `origin-motion-saved-${kind}-native`;
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder)));
  const editor = open(JSON.parse(readFileSync(new URL(scenario.document, folder))), scenario.editor);
  for (const [index, [method, ...args]] of scenario.steps.entries()) {
    if (method === '@frame') { editor.evaluatedFrame; continue; }
    if (method === '@motionFrame') {
      const session = editor._drag?.motionPath ? editor._drag : null;
      if (!session?.draft || !session.display) continue;
      const channels = structuredClone(session.draft.after.channels);
      const report = structuredClone({...editor.report, _styk: {...editor.report._styk,
        animation: session.draft.after, frameSources: {...editor.report._styk.frameSources, ...session.draft.sources}}});
      // A typed document projection is finalized, while the separately bound
      // actual live draft keeps its original order. Never finalize the editor.
      for (const channel of report._styk.animation.channels) channel.keys.sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)));
      entries.push({name, step: index + 1, tick: editor.tick, report, channels,
        frame: JSON.stringify(snapshotPoseFrame(session.display.frame))});
      continue;
    }
    try { editor[method === '@seek' ? 'seek' : method === '@select' ? 'select' : method](...args); }
    catch (error) { if (method !== 'updateMotionPathEdit' || args[0]?.x !== 'invalid') throw error; }
  }
}
if (!entries.some(entry => entry.channels.some(channel => channel.keys.some((key, i, keys) => i && key.tick < keys[i - 1].tick)))) throw Error('No transient insertion-order keys were recorded');
writeFileSync(new URL('origin-motion-draft-records.json', folder), JSON.stringify(entries) + '\n');
console.log(`${entries.length} actual native draft displays at fractional playheads`);
