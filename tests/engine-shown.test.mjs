// The frame on show, its geometry and the timeline come from the engine's session (docs/engine/evaluation.md,
// "The interface's frame"): the groups the canvas reads, kept by identity while a gesture moves other figures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {holdsRevision, registeredEngine} from '../src/engine/engine-open.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';
import {createDemo} from '../src/demo.mjs';

const folder = new URL('../engine/crates/styk-eval/tests/fixtures/channels/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, folder), 'utf8'));
const options = {demo: false, layerTimeline: true, propertyChannels: true};

/** Figures 1 and 2, 3 hanging from 2, and 4 alone, on a layer sheet. */
const poses = () => ownedEditor(options, read('channels-pose.sheet.json'));

test('the frame, geometry and timeline are the session\'s', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await poses();
  try {
    assert.ok(editor._shown.active, 'the engine answers for the open document');
    editor.seek(11);
    const frame = editor.evaluatedFrame, geometry = editor.geometry;
    assert.equal(frame.objects.length, 4);
    assert.deepEqual([...geometry.objects.keys()], [0, 1, 2, 3]);
    for (const [slot, group] of geometry.objects) {
      const figure = editor.report.figure_types.find(type => type.figure_type_id === frame.objects[slot].figure_type_id);
      assert.equal(group.obj, frame.objects[slot], 'a group is of the object of its slot');
      assert.equal(group.segments.length, figure.segments.length, 'a shape for every segment, drawn or not');
      assert.deepEqual([...group.joints.keys()], [0, ...figure.segments.map(segment => segment.segment_id)], 'the root, then a joint for each segment');
      assert.equal(group.joints.get(0), group.root);
      group.segments.forEach((shape, index) => {
        assert.equal(shape.index, index);
        assert.equal(shape.seg, figure.segments[index]);
        assert.deepEqual(group.joints.get(shape.seg.segment_id), shape.end, 'a segment ends where its joint is');
        assert.ok(Number.isFinite(shape.start.x) && Number.isFinite(shape.length));
      });
    }
    assert.equal(geometry.orderedObjects.every(group => group.drawables.length > 0), true, 'the objects in painter order have artwork');
    assert.equal(editor.timeline.at(-1).start + editor.timeline.at(-1).count, editor.totalTicks);
    assert.ok(editor.totalTicks > 11);
    // The same geometry is read again as it was held.
    assert.equal(editor.geometry, geometry);
    editor._invalidate();
    assert.equal(editor.geometry, geometry, 'nothing changed: the groups held are the answer');
  } finally { owner.release(); }
});

test('a gesture rebuilds the groups of the figures it moves and keeps the others', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await poses();
  try {
    editor.seek(11);
    const slotOf = uid => editor.evaluatedFrame.objects.findIndex(object => object.unique_id === uid);
    const before = editor.geometry, alone = slotOf(4);
    editor.select(4, -1);
    editor.beginTranslationDrag();
    editor.moveSelection(12, 0, {fromStart: true});
    const during = editor.geometry;
    assert.notEqual(during, before);
    assert.equal(during.objects.get(alone).root.x, before.objects.get(alone).root.x + 12, 'the moved figure is where the gesture put it');
    for (const [slot, group] of before.objects) if (slot !== alone) assert.equal(during.objects.get(slot), group, `the group of slot ${slot} is the one already held`);
    assert.deepEqual([...during.changedSlots], [alone]);
    editor.cancelDrag();
    assert.equal(editor.geometry.objects.get(alone).root.x, before.objects.get(alone).root.x, 'cancelled: the figure is back');
    // Moving the figure another hangs from moves both.
    editor.select(3, -1);
    const joined = [2, 3].map(uid => slotOf(uid)), held = editor.geometry;
    editor.beginTranslationDrag();
    editor.moveSelection(5, 5, {fromStart: true});
    const moved = editor.geometry;
    for (const slot of joined) assert.notEqual(moved.objects.get(slot), held.objects.get(slot), `slot ${slot} moves with what it hangs from`);
    for (const slot of [1, 4].map(uid => slotOf(uid))) assert.equal(moved.objects.get(slot), held.objects.get(slot), `slot ${slot} is not joined to them`);
    editor.cancelDrag();
  } finally { owner.release(); }
});

test('posing a joint rebuilds the group of the figure posed alone, and undo and redo put the joint back and where it was posed', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await poses();
  try {
    editor.seek(11);
    const slotOf = uid => editor.evaluatedFrame.objects.findIndex(object => object.unique_id === uid);
    const before = editor.geometry, alone = slotOf(4);
    const figure = editor.report.figure_types.find(type => type.figure_type_id === editor.evaluatedFrame.objects[alone].figure_type_id);
    const joint = figure.segments.length - 1, end = {...before.objects.get(alone).segments[joint].end};
    editor.select(4, joint);
    assert.equal(editor.beginDrag('Pose joint'), true);
    assert.equal(editor.poseJoint(end.x + 30, end.y + 30, {snap: false}), true);
    const during = editor.geometry;
    assert.deepEqual([...during.changedSlots], [alone], 'the figure that was posed is the only group read');
    for (const [slot, group] of before.objects) if (slot !== alone) assert.equal(during.objects.get(slot), group, `the group of slot ${slot} is the one already held`);
    // A second pose reads the figure again, and still no other.
    assert.equal(editor.poseJoint(end.x + 40, end.y + 10, {snap: false}), true);
    assert.deepEqual([...editor.geometry.changedSlots], [alone]);
    editor.commitDrag();
    const posed = {...editor.geometry.objects.get(alone).segments[joint].end};
    assert.notDeepEqual(posed, end, 'the joint moved');
    editor.undo();
    assert.deepEqual(editor.geometry.objects.get(alone).segments[joint].end, end, 'undo puts the joint back');
    editor.redo();
    assert.deepEqual(editor.geometry.objects.get(alone).segments[joint].end, posed, 'redo puts it where it was posed');
  } finally { owner.release(); }
});

test('a movieclip being edited is a document of the engine like any other: its session answers and the stage draws it', {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/startup.document.json', import.meta.url), 'utf8'));
  const {editor, owner} = await ownedEditor(options, document);
  const engine = registeredEngine();
  try {
    const project = owner.session();
    editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
    const clip = editor.createMovieclip({start: editor.tick, end: editor.tick + 6});
    editor.enterMovieclip(clip.figure_type_id);
    assert.ok(editor._movieclipScopes.length, 'the movieclip is open for editing');
    assert.notEqual(owner.session(), project, 'the clip has a session of its own');
    assert.ok(editor._shown.frame(), 'the clip\'s session answers for its frame');
    assert.ok(editor._shown.geometry(editor.evaluatedFrame), 'and its geometry');
    assert.equal(editor._shown.source(false)?.session, owner.session(), 'the stage draws the clip\'s session, not poses from the editor');
    assert.ok(holdsRevision(engine, editor.revision), 'the clip is the engine\'s document');
    editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
    const before = editor.evaluatedFrame.objects[0].root_x;
    editor.moveSelection(25, 10);
    assert.equal(editor.evaluatedFrame.objects[0].root_x, before + 25, 'the frame follows the edit');
    assert.equal(editor.geometry.objects.get(0).root.x, before + 25);
    assert.ok(holdsRevision(engine, editor.revision), 'the engine holds the clip as it is edited');
    editor.leaveMovieclip();
    assert.equal(owner.session(), project, 'back in the project its session answers');
    assert.ok(editor._shown.frame());
    assert.equal(editor._shown.source(false)?.session, project);
    assert.ok(holdsRevision(engine, editor.revision), 'and the engine holds the project at its revision');
  } finally { owner.release(); }
});

test('a detached editor has a session of its own and leaves the open project the engine\'s document', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await poses();
  const engine = registeredEngine();
  try {
    assert.ok(holdsRevision(engine, editor.revision), 'the project is the engine\'s document');
    const test = new Editor({demo: false, layerTimeline: true}), tester = installEngineOwner(test, {detached: true});
    try {
      test.load(read('channels-pose.sheet.json'));
      assert.ok(tester.ready(), 'the test editor has its own session');
      const object = test.evaluatedFrame.objects[0], figure = test.report.figure_types.find(type => type.figure_type_id === object.figure_type_id);
      test.select(object.unique_id, figure.segments.length - 1);
      const joint = test.geometry.objects.get(0).segments[figure.segments.length - 1], end = {...joint.end};
      assert.equal(test.beginDrag('Test pose'), true);
      assert.equal(test.poseJoint(end.x + 40, end.y + 40, {snap: false}), true);
      assert.notDeepEqual(test.geometry.objects.get(0).segments[figure.segments.length - 1].end, end, 'posing moves the joint the test shows');
      test.commitDrag();
      assert.ok(holdsRevision(engine, editor.revision), 'the project is still the engine\'s document');
      assert.equal(editor._shown.source(false)?.session, owner.session(), 'and the stage draws from its session');
    } finally { tester.release(); }
  } finally { owner.release(); }
});

/** Counts the reads the owner makes of the session by name. */
function spy(session) {
  const ask = session.query.bind(session), asked = [];
  session.query = (kind, ...rest) => { asked.push(kind); return ask(kind, ...rest); };
  return asked;
}

test('the values the interface shows are the session\'s reads', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await poses();
  try {
    editor.seek(11);
    const asked = spy(owner.session());
    const object = editor.evaluatedFrame.objects.find(candidate => candidate.unique_id === 4);
    assert.equal(editor.animationValue({kind: 'figure', uid: 4}, 'x'), object.root_x);
    assert.equal(editor.animationValue({kind: 'figure', uid: 999}, 'x'), undefined, 'a figure that is not there has no value');
    assert.deepEqual(editor.segmentAnimationTarget(4, 2, 'x'), {kind: 'segment', uid: 4, handleId: 2});
    assert.deepEqual(editor.vfxEffects({kind: 'figure', uid: 4}), []);
    editor.select(4, 0);
    assert.equal(editor.getIKSettings().enabled, false);
    assert.ok(editor.getIKSettings().maxLength >= 1);
    assert.deepEqual(asked.filter(kind => !['frame', 'document', 'geometry', 'timeline', 'motion'].includes(kind)),
      ['animationValue', 'animationValue', 'segmentAnimationTarget', 'vfxEffects', 'getIKSettings', 'getIKSettings']);
    assert.throws(() => editor.animationValue({kind: 'figure', uid: 4}, 'x', -1), /keyframeTimeMustBeAnIntegerFrom0|integer from 0/i);
  } finally { owner.release(); }
});

test('a document the session does not answer property values for raises its refusal', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await ownedEditor({demo: false}, createDemo());
  try {
    const asked = spy(owner.session());
    const object = editor.evaluatedFrame.objects[0];
    assert.throws(() => editor.animationValue({kind: 'figure', uid: object.unique_id}, 'x'), /without a layer sheet/);
    assert.ok(asked.includes('animationValue'), 'the session was asked');
  } finally { owner.release(); }
});

test('a refusal of the session is raised, whatever it says', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await poses();
  try {
    editor.seek(11);
    const expected = editor.evaluatedFrame;
    const session = owner.session(), ask = session.query.bind(session);
    session.query = () => { throw new Error('unported: geometry with a feature of its own'); };
    editor._invalidate();
    assert.throws(() => editor.evaluatedFrame, /unported: geometry with a feature of its own/);
    session.query = () => { throw new Error('errors.something.invalid'); };
    editor._invalidate();
    assert.throws(() => editor.evaluatedFrame, /errors\.something\.invalid/);
    session.query = ask;
    editor._invalidate();
    assert.equal(editor.evaluatedFrame.objects.length, expected.objects.length);
  } finally { owner.release(); }
});

test('a motion-path edit shows the pose it makes at the playhead, and its geometry, while the playhead is in the ticks it changes', {skip: !engineBuilt}, async () => {
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/motion-path.document.json', import.meta.url), 'utf8'));
  const {editor, owner} = await ownedEditor(options, document);
  try {
    editor.select(1, -1);
    editor.seek(6);
    const before = editor.evaluatedFrame.objects.find(object => object.unique_id === 1).root_x;
    editor.beginMotionPathEdit({kind: 'node', uid: 1, handleId: 0, joint: -1}, 6);
    assert.equal(editor._drag.display, null, 'nothing moved yet: the document is shown');
    editor.updateMotionPathEdit({x: 260, y: 170});
    const drag = editor._drag, display = drag.display;
    assert.ok(drag.motionPath && display, 'the playhead is inside the ticks the edit changes');
    const shown = display.frame.objects.find(object => object.unique_id === 1);
    assert.notEqual(shown.root_x, before, "the pose shown is the edit's, not the document's");
    assert.equal(editor.evaluatedFrame.objects.find(object => object.unique_id === 1).root_x, before, "the frame on show stays the document's");
    const geometry = display.geometry, slot = display.frame.objects.indexOf(shown);
    assert.equal(geometry.objects.get(slot).root.x, shown.root_x, 'its geometry is built from the pose it shows');
    assert.notEqual(geometry.objects.get(slot).root.x, editor.geometry.objects.get(slot).root.x, "and is not the document's");
    editor.updateMotionPathEdit({x: 272, y: 182});
    assert.notEqual(drag.display.frame.objects.find(object => object.unique_id === 1).root_x, shown.root_x, 'a later move shows its own pose');
    editor.commitMotionPathEdit();
    assert.equal(editor._drag, null);
  } finally { owner.release(); }
});

test('a group lists its joints in the order they are worked out: roots first, then the children of each joint', {skip: !engineBuilt}, async () => {
  // The demo figure: the order the editor's own geometry listed them in (a tie between coincident joints keeps its pick).
  const {editor} = await ownedEditor(options, createDemo());
  const group = editor.geometry.objects.values().next().value;
  assert.deepEqual([...group.joints.keys()], [0, 1, 7, 9, 2, 3, 5, 8, 10, 4, 6]);
});
