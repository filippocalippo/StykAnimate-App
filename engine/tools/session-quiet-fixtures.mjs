// Actual quiet editor outcomes for the single Session worker/ACK boundary.
import {createHash} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';

const folder = new URL('../tests/session-quiet/', import.meta.url);
mkdirSync(folder, {recursive: true});
Object.defineProperty(performance, 'now', {value: () => 0, configurable: true});
const json = value => JSON.stringify(value, (key, item) => key === 'runtime_segments' ? undefined : item);
const sha = text => createHash('sha256').update(text).digest('hex');
const plain = (value, depth = 4) => value === null || ['number', 'string', 'boolean'].includes(typeof value) ? value
  : value instanceof Set ? plain([...value], depth) : typeof value !== 'object' || depth <= 0 ? undefined
    : Array.isArray(value) ? value.map(item => plain(item, depth - 1)).filter(item => item !== undefined)
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item, depth - 1)]).filter(([, item]) => item !== undefined));
const entry = command => ({label: command.label, bytes: command.bytes,
  ...(command.commands ? {children: command.commands.map(entry)} : {})});
const calls = [['select', 1, -1], ['seek', 0], ['setFPS', 31], ['setFPS', 31], ['setFPS', 1.2],
  ['setCanvasSize', 720, 480], ['updateProject', {canvas_height: 490, fps: 29, canvas_width: 730}],
  ['updateProject', {future: true}], ['undo'], ['redo'], ['undo'], ['setFPS', 27], ['redo'],
  ['selectMany', [1]], ['setFPS', 24], ['undo'], ['redo'], ['seek', 2], ['select', 1, -1]];
let total = 0;
for (const mode of ['native', 'sheet', 'native-null', 'sheet-null', 'native-zero', 'sheet-zero']) {
  const sheet = mode.startsWith('sheet'), nullable = mode.endsWith('-null'), zero = mode.endsWith('-zero');
  const reference = JSON.parse(readFileSync(new URL(`../tests/edit/${sheet ? 'channels-figure-sheet' : 'move-native'}.reference.json`, import.meta.url), 'utf8'));
  const options = {...(sheet ? {layerTimeline: true, propertyChannels: true} : {}), historyLimit: zero ? 0 : 3, historyBytes: 48 * 1024 * 1024};
  const document = JSON.parse(reference.steps[0].document);
  Object.defineProperty(document, '__proto__', {value: {raw: 'unknown survives'}, enumerable: true});
  document.futureTop = {order: ['z', 'a'], missingIsAbsent: null};
  document.keyframes[0].objects[0].futurePose = {numbers: Array.from({length: 2500}, (_, i) => i + .125), text: '🦊'.repeat(4000)};
  const editor = open(document, options), events = [], steps = [];
  editor.addEventListener('change', event => events.push(plain(event.detail)));
  let previous;
  const capture = (call, result = null, error = null) => {
    const text = json(editor.report);
    let fields;
    if (call && ['setFPS', 'setCanvasSize', 'updateProject', 'undo', 'redo'].includes(call[0])) {
      fields = [];
      if (result === true && !error) {
        const command = call[0] === 'undo' ? editor._redo.at(-1) : editor._undo.at(-1);
        if (command?.kind === 'fields') fields = Object.entries(command[call[0] === 'undo' ? 'before' : 'after'])
          .map(([key, value]) => value === undefined ? {key, absent: true} : {key, value});
        else if (!['undo', 'redo'].includes(call[0])) fields = (events.find(event => event.projectFields)?.projectFields ?? [])
          .map(key => ({key, value: editor.report[key]}));
      }
    }
    steps.push({call, result: plain(result ?? null), error, documentSha: sha(text), ...(text !== previous ? {document: text} : {}),
      ...(fields ? {fields} : {}),
      state: {tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null,
        selectedUids: [...editor.selectedUids], selectedJoint: editor.selectedJoint ?? -1,
        canUndo: editor.canUndo, canRedo: editor.canRedo, undoLabel: editor.undoLabel, redoLabel: editor.redoLabel,
        dirty: editor.dirty, layerRevision: editor.layerRevision, nextFrameIdentity: editor._nextFrameIdentity, nextUid: editor._nextUid},
      selection: editor._selectionState(),
      history: {size: editor.historySize, undo: editor._undo.map(entry), redo: editor._redo.map(entry),
        revision: editor.revision, revisionSerial: editor._revisionSerial, savedRevision: editor._savedRevision}, events: [...events]});
    previous = text; events.length = 0;
  };
  capture(null);
  const caseCalls = nullable ? [['updateProject', {canvas_width: null}], ['setCanvasSize', 720, 480], ['undo'], ['redo'], ['setFPS', 33],
    ['updateProject', {canvas_height: null}], ['undo'], ['redo'], ['undo'], ['setCanvasSize', 760, 510], ['undo']]
    : zero ? [['setFPS', 31], ['undo'], ['setCanvasSize', 720, 480], ['redo'], ['setFPS', 31],
      ['updateProject', {canvas_height: 490, fps: 29, canvas_width: 730}], ['undo'], ['setFPS', 1.2], ['setCanvasSize', 0, 480], ['updateProject', {canvas_width: null}]] : calls;
  for (const call of caseCalls) {
    let result, error = null;
    try { result = editor[call[0]](...call.slice(1)); }
    catch (caught) { error = {message: caught.message, key: caught.messageKey ?? null}; }
    capture(call, result, error); total++;
  }
  writeFileSync(new URL(`${mode}.json`, folder), json({name: mode, options, steps}) + '\n');
}
console.log(`Six actual quiet Session traces / ${total} editor calls generated.`);
