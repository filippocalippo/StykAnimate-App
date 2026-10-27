// The engine owning the document (D19): every recorded tape gives the document, selection, change
// events and history the recording says, after every step and after undoing everything. The recordings
// (engine/tests/edit/*.reference.json) are the oracle; the owner checks the engine's own document
// against the read view after every call.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import {withDraws} from './support/with-draws.mjs';
import {holdsRevision, registeredEngine} from '../src/engine/engine-open.mjs';
import {createDrawingFigure, drawingMetadata} from '../src/drawing-model.mjs';
import {hasPinnedIK} from '../src/ik.mjs';
import {MotionTrails} from '../src/motion-path.mjs';
import {snapshotPoseFrame} from './support/pose-snapshot.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';
import {CLOCKS, canonical, ownerReferences} from './support/owner-references.mjs';
import {recordedBounds} from './support/edit-bounds-callbacks.mjs';

const refs = ownerReferences(import.meta.url);
const folder = new URL('../engine/tests/edit/', import.meta.url);
/** Recordings of commands the session took over from the editor (the same format as the tapes in `folder`). */
const otherFolders = ['movieclip-sheet-extension'].map(name => new URL(`../engine/tests/${name}/`, import.meta.url));
const json = value => JSON.stringify(value, (key, item) => key === 'runtime_segments' || key === '_movieclipSample' || CLOCKS.includes(key) ? undefined : item);
const frameText = frame => { const {object_count, ...rest} = frame ?? {}; return json(rest); };
const state = editor => ({tick: editor.tick, frameIndex: editor.frameIndex, selectedUid: editor.selectedUid ?? null,
  selectedUids: [...editor.selectedUids], selectedJoint: editor.selectedJoint ?? -1, canUndo: editor.canUndo, canRedo: editor.canRedo,
  undoLabel: editor.undoLabel, redoLabel: editor.redoLabel, dirty: editor.dirty});
/** What the interface reads of an open motion-path edit (the trails sample `report` over `range`,
 * the arc's overlay and the pinned-origin modifier read the rest), as text; `null` with none open. */
/** The document a motion-path edit shows: its virtual report while one is open (the trails sample it), else the editor's. */
const motionReport = editor => editor._drag?.motionPath ? editor._drag.report : editor.report;
const motionState = (editor, text) => {
  const drag = editor._drag;
  if (!drag?.motionPath) return 'null';
  const {kind, uid, handleId, joint} = drag.target, arc = editor.motionPathFalloff();
  const own = drag.report === editor.report;
  return text({target: {kind, uid, handleId, joint}, tick: drag.tick, falloff: drag.falloff ?? null, moved: Boolean(drag.moved), range: drag.range,
    pinned: (drag.grab?.baseline ?? drag.baseline).some(hasPinnedIK), arc: arc && {...arc, changed: [...arc.changed]},
    report: own ? 'the document' : drag.report, reported: motionReport(editor) === drag.report});
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
/** Event details as plain data, as the recording keeps them. */
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
const scenarios = [folder, ...otherFolders].flatMap(where => readdirSync(where).filter(name => name.endsWith('.scenario.json') && (!process.env.OWNER_TAPE || name.startsWith(`${process.env.OWNER_TAPE}.`))).sort().map(name => ({where, name})));
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
  // The camera the frame on show is shot through: the session's `shot`, else the frame's own.
  '@cameraAtTime': editor => editor._shown.shot() ?? editor.evaluatedFrame.camera,
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
/** Where recorded tapes end because the engine refuses what they do next, by tape. A tape records what the JavaScript editor did at
 * every step; the session refuses the steps of a native timeline that has property channels (the app gives every document a layer
 * sheet) and a bounds callback other than the app's own (not data the session can take). A refused step that changed nothing in the
 * recording is expected to change nothing here and the tape goes on; one that changed the document or the history ends it, as the
 * editor's result is not the engine's to reproduce. */
const expectedFrontiers = Object.fromEntries([
  'camera-center-measured-sheet: centerCamera: arguments that are not plain data',
  'camera-center-media-sheet: centerCamera: arguments that are not plain data',
  'figure-align-measured-native: alignSelection: arguments that are not plain data',
  'figure-align-measured-sheet: alignSelection: arguments that are not plain data',
  'native-transform-channels-invalid-open-pose-key: addAnimationKey: invalid native key input with an open editing gesture',
  'native-transform-channels-invalid-open-property-key: addAnimationKey: invalid native key input with an open editing gesture',
  'native-transform-channels-layout-projection: previewAnimationEdit: unrecorded native channel authoring or projection',
  'native-transform-channels-offsets-projection: previewAnimationEdit: unrecorded native channel authoring or projection',
  'native-transform-channels-plain-projection: previewAnimationEdit: unrecorded native channel authoring or projection',
  'native-transform-channels-support-projection: previewAnimationEdit: unrecorded native channel authoring or projection',
].map(key => [key, 1]));
/** How many steps of the tapes the session refuses: ten end their tapes, seven changed nothing in the recording. (The editor ran 302 steps
 * of the tapes itself before the engine owned the whole document: the ones the session refuses, and every step after the first of
 * those that happened to be on the editor's open gesture.) */
const EXPECTED_REFUSED_STEPS = 17;
const floatsDiffer = new Set(['origin-motion-saved-layout-native', 'origin-motion-saved-support-native']);
// With Pivot's cache on every pose (the recordings' poses have none: the engine's own document is checked against the
// read view there).
const variants = [{legacy: false}, {legacy: true}];
for (const {legacy} of variants) test(`the engine owning the document gives what every recorded tape records${legacy ? ', with legacy pose caches' : ''}`, {skip: !engineBuilt}, async take => {
  let tapes = 0, steps = 0, native = 0, refusedSteps = 0;
  const refusedCalls = {}, frontiers = {}, unnamedErrors = {};
  const failures = [];
  for (const {where, name} of scenarios) {
    const scenario = JSON.parse(readFileSync(new URL(name, where), 'utf8'));
    if (!supported(scenario)) continue;
    const reference = JSON.parse(readFileSync(new URL(name.replace('.scenario.json', '.reference.json'), where), 'utf8'));
    const loaded = typeof scenario.document === 'string' ? JSON.parse(readFileSync(new URL(scenario.document, where), 'utf8')) : scenario.document;
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
    let recorded = reference.steps[0].document, previous = reference.steps[0];
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
        let refused = null;
        try { ({result} = withDraws(() => run(owned, call), () => draws[drawn++]?.[1])); } catch (error) {
          // Beyond what the engine edits (a state it refuses): the recording says what the editor did there.
          if (error.reason) {
            refusedSteps++;
            const idle = wanted.document === undefined && JSON.stringify(wanted.state) === JSON.stringify(previous.state) && !(wanted.events ?? []).length;
            if (!idle) { frontier.push(error.reason); break; }
            refused = error.reason;
          } else {
            ownedError = error.unnamed ?? error.messageKey ?? error.message;
            ownedMessage = error.message;
            if (error.unnamed) unnamed.push(error.unnamed);
          }
        }
        if (refused) {
          // The recording changed nothing there, and neither did the refusal.
          check(index + 1, call, wanted);
          previous = wanted; steps++;
          continue;
        }
        previous = wanted;
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
      native += owner.native;
      for (const [key, count] of Object.entries(owner.refused ?? {})) refusedCalls[key] = (refusedCalls[key] ?? 0) + count;
      owner.release();
    }
  }
  console.log(`# ${tapes} tapes / ${steps} steps; engine ${native}, refused ${refusedSteps}; ${failures.length} failing`);
  for (const failure of failures.slice(0, 40)) console.log(`#   ${failure}`);
  if (process.env.OWNER_COUNTS) {
    console.log(`# refused: ${Object.entries(refusedCalls).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k} ${v}`).join(' | ')}`);
  }
  assert.equal(failures.length, 0);
  // Every step above gives what its tape records, or is refused (docs/engine/editing.md, "Refusals"); OWNER_COUNTS=1 prints which calls.
  console.log(`# tapes ending at a refusal: ${Object.keys(frontiers).length}`); if (process.env.OWNER_FRONTIERS) console.log(JSON.stringify(frontiers));
  assert.deepEqual(frontiers, expectedFrontiers);
  assert.equal(refusedSteps, EXPECTED_REFUSED_STEPS);
  // Errors whose message needs a value the engine does not name yet say only that a value is not valid.
  console.log(`# errors without their values: ${JSON.stringify(unnamedErrors, null, 1)}`);
});

// Property and effect-clip edits run in the session; the editor shows them as its own.
const recorded = name => {
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder), 'utf8'));
  return {options: {demo: false, ...scenario.editor}, document: JSON.parse(readFileSync(new URL(scenario.document, folder), 'utf8'))};
};
/** What a reference keeps of a call's answer: a boolean, number or text (a frame or a selection is not, the documents and states compared after the call are). */
const answered = value => ['boolean', 'number', 'string'].includes(typeof value) ? value : undefined;
/** An owned editor on a recorded tape's document, and the references of an editor alone: `reference(label, read)` is what `read(editor)`
 * gave on the plain editor (made only when the references are recorded); `both(method, ...args)` calls the owned editor and takes the
 * answer of the plain one; `agree(label)` compares the owned editor's document, state and frame on show with the plain one's. */
async function pair(take, name) {
  const {options, document} = recorded(name);
  const {editor: owned, owner} = await ownedEditor(options, document);
  let plain = null;
  const reference = (label, read) => take(label);
  const both = (method, ...args) => { const result = owned[method](...args); return [result, reference(method)]; };
  const agree = label => {
    const wanted = reference(`agree ${label}`);
    sameText(json(owned.report), wanted.document, `${label}: document`);
    same(canonical(state(owned)), wanted.state, `${label}: state`);
    sameText(frameText(owned.evaluatedFrame), wanted.frame, `${label}: frame on show`);
  };
  return {owned, owner, both, agree, reference};
}

refs.test('a property edit runs in the session and shows on the editor as its own', {skip: !engineBuilt}, async take => {
  const {owned, owner, both, agree, reference} = await pair(take, 'property-scrub-sheet');
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
  assert.equal(owned._animationEdit.changed, reference('animation edit changed'));
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
});

refs.test('an effect-clip edit runs in the session and shows on the editor as its own', {skip: !engineBuilt}, async take => {
  const {owned, owner, both, agree} = await pair(take, 'vfx-clips-sheet');
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
});

refs.test('ending an edit that is not open does not ask the session', {skip: !engineBuilt}, async take => {
  const {owned, owner, both} = await pair(take, 'property-scrub-sheet');
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
/** The owned editor shows what the editor alone did of the open motion-path edit, and the engine samples its trail. */
const sameLive = (owned, reference, label) => {
  const wanted = reference(`live ${label}`);
  sameText(motionState(owned, json), wanted.motion, `${label}: the edit as the interface reads it`);
  assert.deepEqual(canonical(staged(owned)), wanted.stage, `${label}: the pose the stage draws`);
  const target = owned._drag?.target;
  if (target) {
    const [trail] = new MotionTrails(owned, {budgetMs: Infinity}).read([target]);
    assert.ok(trail.complete && [...trail.points.values()].every(sample => sample.missing || (Number.isFinite(sample.x) && Number.isFinite(sample.y))), `${label}: the engine samples the trail`);
  }
};

refs.test('a motion-path edit runs in the session and shows on the editor as its own', {skip: !engineBuilt}, async take => {
  const {owned, owner, both, agree, reference} = await pair(take, 'motion-path-sheet');
  both('select', 1, -1);
  both('beginMotionPathEdit', head, 8);
  assert.ok(owned._drag?.engine && owned._drag.motionPath, 'the session\'s edit is on the editor');
  assert.equal(motionReport(owned), owned.report, 'nothing has moved the trail yet');
  assert.equal(owned._drag.display, null, 'the stage draws the pose the document has');
  sameLive(owned, reference, 'begin');
  const start = new MotionTrails(owned, {budgetMs: Infinity}).read([head])[0].points.get(8);
  const session = owner.session(), ask = session.call.bind(session), answers = [];
  session.call = (...parts) => { const reply = ask(...parts); answers.push(JSON.parse(reply)); return reply; };
  both('updateMotionPathEdit', {x: 330, y: 300});
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  session.call = ask;
  // The fixed part of the edit is told once; a move says how the edit stands and what its trail changed.
  assert.equal(answers[1].motionPath.target, undefined);
  assert.equal(answers[1].motionPath.moved, true);
  assert.ok(answers[1].motionPath.report.length > 0 && answers[1].motionPath.report.length < 8, 'the changed tracks and sources, not the document');
  assert.notEqual(motionReport(owned), owned.report);
  assert.equal(motionReport(owned), motionReport(owned), 'one report until the trail moves again');
  assert.equal(owned.dirty, reference('dirty'));
  sameLive(owned, reference, 'move');
  both('updateMotionPathEdit', {x: start.x, y: start.y});
  sameLive(owned, reference, 'back at the start');
  both('updateMotionPathEdit', {x: 330, y: 300});
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  sameLive(owned, reference, 'moved again');
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  sameLive(owned, reference, 'a move that changes nothing');
  both('commitMotionPathEdit');
  assert.equal(owned._drag, null);
  sameLive(owned, reference, 'commit');
  agree('commit');
  both('beginMotionPathEdit', head, 12);
  both('updateMotionPathEdit', {x: 300, y: 320}, {isolate: true});
  both('cancelMotionPathEdit');
  assert.equal(owned._drag, null);
  agree('cancel');
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

refs.test('a motion-path edit on the playhead shows the pose under the trail to the stage', {skip: !engineBuilt}, async take => {
  const {owned, both, reference} = await pair(take, 'motion-path-sheet');
  both('select', 1, -1);
  both('seek', 8);
  both('beginMotionPathEdit', head, 8);
  assert.equal(owned._drag.display, null, 'the pose the document has until the trail moves');
  both('updateMotionPathEdit', {x: 330, y: 300});
  const display = owned._drag.display;
  assert.ok(display?.frame, 'the pose under the trail');
  assert.notEqual(frameText(display.frame), frameText(owned.evaluatedFrame), 'which is not the pose the document has');
  assert.equal(owned._drag.display, display, 'built once until the trail moves again');
  sameLive(owned, reference, 'move');
  both('updateMotionPathEdit', {x: 340, y: 310}, {stretch: true});
  assert.notEqual(owned._drag.display, display);
  sameLive(owned, reference, 'moved again');
  both('cancelMotionPathEdit');
  sameLive(owned, reference, 'cancel');
});

refs.test('a motion-path edit that reshapes the arc shows its falloff on the editor', {skip: !engineBuilt}, async take => {
  const {owned, owner, both, agree, reference} = await pair(take, 'motion-path-falloff-sheet');
  both('select', 1, -1);
  both('beginMotionPathEdit', {kind: 'node', uid: 1, handleId: 0, joint: -1}, 10, {falloff: {radius: 5, shape: 'smooth'}});
  assert.ok(owned.motionPathFalloff().writes.length > 1);
  sameLive(owned, reference, 'begin');
  both('updateMotionPathEdit', {x: 250, y: 180});
  assert.ok(owned.motionPathFalloff().changed.size > 0);
  sameLive(owned, reference, 'move');
  both('setMotionPathFalloff', {radius: 8, shape: 'linear'});
  sameLive(owned, reference, 'a wider arc');
  both('setMotionPathFalloff', null);
  assert.equal(owned.motionPathFalloff(), null);
  sameLive(owned, reference, 'one frame');
  both('updateMotionPathEdit', {x: 262, y: 190});
  both('commitMotionPathEdit');
  agree('commit');
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

/** Calls of a recorded tape on the owned editor and the editor alone (its references): what each raised, and the edit as the interface reads it. */
const tapeSteps = (name, from, to, owned, reference) => {
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder), 'utf8'));
  const raised = [];
  const failure = (editor, method, args) => {
    try { editor[method.replace(/^@/, '')](...args.map(decode)); } catch (error) { return {messageKey: error.messageKey ?? null, messageParams: error.messageParams ?? null}; }
    return null;
  };
  for (const [index, [method, ...args]] of scenario.steps.entries().filter(([index]) => index >= from && index < to)) {
    const wanted = reference(`step ${index + 1} ${method}`), failed = canonical(failure(owned, method, args));
    assert.equal(failed?.messageKey, wanted?.messageKey, `step ${index + 1} ${method}: error`);
    assert.deepEqual(failed?.messageParams, wanted?.messageParams, `step ${index + 1} ${method}: what the error is made of`);
    if (wanted) raised.push(index + 1);
    sameLive(owned, reference, `step ${index + 1} ${method}`);
  }
  return raised;
};

refs.test('a pointer move that is rejected leaves the motion-path edit open, in the session', {skip: !engineBuilt}, async take => {
  // The tape has a stretch the editor refuses (a full-circle bend) and pointers that are not finite.
  const {owned, agree, reference} = await pair(take, 'motion-path-sheet');
  const raised = tapeSteps('motion-path-sheet', 0, Infinity, owned, reference);
  assert.ok(raised.length >= 4, `errors met: ${raised}`);
  agree('the tape');
});

refs.test('redo under an open motion-path edit ends the edit first, as undo does', {skip: !engineBuilt}, async take => {
  const {owned, both, agree, reference} = await pair(take, 'motion-path-sheet');
  both('select', 1, -1);
  both('beginMotionPathEdit', head, 8);
  both('updateMotionPathEdit', {x: 330, y: 300});
  both('commitMotionPathEdit');
  both('undo');
  both('beginMotionPathEdit', head, 12);
  both('updateMotionPathEdit', {x: 300, y: 320});
  // The editor alone leaves the edit open under a redo; the engine ends it, as undo does.
  reference('cancel the drag');
  assert.deepEqual(both('redo'), [true, true]);
  assert.equal(owned._drag, null, 'the edit ended');
  agree('redo');
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

// Figure-handle, Handle Edit Mode and segment-value gestures run in the session; the editor shows them as its own.
/** The gesture as the interface reads it, and what the segment-values dialog and the stage show beside it. */
const valueOptions = [{}, {relative: true}];
const sameHandles = (owned, reference, label) => {
  const wanted = reference(`handles ${label}`);
  sameText(handleState(owned, json), wanted.gesture, `${label}: the gesture as the interface reads it`);
  if (wanted.values) valueOptions.forEach((options, at) => sameText(json(owned.segmentValues(options)), wanted.values[at], `${label}: segment values ${JSON.stringify(options)}`));
  sameText(frameText(owned.evaluatedFrame), wanted.frame, `${label}: frame on show`);
};
/** The pointer for an angle about the pivot of a figure-handle gesture, at a multiple of the distance it began at. */
const around = (editor, angle, factor = 1) => {
  const {origin, distance} = editor._drag.figureHandle.transform;
  return [origin.x + distance * factor * Math.cos(angle), origin.y + distance * factor * Math.sin(angle)];
};
refs.test('a figure-handle gesture runs in the session and shows its turns to the stage', {skip: !engineBuilt}, async take => {
  const {owned, both, agree, reference} = await pair(take, 'figure-transform-sheet');
  both('seek', 3);
  both('select', 1, 2);
  both('beginFigureHandleDrag');
  assert.ok(owned._drag?.engine && owned._drag.figureHandle, 'the session\'s gesture is on the editor');
  assert.equal(owned._drag.figureHandle.transform.rotation, 0);
  sameHandles(owned, reference, 'begin');
  const drag = owned._drag, start = owned._drag.figureHandle.transform.lastAngle;
  // Round the pivot past half a turn and back: the turns are summed, not wrapped.
  for (const [turn, factor] of [[0.9, 1.2], [1.9, 0.8], [2.9, 1], [3.9, 1.3], [4.9, 0.7], [5.9, 1], [3.1, 1], [0.2, 1.5]]) {
    both('transformFigureHandle', ...around(owned, start + turn, factor));
    sameHandles(owned, reference, `turn ${turn}`);
  }
  assert.ok(Math.abs(owned._drag.figureHandle.transform.rotation) < 1, 'the turns came back to where they began');
  assert.equal(owned._drag, drag, 'the gesture is one object while it lasts');
  // The locks: Ctrl keeps the scale, Shift the rotation, the toolbar's options come with the call.
  both('transformFigureHandle', ...around(owned, start + 1, 1.4), {ctrlKey: true});
  both('transformFigureHandle', ...around(owned, start + 2, 0.6), {shiftKey: true});
  both('transformFigureHandle', ...around(owned, start + 2.5, 1.1), {rotate: false});
  sameHandles(owned, reference, 'locks');
  both('commitFigureHandleDrag');
  assert.equal(owned._drag, null);
  sameHandles(owned, reference, 'commit');
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
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

refs.test('a Handle Edit Mode gesture runs in the session and shows the handle on the editor', {skip: !engineBuilt}, async take => {
  const {owned, both, agree, reference} = await pair(take, 'handle-edit-sheet');
  both('seek', 3);
  both('select', 1, 1);
  both('beginHandleEditDrag', {bend: true});
  assert.ok(owned._drag?.engine && owned._drag.handleEdit, 'the session\'s gesture is on the editor');
  assert.equal(owned._drag.handleEdit.bend, true);
  sameHandles(owned, reference, 'begin');
  const drag = owned._drag, {x, y} = owned._drag.handleEdit.point;
  for (const point of [[280, 240], [285, 250, {bend: false}], [x, y], [300, 260], [x + 1e-12, y]]) {
    both('editHandlePosition', ...point);
    sameHandles(owned, reference, `to ${point}`);
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
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

refs.test('a segment-value gesture runs in the session and keeps its options and its dialog\'s gesture', {skip: !engineBuilt}, async take => {
  const {owned, both, agree, reference} = await pair(take, 'handle-commands-sheet');
  both('seek', 6);
  both('select', 2, 1);
  for (const options of [{editMode: true, relative: true}, {isolate: true}, {}]) {
    both('beginSegmentValueEdit', options);
    const drag = owned._drag;
    assert.ok(drag?.engine && drag.segmentValueOptions, 'the session\'s gesture is on the editor');
    assert.deepEqual(drag.segmentValueOptions, options);
    assert.equal(Boolean(drag.handleEdit), Boolean(options.editMode));
    sameHandles(owned, reference, `begin ${JSON.stringify(options)}`);
    for (const [values, more] of [[{angle: 30, length: 60}, options], [{bend: 15}, options], [{angle: -20}, {}]]) {
      both('setSegmentValues', values, more);
      assert.equal(owned._drag, drag, 'the dialog\'s gesture stays the same object');
      sameHandles(owned, reference, `${JSON.stringify(values)}`);
    }
    both(options.isolate ? 'cancelDrag' : 'commitDrag');
    assert.equal(owned._drag, null);
    agree('end');
  }
  // Pasting begins and commits its own.
  both('pasteSegmentValues', '12,5:3:70');
  both('pasteSegmentValues', '1:2:3');
  agree('paste');
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

refs.test('a seek or an undo ends a figure-handle or handle-edit gesture, and a changed selection cancels it, as the editor alone does', {skip: !engineBuilt}, async take => {
  const {owned, both, agree, reference} = await pair(take, 'figure-transform-sheet');
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
  const raised = editor => { try { editor.editHandlePosition(310, 255); } catch (error) { return error.messageKey; } return null; };
  const [fromOwned, fromAlone] = [raised(owned), reference('the error', raised)];
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
  while (reference('can undo')) { both('undo'); agree('undo all'); }
});

// Rig edits and camera drags run in the session; the editor shows them as its own, and builds
// its own when it takes one over.
/** The frame a camera drag shows, as text. */
const previewText = editor => editor._sheetPropertyPreview ? frameText(editor._sheetPropertyPreview) : null;
for (const name of ['rig-drag-sheet', 'rig-drag-native']) {
  refs.test(`a rig edit runs in the session and shows on the editor as its own (${name})`, {skip: !engineBuilt}, async take => {
    const {owned, owner, both, agree, reference} = await pair(take, name);
    both('select', 1, 1);
    both('beginRigDrag', {});
    assert.ok(owned._drag?.engine && owned.dragging, 'the session\'s gesture is on the editor');
    assert.equal(Boolean(owned._authoredPoseEdit), reference('authored pose edit'), 'a draft on a layer sheet, the keyframe itself on a native timeline');
    assert.equal(owned.dirty, false);
    agree('begin');
    both('editRigJoint', 340, 300);
    both('editRigJoint', 345, 310);
    assert.equal(owned.dirty, true, 'a preview is unsaved');
    agree('moves');
    both('commitRigDrag');
    assert.equal(owned._drag, null);
    assert.equal(owned.undoLabel, reference('undo label'));
    agree('commit');
    // A rotation and a stretch, ended by the generic commit.
    both('select', 1, 0);
    both('beginRigDrag', {reposition: false});
    both('editRigJoint', 335, 235);
    both('editRigJoint', 318, 250, {stretch: true, isolate: true});
    agree('rotation');
    both('commitDrag');
    assert.equal(owned.undoLabel, reference('undo label'));
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
    const thrown = editor => { try { editor.editRigJoint('x', 0); } catch (error) { return error.messageKey; } return null; };
    const messages = [thrown(owned), reference('the error', thrown)];
    assert.ok(messages[0] && messages[0] === messages[1], `the same error: ${messages}`);
    assert.ok(owned._drag?.engine, 'the session still holds the edit');
    agree('error');
    both('cancelDrag');
    agree('cancel by cancelDrag');
    while (reference('can undo')) { both('undo'); agree('undo'); }
  });
}

refs.test('a camera drag runs in the session and shows its frame on the editor', {skip: !engineBuilt}, async take => {
  const {owned, owner, both, agree, reference} = await pair(take, 'camera-commands-sheet');
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
  assert.deepEqual(answers[1].cameraPreview, reference('camera preview'));
  assert.ok(owned._sheetPropertyPreview, 'the preview is the frame on show');
  assert.equal(previewText(owned), reference('preview', previewText));
  assert.equal(owned.dirty, reference('dirty'));
  agree('moves');
  both('updateCameraDrag', {angle_rad: 0.1}, {fromStart: false});
  assert.equal(previewText(owned), reference('preview', previewText));
  agree('a nudge');
  both('commitCameraDrag');
  assert.equal(owned._drag, null);
  assert.equal(owned._sheetPropertyPreview, null);
  agree('commit');
  both('beginCameraDrag', {indices: [0, 1], label: 'Pan camera'});
  both('updateCameraDrag', {x: -15});
  assert.equal(previewText(owned), reference('preview', previewText));
  both('cancelCameraDrag');
  assert.equal(owned._sheetPropertyPreview, null);
  agree('cancel');
  // A drag that begins itself, and ends with the generic commit.
  both('updateCameraDrag', {y: 7});
  assert.ok(owned._drag?.engine);
  assert.equal(previewText(owned), reference('preview', previewText));
  both('commitDrag');
  agree('commit by commitDrag');
  // A move that fails ends the drag.
  both('beginCameraDrag');
  assert.throws(() => owned.updateCameraDrag({bogus: 1}));
  assert.equal(reference('a move that fails'), true);
  assert.equal(owned._drag, null);
  assert.equal(owned._sheetPropertyPreview, null);
  agree('error');
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

refs.test('an open camera drag is ended by the calls that end any gesture', {skip: !engineBuilt}, async take => {
  const {owned, owner, both, agree, reference} = await pair(take, 'camera-commands-sheet');
  for (const end of [['seek', 3], ['undo'], ['selectFrame', 1], ['setCameraValues', {x: 2}]]) {
    both('beginCameraDrag');
    both('updateCameraDrag', {x: 12});
    both(...end);
    assert.equal(owned._drag, null);
    assert.equal(reference('drag'), null);
    assert.equal(owned._sheetPropertyPreview, null, `after ${end[0]}`);
    agree(end[0]);
    both('seek', 0);
  }
  while (reference('can undo')) { both('undo'); agree('undo'); }
});

refs.test('redo under an open camera drag or rig edit ends the gesture first, as undo does', {skip: !engineBuilt}, async take => {
  const camera = await pair(take, 'camera-commands-sheet');
  camera.both('setCameraValues', {x: 40});
  camera.both('undo');
  camera.both('beginCameraDrag');
  camera.both('updateCameraDrag', {x: 12});
  camera.reference('cancel the drag', editor => { editor.cancelDrag(); });
  assert.deepEqual(camera.both('redo'), [true, true]);
  assert.equal(camera.owned._drag, null, 'the gesture ended');
  camera.agree('redo');
  const rig = await pair(take, 'rig-drag-sheet');
  rig.both('select', 1, 1);
  rig.both('beginRigDrag', {});
  rig.both('editRigJoint', 340, 300);
  rig.both('commitRigDrag');
  rig.both('undo');
  rig.both('beginRigDrag', {});
  rig.both('editRigJoint', 345, 310);
  rig.reference('cancel the drag', editor => { editor.cancelDrag(); });
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

test("a drawing cel the drawing store finished is the session's at once, and is no edit", {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('startup.document.json', folder), 'utf8'));
  document.figure_types.push(createDrawingFigure({pixelsPerUnit: 1, figureTypeId: Math.max(...document.figure_types.map(figure => figure.figure_type_id)) + 1}));
  const {editor, owner} = await ownedEditor({demo: false, layerTimeline: true, propertyChannels: true}, document);
  const figure = editor.report.figure_types.find(drawingMetadata), cel = drawingMetadata(figure), revision = editor.revision, entries = editor._undo.length;
  // The store attaches what it published to the cel's definition in place: a derived publication, not an edit.
  cel.revision = 7; cel.bounds = {x: 0, y: 0, width: 64, height: 32};
  figure.image_assets[0].styk_tiles = 'data:application/octet-stream;base64,AAAA';
  editor._drawingPublished(figure);
  assert.ok(owner.session().report_json().includes('"revision":7'), "the session's copy is up to date");
  assert.equal(owner.session().report_json(), JSON.stringify(editor.report), 'the same document as the read view');
  assert.equal(editor.revision, revision);
  assert.ok(holdsRevision(registeredEngine(), revision), 'at the revision the engine held');
  assert.equal(editor._undo.length, entries, 'and it is no history entry');
  // A cel the document no longer has is ignored.
  editor._drawingPublished({...figure, _styk: {...figure._styk, drawing: {...cel, celId: 'gone'}}});
  owner.release();
});
