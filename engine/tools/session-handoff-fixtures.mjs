// Actual nonzero-revision/undo/redo ownership at Session worker handoff boundaries.
// The handoff marker only reads the existing editor; it never reconstructs history.
import {createHash} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';

const folder = new URL('../tests/session-handoff/', import.meta.url);
mkdirSync(folder, {recursive: true});
Object.defineProperty(performance, 'now', {value: () => 0, configurable: true});
const json = value => JSON.stringify(value, (key, item) => key === 'runtime_segments' ? undefined : item);
const sha = text => createHash('sha256').update(text).digest('hex');
const plain = (value, depth = 4) => {
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Set) return plain([...value], depth);
  if (typeof value !== 'object' || depth <= 0) return undefined;
  if (Array.isArray(value)) return value.map(item => plain(item, depth - 1)).filter(item => item !== undefined);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item, depth - 1)]).filter(([, item]) => item !== undefined));
};
const entry = command => ({kind: command.kind, label: command.label, bytes: command.bytes,
  ...(command.commands ? {children: command.commands.map(entry)} : {})});
let calls = 0, boundaries = 0;
for (const mode of ['native', 'sheet']) for (const family of ['fresh', 'undo', 'redo', 'saved', 'trimmed', 'pose']) {
  const reference = JSON.parse(readFileSync(new URL(`../tests/edit/${mode === 'native' ? 'move-native' : 'channels-figure-sheet'}.reference.json`, import.meta.url), 'utf8'));
  const options = {...(mode === 'sheet' ? {layerTimeline: true, propertyChannels: true} : {}),
    historyLimit: family === 'trimmed' ? 2 : 80, historyBytes: 48 * 1024 * 1024};
  const editor = open(JSON.parse(reference.steps[0].document), options);
  const events = [], steps = [];
  editor.addEventListener('change', event => events.push(plain(event.detail)));
  let previous;
  const capture = (call, result = null, error = null, boundary = null) => {
    const document = json(editor.report);
    steps.push({call, result: plain(result ?? null), error, ...(boundary ? {boundary} : {}),
      documentSha: sha(document), ...(document !== previous ? {document} : {}),
      selection: editor._selectionState(),
      state: {tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null,
        selectedUids: [...editor.selectedUids], selectedJoint: editor.selectedJoint ?? -1,
        dirty: editor.dirty, canUndo: editor.canUndo, canRedo: editor.canRedo,
        undoLabel: editor.undoLabel, redoLabel: editor.redoLabel,
        layerRevision: editor.layerRevision, nextFrameIdentity: editor._nextFrameIdentity, nextUid: editor._nextUid},
      history: {revision: editor.revision, revisionSerial: editor._revisionSerial, savedRevision: editor._savedRevision,
        size: editor.historySize, undo: editor._undo.map(entry), redo: editor._redo.map(entry)}, events: [...events]});
    previous = document; events.length = 0;
  };
  const run = call => {
    let result, error = null;
    try { result = editor[call[0]](...call.slice(1)); }
    catch (caught) { error = {message: caught.message, key: caught.messageKey ?? null}; }
    capture(call, result, error); calls++;
  };
  capture(null);
  if (family === 'pose') { run(['select', 1, -1]); run(['moveSelection', 7.125, -3.25]); run(['moveSelection', 2.5, 1.75]); }
  else if (family !== 'fresh') { run(['setFPS', 31]); run(['setFPS', 27]); }
  if (family === 'trimmed') { run(['setFPS', 33]); run(['setFPS', 29]); }
  if (family === 'redo') run(['undo']);
  if (family === 'saved') run(['markSaved']);
  const boundary = {kind: family === 'fresh' ? 'fresh-original-counters' : 'warm-preserve-or-refuse',
    revision: editor.revision, revisionSerial: editor._revisionSerial, savedRevision: editor._savedRevision,
    historySize: editor.historySize, limits: {count: editor.historyLimit, bytes: editor.historyBytes},
    undo: json(editor._undo), redo: json(editor._redo),
    pendingSourceBytes: editor._pendingSourceBytes, pendingSourceLayerChanges: plain(editor._pendingSourceLayerChanges),
    generatedSources: [...editor._generatedFrameSources], sourceTableWasPresent: editor._sourceTableWasPresent,
    options: {propertyChannels: editor.propertyChannels, layerTimeline: editor.layerTimeline, autoKey: Boolean(editor.autoKey)}};
  const before = json({report: editor.report, undo: editor._undo, redo: editor._redo, selection: editor._selectionState(), size: editor.historySize,
    revision: editor.revision, serial: editor._revisionSerial, saved: editor._savedRevision});
  capture(null, null, null, boundary); boundaries++;
  const after = json({report: editor.report, undo: editor._undo, redo: editor._redo, selection: editor._selectionState(), size: editor.historySize,
    revision: editor.revision, serial: editor._revisionSerial, saved: editor._savedRevision});
  if (before !== after) throw Error(`${mode}-${family}: reading handoff changed its owner`);
  if (family === 'fresh' && (editor.revision === 0 || editor._undo.length || editor._redo.length || editor.historySize !== 0))
    throw Error('Fresh loaded owner must preserve actual nonzero counters and empty history');
  if (family !== 'fresh') { run(['undo']); run(['redo']); run(['undo']); run(['setFPS', 26]); run(['redo']); }
  writeFileSync(new URL(`${mode}-${family}.json`, folder), json({name: `${mode}-${family}`, options, steps}) + '\n');
}
console.log(`12 actual Session handoff boundaries / ${calls} editor calls generated; warm owners unchanged by capture.`);
