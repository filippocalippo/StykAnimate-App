// Actual saved native motion source/history lifecycle, recorded before Rust admission.
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
const folder = new URL('../tests/edit/', import.meta.url);
const cases = [];
for (const kind of ['layout', 'support']) {
  const name = `origin-motion-saved-${kind}-native`;
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder)));
  const editor = open(JSON.parse(readFileSync(new URL(scenario.document, folder))), scenario.editor);
  const initial = {revision: editor._revision, savedRevision: editor._savedRevision, revisionSerial: editor._revisionSerial};
  const history = [], states = [];
  let cancelledAllocations = 0, rewrites = 0, priorSources;
  scenario.steps.forEach(([method, ...args], index) => {
    if (method.startsWith('@') && !['@seek', '@select'].includes(method)) return;
    const revision = editor._revision, report = JSON.stringify(editor.report), allocated = editor._nextFrameIdentity;
    const session = editor._drag?.motionPath ? editor._drag : null;
    try {editor[method === '@seek' ? 'seek' : method === '@select' ? 'select' : method](...args);} catch (error) {
      if (method !== 'updateMotionPathEdit' || args[0]?.x !== 'invalid') throw error;
    }
    const command = editor._undo.at(-1);
    if (command && method === 'commitMotionPathEdit' && editor._revision !== revision) {
      if (command.kind !== 'animation' || command.structural !== false || command.timing !== true) throw Error(`${name}: unexpected history owner`);
      const copy = structuredClone(command), bytes = copy.bytes; delete copy.bytes;
      history.push({step: index + 1, bytes, command: copy});
    }
    if (method === 'cancelMotionPathEdit' && session?.draft?.sources && Object.keys(session.draft.sources).length) {
      if (editor._nextFrameIdentity !== allocated || JSON.stringify(editor.report) !== report) throw Error(`${name}: cancellation rewound allocations or published sources`);
      cancelledAllocations++;
    }
    const live = editor._drag?.motionPath ? editor._drag : null;
    const liveSources = live?.draft?.sources ? JSON.stringify(live.draft.sources) : null;
    const ids = live?.draft?.sources ? Object.keys(live.draft.sources) : [];
    if (method === 'updateMotionPathEdit' && priorSources?.ids.join(',') === ids.join(',') && priorSources.value !== liveSources && ids.length) rewrites++;
    priorSources = {ids, value: liveSources};
    const subs = live?.subs ?? (live ? [live] : []);
    states.push({step: index + 1, method,
      nextFrameIdentity: editor._nextFrameIdentity,
      generatedSources: [...editor._generatedFrameSources],
      sourceIds: Object.keys(editor.report._styk.frameSources ?? {}),
      uidCounts: [...editor._layerUidCounts].sort(([a], [b]) => a - b),
      liveSources,
      sourceOwners: subs.map(sub => [...sub.sourceIds]),
    });
  });
  if (history.length !== 4 || cancelledAllocations < 3 || rewrites < 1) throw Error(`${name}: incomplete source/history exercise (${history.length}/${cancelledAllocations}/${rewrites})`);
  cases.push({name, initial, cancelledAllocations, rewrites, history, states});
}
writeFileSync(new URL('origin-motion-native-saved-history.json', folder), JSON.stringify(cases) + '\n');
console.log(`${cases.length} saved native motion tapes; ${cases.reduce((n, entry) => n + entry.history.length, 0)} animation commands; ${cases.reduce((n, entry) => n + entry.states.length, 0)} internal lifecycle snapshots`);
