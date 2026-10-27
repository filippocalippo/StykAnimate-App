// Editing inside a movieclip under the engine owner: making a movieclip, entering it, moving a
// figure in it and leaving it is undone back to the document before and redone to the document
// after, as the editor alone does (the gate found redo giving another document). A movieclip's own document is
// edited by a session of its own, which leaving the clip gives to the document it was in as one `Edit movieclip` entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {bothWays, recordedDocument} from './support/owned-vs-plain.mjs';
import {canonical, ownerReferences} from './support/owner-references.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {OnionController} from '../src/onion-controller.mjs';
import {MotionTrails} from '../src/motion-path.mjs';

const refs = ownerReferences(import.meta.url);
const text = editor => JSON.stringify(editor.report, (key, value) => key.startsWith('_') && key !== '_styk' ? undefined : value);
const documents = ['startup', 'sheet-layers'];

for (const name of documents) {
  test(`${name}: a movieclip edit is undone and redone exactly`, {skip: !engineBuilt}, async () => {
    const document = JSON.parse(readFileSync(new URL(`../engine/tests/edit/${name}.document.json`, import.meta.url), 'utf8'));
    const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(structuredClone(document));
    const owner = installEngineOwner(editor);
    try {
      const uid = editor.evaluatedFrame.objects[0].unique_id, before = text(editor), depth = editor._undo.length;
      editor.select(uid, -1);
      const clip = editor.createMovieclip({start: editor.tick, end: editor.tick + 6});
      editor.enterMovieclip(clip.figure_type_id);
      editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
      editor.moveSelection(25, 10);
      editor.leaveMovieclip();
      const after = text(editor), entries = editor._undo.length - depth;
      assert.notEqual(after, before, 'the edit changed the document');
      for (let i = 0; i < entries; i++) await editor.undo();
      assert.equal(text(editor), before, `undoing the ${entries} entries gives the document before`);
      for (let i = 0; i < entries; i++) await editor.redo();
      assert.equal(text(editor), after, `redoing the ${entries} entries gives the document after`);
      assert.deepEqual(owner.refused, {}, 'nothing was refused');
    } finally { owner.release(); }
  });
}

// The editor keeps its own history within a byte limit and retires older entries when a heavy one lands; the
// movieclip edit (the whole clip's document) is such an entry in a large project. The session must still get it,
// or its history and the editor's part ways: undo then took back the movieclip itself, and redo gave back the
// clip as it was made, without the edit and without the frame identities entering it assigned (the gate found
// this on a large project).
for (const name of documents) {
  test(`${name}: a movieclip edit heavier than the history limit is undone and redone exactly`, {skip: !engineBuilt}, async () => {
    const document = JSON.parse(readFileSync(new URL(`../engine/tests/edit/${name}.document.json`, import.meta.url), 'utf8'));
    const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true, historyBytes: 1024}).load(structuredClone(document));
    const owner = installEngineOwner(editor);
    try {
      editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
      const clip = editor.createMovieclip({start: editor.tick, end: editor.tick + 6});
      const clipFrames = () => editor.report.figure_types.find(figure => figure.figure_type_id === clip.figure_type_id)._styk.movieclip.document.keyframes;
      const made = text(editor), identities = clipFrames().filter(frame => frame._styk?.frameId).length;
      editor.enterMovieclip(clip.figure_type_id);
      editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
      editor.moveSelection(25, 10);
      editor.leaveMovieclip();
      const after = text(editor);
      assert.notEqual(after, made, 'the edit changed the document');
      assert.equal(clipFrames().filter(frame => frame._styk?.frameId).length, clipFrames().length, 'entering the clip gave its frames identities');
      assert.equal(editor.undoLabel, 'Edit movieclip');
      assert.deepEqual(owner.depths(), [editor._undo.length, editor._redo.length], 'the editor\'s history follows the session\'s');
      await editor.undo();
      assert.equal(text(editor), made, 'undoing the edit gives the movieclip as it was made');
      assert.equal(clipFrames().filter(frame => frame._styk?.frameId).length, identities);
      await editor.redo();
      assert.equal(text(editor), after, 'redoing the edit gives the clip with its edit and its frame identities');
      assert.equal(editor.undoLabel, 'Edit movieclip');
      assert.deepEqual(Object.keys(owner.refused ?? {}), [], 'nothing was refused');
    } finally { owner.release(); }
  });
}

// While a movieclip is entered, the history and dirty state shown are the clip's own, as the editor alone shows them (the
// app once reported unsaved work inside a clip as saved).
for (const name of documents) {
  refs.test(`${name}: inside an entered movieclip the history and dirty state are the clip's`, {skip: !engineBuilt}, async take => {
    const document = JSON.parse(readFileSync(new URL(`../engine/tests/edit/${name}.document.json`, import.meta.url), 'utf8'));
    const run = () => {
      const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(structuredClone(document));
      const owner = installEngineOwner(editor);
      try {
        editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
        const clip = editor.createMovieclip({start: editor.tick, end: editor.tick + 6});
        editor.markSaved();
        editor.enterMovieclip(clip.figure_type_id);
        const entered = [editor.undoLabel, editor.canUndo, editor.dirty];
        editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
        editor.moveSelection(25, 10);
        const state = {entered, moved: [editor.undoLabel, editor.canUndo, editor.dirty]};
        editor.leaveMovieclip();
        return state;
      } finally { owner.release(); }
    };
    const alone = take('alone'), owned = run();
    assert.deepEqual(canonical(owned), alone);
    assert.equal(owned.moved[2], true, 'a move inside the clip leaves the project with unsaved changes');
  });
}

// Editing inside an entered movieclip is the clip's own session's: the calls, the history and the unsaved state of a clip
// are what the editor alone shows, nothing is refused or run in the editor, and leaving it is one `Edit movieclip` entry
// of the document it was in, undone and redone exactly (and none of the clip's own entries stay in the owner).
const sheet = {layerTimeline: true, propertyChannels: true};
const firstFigure = editor => editor.evaluatedFrame.objects[0].unique_id;
/** A clip of the first figure's first six ticks, entered, with its figure selected. */
const enter = editor => {
  editor.select(firstFigure(editor), -1);
  const clip = editor.createMovieclip({start: editor.tick, end: editor.tick + 6});
  editor.enterMovieclip(clip.figure_type_id);
  editor.select(firstFigure(editor), -1);
  return clip;
};

for (const name of documents) {
  refs.test(`${name}: posing a figure in a movieclip, then leaving, undoing and redoing`, {skip: !engineBuilt}, async take => {
    const {owned} = await bothWays(take, recordedDocument(name), (editor, mark) => {
      enter(editor); mark('entered');
      editor.moveSelection(25, 10); mark('moved');
      editor.leaveMovieclip(); mark('left');
    }, {options: sheet, expectEntries: 2});
    const at = state => owned.states.find(({name}) => name === state);
    assert.equal(at('entered').depth, 0, 'a clip is entered with a history of its own');
    assert.equal(at('moved').depth, 1);
    assert.equal(at('left').undo, 'Edit movieclip');
  });

  refs.test(`${name}: adding a figure to a movieclip`, {skip: !engineBuilt}, async take => {
    await bothWays(take, recordedDocument(name), (editor, mark) => {
      enter(editor);
      const before = editor.evaluatedFrame.objects.length;
      editor.addFigure();
      mark('added');
      assert.equal(editor.evaluatedFrame.objects.length, before + 1);
      editor.leaveMovieclip();
    }, {options: sheet, expectEntries: 2});
  });

  refs.test(`${name}: undo and redo inside a movieclip are the clip's, and leaving it keeps what is done`, {skip: !engineBuilt}, async take => {
    await bothWays(take, recordedDocument(name), async (editor, mark) => {
      enter(editor);
      editor.moveSelection(25, 10); mark('moved');
      editor.moveSelection(-5, 3); mark('moved again');
      await editor.undo(); mark('undone');
      assert.equal(editor.canRedo, true);
      await editor.undo(); mark('undone twice');
      assert.equal(editor.canUndo, false, 'the clip\'s history holds only the clip\'s entries');
      await editor.redo(); mark('redone');
      editor.leaveMovieclip(); mark('left');
    }, {options: sheet, expectEntries: 2});
  });

  refs.test(`${name}: a movieclip left unchanged or discarded leaves no entry`, {skip: !engineBuilt}, async take => {
    await bothWays(take, recordedDocument(name), (editor, mark) => {
      editor.select(firstFigure(editor), -1);
      editor.createMovieclip({start: editor.tick, end: editor.tick + 6});
      mark('made');
      const clip = editor.figure.figure_type_id;
      editor.enterMovieclip(clip); editor.leaveMovieclip(); mark('entered and left');
      editor.enterMovieclip(clip); editor.select(firstFigure(editor), -1); editor.moveSelection(9, 9);
      editor.leaveMovieclip({save: false}); mark('discarded');
    }, {options: sheet, expectEntries: 1});
  });

  refs.test(`${name}: nested movieclips are edited in their own sessions, one entry each when left`, {skip: !engineBuilt}, async take => {
    await bothWays(take, recordedDocument(name), (editor, mark) => {
      enter(editor);
      const inner = editor.createMovieclip({start: editor.tick, end: editor.tick + 3});
      mark('inner made');
      editor.enterMovieclip(inner.figure_type_id);
      editor.select(firstFigure(editor), -1);
      editor.moveSelection(11, -7); mark('moved in the inner clip');
      editor.leaveMovieclip(); mark('left the inner clip');
      assert.equal(editor._movieclipScopes.length, 1);
      editor.moveSelection(2, 2); mark('moved in the outer clip');
      editor.leaveMovieclip(); mark('left the outer clip');
      assert.equal(editor._movieclipScopes.length, 0);
    }, {options: sheet, expectEntries: 2});
  });
}

test("a movieclip edit is the session's: no entry of the editor's own and no session left of the clip", {skip: !engineBuilt}, async () => {
  const editor = new Editor({demo: false, ...sheet}).load(structuredClone(recordedDocument('startup')));
  const owner = installEngineOwner(editor);
  try {
    enter(editor);
    editor.moveSelection(25, 10);
    assert.equal(owner.sessions(), 2, 'the clip has a session beside its parent\'s');
    assert.deepEqual(owner.depths(), [1, 0], 'the clip\'s history is the clip session\'s');
    editor.leaveMovieclip();
    assert.equal(owner.sessions(), 1, 'the clip\'s session is freed');
    assert.deepEqual(owner.depths(), [editor._undo.length, editor._redo.length]);
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
  } finally { owner.release(); }
});

// The frame on show, the onion skins and the trails of a clip being edited are the clip session's.
test('the onion skins and trails of a movieclip being edited are the clip\'s own', {skip: !engineBuilt}, async () => {
  const editor = new Editor({demo: false, ...sheet}).load(structuredClone(recordedDocument('sheet-layers')));
  const owner = installEngineOwner(editor);
  const settings = normalizeEditorSettings({onionBefore: 2, onionAfter: 2});
  const onions = new OnionController({editor, getSettings: () => settings, getEnabled: () => true, onCommit() {}, onError(error) { throw error; }});
  try {
    enter(editor);
    editor.seek(1);
    const request = onions.request({selected: [], hidden: []});
    assert.equal(editor._shown.onions(request)?.session, owner.session(), 'the stage plans the skins from the clip\'s session');
    assert.ok(editor._shown.skins(request).ghosts.length > 0, 'the clip has skins');
    const [trail] = new MotionTrails(editor, {budgetMs: Infinity}).read([{kind: 'node', uid: firstFigure(editor), handleId: 0, joint: -1}]);
    assert.ok(trail?.points.size, 'and trails');
  } finally { onions.destroy(); owner.release(); }
});

/** The first document with imported animation on two segments of its figure (a layer sheet's legacy animation). */
function animatedDocument() {
  const document = recordedDocument('startup'), uid = document.keyframes[0].objects[0].unique_id;
  const channel = (handleId, value) => {
    const target = {kind: 'segment', uid, handleId};
    return {id: animationChannelId(target, 'opacity'), target, property: 'opacity', keys: [2, 8].map((tick, i) => ({id: `key-${handleId}-${i}`, tick, interpolation: 'linear', value: i ? 1 : value}))};
  };
  document._styk.animation = {version: 1, nextKeyId: 3, channels: [channel(3, 0.4), channel(2, 0.2)]};
  delete document._styk.layerSheet;
  return document;
}

// A figure's rig edited inside a clip follows into what the clip retains of the scene it was made from: the poses of the
// figure in the clip's source and the imported animation of its segments, each undone and redone with the edit.
for (const [name, edit] of [
  ['splitting a segment', editor => editor.splitSegment(0.3)],
  ['deleting a segment', editor => editor.deleteSegment()],
  ['adding a segment', editor => editor.addSegment({length: 20, angle: 0.5})],
]) {
  refs.test(`${name} in a movieclip repairs the poses and animation the clip retains`, {skip: !engineBuilt}, async take => {
    await bothWays(take, animatedDocument(), async (editor, mark) => {
      enter(editor);
      const retained = () => editor.report._styk.movieclipSource.document;
      const poses = () => JSON.stringify([retained().keyframes, retained()._styk.layerSheet?.legacyAnimation]);
      const before = poses();
      editor.select(firstFigure(editor), 1);
      edit(editor); mark('edited');
      assert.notEqual(poses(), before, 'what the clip retains follows the figure');
      await editor.undo(); mark('undone');
      assert.equal(poses(), before, 'and goes back with it');
      await editor.redo(); mark('redone');
      editor.leaveMovieclip(); mark('left');
    }, {options: sheet, expectEntries: 2});
  });
}

test('closing a project ends the sessions it holds, those of the movieclips it was open in too', {skip: !engineBuilt}, async () => {
  const editor = new Editor({demo: false, ...sheet}).load(structuredClone(recordedDocument('sheet-layers')));
  const owner = installEngineOwner(editor);
  try {
    enter(editor);
    assert.equal(owner.sessions(), 2);
    // Another project opens beside it, and the first is closed while one of its movieclips is open.
    const detached = editor.detachDocument();
    editor.load(structuredClone(recordedDocument('startup')));
    assert.equal(owner.sessions(), 3, 'the sessions of the project and its clip stay while it can be resumed');
    editor.discardDocument(detached);
    assert.equal(owner.sessions(), 1, 'only the open project\'s remains');
    editor.select(firstFigure(editor), -1);
    editor.moveSelection(5, 5);
    assert.equal(editor.undoLabel !== '', true, 'and it edits');
  } finally { owner.release(); }
});

// A movieclip made inside an entered movieclip retains the poses it was made from, which the clip it was made in
// retains too: those are cut down to the figures the new clip holds, as the editor alone does.
refs.test('a movieclip made inside another keeps only its own figures in the poses it retains', {skip: !engineBuilt}, async take => {
  await bothWays(take, recordedDocument('origin-future-rig-joined-sheet'), (editor, mark) => {
    editor.select(firstFigure(editor), -1);
    const clip = editor.createMovieclip({start: 0, end: 4});
    mark('outer made');
    editor.enterMovieclip(clip.figure_type_id);
    const inner = editor.createMovieclip();
    mark('inner made');
    editor.leaveMovieclip();
    return inner.figure_type_id;
  }, {options: sheet, expectEntries: 2});
});
