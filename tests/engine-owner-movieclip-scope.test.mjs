// Editing inside a movieclip under the engine owner: making a movieclip, entering it, moving a
// figure in it and leaving it is undone back to the document before and redone to the document
// after, as the editor alone does (the gate found redo giving another document).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';

const text = editor => JSON.stringify(editor.report, (key, value) => key.startsWith('_') && key !== '_styk' ? undefined : value);
const documents = ['startup', 'sheet-layers'];

for (const name of documents) for (const options of [{layerTimeline: true, propertyChannels: true}, {layerTimeline: false, propertyChannels: false}]) {
  test(`${name} (${options.layerTimeline ? 'layer sheet' : 'native'}): a movieclip edit is undone and redone exactly`, {skip: !engineBuilt}, async () => {
    const document = JSON.parse(readFileSync(new URL(`../engine/tests/edit/${name}.document.json`, import.meta.url), 'utf8'));
    const editor = new Editor({demo: false, ...options}).load(structuredClone(document));
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
      assert.deepEqual(Object.keys(owner.refused ?? {}), [], 'nothing was refused');
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

// While a movieclip is entered, its calls run in the editor, which keeps its history and dirty state; the owner
// shows those, not an empty session's (the app would otherwise report unsaved work inside a clip as saved).
for (const name of documents) {
  test(`${name}: inside an entered movieclip the history and dirty state are the editor's`, {skip: !engineBuilt}, async () => {
    const document = JSON.parse(readFileSync(new URL(`../engine/tests/edit/${name}.document.json`, import.meta.url), 'utf8'));
    const states = [];
    for (const owned of [false, true]) {
      const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(structuredClone(document));
      const owner = owned ? installEngineOwner(editor) : null;
      try {
        editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
        const clip = editor.createMovieclip({start: editor.tick, end: editor.tick + 6});
        editor.markSaved();
        editor.enterMovieclip(clip.figure_type_id);
        const entered = [editor.undoLabel, editor.canUndo, editor.dirty];
        editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
        editor.moveSelection(25, 10);
        states.push({entered, moved: [editor.undoLabel, editor.canUndo, editor.dirty]});
        editor.leaveMovieclip();
      } finally { owner?.release(); }
    }
    assert.deepEqual(states[1], states[0]);
    assert.equal(states[1].moved[2], true, 'a move inside the clip leaves the project with unsaved changes');
  });
}
