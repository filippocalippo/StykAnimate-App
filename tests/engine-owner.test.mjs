// The engine owning the document (D19): every recorded tape gives the document, selection, change
// events and history the recording says, after every step and after undoing everything. The recordings
// (engine/tests/edit/*.reference.json) are the oracle; the owner checks the engine's own document
// against the read view after every call.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {withDraws} from '../src/editor-draws.mjs';
import {holdsRevision, registeredEngine} from '../src/engine/engine-open.mjs';
import {cameraAtTime} from '../src/camera-motion.mjs';
import {hasPinnedIK} from '../src/ik.mjs';
import {sampleMotionPath} from '../src/motion-path.mjs';
import {snapshotPoseFrame} from '../src/pose-snapshot.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';
import {recordedBounds} from '../engine/tools/edit-bounds-callbacks.mjs';

const folder = new URL('../engine/tests/edit/', import.meta.url);
const json = value => JSON.stringify(value, (key, item) => key === 'runtime_segments' || key === '_movieclipSample' ? undefined : item);
const frameText = frame => { const {object_count, ...rest} = frame ?? {}; return json(rest); };
const state = editor => ({tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null,
  selectedUids: [...editor.selectedUids], selectedJoint: editor.selectedJoint ?? -1, canUndo: editor.canUndo, canRedo: editor.canRedo,
  undoLabel: editor.undoLabel, redoLabel: editor.redoLabel, dirty: editor.dirty});
/** What the interface reads of an open motion-path edit (the trails sample `report` over `range`,
 * the arc's overlay and the pinned-origin modifier read the rest), as text; `null` with none open. */
const motionState = (editor, text) => {
  const drag = editor._drag;
  if (!drag?.motionPath) return 'null';
  const {kind, uid, handleId, joint} = drag.target, arc = editor.motionPathFalloff();
  const own = drag.report === editor.report;
  return text({target: {kind, uid, handleId, joint}, tick: drag.tick, falloff: drag.falloff ?? null, moved: Boolean(drag.moved), range: drag.range,
    pinned: (drag.grab?.baseline ?? drag.baseline).some(hasPinnedIK), arc: arc && {...arc, changed: [...arc.changed]},
    report: own ? 'the document' : drag.report, reported: editor.motionPathReport() === drag.report});
};
/** What the interface reads of an open figure-handle, Handle Edit Mode or segment-value gesture (the stage's
 * pivot marker reads the transform's origin; the segment-values dialog the options), as text; `null` with none open. */
const handleState = (editor, text) => {
  const drag = editor._drag;
  if (!drag || drag.motionPath) return 'null';
  const {figureHandle: figure, handleEdit: edit, segmentValueOptions: options} = drag;
  return text({figureHandle: figure && {uid: figure.uid, rotate: figure.rotate, scale: figure.scale, transform: figure.transform},
    handleEdit: edit && {uid: edit.uid, index: edit.index, point: edit.point, bend: edit.bend}, segmentValueOptions: options});
};
// The app's bounds callback is the only function the owner can take (the engine measures for itself); the
// other recorded callbacks are functions it refuses.
const decode = value => Array.isArray(value) ? value.map(decode) : value === null || typeof value !== 'object' ? value
  : Object.hasOwn(value, '@boundsCallback') ? recordedBounds(value) : Object.hasOwn(value, '@array') ? Object.assign(decode(value['@array']), Object.fromEntries(Object.entries(value).filter(([key]) => key !== '@array')))
  : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
/** Change events as the interface sees them: the recording keeps what the editor emitted when it emitted it, the
 * owner emits them once the playhead is where the call left it (so the playhead's own fields are not compared),
 * and a flag that is off is the same as one that is missing. */
const eventText = events => JSON.stringify(events.map(event => Object.fromEntries(Object.entries(event ?? {}).filter(([key, value]) => value !== false && key !== 'tick' && key !== 'frameIndex'))));
/** Event details as plain data, as the recording keeps them (engine/tools/edit-replay.mjs). */
const plain = (value, depth = 4) => {
  if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Set) return plain([...value], depth);
  if (typeof value !== 'object' || depth <= 0) return undefined;
  if (Array.isArray(value)) return value.map(item => plain(item, depth - 1)).filter(item => item !== undefined);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item, depth - 1)]).filter(([, item]) => item !== undefined));
};

const sameText = (actual, wanted, message) => {
  if (actual === wanted) return;
  let at = 0; while (actual[at] === wanted[at]) at++;
  assert.fail(`${message} at ${at}: engine …${actual.slice(Math.max(0, at - 70), at + 50)}… wanted …${wanted.slice(Math.max(0, at - 70), at + 50)}…`);
};
const same = (actual, wanted, message) => {
  const differing = Object.keys(wanted).filter(key => JSON.stringify(actual[key]) !== JSON.stringify(wanted[key]));
  if (differing.length) assert.fail(`${message}: ${differing.map(key => `${key} ${JSON.stringify(actual[key])} (wanted ${JSON.stringify(wanted[key])})`).join(', ')}`);
};
const scenarios = readdirSync(folder).filter(name => name.endsWith('.scenario.json') && (!process.env.OWNER_TAPE || name.startsWith(`${process.env.OWNER_TAPE}.`))).sort();
// Legacy Pivot poses carry an empty `runtime_segments` cache (styk-piv's legacy decoder):
// the same tapes with it on every pose.
const withCache = document => {
  const copy = structuredClone(document);
  for (const frame of [...copy.keyframes ?? [], ...Object.values(copy._styk?.frameSources ?? {})]) for (const object of frame.objects ?? []) object.runtime_segments ??= [];
  return copy;
};
/** The steps a tape records for an editor to run: the probes that read the editor's own views are run too,
 * and compared with what the recording read. */
const probes = {
  '@frame': editor => JSON.stringify(snapshotPoseFrame(editor.evaluatedFrame)),
  '@motionFrame': editor => JSON.stringify(snapshotPoseFrame((editor._drag?.motionPath ? editor._drag.display?.frame : null) ?? editor.evaluatedFrame)),
  '@selection': editor => JSON.stringify(editor._selectionState()),
  '@restoreSelection': (editor, selection) => editor._restoreSelection(selection),
  '@cameraAtTime': editor => cameraAtTime(editor.report, editor.evaluatedFrame),
};
/** A step of a tape on `editor`: `["@batch", label, steps]` groups its steps in one `movieclipBatch`. */
const run = (editor, [name, ...args]) => {
  if (name === '@batch') {
    let last;
    return editor.movieclipBatch(args[0], () => { for (const step of args[1]) last = run(editor, step); return last; });
  }
  if (Object.hasOwn(probes, name)) return probes[name](editor, ...args.map(decode));
  return editor[name.replace(/^@/, '')](...args.map(decode));
};
const supported = scenario => scenario.steps.every(call => Array.isArray(call) && (!call[0].startsWith('@') || ['@seek', '@select', '@batch', ...Object.keys(probes)].includes(call[0])));
const sha = text => createHash('sha256').update(text).digest('hex');

/** The display frame of a saved origin motion on a native document differs from the editor's by an ulp. */
/** Where recorded tapes end because the engine refuses what they do next, by tape. The app never reaches these: a bounds
 * callback other than its own, and native documents with property channels (the app gives every document a layer sheet). */
const expectedFrontiers = Object.fromEntries([
  'camera-center-measured-sheet: centerCamera: arguments that are not plain data',
  'camera-center-media-sheet: centerCamera: arguments that are not plain data',
  'figure-align-measured-native: alignSelection: arguments that are not plain data',
  'figure-align-measured-sheet: alignFiguresInFrames: arguments that are not plain data',
  'native-transform-channels-future-rig-joined: addAnimationKey: origin posing with an unrecorded rig, pose choice, 3D, movieclip or drawing definition',
  'native-transform-channels-future-rig: addAnimationKey: origin posing with an unrecorded rig, pose choice, 3D, movieclip or drawing definition',
  'native-transform-channels-invalid-open-pose-key: addAnimationKey: invalid native key input with an open editing gesture',
  'native-transform-channels-invalid-open-property-begin: beginAnimationEdit: an absent origin property target at the edited tick',
  'native-transform-channels-invalid-open-property-key: addAnimationKey: invalid native key input with an open editing gesture',
  'native-transform-channels-layout-projection: beginAnimationEdit: unrecorded native channel authoring or projection',
  'native-transform-channels-offsets-projection: beginAnimationEdit: unrecorded native channel authoring or projection',
  'native-transform-channels-plain-projection: beginAnimationEdit: unrecorded native channel authoring or projection',
  'native-transform-channels-support-projection: beginAnimationEdit: unrecorded native channel authoring or projection',
].map(key => [key, 1]));
const floatsDiffer = new Set(['origin-motion-saved-layout-native', 'origin-motion-saved-support-native']);
// With Pivot's cache on every pose (the recordings' poses have none: the engine's own document is checked against the
// read view there).
const variants = [{legacy: false}, {legacy: true}];
for (const {legacy} of variants) test(`the engine owning the document gives what every recorded tape records${legacy ? ', with legacy pose caches' : ''}`, {skip: !engineBuilt}, async () => {
  let tapes = 0, steps = 0, native = 0, fallback = 0;
  const editorCalls = {}, refusedCalls = {}, frontiers = {}, unnamedErrors = {};
  const failures = [];
  for (const name of scenarios) {
    const scenario = JSON.parse(readFileSync(new URL(name, folder), 'utf8'));
    if (!supported(scenario)) continue;
    const reference = JSON.parse(readFileSync(new URL(name.replace('.scenario.json', '.reference.json'), folder), 'utf8'));
    const loaded = typeof scenario.document === 'string' ? JSON.parse(readFileSync(new URL(scenario.document, folder), 'utf8')) : scenario.document;
    const document = legacy ? withCache(loaded) : loaded;
    const options = {demo: false, ...scenario.editor};
    let made;
    try { made = await ownedEditor(options, document); } catch { continue; }
    const {editor: owned, owner, setDraws} = made;
    owned.autoKey = Boolean(scenario.editor?.autoKey);
    const events = [];
    owned.addEventListener('change', event => events.push(plain(event.detail ?? null)));
    const label = step => `${scenario.name ?? name} step ${step}`;
    const frontier = [], unnamed = [];
    // The recorded document of the step: kept as text only where it changed.
    let recorded = reference.steps[0].document;
    const check = (index, call, wanted) => {
      const where = `${label(index)} ${call?.[0] ?? 'start'}`;
      if (wanted.document !== undefined) recorded = wanted.document;
      const text = json(owned.report);
      // A pose with the legacy cache is edited by materializing what it holds (lengths, bends): another
      // document than the recording's, whose poses have none. The engine's own is checked against the read view.
      if (!legacy && sha(text) !== wanted.documentSha) sameText(text, recorded, `${where}: document`);
      if (!legacy) same({...state(owned), layerRevision: owned.layerRevision, nextFrameIdentity: owned._nextFrameIdentity, nextUid: owned._nextUid,
        ...Object.fromEntries(Object.entries(owned._selectionState()).filter(([key]) => ['polygonSelection', 'segmentIds', 'branch'].includes(key)))}, wanted.state, `${where}: state`);
    };
    try {
      check(0, null, reference.steps[0]);
      for (const [index, call] of scenario.steps.entries()) {
        const wanted = reference.steps[index + 1];
        let ownedError, ownedMessage, result, drawn = 0;
        const draws = wanted.draws ?? [];
        setDraws(draws.map(pair => [...pair]));
        events.length = 0;
        try { ({result} = withDraws(() => run(owned, call), () => draws[drawn++]?.[1])); } catch (error) {
          // Beyond what the engine edits (a state it refuses): the recording says what the editor did there.
          if (error.reason) { frontier.push(error.reason); break; }
          ownedError = error.unnamed ?? error.messageKey ?? error.message;
          ownedMessage = error.message;
          if (error.unnamed) unnamed.push(error.unnamed);
        }
        const wantedError = wanted.error ? wanted.error.key ?? wanted.error.message : undefined;
        assert.equal(ownedError, wantedError, `${label(index + 1)} ${call[0]}: error`);
        if (wanted.error && !legacy && !unnamed.length && ownedMessage !== wanted.error.message) assert.fail(`${label(index + 1)} ${call[0]}: the error says "${ownedMessage}", the recording "${wanted.error.message}"`);
        check(index + 1, call, wanted);
        // The stage, playback and exports draw what the engine holds: it holds the editor's revision after every call.
        assert.ok(holdsRevision(registeredEngine(), owned.revision), `${label(index + 1)} ${call[0]}: the engine holds revision ${owned.revision}`);
        steps++;
        if (legacy) continue;
        sameText(eventText(events), eventText(wanted.events), `${label(index + 1)} ${call[0]}: change events`);
        if (Object.hasOwn(probes, call[0]) && !(call[0] === '@motionFrame' && floatsDiffer.has(scenario.name))) sameText(JSON.stringify(plain(result ?? null)), JSON.stringify(wanted.result), `${label(index + 1)} ${call[0]}: what it read`);
      }
      for (const key of unnamed) unnamedErrors[`${scenario.name}: ${key}`] = (unnamedErrors[`${scenario.name}: ${key}`] ?? 0) + 1;
      for (const reason of frontier) frontiers[`${scenario.name}: ${reason}`] = (frontiers[`${scenario.name}: ${reason}`] ?? 0) + 1;
      // Undoing everything reaches the start of the history, and redoing everything its end.
      let guard = 1000;
      while (owned.canUndo && guard--) owned.undo();
      assert.equal(owned.canUndo, false, `${label('undo all')}: the engine's history is as long`);
      while (owned.canRedo && guard--) owned.redo();
      assert.equal(owned.canRedo, false, `${label('redo all')}: the engine's history is as long`);
      assert.ok(holdsRevision(registeredEngine(), owned.revision), `${label('redo all')}: the engine holds revision ${owned.revision}`);
      tapes++;
    } catch (error) {
      if (process.env.OWNER_TAPE) console.log(error.stack, JSON.stringify(owner.refused));
      failures.push(`${String(error.message).includes(scenario.name ?? name) ? '' : (scenario.name ?? name) + ': '}${String(error.message).split('\n')[0].slice(0, 420)}` + (owner.broken ? ` [session: ${owner.broken.slice(0, 300)}]` : ''));
    } finally {
      native += owner.native; fallback += owner.fallback;
      for (const [key, count] of Object.entries(owner.editor ?? {})) editorCalls[key] = (editorCalls[key] ?? 0) + count;
      for (const [key, count] of Object.entries(owner.refused ?? {})) refusedCalls[key] = (refusedCalls[key] ?? 0) + count;
      owner.release();
    }
  }
  console.log(`# ${tapes} tapes / ${steps} steps; engine ${native}, editor ${fallback}; ${failures.length} failing`);
  for (const failure of failures.slice(0, 40)) console.log(`#   ${failure}`);
  if (process.env.OWNER_COUNTS) {
    console.log(`# editor calls: ${Object.entries(editorCalls).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`# refused: ${Object.entries(refusedCalls).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k} ${v}`).join(' | ')}`);
  }
  assert.equal(failures.length, 0);
  // The census of calls the editor runs for the engine: none of the recorded tapes needs it.
  assert.deepEqual(editorCalls, {}, 'calls that ran in the editor');
  // The tapes end where the engine refuses a state it does not edit yet (the app never opens them).
  console.log(`# tapes ending at a refusal: ${Object.keys(frontiers).length}`);
  assert.deepEqual(frontiers, expectedFrontiers);
  // Errors whose message needs a value the engine does not name yet say only that a value is not valid.
  console.log(`# errors without their values: ${JSON.stringify(unnamedErrors, null, 1)}`);
});

// Property and effect-clip edits run in the session; the editor shows them as its own.
const recorded = name => {
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder), 'utf8'));
  return {options: {demo: false, ...scenario.editor}, document: JSON.parse(readFileSync(new URL(scenario.document, folder), 'utf8'))};
};
/** An owned editor and an editor alone on the same document, and a call made on both. */
async function pair(name) {
  const {options, document} = recorded(name);
  const {editor: owned, owner} = await ownedEditor(options, document);
  const alone = new Editor(options).load(structuredClone(document));
  const both = (method, ...args) => { const results = [owned, alone].map(editor => editor[method](...args)); return results; };
  const agree = label => {
    sameText(json(owned.report), json(alone.report), `${label}: document`);
    same(state(owned), state(alone), `${label}: state`);
    sameText(frameText(owned.evaluatedFrame), frameText(alone.evaluatedFrame), `${label}: frame on show`);
  };
  return {owned, alone, owner, both, agree};
}

test('a property edit runs in the session and shows on the editor as its own', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('property-scrub-sheet');
  both('select', 1, -1);
  both('beginAnimationEdit', {kind: 'figure', uid: 1}, 'scale');
  assert.ok(owned._animationEdit?.engine && owned._animationEdit.sheet, 'the session\'s edit is on the editor');
  assert.equal(owned.dirty, false);
  agree('begin');
  // The session sends the figures the preview changed, not the whole frame.
  const session = owner.session(), ask = session.call.bind(session), answers = [];
  session.call = (...parts) => { const text = ask(...parts); answers.push(JSON.parse(text)); return text; };
  both('previewAnimationEdit', 1.3);
  session.call = ask;
  assert.equal(answers.length, 1);
  assert.equal(answers[0].preview, undefined);
  assert.equal(answers[0].previewChanges.figures.length, 1);
  assert.ok(owned.evaluatedFrame.objects.length > 1);
  assert.equal(owned.dirty, true, 'a previewed change is unsaved');
  assert.equal(owned._animationEdit.changed, alone._animationEdit.changed);
  assert.equal(owned._animationEdit.value, 1.3);
  assert.ok(owned._sheetPropertyPreview, 'the preview is the frame on show');
  agree('preview');
  both('commitAnimationEdit');
  assert.equal(owned._animationEdit, null);
  assert.equal(owned._sheetPropertyPreview, null);
  agree('commit');
  both('beginAnimationEdit', {kind: 'figure', uid: 2}, 'opacity');
  both('previewAnimationEdit', 0.4);
  both('cancelAnimationEdit');
  assert.equal(owned._animationEdit, null);
  agree('cancel');
  assert.equal(owner.fallback, 0, 'no call ran in the editor');
});

test('an effect-clip edit runs in the session and shows on the editor as its own', {skip: !engineBuilt}, async () => {
  const {owned, owner, both, agree} = await pair('vfx-clips-sheet');
  const before = owned.report._styk.vfxClips;
  both('beginVfxClipEdit');
  assert.ok(owned._vfxClipEdit?.engine);
  assert.equal(owned._vfxClipEdit.before, before, 'the clips as they were');
  both('setVfxClipParameter', 'clip-glow', 'fx-glow', 'intensity', 1.5);
  agree('preview');
  assert.equal(owned.canUndo, false, 'a preview is not an entry');
  both('commitVfxClipEdit');
  assert.equal(owned._vfxClipEdit, null);
  agree('commit');
  both('beginVfxClipEdit');
  both('setVfxClip', 'clip-tint', {strength: 0.2});
  both('seek', 4);
  assert.equal(owned._vfxClipEdit, null, 'moving the playhead ends the edit');
  agree('seek');
  both('beginVfxClipEdit');
  both('setVfxClip', 'clip-tint', {strength: 0.4});
  both('undo');
  assert.equal(owned._vfxClipEdit, null);
  agree('undo');
  assert.equal(owner.fallback, 0, 'no call ran in the editor');
});

test('ending an edit that is not open does not ask the session', {skip: !engineBuilt}, async () => {
  const {owned, owner, both} = await pair('property-scrub-sheet');
  owner.capture = [];
  const calls = owner.native;
  assert.deepEqual(both('commitVfxClipEdit'), [false, false]);
  assert.deepEqual(both('cancelVfxClipEdit'), [false, false]);
  assert.deepEqual(both('commitAnimationEdit'), [false, false]);
  assert.deepEqual(both('cancelAnimationEdit'), [false, false]);
  both('seek', 2);
  assert.deepEqual(owner.capture, []);
  assert.equal(owner.native - calls, 5, 'the owner answered them');
  assert.equal(owned.tick, 2);
});

// Motion-path edits run in the session; the editor shows them as its own.
const head = {kind: 'node', uid: 1, handleId: 22, joint: 1};
/** What the stage draws while the edit is open: the playhead's pose under the trail (`currentFrame`, `display.geometry`), as text. */
const staged = editor => {
  if (!editor._drag?.motionPath) return null;
  const display = editor._drag.display, geometry = display?.geometry ?? editor.geometry;
  return {frame: frameText(display?.frame ?? editor.evaluatedFrame),
    figures: json([...geometry.objects].sort((a, b) => a[0] - b[0]).map(([slot, item]) => [slot, item.root, item.joints]))};
};
/** The owned editor shows what the editor alone does of the open motion-path edit, and samples the same trail. */
const sameLive = (owned, alone, label) => {
  sameText(motionState(owned, json), motionState(alone, json), `${label}: the edit as the interface reads it`);
  assert.deepEqual(staged(owned), staged(alone), `${label}: the pose the stage draws`);
  const target = owned._drag?.target;
  if (target) sameText(json(sampleMotionPath(owned.motionPathReport(), owned, target)), json(sampleMotionPath(alone.motionPathReport(), alone, target)), `${label}: trail`);
};

test('a motion-path edit runs in the session and shows on the editor as its own', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('motion-path-sheet');
  both('select', 1, -1);
  both('beginMotionPathEdit', head, 8);
  assert.ok(owned._drag?.engine && owned._drag.motionPath, 'the session\'s edit is on the editor');
  assert.equal(owned.motionPathReport(), owned.report, 'nothing has moved the trail yet');
  assert.equal(owned._drag.display, null, 'the stage draws the pose the document has');
  sameLive(owned, alone, 'begin');
  const start = sampleMotionPath(owned.motionPathReport(), owned, head).points.find(point => point.tick === 8);
  const session = owner.session(), ask = session.call.bind(session), answers = [];
  session.call = (...parts) => { const reply = ask(...parts); answers.push(JSON.parse(reply)); return reply; };
  both('updateMotionPathEdit', {x: 330, y: 300});
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  session.call = ask;
  // The fixed part of the edit is told once; a move says how the edit stands and what its trail changed.
  assert.equal(answers[1].motionPath.target, undefined);
  assert.equal(answers[1].motionPath.moved, true);
  assert.ok(answers[1].motionPath.report.length > 0 && answers[1].motionPath.report.length < 8, 'the changed tracks and sources, not the document');
  assert.notEqual(owned.motionPathReport(), owned.report);
  assert.equal(owned.motionPathReport(), owned.motionPathReport(), 'one report until the trail moves again');
  assert.equal(owned.dirty, alone.dirty);
  sameLive(owned, alone, 'move');
  both('updateMotionPathEdit', {x: start.x, y: start.y});
  sameLive(owned, alone, 'back at the start');
  both('updateMotionPathEdit', {x: 330, y: 300});
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  sameLive(owned, alone, 'moved again');
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  sameLive(owned, alone, 'a move that changes nothing');
  both('commitMotionPathEdit');
  assert.equal(owned._drag, null);
  sameLive(owned, alone, 'commit');
  agree('commit');
  both('beginMotionPathEdit', head, 12);
  both('updateMotionPathEdit', {x: 300, y: 320}, {isolate: true});
  both('cancelMotionPathEdit');
  assert.equal(owned._drag, null);
  agree('cancel');
  while (alone.canUndo) { both('undo'); agree('undo'); }
  assert.equal(owner.fallback, 0, 'no call ran in the editor');
});

test('a motion-path edit on the playhead shows the pose under the trail to the stage', {skip: !engineBuilt}, async () => {
  const {owned, alone, both} = await pair('motion-path-sheet');
  both('select', 1, -1);
  both('seek', 8);
  both('beginMotionPathEdit', head, 8);
  assert.equal(owned._drag.display, null, 'the pose the document has until the trail moves');
  both('updateMotionPathEdit', {x: 330, y: 300});
  const display = owned._drag.display;
  assert.ok(display?.frame, 'the pose under the trail');
  assert.notEqual(frameText(display.frame), frameText(owned.evaluatedFrame), 'which is not the pose the document has');
  assert.equal(owned._drag.display, display, 'built once until the trail moves again');
  sameLive(owned, alone, 'move');
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  assert.notEqual(owned._drag.display, display);
  sameLive(owned, alone, 'moved again');
  both('cancelMotionPathEdit');
  sameLive(owned, alone, 'cancel');
});

test('a motion-path edit that reshapes the arc shows its falloff on the editor', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('motion-path-falloff-sheet');
  both('select', 1, -1);
  both('beginMotionPathEdit', {kind: 'node', uid: 1, handleId: 0, joint: -1}, 10, {falloff: {radius: 5, shape: 'smooth'}});
  assert.ok(owned.motionPathFalloff().writes.length > 1);
  sameLive(owned, alone, 'begin');
  both('updateMotionPathEdit', {x: 250, y: 180});
  assert.ok(owned.motionPathFalloff().changed.size > 0);
  sameLive(owned, alone, 'move');
  both('setMotionPathFalloff', {radius: 8, shape: 'linear'});
  sameLive(owned, alone, 'a wider arc');
  both('setMotionPathFalloff', null);
  assert.equal(owned.motionPathFalloff(), null);
  sameLive(owned, alone, 'one frame');
  both('updateMotionPathEdit', {x: 262, y: 190});
  both('commitMotionPathEdit');
  agree('commit');
  while (alone.canUndo) { both('undo'); agree('undo'); }
  assert.equal(owner.fallback, 0, 'no call ran in the editor');
});

/** Calls of a recorded tape on both editors: what each raised, and the edit as the interface reads it. */
const tapeSteps = (name, from, to, owned, alone) => {
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder), 'utf8'));
  const raised = [];
  for (const [index, [method, ...args]] of scenario.steps.entries().filter(([index]) => index >= from && index < to)) {
    const failures = [owned, alone].map(editor => { try { editor[method.replace(/^@/, '')](...args.map(decode)); } catch (error) { return error; } });
    assert.equal(failures[0]?.messageKey, failures[1]?.messageKey, `step ${index + 1} ${method}: error`);
    assert.deepEqual(failures[0]?.messageParams, failures[1]?.messageParams, `step ${index + 1} ${method}: what the error is made of`);
    if (failures[1]) raised.push(index + 1);
    sameLive(owned, alone, `step ${index + 1} ${method}`);
  }
  return raised;
};

test('a pointer move that is rejected leaves the motion-path edit open, in the session', {skip: !engineBuilt}, async () => {
  // The tape has a stretch the editor refuses (a full-circle bend) and pointers that are not finite.
  const {owned, alone, owner, agree} = await pair('motion-path-sheet');
  const raised = tapeSteps('motion-path-sheet', 0, Infinity, owned, alone);
  assert.ok(raised.length >= 4, `errors met: ${raised}`);
  agree('the tape');
  assert.deepEqual(Object.keys(owner.editor ?? {}).filter(name => /MotionPath/.test(name)), [], 'no motion-path call ran in the editor');
});

test('redo under an open motion-path edit ends the edit first, as undo does', {skip: !engineBuilt}, async () => {
  const {owned, alone, both, agree} = await pair('motion-path-sheet');
  both('select', 1, -1);
  both('beginMotionPathEdit', head, 8);
  both('updateMotionPathEdit', {x: 330, y: 300});
  both('commitMotionPathEdit');
  both('undo');
  both('beginMotionPathEdit', head, 12);
  both('updateMotionPathEdit', {x: 300, y: 320});
  // The editor alone leaves the edit open under a redo; the engine ends it, as undo does.
  alone.cancelDrag();
  assert.deepEqual(both('redo'), [true, true]);
  assert.equal(owned._drag, null, 'the edit ended');
  agree('redo');
  while (alone.canUndo) { both('undo'); agree('undo'); }
});

// Figure-handle, Handle Edit Mode and segment-value gestures run in the session; the editor shows them as its own.
const HANDLE_CALLS = ['beginFigureHandleDrag', 'transformFigureHandle', 'commitFigureHandleDrag', 'cancelFigureHandleDrag', 'beginHandleEditDrag', 'editHandlePosition',
  'commitHandleEditDrag', 'cancelHandleEditDrag', 'beginSegmentValueEdit', 'setSegmentValues', 'pasteSegmentValues'];
const ranHere = owner => HANDLE_CALLS.filter(name => owner.editor?.[name]);
/** The gesture as the interface reads it, and what the segment-values dialog and the stage show beside it. */
const sameHandles = (owned, alone, label) => {
  sameText(handleState(owned, json), handleState(alone, json), `${label}: the gesture as the interface reads it`);
  if (alone.figure?.segments[alone.selectedJoint]) for (const options of [{}, {relative: true}]) {
    sameText(json(owned.segmentValues(options)), json(alone.segmentValues(options)), `${label}: segment values ${JSON.stringify(options)}`);
  }
  sameText(frameText(owned.evaluatedFrame), frameText(alone.evaluatedFrame), `${label}: frame on show`);
};
/** The pointer for an angle about the pivot of a figure-handle gesture, at a multiple of the distance it began at. */
const around = (editor, angle, factor = 1) => {
  const {origin, distance} = editor._drag.figureHandle.transform;
  return [origin.x + distance * factor * Math.cos(angle), origin.y + distance * factor * Math.sin(angle)];
};
test('a figure-handle gesture runs in the session and shows its turns to the stage', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('figure-transform-sheet');
  both('seek', 3);
  both('select', 1, 2);
  both('beginFigureHandleDrag');
  assert.ok(owned._drag?.engine && owned._drag.figureHandle, 'the session\'s gesture is on the editor');
  assert.equal(owned._drag.figureHandle.transform.rotation, 0);
  sameHandles(owned, alone, 'begin');
  const drag = owned._drag, start = owned._drag.figureHandle.transform.lastAngle;
  // Round the pivot past half a turn and back: the turns are summed, not wrapped.
  for (const [turn, factor] of [[0.9, 1.2], [1.9, 0.8], [2.9, 1], [3.9, 1.3], [4.9, 0.7], [5.9, 1], [3.1, 1], [0.2, 1.5]]) {
    both('transformFigureHandle', ...around(owned, start + turn, factor));
    sameHandles(owned, alone, `turn ${turn}`);
  }
  assert.ok(Math.abs(owned._drag.figureHandle.transform.rotation) < 1, 'the turns came back to where they began');
  assert.equal(owned._drag, drag, 'the gesture is one object while it lasts');
  // The locks: Ctrl keeps the scale, Shift the rotation, the toolbar's options come with the call.
  both('transformFigureHandle', ...around(owned, start + 1, 1.4), {ctrlKey: true});
  both('transformFigureHandle', ...around(owned, start + 2, 0.6), {shiftKey: true});
  both('transformFigureHandle', ...around(owned, start + 2.5, 1.1), {rotate: false});
  sameHandles(owned, alone, 'locks');
  both('commitFigureHandleDrag');
  assert.equal(owned._drag, null);
  sameHandles(owned, alone, 'commit');
  agree('commit');
  both('beginFigureHandleDrag');
  both('transformFigureHandle', ...around(owned, start + 0.7, 1.2));
  both('cancelFigureHandleDrag');
  assert.equal(owned._drag, null);
  agree('cancel');
  // One move outside a gesture begins and commits its own.
  both('transformFigureHandle', 410, 260);
  assert.equal(owned._drag, null);
  agree('a single move');
  while (alone.canUndo) { both('undo'); agree('undo'); }
  assert.deepEqual(ranHere(owner), [], 'no figure-handle call ran in the editor');
});

test('a Handle Edit Mode gesture runs in the session and shows the handle on the editor', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('handle-edit-sheet');
  both('seek', 3);
  both('select', 1, 1);
  both('beginHandleEditDrag', {bend: true});
  assert.ok(owned._drag?.engine && owned._drag.handleEdit, 'the session\'s gesture is on the editor');
  assert.equal(owned._drag.handleEdit.bend, true);
  sameHandles(owned, alone, 'begin');
  const drag = owned._drag, {x, y} = owned._drag.handleEdit.point;
  for (const point of [[280, 240], [285, 250, {bend: false}], [x, y], [300, 260], [x + 1e-12, y]]) {
    both('editHandlePosition', ...point);
    sameHandles(owned, alone, `to ${point}`);
  }
  assert.equal(owned._drag, drag);
  both('commitHandleEditDrag');
  assert.equal(owned._drag, null);
  agree('commit');
  both('select', 3, 0);
  both('beginHandleEditDrag');
  both('editHandlePosition', 400, 330);
  both('cancelHandleEditDrag');
  assert.equal(owned._drag, null);
  agree('cancel');
  while (alone.canUndo) { both('undo'); agree('undo'); }
  assert.deepEqual(ranHere(owner), [], 'no handle-edit call ran in the editor');
});

test('a segment-value gesture runs in the session and keeps its options and its dialog\'s gesture', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('handle-commands-sheet');
  both('seek', 6);
  both('select', 2, 1);
  for (const options of [{editMode: true, relative: true}, {isolate: true}, {}]) {
    both('beginSegmentValueEdit', options);
    const drag = owned._drag;
    assert.ok(drag?.engine && drag.segmentValueOptions, 'the session\'s gesture is on the editor');
    assert.deepEqual(drag.segmentValueOptions, options);
    assert.equal(Boolean(drag.handleEdit), Boolean(options.editMode));
    sameHandles(owned, alone, `begin ${JSON.stringify(options)}`);
    for (const [values, more] of [[{angle: 30, length: 60}, options], [{bend: 15}, options], [{angle: -20}, {}]]) {
      both('setSegmentValues', values, more);
      assert.equal(owned._drag, drag, 'the dialog\'s gesture stays the same object');
      sameHandles(owned, alone, `${JSON.stringify(values)}`);
    }
    both(options.isolate ? 'cancelDrag' : 'commitDrag');
    assert.equal(owned._drag, null);
    agree('end');
  }
  // Pasting begins and commits its own.
  both('pasteSegmentValues', '12,5:3:70');
  both('pasteSegmentValues', '1:2:3');
  agree('paste');
  while (alone.canUndo) { both('undo'); agree('undo'); }
  assert.deepEqual(ranHere(owner), [], 'no segment-value call ran in the editor');
});

test('a seek or an undo ends a figure-handle or handle-edit gesture, and a changed selection cancels it, as the editor alone does', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('figure-transform-sheet');
  both('seek', 3);
  both('select', 1, 2);
  both('beginFigureHandleDrag');
  both('transformFigureHandle', ...around(owned, owned._drag.figureHandle.transform.lastAngle + 0.8, 1.3));
  both('seek', 5);
  assert.equal(owned._drag, null);
  agree('seek');
  both('select', 1, 1);
  both('beginHandleEditDrag');
  both('editHandlePosition', 300, 250);
  both('select', 2, 1);
  // The editor raises that the handle changed and cancels the gesture; the session's error is the editor's.
  const raised = editor => { try { editor.editHandlePosition(310, 255); } catch (error) { return error.messageKey; } };
  const [fromOwned, fromAlone] = [raised(owned), raised(alone)];
  assert.equal(fromAlone, 'errors.editorHandleEdit.theSelectedHandleChangedDuringItsGesture');
  assert.equal(fromOwned, fromAlone);
  assert.equal(owned._drag, null);
  agree('selection changed');
  both('select', 1, 1);
  both('beginHandleEditDrag');
  both('editHandlePosition', 305, 255);
  assert.deepEqual(both('undo'), [true, true]);
  assert.equal(owned._drag, null);
  agree('undo');
  while (alone.canUndo) { both('undo'); agree('undo all'); }
  assert.deepEqual(ranHere(owner), []);
});

// Rig edits and camera drags run in the session; the editor shows them as its own, and builds
// its own when it takes one over.
/** The frame a camera drag shows, as text. */
const previewText = editor => editor._sheetPropertyPreview ? frameText(editor._sheetPropertyPreview) : null;
for (const name of ['rig-drag-sheet', 'rig-drag-native']) {
  test(`a rig edit runs in the session and shows on the editor as its own (${name})`, {skip: !engineBuilt}, async () => {
    const {owned, alone, owner, both, agree} = await pair(name);
    both('select', 1, 1);
    both('beginRigDrag', {});
    assert.ok(owned._drag?.engine && owned.dragging, 'the session\'s gesture is on the editor');
    assert.equal(Boolean(owned._authoredPoseEdit), Boolean(alone._authoredPoseEdit), 'a draft on a layer sheet, the keyframe itself on a native timeline');
    assert.equal(owned.dirty, false);
    agree('begin');
    both('editRigJoint', 340, 300);
    both('editRigJoint', 345, 310);
    assert.equal(owned.dirty, true, 'a preview is unsaved');
    agree('moves');
    both('commitRigDrag');
    assert.equal(owned._drag, null);
    assert.equal(owned.undoLabel, alone.undoLabel);
    agree('commit');
    // A rotation and a stretch, ended by the generic commit.
    both('select', 1, 0);
    both('beginRigDrag', {reposition: false});
    both('editRigJoint', 335, 235);
    both('editRigJoint', 318, 250, {stretch: true, isolate: true});
    agree('rotation');
    both('commitDrag');
    assert.equal(owned.undoLabel, alone.undoLabel);
    agree('commit by commitDrag');
    // The bend of a joint (the editor's bend reads the rig it began), and a cancel.
    both('select', 1, 4);
    both('beginRigDrag', {bend: true});
    both('bendJoint', 255, 262);
    both('bendJoint', 250, 265, {stretch: true});
    agree('bend');
    both('cancelRigDrag');
    assert.equal(owned._drag, null);
    agree('cancel');
    // Coordinates that are not finite are rejected before the edit is touched: it stays open, in the session.
    both('select', 1, 2);
    both('beginRigDrag', {});
    both('editRigJoint', 370, 320);
    const messages = [owned, alone].map(editor => { try { editor.editRigJoint('x', 0); } catch (error) { return error.messageKey; } return null; });
    assert.ok(messages[0] && messages[0] === messages[1], `the same error: ${messages}`);
    assert.ok(owned._drag?.engine, 'the session still holds the edit');
    agree('error');
    both('cancelDrag');
    agree('cancel by cancelDrag');
    while (alone.canUndo) { both('undo'); agree('undo'); }
    assert.equal(owner.fallback, 0, 'no call ran in the editor');
  });
}

test('a camera drag runs in the session and shows its frame on the editor', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('camera-commands-sheet');
  both('beginCameraDrag');
  assert.ok(owned._drag?.engine && owned.dragging, 'the session\'s gesture is on the editor');
  assert.equal(owned._sheetPropertyPreview, null, 'nothing moved yet');
  agree('begin');
  const session = owner.session(), ask = session.call.bind(session), answers = [];
  session.call = (...parts) => { const text = ask(...parts); answers.push(JSON.parse(text)); return text; };
  both('updateCameraDrag', {x: 10, y: 5});
  both('updateCameraDrag', {x: 20, scale: 1.2});
  session.call = ask;
  // The session tells the camera, not the frame.
  assert.equal(answers.length, 2);
  assert.equal(answers[1].preview, undefined);
  assert.deepEqual(answers[1].cameraPreview, alone._sheetPropertyPreview.camera);
  assert.ok(owned._sheetPropertyPreview, 'the preview is the frame on show');
  assert.equal(previewText(owned), previewText(alone));
  assert.equal(owned.dirty, alone.dirty);
  agree('moves');
  both('updateCameraDrag', {angle_rad: 0.1}, {fromStart: false});
  assert.equal(previewText(owned), previewText(alone));
  agree('a nudge');
  both('commitCameraDrag');
  assert.equal(owned._drag, null);
  assert.equal(owned._sheetPropertyPreview, null);
  agree('commit');
  both('beginCameraDrag', {indices: [0, 1], label: 'Pan camera'});
  both('updateCameraDrag', {x: -15});
  assert.equal(previewText(owned), previewText(alone));
  both('cancelCameraDrag');
  assert.equal(owned._sheetPropertyPreview, null);
  agree('cancel');
  // A drag that begins itself, and ends with the generic commit.
  both('updateCameraDrag', {y: 7});
  assert.ok(owned._drag?.engine);
  assert.equal(previewText(owned), previewText(alone));
  both('commitDrag');
  agree('commit by commitDrag');
  // A move that fails ends the drag.
  both('beginCameraDrag');
  assert.throws(() => owned.updateCameraDrag({bogus: 1}));
  assert.throws(() => alone.updateCameraDrag({bogus: 1}));
  assert.equal(owned._drag, null);
  assert.equal(owned._sheetPropertyPreview, null);
  agree('error');
  while (alone.canUndo) { both('undo'); agree('undo'); }
  assert.equal(owner.fallback, 0, 'no call ran in the editor');
});

test('an open camera drag is ended by the calls that end any gesture', {skip: !engineBuilt}, async () => {
  const {owned, alone, owner, both, agree} = await pair('camera-commands-sheet');
  for (const end of [['seek', 3], ['undo'], ['selectFrame', 1], ['setCameraValues', {x: 2}]]) {
    both('beginCameraDrag');
    both('updateCameraDrag', {x: 12});
    both(...end);
    assert.equal(owned._drag, null);
    assert.equal(alone._drag, null);
    assert.equal(owned._sheetPropertyPreview, null, `after ${end[0]}`);
    agree(end[0]);
    both('seek', 0);
  }
  while (alone.canUndo) { both('undo'); agree('undo'); }
  assert.equal(owner.fallback, 0, 'no call ran in the editor');
});

test('redo under an open camera drag or rig edit ends the gesture first, as undo does', {skip: !engineBuilt}, async () => {
  const camera = await pair('camera-commands-sheet');
  camera.both('setCameraValues', {x: 40});
  camera.both('undo');
  camera.both('beginCameraDrag');
  camera.both('updateCameraDrag', {x: 12});
  camera.alone.cancelDrag();
  assert.deepEqual(camera.both('redo'), [true, true]);
  assert.equal(camera.owned._drag, null, 'the gesture ended');
  camera.agree('redo');
  const rig = await pair('rig-drag-sheet');
  rig.both('select', 1, 1);
  rig.both('beginRigDrag', {});
  rig.both('editRigJoint', 340, 300);
  rig.both('commitRigDrag');
  rig.both('undo');
  rig.both('beginRigDrag', {});
  rig.both('editRigJoint', 345, 310);
  rig.alone.cancelDrag();
  assert.deepEqual(rig.both('redo'), [true, true]);
  assert.equal(rig.owned._drag, null, 'the gesture ended');
  rig.agree('redo');
});

test('a document marked as changed is the engine\'s at its new revision', {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('startup.document.json', folder), 'utf8'));
  const {editor, owner} = await ownedEditor({demo: false, layerTimeline: true, propertyChannels: true}, document);
  assert.ok(owner.ready());
  assert.ok(holdsRevision(registeredEngine(), editor.revision), 'the open document is the engine\'s');
  const opened = editor.revision;
  editor.dirty = true;
  assert.notEqual(editor.revision, opened);
  assert.equal(editor.dirty, true);
  assert.ok(holdsRevision(registeredEngine(), editor.revision), 'and so is the revision that marks it changed');
  owner.release();
});

test("an edit made outside the session's calls reaches the engine once the code that made it has finished", {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('startup.document.json', folder), 'utf8'));
  const {editor, owner} = await ownedEditor({demo: false, layerTimeline: true, propertyChannels: true}, document);
  const opened = editor.revision;
  // A module that moves the revision and announces the change without a command.
  editor._revision = ++editor._revisionSerial;
  editor._emit('edit', {label: 'Project metadata'});
  assert.notEqual(editor.revision, opened);
  assert.equal(holdsRevision(registeredEngine(), editor.revision), false, 'not before the code that made the edit is done');
  await Promise.resolve();
  assert.ok(holdsRevision(registeredEngine(), editor.revision), "and then it is the engine's");
  owner.release();
});

test("a definition attached in place (a drawing's encoded tiles) reaches the session once the code that made it has finished", {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('startup.document.json', folder), 'utf8'));
  const {editor, owner} = await ownedEditor({demo: false, layerTimeline: true, propertyChannels: true}, document);
  const figure = editor.report.figure_types[0], revision = editor.revision;
  figure.name = 'Encoded in place';
  // A derived publication is no edit: the revision stays, the session's copy is brought up to date.
  editor._drawingPublished(figure);
  assert.ok(!owner.session().report_json().includes('Encoded in place'), 'not before the code that made it is done');
  await Promise.resolve();
  assert.ok(owner.session().report_json().includes('Encoded in place'), "and then it is the session's");
  assert.equal(editor.revision, revision);
  assert.ok(holdsRevision(registeredEngine(), revision), 'at the revision the engine held');
  assert.equal(editor.canUndo, false, 'and it is no history entry');
  owner.release();
});
