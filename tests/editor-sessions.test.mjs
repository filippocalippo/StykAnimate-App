import test from 'node:test';
import assert from 'node:assert/strict';
import {isSharedEditorKey} from '../src/editor-sessions.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit} from '../src/native-property-edit.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

const application = () => open({demo: false, propertyChannels: true, layerTimeline: true}).newDocument();
function scene(count = 3, objects = 2) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = Array.from({length: count}, (_, i) => createFrame(Array.from({length: objects}, (_, j) => createObject(figure, j + 1, i * 10 + j * 100, 180)), 5));
  return report;
}
function setX(editor, x) {
  const uid = editor.frame.objects[0].unique_id;
  editor.select(uid); const token = beginNativePropertyEdit(editor, 'root_x'); previewNativePropertyEdit(token, x); commitNativePropertyEdit(token);
  return uid;
}
const rootX = editor => editor.frame.objects[0].root_x;
const events = editor => { const seen = []; editor.addEventListener('change', event => seen.push(event.detail)); return seen; };

test('a detached project comes back with its history, selection, playhead and saved state', () => {
  const editor = open({demo: false}).load(scene(), 'First');
  const first = editor.report, start = rootX(editor);
  setX(editor, 55); setX(editor, 80); editor.undo();
  editor.selectFrame(2);
  const token = editor._documentToken, revision = editor.revision, selected = editor.selectedUid;
  assert.equal(editor.dirty, true);

  const resting = editor.detachDocument();
  assert.equal(editor.report, undefined);
  editor.load(scene(1), 'Second');
  assert.equal(editor.name, 'Second'); assert.equal(editor.dirty, false); assert.equal(editor.canUndo, false);
  setX(editor, 300);
  assert.notEqual(editor.revision, revision);

  const second = editor.detachDocument();
  editor.resumeDocument(resting);
  assert.equal(editor.report, first); assert.equal(editor.name, 'First');
  assert.equal(editor._documentToken, token); assert.equal(editor.revision, revision);
  assert.equal(editor.frameIndex, 2); assert.equal(editor.selectedUid, selected);
  assert.equal(editor.dirty, true); assert.equal(editor.canUndo, true); assert.equal(editor.canRedo, true);
  editor.selectFrame(0);
  assert.equal(rootX(editor), 55);
  editor.redo(); assert.equal(rootX(editor), 80);
  editor.undo(); editor.undo(); assert.equal(rootX(editor), start); assert.equal(editor.canUndo, false);

  const firstAgain = editor.detachDocument();
  editor.resumeDocument(second);
  assert.equal(editor.name, 'Second'); assert.equal(rootX(editor), 300);
  editor.undo(); assert.notEqual(rootX(editor), 300);
  editor.detachDocument(); editor.resumeDocument(firstAgain);
  assert.equal(editor.report, first);
});

test('a session is spent once resumed and an edit in progress keeps the project in front', () => {
  const editor = open({demo: false}).load(scene(), 'First');
  const resting = editor.detachDocument();
  editor.load(scene(1), 'Second');
  const second = editor.detachDocument();
  editor.resumeDocument(resting);
  assert.throws(() => editor.resumeDocument(resting), /no longer open/);
  assert.throws(() => editor.resumeDocument({report: scene()}), /no longer open/);
  const uid = editor.frame.objects[0].unique_id;
  editor.select(uid); editor.beginDrag(uid, -1, {x: 0, y: 0});
  assert.throws(() => editor.detachDocument(), /Finish the current edit/);
  assert.throws(() => editor.resumeDocument(second), /Finish the current edit/);
  assert.equal(editor.name, 'First');
  editor.cancelDrag();
  editor.detachDocument(); editor.resumeDocument(second);
  assert.equal(editor.name, 'Second');
});

test('revisions never repeat across projects, through undo and a movieclip session', () => {
  const editor = application();
  const seen = new Set([editor.revision]);
  const fresh = () => { assert.equal(seen.has(editor.revision), false, `revision ${editor.revision} repeated`); seen.add(editor.revision); };
  setX(editor, 10); fresh();
  const first = editor.detachDocument();
  editor.newDocument(); fresh();
  setX(editor, 20); fresh(); setX(editor, 30); fresh();
  const second = editor.detachDocument();
  editor.resumeDocument(first);
  setX(editor, 40); fresh();
  editor.createMovieclip?.();
  if (editor.figure && editor.report.figure_types.some(figure => figure._styk?.movieclip)) {
    editor.enterMovieclip(); fresh();
    const inside = editor.detachDocument();
    editor.resumeDocument(second); setX(editor, 50); fresh(); setX(editor, 60); fresh();
    editor.detachDocument(); editor.resumeDocument(inside);
    assert.equal(editor._movieclipScopes.length, 1);
    editor.leaveMovieclip();
    editor.setFPS(30); fresh();
  }
});

test('resuming publishes one document replacement that every listener rebuilds from', () => {
  const editor = application();
  setX(editor, 12);
  const first = editor.detachDocument();
  editor.newDocument();
  const second = editor.detachDocument();
  const seen = events(editor), definition = editor.definitionRevision, layers = editor.layerRevision;
  editor.resumeDocument(first);
  assert.deepEqual(seen.map(detail => detail.kind), ['document']);
  assert.equal(seen[0].resumed, true); assert.equal(seen[0].structural, true); assert.equal(seen[0].timing, true);
  assert.ok(editor.definitionRevision > definition); assert.ok(editor.layerRevision > layers);
  assert.equal(editor.geometry.objects.size > 0, true);
  editor.detachDocument(); editor.resumeDocument(second);
  assert.equal(seen.filter(detail => detail.kind === 'document').length, 2);
});

test('a loaded project receives nothing from the one it replaces in front, and gives nothing back', () => {
  const editor = application();
  editor._selectedCameraMotion = 'first-motion'; editor._newLayerHints = {first: true};
  const first = editor.detachDocument();
  for (const key of Object.keys(editor)) assert.equal(isSharedEditorKey(key), true, `${key} stayed on the editor`);
  editor.newDocument();
  assert.equal(editor._selectedCameraMotion, undefined); assert.equal(editor._newLayerHints, undefined);
  editor._selectedCameraMotion = 'second-motion';
  const second = editor.detachDocument();
  editor.resumeDocument(first);
  assert.equal(editor._selectedCameraMotion, 'first-motion'); assert.deepEqual(editor._newLayerHints, {first: true});
  editor.detachDocument(); editor.resumeDocument(second);
  assert.equal(editor._selectedCameraMotion, 'second-motion'); assert.equal(editor._newLayerHints, undefined);
});

test('clipboards, configuration and installed services belong to the editor, not to a project', () => {
  const editor = application();
  editor.autoKey = true;
  const uid = editor.frame.objects[0].unique_id;
  editor.select(uid); editor.copySelection();
  const copied = editor._selectionClipboard ?? editor._figureClipboard;
  assert.ok(copied, 'the selection was copied');
  const source = editor._documentToken;
  const first = editor.detachDocument();
  editor.newDocument();
  assert.equal(editor._selectionClipboard ?? editor._figureClipboard, copied);
  assert.equal(editor.autoKey, true); assert.equal(editor.layerTimeline, true); assert.equal(editor.propertyChannels, true);
  assert.notEqual(editor._documentToken, source);
  const count = editor.selectionFrame.objects.length;
  editor.pasteSelection();
  assert.equal(editor.selectionFrame.objects.length, count + 1, 'a figure copied in one project pastes into another');
  editor.detachDocument(); editor.resumeDocument(first);
  assert.equal(editor.selectionFrame.objects.length, count);
});

test('an asynchronous load hands the open project over only when the new one is published', async () => {
  const editor = open({demo: false}).load(scene(), 'First');
  setX(editor, 44);
  const first = editor.report;
  let detached = null;
  const invalid = scene(1); invalid.keyframes[0].objects[0].root_x = NaN;
  await assert.rejects(editor.loadAsync(invalid, 'Broken', {onDetach: session => { detached = session; }}));
  assert.equal(detached, null); assert.equal(editor.report, first); assert.equal(editor.canUndo, true);

  await editor.loadAsync(scene(1), 'Second', {onDetach: session => { detached = session; }});
  assert.ok(detached); assert.equal(detached.report, first); assert.equal(editor.name, 'Second'); assert.equal(editor.canUndo, false);
  const second = editor.detachDocument();
  editor.resumeDocument(detached);
  assert.equal(editor.report, first); assert.equal(rootX(editor), 44);
  editor.undo(); assert.notEqual(rootX(editor), 44);
  editor.detachDocument(); editor.resumeDocument(second);
});

test('a load whose receiver fails leaves the open project in place', async () => {
  const editor = open({demo: false}).load(scene(), 'First');
  setX(editor, 44);
  const first = editor.report, seen = events(editor);
  let received = null;
  await assert.rejects(editor.loadAsync(scene(1), 'Second', {onDetach: session => { received = session; throw new Error('the tab could not be made'); }}), /could not be made/);
  assert.equal(editor.report, first); assert.equal(editor.name, 'First'); assert.equal(rootX(editor), 44);
  assert.equal(seen.some(detail => detail.kind === 'document'), false, 'nothing was published');
  editor.undo(); assert.notEqual(rootX(editor), 44);
  assert.throws(() => editor.resumeDocument(received), /no longer open/);
  assert.throws(() => editor.load(scene(1), 'Second', {onDetach: () => { throw new Error('again'); }}), /again/);
  assert.equal(editor.report, first);
});

