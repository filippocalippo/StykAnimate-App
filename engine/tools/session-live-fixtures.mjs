// Actual editor lifecycle/working-head evidence for the canonical Session worker.
// Transport phases are tested separately; these traces preserve command outcomes.
import {createHash} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';

const folder = new URL('../tests/session-live/', import.meta.url);
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
function seed(mode) {
  const source = mode === 'sheet' ? 'channels-figure-sheet' : 'move-native';
  const reference = JSON.parse(readFileSync(new URL(`../tests/edit/${source}.reference.json`, import.meta.url), 'utf8'));
  const options = mode === 'sheet' ? {layerTimeline: true, propertyChannels: true}
    : mode === 'native-channels' ? {propertyChannels: true} : {};
  const initial = open(JSON.parse(reference.steps[0].document), options);
  if (mode === 'native-channels') {
    initial.setFrameDuration(12);
    initial.addAnimationKeys([{target: {kind: 'figure', uid: 1}, property: 'x', tick: 0, value: 300},
      {target: {kind: 'figure', uid: 1}, property: 'x', tick: 6, value: 340}]);
  }
  initial.createLayer('Destination');
  return {editor: open(JSON.parse(json(initial.report)), options), options};
}
function recorder(editor) {
  const events = [], steps = [], identities = new WeakMap();
  let nextIdentity = 1, previousDocument, previousFrame;
  const identity = value => {
    if (!value || typeof value !== 'object') return null;
    if (!identities.has(value)) identities.set(value, nextIdentity++);
    return identities.get(value);
  };
  editor.addEventListener('change', event => events.push(plain(event.detail)));
  const capture = (call, result = null, error = null, progress = []) => {
    const frame = editor.evaluatedFrame;
    const display = editor._drag?.motionPath?.display?.frame ?? frame;
    const document = json(editor.report), frameText = json(display);
    steps.push({call, result: plain(result ?? null), error,
      documentSha: sha(document), ...(document !== previousDocument ? {document} : {}),
      frameSha: sha(frameText), ...(frameText !== previousFrame ? {frame: frameText} : {}),
      state: {tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null,
        selectedUids: [...editor.selectedUids], selectedJoint: editor.selectedJoint ?? -1,
        canUndo: editor.canUndo, canRedo: editor.canRedo, undoLabel: editor.undoLabel, redoLabel: editor.redoLabel,
        dirty: editor.dirty, layerRevision: editor.layerRevision, nextFrameIdentity: editor._nextFrameIdentity, nextUid: editor._nextUid},
      selection: editor._selectionState(),
      history: {size: editor.historySize, undo: editor._undo.map(entry), redo: editor._redo.map(entry),
        revision: editor.revision, revisionSerial: editor._revisionSerial, savedRevision: editor._savedRevision},
      live: {drag: Boolean(editor._drag), authored: Boolean(editor._authoredPoseEdit), animationEdit: Boolean(editor._animationEdit),
        changed: Boolean(editor._drag?.changed || editor._animationEdit?.changed),
        identities: {report: identity(editor.report), animation: identity(editor.report._styk?.animation),
          sheet: identity(editor.report._styk?.layerSheet), nativeFrame: identity(editor.report.keyframes[editor.frameIndex]),
          authoredFrame: identity(editor._authoredPoseEdit?.frame), evaluatedFrame: identity(frame), displayFrame: identity(display)}},
      events: [...events], progress});
    events.length = 0; previousDocument = document; previousFrame = frameText;
  };
  const run = async call => {
    let result, error = null;
    try { result = await editor[call[0]](...call.slice(1)); }
    catch (caught) { error = {message: caught.message, key: caught.messageKey ?? null, name: caught.name}; }
    capture(call, result, error);
  };
  capture(null);
  return {steps, capture, run};
}
let calls = 0, files = 0;
async function record(mode, gesture, outcome) {
  const {editor, options} = seed(mode), trace = recorder(editor);
  const name = `${mode}-${gesture}-${outcome}`;
  await trace.run(['select', 1, -1]);
  if (gesture === 'drag') {
    await trace.run(['beginDrag', 'Worker gesture']);
    await trace.run(['moveSelection', 7.125, -3.25]);
    await trace.run(['moveSelection', 2.5, 1.75]);
  } else {
    await trace.run(['beginAnimationEdit', {kind: 'figure', uid: 1}, 'x']);
    await trace.run(['previewAnimationEdit', 321.125]);
    await trace.run(['previewAnimationEdit', 322.25]);
    const first = trace.steps[2], preview = trace.steps[3];
    if (first.history.revision !== preview.history.revision || first.history.size !== preview.history.size)
      throw Error(`${name}: property preview unexpectedly recorded history`);
    if (mode === 'native-channels' && first.documentSha === preview.documentSha)
      throw Error(`${name}: native scalar working report mutation was lost`);
    if (mode === 'sheet' && (first.documentSha !== preview.documentSha || first.frameSha === preview.frameSha))
      throw Error(`${name}: sheet property must change only the display pose`);
  }
  const end = gesture === 'drag' ? 'commitDrag' : 'commitAnimationEdit';
  const cancel = gesture === 'drag' ? 'cancelDrag' : 'cancelAnimationEdit';
  if (outcome === 'error') {
    await trace.run(gesture === 'drag' ? ['moveSelection', 'invalid', 0] : ['previewAnimationEdit', 'invalid']);
    if (!trace.steps.at(-1).error) throw Error(`${name}: invalid update did not refuse`);
    await trace.run([cancel]);
  } else if (outcome === 'cancel') await trace.run([cancel]);
  else if (outcome === 'replace') {
    await trace.run(gesture === 'drag' ? ['beginDrag', 'Replacement gesture'] : ['beginAnimationEdit', {kind: 'figure', uid: 1}, 'y']);
    await trace.run(gesture === 'drag' ? ['moveSelection', -1.25, 2.125] : ['previewAnimationEdit', 180.75]);
    await trace.run([end]);
  } else if (outcome === 'seek') {
    await trace.run(['seek', 3]);
    // Seek commits a drag; native scalar preview remains live until its actual owner ends.
    await trace.run([end]);
  } else await trace.run([end]);
  await trace.run(['undo']); await trace.run(['redo']);
  await trace.run(['undo']);
  await trace.run(['select', 1, -1]);
  await trace.run(['moveSelection', 1.125, -0.875]);
  await trace.run(['redo']);
  calls += trace.steps.length - 1; files++;
  writeFileSync(new URL(`${name}.json`, folder), json({name, options, gesture, outcome,
    historyLimits: {count: editor.historyLimit, bytes: editor.historyBytes}, steps: trace.steps}) + '\n');
}
for (const mode of ['native', 'native-channels', 'sheet'])
  for (const outcome of mode === 'native' ? ['commit', 'cancel', 'error', 'seek', 'replace'] : ['commit', 'cancel', 'error'])
    await record(mode, 'drag', outcome);
for (const mode of ['native-channels', 'sheet'])
  for (const outcome of mode === 'sheet' ? ['commit', 'cancel'] : ['commit', 'cancel', 'error', 'replace', 'seek'])
    await record(mode, 'property', outcome);
for (const outcome of ['cancel-before', 'cancel-during', 'stale-during', 'noop', 'invalid-target']) {
  const {editor, options} = seed('native-channels'), trace = recorder(editor);
  const name = `native-channels-property-preflight-${outcome}`;
  await trace.run(['select', 1, -1]);
  await trace.run(['beginAnimationEdit', {kind: 'figure', uid: 1}, 'x']);
  await trace.run(['previewAnimationEdit', 321.125]);
  const controller = new AbortController(), progress = [];
  if (outcome === 'cancel-before' || outcome === 'noop') controller.abort();
  let plannerCalls = 0, result, error = null;
  const planMigration = async () => {
    plannerCalls++;
    if (outcome === 'cancel-during') controller.abort();
    if (outcome === 'stale-during') editor.renameLayer('layer-2', 'Changed during scalar migration');
    return null;
  };
  const target = outcome === 'noop' ? 'layer-1' : outcome === 'invalid-target' ? 'missing-layer' : 'layer-2';
  try { result = await editor.assignFiguresToLayerAsync([1], target,
    {signal: controller.signal, planMigration, onProgress: value => progress.push(value)}); }
  catch (caught) { error = {message: caught.message, key: caught.messageKey ?? null, name: caught.name}; }
  trace.capture(['assignFiguresToLayerAsync', [1], target, {outcome}], result, error, progress);
  const publication = trace.steps.at(-1);
  if (publication.live.animationEdit || publication.live.drag || publication.history.undo.length === 0)
    throw Error(`${name}: async preflight must publish its committed scalar prefix`);
  if (outcome === 'noop' && (result !== false || error)) throw Error(`${name}: aborted native noop must return false`);
  if (outcome === 'cancel-before' && plannerCalls !== 0) throw Error(`${name}: pre-aborted planning ran`);
  await trace.run(['undo']); await trace.run(['redo']);
  calls += trace.steps.length - 1; files++;
  writeFileSync(new URL(`${name}.json`, folder), json({name, options, gesture: 'property', outcome,
    plannerCalls, historyLimits: {count: editor.historyLimit, bytes: editor.historyBytes}, steps: trace.steps}) + '\n');
}
console.log(`${files} actual live Session lifecycle recordings / ${calls} editor calls generated.`);
