// Movieclip calls the engine session used to refuse (and the editor ran instead): each now runs in the session and leaves
// the document, the history entries and the undo and redo of the editor alone (tests/support/owned-vs-plain.mjs).
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {engineBuilt} from './support/engine-node.mjs';
import {bothWays, recordedDocument} from './support/owned-vs-plain.mjs';
import {ownerReferences} from './support/owner-references.mjs';

const opts = {skip: !engineBuilt};
const refs = ownerReferences(import.meta.url);
const instances = (editor, tick) => { editor.seek(tick); return editor.evaluatedFrame.objects; };
const presence = {clock: 'presence', offset: 0, speed: 1, mode: 'loop'};

refs.test('duplicating a movieclip instance puts a copy on the presence clock', opts, async take => {
  // The second clip runs on the document's own clock, from the frame 2 to 6.
  for (const [name, tick] of [['sheet-movieclip', 0], ['sheet-movieclip-timed', 3]]) {
    const {owned} = await bothWays(take, recordedDocument(name), editor => {
      editor.seek(tick);
      editor.select(4, -1);
      const copy = editor.duplicateFigure();
      assert.notEqual(copy.unique_id, 4);
      assert.deepEqual(copy._stykMovieclip, presence, `${name}: the copy plays from its start`);
      assert.equal(editor.undoLabel, 'Duplicate figure');
    }, {expectEntries: 1});
    assert.ok(owned.states.length);
  }
});

refs.test('adding a movieclip from the project puts an instance at the playhead', opts, async take => {
  for (const tick of [0, 3]) {
    await bothWays(take, recordedDocument('sheet-movieclip'), editor => {
      editor.seek(tick);
      const added = editor.addFigure(4);
      assert.equal(added.figure_type_id, 4);
      assert.deepEqual(added._stykMovieclip, presence);
      assert.equal(editor.undoLabel, 'Add figure');
      assert.ok(instances(editor, tick).some(object => object.unique_id === added.unique_id), 'it shows at the playhead');
    }, {expectEntries: 1});
  }
});

refs.test('adding a movieclip across a range of frames is one step', opts, async take => {
  await bothWays(take, recordedDocument('sheet-movieclip'), editor => {
    const result = editor.addFigureInFrames(4, undefined, {ticks: [1, 4]});
    assert.equal(result.insertedUids.length, 1);
    assert.equal(editor.undoLabel, 'Add figures across frames');
    for (const tick of [1, 4]) assert.ok(instances(editor, tick).some(object => object.unique_id === result.insertedUids[0]), `it shows at ${tick}`);
  }, {expectEntries: 1});
});

refs.test('duplicating figures that have effect clips across frames copies the clips in the same step', opts, async take => {
  const {plain} = await bothWays(take, recordedDocument('vfx-clips'), editor => {
    const clips = () => editor.report._styk.vfxClips.clips.length;
    const before = clips();
    editor.select(1, -1);
    editor.duplicateFiguresInFrames(undefined, {ticks: [0, 3]});
    assert.ok(clips() > before, 'the copies carry the clips of the figure');
    assert.equal(editor.undoLabel, 'Duplicate figures across frames');
  }, {expectEntries: 1});
  assert.ok(plain.states.length);
});

refs.test('breaking apart a movieclip with the document\'s own clock gives it the presence clock first', opts, async take => {
  await bothWays(take, recordedDocument('sheet-movieclip-timed'), async editor => {
    editor.seek(2);
    editor.select(4, -1);
    const parts = await editor.breakApartMovieclip();
    assert.ok(parts.length, 'the frame came apart into figures');
    assert.equal(editor.undoLabel, 'Break apart frame');
  });
});
