// A movieclip the engine cannot hold is refused, and the session stays alive with the project as it was (docs/engine/editing.md, "Making a
// clip"). The engine's memory limit is lowered for the call and put back: a clip of every figure of a large project made the engine run
// out of memory and trap, which loses the project.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registeredEngine} from '../src/engine/engine-open.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

const options = {demo: false, layerTimeline: true, propertyChannels: true};
const MiB = 1 << 20;
/** The cost the engine reserves for any call, below which every call is refused before it begins. */
const CALL_WORKING = 64 * MiB;

function crowd(count) {
  const document = emptyDocument(), figure = document.figure_types[0];
  for (let id = 11; id < 71; id++) figure.segments.push({...figure.segments[2], segment_id: id, parent_id: 1, z_order: id});
  figure.segment_count = figure.segments.length;
  document.keyframes = Array.from({length: 6}, (_, index) => createFrame(Array.from({length: count}, (_, slot) => createObject(figure, slot + 1, 100 + index + slot * 40, 100)), 1));
  return document;
}

/** Runs `body` with the engine able to take `headroom` bytes more than it holds now, and puts its limit back. */
async function withHeadroom(headroom, body) {
  const engine = registeredEngine(), before = engine.handle.limit_memory(Math.ceil((engine.memory().liveBytes + headroom) * 16 / 15));
  try { return await body(); } finally { engine.handle.limit_memory(before); }
}

const session = count => ownedEditorSync(options, crowd(count), {verify: false});

test('a clip the engine cannot take is refused before it is made, and the project is as it was', async () => {
  const {editor, owner} = session(6);
  editor.select(null);
  const before = owner.session().report_json(), depth = editor._undo.length;
  // Room for the call itself but not for the records the clip copies.
  await withHeadroom(CALL_WORKING + 64 * 1024, () => {
    assert.throws(() => editor.createMovieclip({start: 0, end: 4, uids: []}), /not enough memory/);
  });
  assert.equal(owner.session().report_json(), before, 'the document is as it was');
  assert.equal(editor._undo.length, depth, 'no entry was made');
  assert.equal(editor.report.figure_types.length, 1, 'and no figure');
  // The session is alive: with the room back, the same call runs, and undoes and redoes.
  const clip = editor.createMovieclip({start: 0, end: 4, uids: []});
  assert.ok(clip.figure_type_id > 1);
  await editor.undo();
  assert.equal(owner.session().report_json(), before);
  await editor.redo();
  assert.equal(editor.report.figure_types.length, 2);
});

test('a redo the engine cannot take is refused with the clip as it was, and runs when there is room', async () => {
  const {editor, owner} = session(4);
  editor.select(null);
  editor.createMovieclip({start: 0, end: 4, uids: []});
  const made = owner.session().report_json();
  await editor.undo();
  const undone = owner.session().report_json();
  await withHeadroom(32 * MiB, async () => {
    await assert.rejects(async () => editor.redo(), /not enough memory/);
  });
  assert.equal(owner.session().report_json(), undone, 'nothing was redone');
  assert.equal(editor.canRedo, true, 'the entry is still there to redo');
  await editor.redo();
  assert.equal(owner.session().report_json(), made);
});

test('entering a clip the engine cannot take is refused, and the project stays open', async () => {
  const {editor, owner} = session(4);
  editor.select(null);
  const clip = editor.createMovieclip({start: 0, end: 4, uids: []});
  const report = editor.report;
  await withHeadroom(16 * MiB, () => {
    assert.throws(() => editor.enterMovieclip(clip.figure_type_id), /not enough memory/);
  });
  assert.equal(editor.report, report, 'still the project');
  assert.ok(!editor._movieclipScopes?.length);
  assert.equal(owner.sessions(), 1);
  editor.enterMovieclip(clip.figure_type_id);
  assert.equal(editor._movieclipScopes.length, 1, 'and it enters once there is room');
});

/** A project holding a movieclip of `count` figures: the copy of the clip's list of objects alone is a request the engine refuses when it reaches into its reserve. */
function projectWithBigClip(count) {
  const small = emptyDocument();
  small.keyframes = [createFrame(Array.from({length: 2}, (_, slot) => createObject(small.figure_types[0], slot + 1, 100 + slot * 40, 100)), 1)];
  const made = ownedEditorSync(options, small, {verify: false});
  made.editor.select(null);
  const clip = made.editor.createMovieclip({start: 0, end: 1, uids: []});
  const project = JSON.parse(made.owner.session().report_json());
  const frame = project.figure_types.find(figure => figure.figure_type_id === clip.figure_type_id)._styk.movieclip.document.keyframes[0];
  const template = frame.objects[0];
  frame.objects = Array.from({length: count}, (_, index) => ({...template, unique_id: index + 1, object_slot: index, root_x: index}));
  frame.object_draw_order = frame.objects.map((_, index) => index);
  frame.object_draw_order_unique_ids = frame.objects.map((_, index) => index + 1);
  made.owner.release();
  return {project, clipId: clip.figure_type_id};
}

test('entering a clip with no room even to copy it is refused before anything is copied, and the project stays open', async () => {
  // The copy was made before the memory was asked for: the module trapped, and answered "recursive use of an object" to every call after it.
  const {project, clipId} = projectWithBigClip(20000);
  const {editor, owner} = ownedEditorSync(options, project, {verify: false});
  const report = editor.report;
  await withHeadroom(1024, () => {
    assert.throws(() => editor.enterMovieclip(clipId), /not enough memory/);
  });
  assert.equal(editor.report, report, 'still the project');
  assert.equal(owner.sessions(), 1);
  // The session is alive: the next call runs, and so does the entry once there is room.
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(3, 4);
  editor.enterMovieclip(clipId);
  assert.equal(editor._movieclipScopes.length, 1);
});

test('leaving a clip of 20,000 figures is refused cleanly with no room, and runs with the reservation of the call and little more', async () => {
  const {project, clipId} = projectWithBigClip(20000);
  const {editor, owner} = ownedEditorSync(options, project, {verify: false});
  editor.enterMovieclip(clipId);
  const inside = editor.report;
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(25, 10);
  const edited = owner.session().report_json();
  await withHeadroom(1024, () => {
    assert.throws(() => editor.leaveMovieclip(), /not enough memory/);
  });
  assert.equal(editor.report, inside, 'still in the clip');
  assert.equal(editor._movieclipScopes.length, 1);
  // The next call or read of the clip is the clip session's again.
  assert.ok(owner.ready());
  assert.equal(owner.session().report_json(), edited, 'with the edit it had');
  // The copy of the clip is part of what the call reserves, not memory on top of it: with the call's own reservation and little more, leaving runs
  // (the copy was made first and then the reservation was asked for, which failed here), and the edit reaches the project.
  await withHeadroom(66 * MiB, () => editor.leaveMovieclip());
  assert.equal(editor._movieclipScopes.length, 0);
  assert.equal(editor.undoLabel, 'Edit movieclip');
});

test('a clip of two million small arrays, which its text does not show, is refused cleanly when entered and left with too little room', async () => {
  // The copy that gives the text's arrays allocates for each of them (a header, a list, an owner): two million arrays of one number are a few
  // megabytes of text and hundreds of megabytes of copy, and the reservation was sized from the text (the module trapped inside the copy).
  const {project, clipId} = projectWithBigClip(40);
  project.figure_types.find(figure => figure.figure_type_id === clipId)._styk.movieclip.document._styk.padding = Array.from({length: 2_000_000}, () => [0]);
  const {editor, owner} = ownedEditorSync(options, project, {verify: false});
  const report = editor.report;
  editor.enterMovieclip(clipId);
  const inside = editor.report;
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(25, 10);
  await withHeadroom(66 * MiB, () => {
    assert.throws(() => editor.leaveMovieclip(), /not enough memory/);
  });
  assert.equal(editor.report, inside, 'still in the clip');
  // The sessions are alive: the next call is answered (a trapped module answers "recursive use of an object"), and leaving runs with room.
  assert.ok(owner.ready());
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.leaveMovieclip();
  assert.equal(editor._movieclipScopes.length, 0);
  assert.equal(editor.report, report);
  // Entering it needs as much room, which it says it does not have.
  await withHeadroom(150 * MiB, () => {
    assert.throws(() => editor.enterMovieclip(clipId), /not enough memory/);
  });
  assert.equal(editor.report, report, 'still the project');
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(3, 4);
});

test('entering and leaving a clip twenty times returns the memory of the engine to its level', async () => {
  // A closed session's document is dropped by the engine's workers; where the engine has none, its work runs in slices that closing a session
  // has to start. Before that, each cycle left the clip's document in memory until something else started the slices.
  const {project, clipId} = projectWithBigClip(3000);
  const {editor} = ownedEditorSync(options, project, {verify: false});
  const engine = registeredEngine(), settle = async () => { for (let turn = 0; turn < 6; turn++) await new Promise(resolve => setTimeout(resolve, 50)); };
  editor.enterMovieclip(clipId); editor.leaveMovieclip(); await settle();
  const level = engine.memory().liveBytes;
  for (let cycle = 0; cycle < 20; cycle++) {
    editor.enterMovieclip(clipId);
    editor.leaveMovieclip();
  }
  await settle();
  const grown = engine.memory().liveBytes - level;
  assert.ok(grown < 4 * MiB, `the engine holds ${(grown / MiB).toFixed(1)} MiB more than before the twenty cycles`);
});

test('a clip whose edit the project cannot take stays open with the edit, to leave again', async () => {
  const {editor, owner} = session(4);
  editor.select(null);
  const clip = editor.createMovieclip({start: 0, end: 4, uids: []});
  editor.enterMovieclip(clip.figure_type_id);
  const inside = editor.report;
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(25, 10);
  const edited = owner.session().report_json();
  await withHeadroom(16 * MiB, () => {
    assert.throws(() => editor.leaveMovieclip(), /memory/);
  });
  assert.equal(editor.report, inside, 'still in the clip');
  assert.equal(editor._movieclipScopes.length, 1);
  // The next call or read of the clip is the clip session's again.
  assert.ok(owner.ready());
  assert.equal(owner.session().report_json(), edited, 'with the edit it had');
  assert.equal(owner.sessions(), 2, 'the clip and the project each have their session');
  assert.ok(editor.canUndo && editor.undoLabel !== 'Edit movieclip', 'and its own history');
  editor.leaveMovieclip();
  assert.equal(editor._movieclipScopes.length, 0);
  assert.equal(editor.undoLabel, 'Edit movieclip', 'the edit reached the project');
  assert.deepEqual(owner.refused, {});
});
