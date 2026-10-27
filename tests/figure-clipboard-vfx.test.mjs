import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {vfxProperty} from '../src/vfx.mjs';
import {clipboardSnapshot, restoreClipboard} from '../src/shared-clipboard.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 1, 2].map(() => createFrame([createObject(figure, 1, 120, 180), createObject(figure, 2, 280, 180)], 10));
  return open({demo: false, layerTimeline: true}, report);
}
const clipsFor = (editor, uid) => editor.getVfxClips().filter(clip => clip.target.uid === uid);

test('pasting a figure keeps its timeline effects', () => {
  const editor = fixture();
  const always = editor.addVfxClip({kind: 'figure', uid: 1}, 'glow');
  const timed = editor.addVfxClip({kind: 'segment', uid: 1, handleId: 2}, 'tint', {start: 4, duration: 12});
  const effect = editor.getVfxClips().find(clip => clip.id === timed).effects[0];
  editor.setVfxClipParameter(timed, effect.id, 'mix', 0, {key: true, tick: 4});
  editor.setVfxClipParameter(timed, effect.id, 'mix', 1, {key: true, tick: 10});
  editor.addVfxClip({kind: 'figure', uid: 2}, 'blur');
  editor.seek(5); editor.select(1);
  assert.equal(editor.copySelection(), 1);
  editor.seek(8);
  const undoDepth = editor._undo.length;
  const [pasted] = editor.pasteSelection();
  assert.notEqual(pasted.unique_id, 1);
  assert.equal(editor._undo.length, undoDepth + 1, 'figure and effects paste as one undo step');
  const copies = clipsFor(editor, pasted.unique_id);
  assert.equal(copies.length, 2, 'only the copied figure\'s effects are pasted');
  const glow = copies.find(clip => clip.effects[0].type === 'glow'), tint = copies.find(clip => clip.effects[0].type === 'tint');
  assert.ok(glow.id !== always && tint.id !== timed && tint.effects[0].id !== effect.id, 'fresh identities');
  assert.equal(glow.duration, null);
  assert.deepEqual([tint.target.kind, tint.target.handleId, tint.start, tint.duration], ['segment', 2, 7, 12], 'timing follows the playhead');
  assert.deepEqual(tint.keys[vfxProperty('tint', tint.effects[0].id, 'mix')].map(key => key.value), [0, 1]);
  editor.undo();
  assert.equal(clipsFor(editor, pasted.unique_id).length, 0);
  assert.equal(editor.getVfxClips().length, 3);
  editor.redo();
  assert.equal(clipsFor(editor, pasted.unique_id).length, 2);
});

test('duplicating figures keeps their effects', () => {
  const editor = fixture();
  editor.addVfxClip({kind: 'figure', uid: 1}, 'outline');
  editor.select(1);
  const [copy] = editor.duplicateSelection();
  assert.equal(clipsFor(editor, copy.unique_id).length, 1);
  assert.equal(clipsFor(editor, 1).length, 1);
});

test('figure effects survive the shared clipboard into another document', async () => {
  const source = fixture();
  source.addVfxClip({kind: 'figure', uid: 2}, 'shadow', {start: 2, duration: 6});
  source.select(2); source.copySelection();
  const packet = structuredClone(clipboardSnapshot(source, 'figures'));
  const target = fixture();
  await restoreClipboard(target, packet);
  target.seek(0);
  const [pasted] = target.pasteSelection();
  const [clip] = clipsFor(target, pasted.unique_id);
  assert.equal(clip.effects[0].type, 'shadow');
  assert.deepEqual([clip.start, clip.duration, clip.offset], [2, 6, 0]);
  packet.data.vfxClips = [{bad: true}];
  await assert.rejects(restoreClipboard(target, packet));
});

test('clips shifted before the first frame keep their phase and end', () => {
  const editor = fixture();
  editor.addVfxClip({kind: 'figure', uid: 1}, 'tint', {start: 2, duration: 10});
  editor.seek(6); editor.select(1); editor.copySelection();
  editor.seek(0);
  const [pasted] = editor.pasteSelection();
  const [clip] = clipsFor(editor, pasted.unique_id);
  assert.deepEqual([clip.start, clip.duration, clip.offset], [0, 6, 4]);
});
