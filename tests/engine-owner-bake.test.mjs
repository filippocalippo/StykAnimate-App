// Baking a movieclip under the engine owner (D19): the session samples the clip in slices and the interface thread gets turns of the
// event loop between them (D7); publication is one step. An edit between the slices ends the bake and leaves nothing of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';

/** An owned editor on a document with a movieclip of its first figure, the clip's instance selected. */
function clipped() {
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/sheet-layers.document.json', import.meta.url), 'utf8'));
  const {editor, owner} = ownedEditorSync({demo: false, layerTimeline: true, propertyChannels: true}, document, {recorded: false});
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.createMovieclip({start: 0, end: 6});
  assert.ok(editor.object?._stykMovieclip, 'the clip is selected');
  return {editor, owner};
}

/** Runs `work` while counting the turns the event loop takes (a turn is what a bake that gives the thread back lets happen). */
async function counting(work) {
  let turns = 0, beating = true;
  const beat = () => { turns++; if (beating) setImmediate(beat); };
  setImmediate(beat);
  try { return {result: await work(), turns: () => turns}; } finally { beating = false; }
}

test('a bake gives the interface thread back between its slices and publishes one entry', {skip: !engineBuilt}, async () => {
  const {editor, owner} = clipped();
  const entries = editor._undo.length;
  const {result: baked, turns} = await counting(() => editor.bakeMovieclip());
  assert.ok(baked.length > 0, 'the baked figures');
  assert.ok(turns() >= 1, `the event loop turned between the slices: ${turns()}`);
  assert.equal(editor.undoLabel, 'Bake animation');
  assert.equal(editor._undo.length, entries + 1, 'one entry');
  assert.ok(!editor.object?._stykMovieclip, 'the clip is baked into figures');
  editor.undo();
  assert.ok(editor.report.figure_types.some(figure => figure._styk?.movieclip), 'undone, the clip is back');
  assert.deepEqual(owner.refused, {});
});

test('an edit between the slices ends the bake and leaves nothing of it', {skip: !engineBuilt}, async () => {
  const {editor, owner} = clipped();
  let edited = false;
  // The first turn of the event loop the bake gives back is the user's edit.
  setImmediate(() => { edited = true; editor.setCanvasSize(321, 240); });
  await assert.rejects(editor.bakeMovieclip(), error => error.messageKey === 'errors.editorMovieclips.theSceneChangedWhileBakingTryAgain');
  assert.ok(edited, 'the bake had given the thread back');
  assert.equal(editor.undoLabel, 'Resize canvas', 'the edit is the last entry');
  assert.ok(editor.object?._stykMovieclip, 'the clip is as it was');
  // No job is left: nothing to publish.
  const answer = JSON.parse(owner.session().call('bakeMovieclipPublish', '[]', 'null'));
  assert.equal(answer.status, 'error');
  assert.deepEqual(owner.refused, {});
});

test('a bake of something that is not a movieclip is refused before any slice', {skip: !engineBuilt}, async () => {
  const {editor} = clipped();
  editor.undo();
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  await assert.rejects(editor.bakeMovieclip(), error => error.messageKey === 'errors.editorMovieclips.selectAMovieclip');
});
