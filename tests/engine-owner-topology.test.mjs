// The builder and topology calls the engine session used to refuse (and the editor then ran) run in the session
// under the owner (D19): each is run on an editor the engine owns, and must end as a plain editor did on the same repository
// document (the frozen references of tests/support/owner-references.mjs) at every step, in the error a refused edit shows,
// and through undo and redo. Nothing is refused.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import {canonical, ownerReferences} from './support/owner-references.mjs';

const refs = ownerReferences(import.meta.url);
const SHEET = {demo: false, layerTimeline: true, propertyChannels: true};
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const text = editor => JSON.stringify(editor.report);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
const sprite = (start = {x: -7, y: 5}, end = {x: 23, y: -35}) => {
  const figure = createImageFigure({dataUrl: png, width: 1, height: 1, name: 'Placed sprite'});
  Object.assign(figure.image_assets[0], {anchor_start: start, anchor_end: end});
  return figure;
};
const jointOf = (editor, handle) => editor.figure.segments.findIndex(segment => segment.segment_id === handle);
const at = (editor, handle) => editor.select(editor.selectedUid, jointOf(editor, handle));

/** What is selected: the figures and joint, and the fill, joints and branch chosen. */
const selection = editor => JSON.stringify({uids: [...editor.selectedUids], uid: editor.selectedUid, joint: editor.selectedJoint,
  polygon: editor.selectedPolygonIndex, segments: [...editor.selectedSegmentIds], branch: editor.branchSelected});

/** One run of `script` on an owned editor: its document and history label after every call, what each returned or raised,
 * and the document after every undo and redo. */
async function trace({options, document, script}) {
  const made = ownedEditorSync(options, document, {recorded: false});
  const editor = made.editor;
  try {
    const steps = [{name: 'opened', text: text(editor), undo: editor.undoLabel, selected: selection(editor)}];
    const call = (name, run) => {
      let outcome;
      try { outcome = {result: JSON.stringify(run() ?? null)}; } catch (error) { outcome = {error: error.messageKey ?? error.message}; }
      steps.push({name, ...outcome, text: text(editor), undo: editor.undoLabel, selected: selection(editor)});
      return outcome;
    };
    await script(editor, call);
    while (editor.canUndo) { await editor.undo(); steps.push({name: 'undo', text: text(editor), undo: editor.undoLabel, selected: selection(editor)}); }
    while (editor.canRedo) { await editor.redo(); steps.push({name: 'redo', text: text(editor), undo: editor.undoLabel, selected: selection(editor)}); }
    return {steps, refused: {...made.owner.refused}};
  } finally { made.owner.release(); }
}

/** The script on an owned editor, and what a plain editor gave for it (its references): the same steps, nothing refused.
 * Returns the steps by name for the test to say what the calls did. */
async function same(take, options, document, script) {
  const plain = {steps: take('plain')};
  const owned = await trace({options, document, script});
  assert.deepEqual(canonical(owned.steps), plain.steps);
  assert.deepEqual(owned.refused, {}, 'the session refused nothing');
  const named = {};
  plain.steps.forEach((step, index) => { (named[step.name] ??= []).push({...step, changed: step.text !== plain.steps[index - 1]?.text}); });
  return named;
}

/** The rotating cube, a rigged figure with connectors, stretch drivers and six faces, on the layer sheet (built by a plain editor, once: its reference). */
async function cube(take) {
  const built = await take('cube');
  return {document: JSON.parse(built.document), q: built.q};
}

/** The default figure with three poses and a second figure joined to its hand. */
function walker() {
  const report = emptyDocument(), figure = report.figure_types[0];
  const other = {...structuredClone(figure), figure_type_id: 2};
  for (const segment of other.segments) { segment.segment_id *= 11; segment.parent_id *= 11; }
  report.figure_types.push(other);
  report.keyframes = Array.from({length: 3}, (_, i) => {
    const object = createObject(figure, 1, 300 + i * 10, 300);
    object.angles = object.angles.map(angle => angle + i * 0.1);
    const child = createObject(other, 2, 500, 300);
    child.join = {target_object_slot: 0, target_unique_id: 1, target_handle_id: figure.segments.at(-1).segment_id};
    return createFrame([object, child], 3);
  });
  return report;
}

refs.test('Smart Stretch on a connector measures the span it is drawn across', {skip: !engineBuilt}, async take => {
  const {document, q} = await cube(take);
  const steps = await same(take, SHEET, document, (editor, call) => {
    at(editor, q.edges[0]);
    call('enableSmartStretch', () => editor.enableSmartStretch(true));
    call('disable', () => editor.enableSmartStretch(false));
    at(editor, q.edges[5]);
    call('enableSmartStretch', () => editor.enableSmartStretch(true));
  });
  assert.ok(steps.enableSmartStretch.every(step => step.changed && !step.error), 'it turned on');
  assert.equal(steps.enableSmartStretch[0].undo, 'Enable Smart Stretch');
});

refs.test('a stroke drawn into a rigged figure is stored in the space its parent is drawn in', {skip: !engineBuilt}, async take => {
  const {document, q} = await cube(take);
  const steps = await same(take, SHEET, document, (editor, call) => {
    at(editor, q.top[0]);
    call('addSegment', () => editor.addSegment({length: 30, angle: 0.4}));
    call('addSegments', () => editor.addSegments([{length: 20, angle: 0.1}, {length: 12, angle: -0.6, thickness: 4}]));
    at(editor, q.radials[1]);
    call('addSegment', () => editor.addSegment({length: 25, angle: 1.2, type: 'circle'}));
  });
  assert.ok(steps.addSegment.every(step => step.changed && !step.error) && steps.addSegments[0].changed);
});

refs.test('a face visibility surface is checked against the joints on show and stored with the polygon', {skip: !engineBuilt}, async take => {
  const {document, q} = await cube(take);
  const steps = await same(take, SHEET, document, (editor, call) => {
    call('back', () => editor.updatePolygon(0, {surface: {basis: q.basis, side: 'back'}}));
    call('flipped', () => editor.updatePolygon(0, {surface: {basis: q.basis, side: 'back', flipped: true}}));
    call('depth', () => editor.updatePolygon(1, {surface: {basis: q.basis, depth: [q.depth]}}));
    call('same', () => editor.updatePolygon(0, {surface: {basis: q.basis, side: 'back', flipped: true}}));
    call('off', () => editor.updatePolygon(0, {surface: null}));
    for (const [name, surface] of Object.entries({missing: {basis: [0, 1, 999]}, repeated: {basis: [0, 0, 1]}, side: {basis: q.basis, side: 'both'}, flat: {basis: [0, q.turn, q.turn + 0]}, depthTest: {basis: q.basis, depthTest: true}}))
      call(name, () => editor.updatePolygon(0, {surface}));
  });
  assert.ok(steps.back[0].changed && steps.flipped[0].changed && steps.depth[0].changed && steps.off[0].changed);
  assert.equal(steps.same[0].changed, false, 'the same surface changes nothing');
  for (const name of ['missing', 'repeated', 'side', 'flat', 'depthTest']) assert.ok(steps[name][0].error, `${name} is refused with the editor's message`);
});

refs.test('a sprite attaches to a joint of a rigged figure', {skip: !engineBuilt}, async take => {
  const {document, q} = await cube(take);
  const steps = await same(take, SHEET, document, (editor, call) => {
    at(editor, q.top[2]);
    call('addSpriteSegment', () => editor.addSpriteSegment(sprite()));
    at(editor, q.turn);
    call('addSpriteSegment', () => editor.addSpriteSegment(sprite({x: 0, y: 0}, {x: 10, y: 10}), {angle: 0.5}));
  });
  assert.ok(steps.addSpriteSegment.every(step => step.changed && !step.error));
  assert.equal(steps.addSpriteSegment[0].undo, 'Add sprite segment');
});

refs.test('a sprite attached over a pose that only holds derived lengths keeps them', {skip: !engineBuilt}, async take => {
  const report = walker();
  for (const frame of report.keyframes) {
    const object = frame.objects[0], figure = report.figure_types[0];
    object.runtime_segments = figure.segments.map((segment, index) => ({angle_rad: object.angles[index], length: segment.length + 7, bend_rad: 0.15}));
  }
  const steps = await same(take, SHEET, report, (editor, call) => {
    editor.select(1, 3);
    call('addSpriteSegment', () => editor.addSpriteSegment(sprite()));
  });
  assert.ok(steps.addSpriteSegment[0].changed && !steps.addSpriteSegment[0].error);
});

refs.test('deleting segments named by a Set of selected joints', {skip: !engineBuilt}, async take => {
  const steps = await same(take, SHEET, walker(), (editor, call) => {
    editor.select(1, 2);
    call('delete one', () => editor.deleteSegment({handleIds: editor.selectedSegmentIds, branch: false}));
    editor.select(1, 1); editor.toggleSegment(1, 4); editor.toggleSegment(1, 5);
    call('selected', () => [...editor.selectedSegmentIds]);
    call('delete several', () => editor.deleteSegment({handleIds: editor.selectedSegmentIds, branch: false}));
    editor.select(1, 3);
    call('delete branch', () => editor.deleteSegment({handleIds: editor.selectedSegmentIds}));
  });
  assert.ok(steps['delete one'][0].changed && steps['delete several'][0].changed && steps['delete branch'][0].changed);
  assert.equal(steps['delete several'][0].undo, 'Delete selected segments');
});

refs.test('a 3D mesh stays valid through topology edits and keeps the joints it is bound to', {skip: !engineBuilt}, async take => {
  const document = read('../engine/crates/styk-eval/tests/fixtures/spatial/mesh-sheet.json');
  const steps = await same(take, SHEET, document, (editor, call) => {
    editor.select(1, 0);
    call('add', () => editor.addSegment({parentId: 0, length: 40, angle: 0.3}));
    call('delete single', () => editor.deleteSingleSegment());
    at(editor, 1);
    call('split', () => editor.splitBuilderSegments({branch: false}));
    at(editor, 1);
    call('duplicate', () => editor.duplicateSegment({angleOffset: 0.4}));
    at(editor, 1);
    call('delete branch', () => editor.deleteSegment());
    // The joints the mesh is bound to and oriented by (2 and 3, 6 and 9) stay.
    at(editor, 2);
    call('delete basis', () => editor.deleteSegment());
    at(editor, 6);
    call('delete bound', () => editor.deleteSegment());
    at(editor, 9);
    call('delete bone', () => editor.deleteSingleSegment());
    call('unsplit bone', () => editor.unsplitSegment());
    at(editor, 6);
    call('delete bone with children', () => editor.deleteSegment({handleIds: [6], branch: true}));
  });
  for (const name of ['add', 'delete single', 'split', 'duplicate', 'delete branch']) assert.ok(steps[name][0].changed && !steps[name][0].error, name);
  for (const name of ['delete basis', 'delete bound', 'delete bone', 'unsplit bone', 'delete bone with children'])
    assert.equal(steps[name][0].error, 'errors.surfaces.thisJointMovesOrOrientsThe3dMesh', name);
});

refs.test('topology edits of a figure with pose choices are validated with them', {skip: !engineBuilt}, async take => {
  const document = read('../engine/tests/edit/ik-spatial-free.document.json');
  const figure = document.figure_types[0], bones = figure.segments.filter(segment => segment._stykRig?.spatial?.origin);
  figure._styk = {...figure._styk, poseChoices: [{name: 'Hand', choices: [
    {id: 1, label: 'Open', angles: [[bones[1].segment_id, 0.2]], lengths: []},
    {id: 2, label: 'Closed', angles: [[bones[1].segment_id, 1.1]], lengths: []},
  ]}]};
  const hidden = figure.segments.find(segment => segment._stykRig?.spatial?.origin && segment.length > 0 && segment.segment_id !== bones[1].segment_id);
  hidden._stykPoseChoice = {group: 'Mouth', label: 'Wide', shown: hidden.length, hidden: 0};
  const steps = await same(take, SHEET, document, (editor, call) => {
    editor.select(1, 0);
    call('add', () => editor.addSegment({parentId: 0, length: 33, angle: 0.2}));
    call('add chain', () => editor.addSegments([{length: 10, angle: 0.1}, {length: 12, angle: 0.5}]));
    at(editor, 1);
    call('delete', () => editor.deleteSingleSegment());
    // The bone a choice names cannot go.
    at(editor, bones[1].segment_id);
    call('delete choice bone', () => editor.deleteSegment({handleIds: [bones[1].segment_id], branch: false}));
    call('unsplit choice bone', () => editor.unsplitSegment());
  });
  assert.ok(steps.add[0].changed && steps['add chain'][0].changed && steps.delete[0].changed && !steps.delete[0].error);
  assert.ok(steps['delete choice bone'][0].error, 'a pose choice needs the bone it names');
});

refs.test('duplicating a 3D joint renames the joints its rig names to the copies', {skip: !engineBuilt}, async take => {
  const document = read('../engine/tests/edit/ik-spatial-free.document.json');
  const bone = document.figure_types[0].segments.find(segment => segment._stykRig?.spatial?.origin && segment.parent_id === 7).segment_id;
  const steps = await same(take, SHEET, document, (editor, call) => {
    at(editor, 7);
    call('duplicate', () => editor.duplicateSegment({angleOffset: 0.3}));
    at(editor, 7);
    call('duplicate branch', () => editor.duplicateSegmentBranch());
    at(editor, bone);
    call('duplicate bone', () => editor.duplicateSegment({parentId: 0, flip: true}));
  });
  assert.ok(steps.duplicate[0].changed && steps['duplicate branch'][0].changed);
});

refs.test('the controllers of figures joined to an edited figure follow its handles', {skip: !engineBuilt}, async take => {
  const document = read('../engine/crates/styk-eval/tests/fixtures/ik/joined.json');
  const steps = await same(take, SHEET, document, (editor, call) => {
    editor.select(3, 0);
    call('switch on', () => editor.setNodeIK({enabled: true}));
    editor.select(1, 0);
    call('split', () => editor.splitBuilderSegments({branch: false}));
    call('controllers', () => editor.report.keyframes.map(frame => frame.objects[1]._stykIK));
    editor.select(2, 1);
    call('add', () => editor.addSegment({length: 20, angle: 0.4}));
    editor.select(2, 0);
    call('duplicate', () => editor.duplicateSegment({angleOffset: 0.2}));
    editor.select(1, 1);
    call('unsplit', () => editor.unsplitSegment());
    editor.select(2, 0);
    call('flip', () => editor.mirrorSegment('horizontal', {branch: true}));
    editor.select(2, 1);
    call('delete', () => editor.deleteSingleSegment());
  });
  for (const name of ['split', 'add', 'duplicate']) assert.ok(steps[name][0].changed, name);
  const [first] = JSON.parse(steps.controllers[0].result);
  assert.ok(first['22']?.chainLength >= 1 && first['22'].followers, 'the controller of the joined figure is still there');
});

/** The default figure with a saved animation of one segment's opacity (the baseline an imported file brings), built by a plain editor once: its reference. */
async function animated(take) {
  return JSON.parse(await take('animated'));
}

refs.test('saved channels follow the segment they animate through topology edits', {skip: !engineBuilt}, async take => {
  const document = await animated(take);
  const steps = await same(take, SHEET, document, (editor, call) => {
    const channels = () => editor.report._styk.layerSheet.legacyAnimation.channels.map(channel => [channel.id, channel.keys.map(key => key.id)]);
    call('channels', channels);
    at(editor, 5);
    call('split', () => editor.splitBuilderSegments({branch: false}));
    call('after split', channels);
    at(editor, 5);
    call('duplicate', () => editor.duplicateSegment({angleOffset: 0.4}));
    call('after duplicate', channels);
    editor.select(1, 3);
    call('unsplit', () => editor.unsplitSegment());
    at(editor, 5);
    call('delete', () => editor.deleteSingleSegment());
    call('after delete', channels);
  });
  assert.ok(steps.split[0].changed && steps.duplicate[0].changed);
  const channels = name => JSON.parse(steps[name][0].result);
  assert.equal(channels('channels').length, 1);
  // Split, the animation reaches the far piece with keys of its own; duplicated, the copy; deleted, the segment's own goes.
  assert.deepEqual([channels('after split').length, channels('after duplicate').length, channels('after delete').length], [2, 3, 2]);
  assert.equal(channels('after split')[1][1].length, channels('channels')[0][1].length, 'the piece has as many keys as the channel it comes from');
  assert.ok(channels('after split')[1][1].every(key => !channels('channels')[0][1].includes(key)));
});

refs.test('a fill, several joints or a branch selected do not send the next call to the editor', {skip: !engineBuilt}, async take => {
  const {document, q} = await cube(take);
  const steps = await same(take, SHEET, document, (editor, call) => {
    const uid = editor.selectedUid;
    call('selectPolygon', () => editor.selectPolygon(uid, 2));
    call('recolor', () => editor.updatePolygon(2, {color: '#ff3366'}));
    call('face', () => editor.updatePolygon(2, {surface: {basis: q.basis, side: 'back'}}));
    call('remove', () => editor.removePolygon(2));
    call('add', () => editor.addPolygon(q.cycles[3], {color: '#00aa44'}));
    editor.select(uid, jointOf(editor, q.top[0]));
    call('toggle', () => editor.toggleSegment(uid, jointOf(editor, q.top[1])));
    call('chosen', () => [...editor.selectedSegmentIds]);
    call('style', () => editor.updateBuilderSegmentStyle({thickness: 9}));
    call('bind', () => editor.bindStretchParts(q.depth));
    call('select branch', () => editor.selectBranch(uid, jointOf(editor, q.radials[0])));
    call('thickness', () => editor.changeBranchThickness(2));
    call('order', () => editor.orderSelection('front'));
    call('flip', () => editor.mirrorFigure('horizontal'));
  });
  assert.deepEqual(steps.chosen[0].result && JSON.parse(steps.chosen[0].result).length, 2);
  for (const name of ['recolor', 'face', 'remove', 'add', 'style', 'bind', 'flip']) assert.ok(steps[name][0].changed || steps[name][0].error, name);
});

refs.test('flipping, ordering, styling and deleting a selected branch or several joints', {skip: !engineBuilt}, async take => {
  const steps = await same(take, SHEET, walker(), (editor, call) => {
    // Two forearms chosen with Shift.
    at(editor, 1);
    call('stretch driver', () => editor.enableSmartStretch(true));
    editor.select(1, 3);
    call('toggle', () => editor.toggleSegment(1, 5));
    call('style two', () => editor.updateBuilderSegmentStyle({thickness: 3}));
    call('stretch two', () => editor.bindStretchParts(1));
    call('flip two', () => editor.mirrorFigure('vertical'));
    call('order two', () => editor.orderSelection('back'));
    // An arm, then a leg with the figure joined to its end.
    call('arm', () => editor.selectBranch(1, 2));
    call('flip arm', () => editor.mirrorFigure('horizontal'));
    call('order arm', () => editor.orderSelection(1));
    call('style arm', () => editor.updateBuilderSegmentStyle({thickness: 11}, {branch: true}));
    call('leg', () => editor.selectBranch(1, 8));
    call('uids', () => [...editor.selectedUids]);
    call('flip leg', () => editor.mirrorFigure('horizontal'));
    call('flip leg selection', () => editor.mirrorSelection('vertical'));
    call('rotate', () => editor.rotateSelection(0.2));
    call('delete leg', () => editor.deleteSelection());
    call('arm again', () => editor.selectBranch(1, 4));
    call('delete arm', () => editor.deleteSegment());
  });
  for (const name of ['stretch driver', 'style two', 'stretch two', 'flip two', 'flip arm', 'order arm', 'style arm', 'flip leg', 'flip leg selection', 'rotate', 'delete leg', 'delete arm'])
    assert.ok(steps[name][0].changed && !steps[name][0].error, name);
  assert.equal(JSON.parse(steps.uids[0].result).length, 2, 'the figure joined to the leg is selected with it');
  assert.equal(steps['delete leg'][0].undo, 'Delete segment branches');
});

refs.test('copying a selected branch hands the clipboard a definition of its own, and the session pastes it', {skip: !engineBuilt}, async take => {
  const steps = await same(take, SHEET, walker(), (editor, call) => {
    call('select', () => editor.selectBranch(1, 4));
    call('copy', () => editor.copySelection());
    // The branch is extracted as a definition of its own, which pastes as a new one.
    call('paste', () => editor.pasteSelection());
    editor.selectBranch(1, 6);
    call('duplicate', () => editor.duplicateSelection());
    editor.selectBranch(1, 4);
    call('cut', () => editor.cutSelection());
  });
  for (const name of ['paste', 'duplicate', 'cut']) assert.ok(steps[name][0].changed && !steps[name][0].error, name);
});

refs.test('topology edits of poses that only hold derived lengths keep them', {skip: !engineBuilt}, async take => {
  const report = walker();
  for (const frame of report.keyframes) {
    const object = frame.objects[0], figure = report.figure_types[0];
    object.runtime_segments = figure.segments.map((segment, index) => ({angle_rad: object.angles[index], length: segment.length + 7, bend_rad: 0.15}));
  }
  const steps = await same(take, SHEET, report, (editor, call) => {
    editor.select(1, 3);
    call('duplicate', () => editor.duplicateSegment({angleOffset: 0.2}));
    editor.select(1, 3);
    call('split', () => editor.splitBuilderSegments({branch: false}));
    editor.select(1, 3);
    call('mirror', () => editor.mirrorSegment('horizontal'));
    editor.select(1, 5);
    call('move', () => editor.moveBuilderSegment(6, {parentId: 3}));
    editor.select(1, 3);
    call('unsplit', () => editor.unsplitSegment());
    editor.select(1, 8);
    call('delete', () => editor.deleteSingleSegment());
  });
  for (const name of ['duplicate', 'split', 'mirror', 'move', 'unsplit', 'delete']) assert.ok(steps[name][0].changed && !steps[name][0].error, name);
});
