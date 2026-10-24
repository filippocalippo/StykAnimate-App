// What the interface reads of the gestures the engine session runs for the editor (D19): the duplicate drag, the
// tweener, grouped edits, working frames, the audio clip commands and the errors the session raises. The expectations
// are stated here; nothing is compared with the editor alone.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const folder = new URL('../engine/tests/edit/', import.meta.url);
/** An owned editor on the first document of a recorded tape. */
async function owned(name) {
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder), 'utf8'));
  const document = JSON.parse(readFileSync(new URL(scenario.document, folder), 'utf8'));
  const made = await ownedEditor({demo: false, ...scenario.editor}, document, {recorded: false});
  made.editor.autoKey = Boolean(scenario.editor?.autoKey);
  return made;
}
const figures = editor => editor.evaluatedFrame.objects.length;
const angles = editor => editor.evaluatedFrame.objects.find(object => object.unique_id === 1).angles.slice();

test('a duplicate drag runs in the session: the copies and their move are one undo step', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('rig-drag-sheet');
  editor.select(1, -1);
  const before = figures(editor);
  assert.equal(editor.beginDuplicateDrag({pasteMode: 'instance'}), true);
  assert.ok(editor._drag?.engine && editor.dragging, 'the session\'s gesture is on the editor');
  assert.equal(figures(editor), before + 1, 'the copy shows while the gesture lasts');
  assert.equal(editor.canUndo, false, 'nothing is in history yet');
  editor.moveSelection(30, 10);
  assert.equal(editor.dirty, true);
  assert.equal(editor.commitDrag(), true);
  assert.equal(editor._drag, null);
  assert.equal(editor.undoLabel, 'Duplicate figures');
  assert.equal(figures(editor), before + 1);
  editor.undo();
  assert.equal(figures(editor), before);
  assert.equal(editor.canUndo, false, 'one undo took the copy and its move');
  editor.redo();
  assert.equal(figures(editor), before + 1);
  assert.equal(owner.fallback, 0, 'no call ran in the editor');
});

test('cancelling a duplicate drag takes the copies away and leaves history alone', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('rig-drag-sheet');
  editor.select(1, -1);
  const before = figures(editor);
  assert.equal(editor.beginDuplicateDrag(), true);
  editor.moveSelection(30, 10);
  assert.equal(editor.cancelDrag(), true);
  assert.equal(editor._drag, null);
  assert.equal(figures(editor), before);
  assert.equal(editor.canUndo || editor.canRedo, false);
  // With nothing selected there is nothing to duplicate.
  editor.select(null, -1);
  assert.equal(editor.beginDuplicateDrag(), false);
  assert.equal(owner.fallback, 0);
});

const rootOf = (editor, uid) => { const object = editor.evaluatedFrame.objects.find(item => item.unique_id === uid); return [object.root_x, object.root_y]; };
const near = (actual, wanted, message) => assert.ok(actual.every((value, i) => Math.abs(value - wanted[i]) < 1e-9), `${message}: ${actual} against ${wanted}`);

test('a duplicate drag begun over another commits the first and shows the figures it moved', {skip: !engineBuilt}, async () => {
  // The chain 1-2-3 is duplicated whole; the copies of 2 and 3 hang from the copy of 1.
  const {editor, owner} = await owned('add-figure-layers-sheet');
  const known = new Set(editor.evaluatedFrame.objects.map(object => object.unique_id));
  editor.select(1, -1);
  assert.equal(editor.beginDuplicateDrag(), true);
  const first = editor._drag.serial;
  const child = editor.evaluatedFrame.objects.find(object => !known.has(object.unique_id) && object.join).unique_id;
  const [x, y] = rootOf(editor, child);
  editor.moveSelection(35, 12, {fromStart: true});
  assert.equal(editor.beginDuplicateDrag(), true);
  assert.notEqual(editor._drag.serial, first, 'the second is a gesture of its own');
  assert.equal(editor._undo.length, 1, 'the first copies and their move are one entry');
  assert.equal(editor.undoLabel, 'Duplicate figures');
  near(rootOf(editor, child), [x + 35, y + 12], 'the copy that hangs from the moved one is where the first gesture left it');
  assert.equal(editor.commitDrag(), true);
  assert.equal(editor._undo.length, 2);
  editor.undo();
  near(rootOf(editor, child), [x + 35, y + 12], 'one undo takes the second copies only');
  assert.equal(owner.fallback, 0);
});

test('redo under an open duplicate drag leaves the gesture open under the entry it applies', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('add-figure-layers-sheet');
  editor.select(1, -1);
  editor.moveSelection(2, 1);
  editor.undo();
  assert.equal(editor.beginDuplicateDrag(), true);
  editor.moveSelection(30, 10);
  assert.equal(editor.redo(), true);
  assert.ok(editor._drag?.engine && editor._drag.label === 'Duplicate figures', 'the gesture is still open');
  assert.equal(editor.commitDrag(), true);
  assert.equal(editor._drag, null);
  assert.equal(editor.undoLabel, 'Duplicate figures');
  assert.equal(editor._undo.length, 2, 'the redone move and the duplicate are two entries');
  assert.equal(owner.fallback, 0);
});

test('a duplicate drag copies the effect clips of the figures with new identities, in the same entry', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('vfx-clip-add-sheet');
  const clips = () => editor.getVfxClips();
  const before = clips();
  editor.select(1, -1);
  assert.equal(editor.beginDuplicateDrag(), true);
  const copy = Math.max(...editor.evaluatedFrame.objects.map(object => object.unique_id));
  assert.notEqual(copy, 1);
  const copied = clips().filter(clip => clip.target.uid === copy);
  assert.equal(copied.length, before.filter(clip => clip.target.uid === 1).length, 'every clip of the figure has a copy');
  assert.ok(copied.length > 0);
  for (const clip of copied) {
    assert.ok(!before.some(old => old.id === clip.id), 'a new clip identity');
    assert.ok(clip.effects.every(effect => !before.some(old => old.effects.some(item => item.id === effect.id))), 'new effect identities');
  }
  assert.equal(editor.commitDrag(), true);
  assert.equal(editor.undoLabel, 'Duplicate figures');
  assert.equal(editor._undo.length, 1);
  editor.undo();
  assert.deepEqual(clips().map(clip => clip.id), before.map(clip => clip.id), 'one undo took the figure and its effects');
  editor.redo();
  assert.equal(clips().filter(clip => clip.target.uid === copy).length, copied.length);
  assert.equal(owner.fallback, 0);
});

/** The tape's document with a figure keyed in different poses at ticks 4 and 6, the playhead between them. */
async function tweening() {
  const made = await owned('channels-pose-sheet');
  const {editor} = made;
  editor.select(1, -1);
  const poses = {};
  for (const [tick, by] of [[4, 0.3], [6, -0.4]]) { editor.seek(tick); editor.rotateSelection(by); poses[tick] = angles(editor); }
  editor.seek(5);
  return {...made, poses, start: angles(editor)};
}

test('the tweener runs in the session: the draft follows the amount and the commit keys the playhead', {skip: !engineBuilt}, async () => {
  const {editor, owner, poses} = await tweening();
  const entries = editor._undo.length;
  assert.deepEqual(editor.beginTween(), {groups: [{previous: 4, next: 6}], figures: 1});
  const gesture = editor._drag;
  assert.ok(gesture?.engine && editor._authoredPoseEdit, 'the session\'s gesture and its draft are on the editor');
  assert.equal(gesture.label, 'Tween pose');
  for (const [amount, mode, wanted] of [[0, 'breakdown', poses[4]], [1, 'breakdown', poses[6]], [-1, 'neighbor', poses[4]], [1, 'neighbor', poses[6]]]) {
    assert.equal(editor.updateTween(amount, mode), true);
    assert.equal(editor._drag, gesture, 'the gesture stays one object');
    editor.evaluatedFrame.objects.find(object => object.unique_id === 1).angles.forEach((angle, i) => assert.ok(Math.abs(angle - wanted[i]) < 1e-9, `${mode} ${amount}`));
  }
  assert.equal(editor.dirty, true);
  editor.updateTween(0.25);
  assert.equal(editor.commitDrag(), true);
  assert.equal(editor._drag, null);
  assert.equal(editor.undoLabel, 'Tween pose');
  assert.equal(editor._undo.length, entries + 1);
  const keys = editor.report._styk.layerSheet.tracks['layer-1'].keys.map(key => key.tick);
  assert.ok(keys.includes(5), `the playhead is keyed: ${keys}`);
  editor.undo();
  assert.ok(!editor.report._styk.layerSheet.tracks['layer-1'].keys.some(key => key.tick === 5));
  assert.equal(owner.fallback, 0);
});

test('the tweener refuses what the editor refuses and keeps its gesture open for a bad amount', {skip: !engineBuilt}, async () => {
  const {editor} = await tweening();
  const refusal = run => { try { run(); } catch (error) { return error.messageKey; } };
  assert.equal(refusal(() => editor.updateTween(0.5)), 'errors.editorTweener.openTweenerBeforeAdjustingThePose');
  editor.beginTween();
  assert.equal(refusal(() => editor.beginTween()), 'errors.editorTweener.finishTheCurrentEditBeforeOpeningTweener');
  assert.equal(refusal(() => editor.updateTween(3, 'breakdown')), 'errors.editorTweener.chooseAValidTweenerModeAndAmount');
  assert.equal(refusal(() => editor.updateTween(0.5, 'wobble')), 'errors.editorTweener.chooseAValidTweenerModeAndAmount');
  assert.ok(editor._drag?.engine, 'the gesture is still open');
  assert.equal(editor.cancelDrag(), true);
  editor.seek(0);
  assert.equal(refusal(() => editor.beginTween()), 'errors.editorTweener.placeThePlayheadBetweenTwoKeysOnEvery');
});

/** A tape's document with its first figure keyed in different poses at ticks 2 and 8, the playhead between them. */
async function keyed(name) {
  const made = await owned(name);
  made.editor.select(made.editor.evaluatedFrame.objects[0].unique_id, -1);
  for (const [tick, by] of [[2, 0.3], [8, -0.4]]) { made.editor.seek(tick); made.editor.rotateSelection(by); }
  made.editor.seek(5);
  return made;
}

test('the tweener runs on a document with animation origins and keeps the pivot with the pose', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await keyed('origin-pose-layout-sheet');
  const uid = editor.selectedUid;
  assert.deepEqual(editor.beginTween(), {groups: [{previous: 2, next: 8}], figures: 1});
  assert.equal(editor.updateTween(0.5, 'breakdown'), true);
  assert.equal(editor.updateTween(0.25, 'push'), true);
  assert.equal(editor.commitDrag(), true);
  assert.equal(editor.undoLabel, 'Tween pose');
  const pivot = editor.evaluatedFrame.objects.find(object => object.unique_id === uid)._stykAnimationOrigin;
  assert.ok(Number.isFinite(pivot.x) && Number.isFinite(pivot.y), 'the figure still has its pivot');
  assert.ok(editor.report._styk.layerSheet.tracks['layer-1'].keys.some(key => key.tick === 5), 'the playhead is keyed');
  editor.undo();
  assert.ok(!editor.report._styk.layerSheet.tracks['layer-1'].keys.some(key => key.tick === 5));
  // A playhead outside the keys raises the tweener's own message, as on any document.
  editor.seek(0);
  assert.throws(() => editor.beginTween(), error => error.messageKey === 'errors.editorTweener.placeThePlayheadBetweenTwoKeysOnEvery');
  assert.equal(owner.fallback, 0);
});

test('the tweener pushes a 3D figure past the pose it began with', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('recolor-mesh-sheet');
  editor.select(1, -1);
  // The perspective is 0.2 at frame 2 and 0.6 at frame 6, so 0.5 between them at frame 5, where it is 0.65.
  for (const [tick, strength] of [[2, 0.2], [6, 0.6], [5, 0.65]]) { editor.seek(tick); editor.setSpatialCamera({strength}); }
  const shown = () => editor.evaluatedFrame.objects.find(object => object.unique_id === 1);
  const [x, y] = [shown().root_x, shown().root_y], distance = shown()._stykSpatial.camera.distance;
  editor.beginTween();
  assert.equal(editor.updateTween(1, 'relax'), true);
  assert.ok(Math.abs(shown()._stykSpatial.camera.strength - 0.5) < 1e-9, "relaxed, the perspective is the breakdown's");
  assert.equal(editor.updateTween(1, 'push'), true);
  // Pushed, it is the breakdown reflected around the pose it began with: 2 * 0.65 - 0.5.
  const camera = shown()._stykSpatial.camera;
  assert.ok(Math.abs(camera.strength - 0.8) < 1e-9, `strength ${camera.strength}`);
  assert.equal(camera.distance, distance);
  assert.equal(editor.updateTween(0, 'push'), true);
  near([shown().root_x, shown().root_y], [x, y], 'amount 0 is the pose it began with');
  assert.ok(Math.abs(shown()._stykSpatial.camera.strength - 0.65) < 1e-9);
  assert.equal(editor.cancelDrag(), true);
  assert.deepEqual(owner.editor, {setSpatialCamera: 3}, 'only the perspective settings ran in the editor, the tween in the session');
});

test('movieclipBatch groups what its operation does into one entry and undoes all of it when it fails', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('camera-commands-sheet');
  const camera = () => JSON.stringify(editor.evaluatedFrame.camera);
  const original = camera();
  const result = editor.movieclipBatch('Two camera edits', () => { editor.setCameraValues({x: 5}); editor.setCameraValues({y: 7}); return 'done'; });
  assert.equal(result, 'done');
  assert.equal(editor.undoLabel, 'Two camera edits');
  assert.notEqual(camera(), original);
  editor.undo();
  assert.equal(camera(), original, 'one undo took both edits');
  assert.equal(editor.canUndo, false);
  const entries = editor._undo.length;
  assert.throws(() => editor.movieclipBatch('Fails', () => { editor.setCameraValues({x: 9}); throw new Error('stop'); }), /stop/);
  assert.equal(camera(), original, 'what it did before failing was undone');
  assert.equal(editor._undo.length, entries);
  // An edit the engine refuses inside the batch ends it the same way.
  assert.throws(() => editor.movieclipBatch('Refused', () => { editor.setCameraValues({x: 9}); editor.setCameraValues({x: 'a'}); }), error => error.messageKey === 'errors.editorCamera.mustBeFinite');
  assert.equal(camera(), original);
  assert.equal(owner.fallback, 0);
});

test('working frames: the interface can end them and ask for a preview; the engine does not start one', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('rig-drag-sheet');
  const events = [];
  editor.addEventListener('change', event => events.push(event.detail.kind));
  assert.equal(editor.disableFrameDrafts(), false);
  assert.ok(events.includes('frame-draft'), 'the timeline hears that working frames ended');
  assert.equal(editor.endFrameDraftPreview(), false);
  assert.equal(editor.beginFrameDraftPreview(), false);
  assert.throws(() => editor.enableFrameDrafts(), error => error.messageKey === 'errors.engineOwner.notSupported');
  assert.throws(() => editor.beginFrameDraft({mode: 'add'}), error => error.messageKey === 'errors.engineOwner.notSupported');
  assert.equal(owner.fallback, 0, 'a refusal never runs in the editor');
  assert.ok(owner.refused['enableFrameDrafts: working frames are not edited by the engine'] >= 1);
  assert.equal(editor.canUndo, false);
});

test('an open gesture is committed by disableFrameDrafts, as the timeline mounting would end it', {skip: !engineBuilt}, async () => {
  const {editor} = await owned('rig-drag-sheet');
  editor.select(1, -1);
  editor.beginTranslationDrag('Move figures');
  editor.moveSelection(12, 4);
  editor.disableFrameDrafts();
  assert.equal(editor._drag, null);
  assert.equal(editor.undoLabel, 'Move figures');
});

test('the audio clip commands run in the session with identities from the editor\'s draws', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('audio-sheet');
  const tracks = () => editor.report._styk.audio.tracks;
  const count = tracks().length;
  const id = editor.addAudioTrack('Foley');
  assert.match(id, /^audio-[0-9a-f-]{36}$/);
  assert.equal(tracks().length, count + 1);
  assert.equal(editor.undoLabel, 'Add audio track');
  const right = editor.splitAudioClip('clip-1', 0.4);
  assert.match(right, /^clip-[0-9a-f-]{36}$/);
  assert.equal(tracks()[0].clips.length, 3);
  assert.equal(editor._audioClipboard, undefined);
  assert.equal(editor.copyAudioClip('clip-3'), true);
  assert.ok(editor._audioClipboard, 'the interface can tell something was copied');
  const pasted = editor.pasteAudioClip('audio-a', 3);
  assert.ok(tracks()[0].clips.some(clip => clip.id === pasted && clip.start === 3));
  assert.equal(editor.duplicateAudioClip(pasted).startsWith('clip-'), true);
  for (let steps = 0; editor.canUndo && steps < 20; steps++) editor.undo();
  assert.equal(tracks().length, count);
  assert.equal(tracks()[0].clips.length, 2);
  assert.equal(owner.fallback, 0);
});

test('the audio follows frames inserted on every layer when the ripple option is on', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('audio-sheet');
  const layers = ['scene', 'camera', ...editor.report._styk.layers.order];
  const start = clip => editor.report._styk.audio.tracks.flatMap(track => track.clips).find(item => item.id === clip).start;
  editor.sheetInsertFrames(layers, 6, 6);
  assert.equal(start('clip-2'), 2, 'without the option the audio stays');
  editor.undo();
  editor.audioRipple = true;
  editor.sheetInsertFrames(layers, 6, 6);
  assert.equal(start('clip-2'), 2.25);
  assert.equal(editor.undoLabel, 'Insert scene frames with audio');
  editor.undo();
  assert.equal(start('clip-2'), 2, 'one undo took both back');
  assert.equal(owner.fallback, 0);
});


test('a call the session has no command for runs in the editor and is written back as one history entry', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('add-figure-layers-sheet');
  const layers = () => [...editor.report._styk.layers.order];
  const before = layers();
  assert.ok(before.length > 1);
  assert.equal(await editor.deleteLayerAsync(before[0]), true);
  assert.deepEqual(layers(), before.slice(1));
  assert.deepEqual(owner.editor, {deleteLayerAsync: 1}, 'the census names what ran in the editor');
  assert.equal(editor.undoLabel, 'Delete layer');
  // The session keeps the entry: undo and redo go through it, and a call the session runs follows.
  editor.undo();
  assert.deepEqual(layers(), before);
  editor.redo();
  assert.deepEqual(layers(), before.slice(1));
  editor.undo();
  editor.select(1, -1);
  editor.moveSelection(5, 5);
  assert.equal(editor.canUndo, true);
  assert.equal(owner.refused && Object.keys(owner.refused).length, 0);
});
