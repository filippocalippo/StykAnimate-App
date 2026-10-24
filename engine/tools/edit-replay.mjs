#!/usr/bin/env node
// Command-replay harness, JavaScript side (docs/engine/editing.md): runs a scenario's
// editor calls in the real JavaScript Editor and records, after every step, what a
// port must reproduce: the document's bytes, the selection, the playhead, history and
// the change events the interface listens to.
//
//   node engine/tools/edit-replay.mjs <scenario.json> <reference.json>
//   node engine/tools/edit-replay.mjs --all [--out <folder>]   # every scenario in engine/tests/edit/
//
// A scenario: {"name", "document": <path relative to the scenario | inline document>,
// "editor": {"propertyChannels", "layerTimeline", "autoKey"}, "steps": [["method", ...arguments], …]}.
// Optional observeFigureClipboardPastes:true records the existing clipboard counter
// before/after each call and at each change event, outside the ordinary state/events.
// A step may also be ["@batch", label, [steps]] (the steps inside one movieclipBatch), or
// ["@frame"] (a saved pose snapshot), ["@seek", tick] or ["@select", uid, joint] (the same as the method
// calls, spelled out for readability). The document recorded is the editor's in-memory
// report as the engine's mirror receives it (`JSON.stringify(editor.report)` without the
// `runtime_segments` caches): phase 1 ports start from the loaded report, not the file.
import './v8-pin.mjs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import {captureEditBounds} from '../../src/engine/engine-edit-bounds.mjs';
import {recordedBounds} from './edit-bounds-callbacks.mjs';
import {nativePropertyReplay} from './edit-native-property.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const repoUrl = pathToFileURL(repo).href;
const {Editor} = await import(`${repoUrl}/src/editor.mjs`);
const {withDraws} = await import(`${repoUrl}/src/editor-draws.mjs`);
const {cameraAtTime} = await import(`${repoUrl}/src/camera-motion.mjs`);

const sha = text => createHash('sha256').update(text).digest('hex');
/** The report without the derived pose caches, as the engine's document holds it. */
const reportJSON = editor => JSON.stringify(editor.report, (key, value) => key === 'runtime_segments' ? undefined : value);
/** Event details as plain data: numbers, strings, booleans, arrays and objects of them. */
const plain = (value, depth = 4) => {
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Set) return plain([...value], depth);
  if (typeof value !== 'object' || depth <= 0) return undefined;
  if (Array.isArray(value)) return value.map(item => plain(item, depth - 1)).filter(item => item !== undefined);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item, depth - 1)]).filter(([, item]) => item !== undefined));
};

/** `{"@array": [...], key: value}` in a step's arguments: an array carrying properties, as the
 * app's frame ranges on a layer sheet carry `sheetTicks` (JSON drops them; the shadow facade
 * sends them the same way). */
const decode = value => Array.isArray(value) ? value.map(decode) : value === null || typeof value !== 'object' ? value
  : recordedBounds(value) ?? (Object.hasOwn(value, '@array') ? Object.assign(decode(value['@array']), Object.fromEntries(Object.entries(value).filter(([key]) => key !== '@array')))
  : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)])));

export function replay(scenario, base = repo) {
  const document = typeof scenario.document === 'string' ? JSON.parse(readFileSync(path.resolve(base, scenario.document), 'utf8')) : structuredClone(scenario.document);
  const {autoKey = false, ...options} = scenario.editor ?? {};
  const editor = new Editor({demo: false, ...options}).load(document, scenario.name ?? 'Scenario');
  // The app sets this from its settings (src/app.mjs): every edited track keys the playhead.
  editor.autoKey = autoKey;
  const events = [], clipboardEvents = [];
  const observeClipboard = scenario.observeFigureClipboardPastes === true;
  const clipboard = () => editor._selectionClipboard ?? editor._figureClipboard;
  const clipboardPastes = () => clipboard()?.pastes ?? null;
  // The editor dispatches every change as one 'change' event whose detail names its kind.
  editor.addEventListener('change', event => {
    events.push(plain(event.detail ?? null));
    if (observeClipboard) clipboardEvents.push(clipboardPastes());
  });
  const state = () => ({
    tick: editor.tick, frameIndex: editor.frameIndex,
    selectedUid: editor.selectedUid ?? null, selectedUids: [...(editor.selectedUids ?? [])], selectedJoint: editor.selectedJoint ?? -1,
    canUndo: editor.canUndo, canRedo: editor.canRedo, undoLabel: editor.undoLabel, redoLabel: editor.redoLabel, dirty: editor.dirty,
    // Runtime counters the document does not carry: events name the layer revision, new
    // pose sources take the next frame identity and new figures the next unique id.
    layerRevision: editor.layerRevision, nextFrameIdentity: editor._nextFrameIdentity, nextUid: editor._nextUid,
    ...Object.fromEntries(Object.entries(editor._selectionState()).filter(([key]) => ['polygonSelection', 'segmentIds', 'branch'].includes(key))),
  });
  let previous = reportJSON(editor);
  const steps = [{step: 0, call: null, state: state(), documentSha: sha(previous), document: previous, events: [],
    ...(observeClipboard ? {figureClipboardPastes: {before: clipboardPastes(), after: clipboardPastes(), events: [], sameClipboard: true}} : {})}];
  // ["@batch", label, steps]: the steps inside one `movieclipBatch`, as the timeline runs
  // several commands; recorded as one step, returning the last step's result.
  let measured = null;
  const nativeProperty = nativePropertyReplay(editor);
  const run = ([name, ...args]) => {
    if (name === '@frame') return JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame));
    if (name === '@motionFrame') return JSON.stringify(snapshotPoseFrame((editor._drag?.motionPath ? editor._drag.display?.frame : null) ?? editor.evaluatedFrame));
    if (name === '@selection') return JSON.stringify(editor._selectionState());
    if (name === '@restoreSelection') return editor._restoreSelection(args[0]);
    // Read the existing camera owner, including follow travel, without view changes.
    if (name === '@cameraAtTime') return cameraAtTime(editor.report, editor.evaluatedFrame);
    if (name.startsWith('@native')) return nativeProperty(name, args.map(decode));
    if (name === '@batch') {
      let last;
      try { return editor.movieclipBatch(args[0], () => { for (const step of args[1]) last = run(step); return last; }); }
      finally { measured = null; } // Nested tapes are not a top-level call's argument list.
    }
    const decoded = args.map(decode), capture = captureEditBounds(name, decoded, editor);
    measured = capture;
    return editor[name === '@seek' ? 'seek' : name === '@select' ? 'select' : name](...(capture?.args ?? decoded));
  };
  // What the editor draws at random comes from a fixed sequence, and each step records it
  // (`draws`) for the engine to be handed the same values (D18).
  let drawn = 0;
  const source = kind => {
    drawn++;
    // Not the pattern the fixture generators and the app driver draw with: documents made by them keep their identities.
    if (kind === 'uuid') return `d0d0d0d0-0000-4000-8000-${String(drawn).padStart(12, '0')}`;
    const bits = Math.imul(drawn, 0x9e3779b1) >>> 0;
    return kind === 'seed' ? bits : bits / 2 ** 32;
  };
  scenario.steps.forEach((call, index) => {
    events.length = 0;
    clipboardEvents.length = 0;
    const beforeClipboard = observeClipboard ? clipboard() : null;
    const beforePastes = observeClipboard ? clipboardPastes() : null;
    measured = null;
    let result, error = null, draws = [];
    try { ({result, draws} = withDraws(() => run(call), source)); }
    catch (caught) { error = {message: caught.message, key: caught.messageKey ?? null}; draws = caught?.draws ?? []; }
    const text = reportJSON(editor);
    const boundsArgs = measured?.payload();
    steps.push({step: index + 1, call, ...(boundsArgs ? {boundsArgs: JSON.parse(boundsArgs)} : {}), ...(draws.length ? {draws} : {}), result: plain(result ?? null), error, state: state(), documentSha: sha(text), ...(text !== previous ? {document: text} : {}), events: events.slice(),
      ...(observeClipboard ? {figureClipboardPastes: {before: beforePastes, after: clipboardPastes(), events: clipboardEvents.slice(), sameClipboard: clipboard() === beforeClipboard}} : {})});
    previous = text;
  });
  return {scenario: scenario.name, editor: scenario.editor ?? {}, steps};
}

const args = process.argv.slice(2);
if (args[0] === '--all') {
  const folder = path.join(repo, 'engine/tests/edit');
  const outAt = args.indexOf('--out'), out = outAt >= 0 ? path.resolve(args[outAt + 1]) : folder;
  mkdirSync(out, {recursive: true});
  for (const name of existsSync(folder) ? readdirSync(folder).filter(file => file.endsWith('.scenario.json')).sort() : []) {
    const scenario = JSON.parse(readFileSync(path.join(folder, name), 'utf8'));
    const reference = replay(scenario, folder);
    writeFileSync(path.join(out, name.replace('.scenario.json', '.reference.json')), JSON.stringify(reference) + '\n');
    const changed = reference.steps.filter(step => step.document && step.step > 0).length, failed = reference.steps.filter(step => step.error).length;
    console.log(`${scenario.name}: ${reference.steps.length - 1} steps, ${changed} changed the document, ${failed} refused`);
  }
} else if (args.length === 2) {
  const scenario = JSON.parse(readFileSync(args[0], 'utf8'));
  writeFileSync(args[1], JSON.stringify(replay(scenario, path.dirname(path.resolve(args[0])))) + '\n');
} else {
  console.error('usage: node engine/tools/edit-replay.mjs <scenario.json> <reference.json> | --all [--out <folder>]');
  process.exit(2);
}
