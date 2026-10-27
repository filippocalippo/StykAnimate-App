// Calls the engine session used to refuse or had no command for, which the editor ran (docs/engine/editing.md): each runs in the session now,
// on an editor the engine owns, over a repository document that reaches the case, and compared with what a plain editor gave
// (the frozen references of tests/support/owner-references.mjs). The documents, history labels and undo and redo agree step
// by step, and nothing is refused.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {canonical, ownerReferences} from './support/owner-references.mjs';

const refs = ownerReferences(import.meta.url);
const folder = new URL('../engine/tests/', import.meta.url);
const load = path => JSON.parse(readFileSync(new URL(path, folder), 'utf8'));
const text = editor => JSON.stringify(editor.report);

/** Runs `script(editor, note)` on one the engine owns, over `document`, and compares it with what a plain editor gave (its references);
 * `note(label, value)` records what the interface reads after a step. Returns both records and what the owner refused. */
async function bothWays(take, document, options, script) {
  const run = async () => {
    const editor = new Editor({demo: false, ...options}).load(structuredClone(document));
    const owner = installEngineOwner(editor, {verify: true});
    const steps = [];
    const note = (label, value) => steps.push({label, value, document: text(editor), undo: editor.undoLabel, redo: editor.redoLabel, canUndo: editor.canUndo, canRedo: editor.canRedo, dirty: editor.dirty});
    try {
      await script(editor, note);
      return {steps, refused: {...owner.refused}};
    } finally { owner.release(); }
  };
  const plain = take('plain'), owned = await run();
  assert.deepEqual(canonical(owned.steps), plain.steps, 'the engine and the editor leave the same document, history and state at every step');
  assert.deepEqual(owned.refused, {}, 'nothing was refused');
  return {plain, owned};
}

/** Undoes every step of `count` and redoes them, noting the state after each. */
async function unwind(editor, note, count) {
  for (let i = 0; i < count; i++) { assert.equal(await editor.undo(), true); note(`undo ${i + 1}`); }
  for (let i = 0; i < count; i++) { assert.equal(await editor.redo(), true); note(`redo ${i + 1}`); }
}

const sheet = {layerTimeline: true, propertyChannels: true};

for (const name of ['playback-authored', 'playback-imported']) {
  refs.test(`${name}: movieclip playback on every frame of a legacy-timed clip is set, restarted and undone like the editor does`, {skip: !engineBuilt}, async take => {
    const document = load(`movieclip-timed-sheet-commands/${name}.document.json`);
    const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
      editor.select(1, -1); note('select');
      editor.seek(2.75);
      assert.ok(editor.setMovieclipPlayback({mode: 'single', offset: 2.5}, {allFrames: true})); note('playback');
      assert.ok(editor.restartMovieclip()); note('restart');
      editor.seek(3);
      assert.ok(editor.removeMovieclipRestart()); note('remove restart');
      await unwind(editor, note, 3);
    });
    assert.notEqual(plain.steps.find(step => step.label === 'playback').document, plain.steps[0].document, 'the playback changed the document');
  });
}

/** The tip of joint `joint` of the first figure as geometry draws it: where a drag of the bone starts. */
const tip = (editor, joint) => editor.geometry.objects.get(editor.selectedSlot).segments[joint].end;

refs.test('posing a bone of a figure with IK in perspective is done, undone and redone like the editor does', {skip: !engineBuilt}, async take => {
  const document = load('edit/ik-spatial-perspective-target-sheet.document.json');
  assert.ok(document.keyframes[0].objects[0]._stykSpatial.camera.strength > 0 && document.keyframes[0].objects[0]._stykIK, 'perspective and IK');
  const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
    editor.seek(0);
    let count = 0;
    // The thigh steers the planted limb's knee; the foot and toe turn on their own.
    for (const joint of [6, 12]) {
      editor.select(1, joint);
      const end = tip(editor, joint);
      editor.beginDrag('Pose joint');
      assert.equal(editor.poseJoint(end.x + 14, end.y + 9), true); note(`pose ${joint} 1`);
      assert.equal(editor.poseJoint(end.x + 22, end.y - 3), true); note(`pose ${joint} 2`);
      assert.equal(editor.commitDrag(), true); note(`commit ${joint}`);
      count++;
    }
    // A single call opens and ends its own edit.
    editor.select(1, 15);
    const end = tip(editor, 15);
    assert.equal(editor.poseJoint(end.x - 9, end.y + 6), true); note('pose 15'); count++;
    // The depth key swings the bone in depth instead.
    editor.select(1, 12);
    const foot = tip(editor, 12);
    assert.equal(editor.poseJoint(foot.x + 6, foot.y - 4, {depth: true, pixel: 1}), true); note('pose 12 in depth'); count++;
    assert.equal(editor.undoLabel, 'Pose articulated joint');
    await unwind(editor, note, count);
  });
  assert.notEqual(plain.steps.at(-1).document, plain.steps[0].document, 'the posing changed the document');
});

refs.test('a segment\'s own paint is read, keyed and edited as a property like the editor does', {skip: !engineBuilt}, async take => {
  const document = load('edit/startup.document.json');
  const segments = document.figure_types[0].segments;
  // One plain segment, one with a second colour (a gradient) and one with a stored gradient paint.
  segments[2].secondary = {rgb: [200, 10, 10], a: 64};
  segments[3].paint = {type: 'radial', angle: 20, stops: [{offset: 0.8, color: [250.4, 1, 2], opacity: 0.5}, {offset: 0, color: [3, 4, 5], opacity: 1}, {offset: 1, color: [9, 8, 7], opacity: 0.25}]};
  segments[3].transparency = 51;
  const target = handleId => ({kind: 'segment', uid: 1, handleId});
  const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
    editor.select(1, -1);
    const read = handleId => editor.animationValue(target(handleId), 'paint', 0);
    const painted = [segments[1], segments[2], segments[3]].map(segment => read(segment.segment_id));
    note('read', painted);
    assert.deepEqual(painted.map(paint => paint.type), ['solid', 'linear', 'radial']);
    editor.addAnimationKey(target(segments[2].segment_id), 'paint', 4); note('key');
    editor.addAnimationKey(target(segments[3].segment_id), 'paint', 4); note('key stored');
    editor.seek(4);
    editor.beginAnimationEdit(target(segments[1].segment_id), 'paint');
    editor.previewAnimationEdit({type: 'linear', angle: 45, stops: [{offset: 0, color: [255, 0, 0], opacity: 1}, {offset: 1, color: [0, 0, 255], opacity: 0.5}]});
    assert.equal(editor.commitAnimationEdit(), true); note('edit', read(segments[1].segment_id));
    await unwind(editor, note, 3);
  });
  assert.notEqual(plain.steps.find(step => step.label === 'edit').document, plain.steps[0].document, 'the keys changed the document');
});

/** Motion-path edits of `targets` (`[handleId, joint, tick, options]`, the options of the edit's `falloff` and of its pointer moves `movePins`,
 * `stretch` and `isolate`): the trail point of each is dragged twice from where the figure draws it at the playhead and committed.
 * What each call answers is recorded. */
function editTrails(editor, note, uid, targets) {
  for (const [handleId, joint, tick, {falloff, ...moves} = {}] of targets) {
    const pointer = Object.keys(moves).length ? [moves] : [];
    const slot = editor.selectionFrame.objects.findIndex(object => object.unique_id === uid);
    const geometry = editor.geometry.objects.get(slot);
    const at = joint >= 0 ? geometry.segments[joint].end : geometry.root;
    const begun = editor.beginMotionPathEdit(...[{kind: 'node', uid, handleId, joint}, tick, ...(falloff ? [{falloff}] : [])]);
    note(`begin ${handleId}`, begun);
    if (!begun) continue;
    note(`move ${handleId}`, editor.updateMotionPathEdit({x: at.x + 17, y: at.y + 11}, ...pointer));
    note(`move again ${handleId}`, editor.updateMotionPathEdit({x: at.x + 26, y: at.y - 8}, ...pointer));
    note(`commit ${handleId}`, editor.commitMotionPathEdit());
  }
}

refs.test('motion paths of a rigged figure are edited, undone and redone like the editor does', {skip: !engineBuilt}, async take => {
  const document = load('edit/rig.document.json');
  const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
    editor.select(1, -1);
    editor.sheetInsertKey(['layer-1'], 6); note('key');
    const before = editor.undoLabel;
    // The stretching bone, the one that follows it, the connector, the angle-locked bone and the figure's origin.
    editTrails(editor, note, 1, [[22, 1, 3], [33, 2, 2], [56, 5, 4], [44, 3, 5], [11, 0, 1, {stretch: true}], [0, -1, 5]]);
    assert.notEqual(editor.undoLabel, before, 'an edit was recorded');
    // A falloff reshape.
    editTrails(editor, note, 1, [[22, 1, 3, {falloff: {radius: 3, shape: 'smooth'}}]]);
    const depth = editor._undo.length;
    await unwind(editor, note, depth);
  });
  const documents = new Set(plain.steps.map(step => step.document));
  assert.ok(documents.size > 3, 'the trails changed the document');
});

refs.test('motion paths of a 3D figure in perspective with IK are edited, undone and redone like the editor does', {skip: !engineBuilt}, async take => {
  const document = load('edit/ik-spatial-perspective-target-sheet.document.json');
  const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
    editor.select(1, -1);
    const before = editor.undoLabel;
    // The thigh and foot bones, the pinned foot, the figure's origin and a reshape of the foot.
    editTrails(editor, note, 1, [[7, 6, 3], [13, 12, 2], [10, 9, 4], [0, -1, 1, {movePins: true}], [13, 12, 4, {falloff: {radius: 2, shape: 'linear'}}]]);
    assert.notEqual(editor.undoLabel, before, 'an edit was recorded');
    // The foot let go: dragging its trail solves the free limb in 3D.
    editor.select(1, 9); note('released', editor.setNodeIK({pinned: false})); editor.select(1, -1);
    editTrails(editor, note, 1, [[10, 9, 3]]);
    const depth = editor._undo.length;
    await unwind(editor, note, depth);
  });
  const documents = new Set(plain.steps.map(step => step.document));
  assert.ok(documents.size > 3, 'the trails changed the document');
});

/** `run()`'s outcome as the interface sees a command: its answer, or the message of the error it raised. */
const attempt = run => { try { return run(); } catch (error) { return `throws: ${error.message}`; } };
const jointOf = (editor, name) => editor.figure.segments.findIndex(segment => segment.name === name);

refs.test('disconnecting a segment makes a figure of its branch in every frame, and undoes, like the editor does', {skip: !engineBuilt}, async take => {
  const document = load('edit/startup.document.json');
  const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
    // Blue walks right while her left arm swings, over three held poses.
    for (const tick of [4, 8]) editor.sheetInsertKey(['layer-1'], tick);
    [0, 4, 8].forEach((tick, i) => {
      editor.seek(tick);
      editor.select(1); editor.updateObject({root_x: editor.object.root_x + 30 * i});
      editor.select(1, jointOf(editor, 'Left upper arm')); editor.rotateJoint(0.4 * i);
      editor.select(1, jointOf(editor, 'Left forearm')); editor.rotateJoint(-0.3 * i);
    });
    editor.seek(4);
    editor.select(1, jointOf(editor, 'Left upper arm'));
    note('selected', editor.canDisconnectSegment());
    const piece = editor.disconnectSegment();
    note('disconnected', [piece.unique_id, piece.join, editor.selectedUid, editor.figure.name, editor.undoLabel]);
    assert.equal(editor.undoLabel, 'Disconnect segment');
    assert.equal(editor.figure.segments.length, 2);
    for (const tick of [0, 8]) { editor.seek(tick); note(`frame ${tick}`, editor.evaluatedFrame.objects.map(object => [object.unique_id, object.figure_type_id, object.root_x, object.root_y])); }
    editor.seek(4);
    await unwind(editor, note, 1);
  });
  assert.notEqual(plain.steps.find(step => step.label === 'disconnected').document, plain.steps.find(step => step.label === 'selected').document);
});

refs.test('disconnecting from a linked instance, with figures joined to the part, matches the editor', {skip: !engineBuilt}, async take => {
  const document = load('edit/startup.document.json');
  // Joined figures with IK controllers are the topology edits' own case.
  for (const frame of document.keyframes) for (const object of frame.objects) delete object._stykIK;
  await bothWays(take, document, sheet, async (editor, note) => {
    // A second instance of the figure, a hand attached to the first one's arm and a body part attached to its chest.
    const typeId = editor.figure.figure_type_id;
    editor.addFigure(typeId);
    editor.addFigure(typeId); const hand = editor.selectedUid; editor.joinTo(1, 4);
    editor.addFigure(typeId); const chest = editor.selectedUid; editor.joinTo(1, 1);
    note('prepared');
    editor.select(1, jointOf(editor, 'Left upper arm'));
    const piece = editor.disconnectSegment();
    const joins = () => editor.selectionFrame.objects.map(object => [object.unique_id, object.figure_type_id, object.join?.target_unique_id, object.join?.target_handle_id]);
    note('disconnected', [piece.unique_id, joins(), editor.report.figure_types.map(figure => [figure.figure_type_id, figure.name, figure.segments.length])]);
    assert.equal(editor.selectionFrame.objects.find(object => object.unique_id === hand).join.target_unique_id, piece.unique_id, 'the hand stays on the arm');
    assert.equal(editor.selectionFrame.objects.find(object => object.unique_id === chest).join.target_unique_id, 1, 'the chest stays on the body');
    // The other instance shares the definition: this one splits again from the fork.
    editor.select(1); editor.select(1, jointOf(editor, 'Right upper arm'));
    note('again', editor.disconnectSegment().unique_id);
    await unwind(editor, note, 2);
  });
});

refs.test('disconnecting a segment of a pinned limb keeps its displayed pose, as the editor does', {skip: !engineBuilt}, async take => {
  const document = load('edit/startup.document.json');
  const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
    editor.select(1, jointOf(editor, 'Left forearm')); note('pinned', editor.setNodeIK({pinned: true}));
    editor.select(1); editor.updateObject({root_x: editor.object.root_x - 25}); note('moved');
    editor.select(1, jointOf(editor, 'Left forearm'));
    const piece = editor.disconnectSegment();
    note('disconnected', [piece.unique_id, piece._stykIK, editor.selectionFrame.objects.find(object => object.unique_id === 1)._stykIK]);
    await unwind(editor, note, 2);
  });
  assert.equal(plain.steps.find(step => step.label === 'pinned').value, true);
});

refs.test('fills move with their part and a fill across the cut is refused without a change, as the editor does', {skip: !engineBuilt}, async take => {
  const document = load('edit/startup.document.json');
  await bothWays(take, document, sheet, async (editor, note) => {
    editor.addPolygon([1, 3, 4]); editor.addPolygon([0, 7, 9]);
    editor.select(1, jointOf(editor, 'Left upper arm'));
    const piece = editor.disconnectSegment();
    note('disconnected', [piece.unique_id, editor.figure.polyfills.map(polygon => polygon.segment_ids)]);
    await unwind(editor, note, 1);
    assert.equal(await editor.undo(), true); editor.select(1);
    const depth = editor._undo.length;
    editor.addPolygon([2, 3, 4]);
    editor.select(1, jointOf(editor, 'Left upper arm'));
    note('refused', attempt(() => editor.disconnectSegment()));
    assert.equal(editor._undo.length, depth + 1, 'the refusal recorded nothing');
  });
});

refs.test('what cannot be disconnected is refused with the editor\'s message', {skip: !engineBuilt}, async take => {
  const document = load('edit/startup.document.json');
  await bothWays(take, document, sheet, async (editor, note) => {
    editor.select(1);
    note('whole figure', [editor.canDisconnectSegment(), attempt(() => editor.disconnectSegment())]);
    editor.select(1, jointOf(editor, 'Left upper arm')); editor.disconnectSegment();
    editor.select(editor.selectedUid, 0);
    note('the part is a whole figure now', [editor.canDisconnectSegment(), attempt(() => editor.disconnectSegment())]);
    editor.select(1); editor.select(1, jointOf(editor, 'Head')); editor.setLayerLocked(editor.layerForUid(1), true);
    note('locked layer', attempt(() => editor.disconnectSegment()));
  });
});

refs.test('combining joined figures makes one figure that draws as they did, and undoes, like the editor does', {skip: !engineBuilt}, async take => {
  for (const outside of [false, true]) {
    const {document, root} = await take(`document ${outside}`);
    const {plain} = await bothWays(take, document, sheet, async (editor, note) => {
      editor.select(root); note('before');
      const combined = editor.combineJoinedFigure(root, {name: 'Merged rig'});
      note('combined', [combined.unique_id, combined.join, editor.figure.name, editor.figure.segments.length, editor.figure.polyfills.length, editor.undoLabel,
        editor.evaluatedFrame.objects.map(object => [object.unique_id, object.figure_type_id, object.join?.target_unique_id])]);
      assert.equal(editor.undoLabel, 'Combine joined figures');
      assert.equal(editor.figure.name, 'Merged rig');
      assert.equal(editor.figure.segments.length, 20);
      await unwind(editor, note, 1);
    });
    assert.notEqual(plain.steps.find(step => step.label === 'combined').document, plain.steps[0].document, 'the combine changed the document');
  }
});

refs.test('what cannot be combined is refused with the editor\'s message', {skip: !engineBuilt}, async take => {
  const {document, root, child} = await take('document');
  await bothWays(take, document, sheet, async (editor, note) => {
    note('an unknown figure', attempt(() => editor.combineJoinedFigure(child + 100)));
    editor.select(root); editor.updateObject({field28: 40});
    note('translucent', attempt(() => editor.combineJoinedFigure(root)));
    editor.updateObject({field28: 0});
    editor.setLayerLocked(editor.layerForUid(root), true);
    note('locked', attempt(() => editor.combineJoinedFigure(root)));
    editor.setLayerLocked(editor.layerForUid(root), false);
    editor.select(child); editor.unjoinFigure(); editor.select(root);
    note('nothing joined', attempt(() => editor.combineJoinedFigure(root)));
  });
});
