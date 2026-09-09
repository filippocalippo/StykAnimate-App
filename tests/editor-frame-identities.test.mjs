import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {validateFrameIdentities} from '../src/editor-frames.mjs';

const clone = value => structuredClone(value);
const ids = editor => editor.report.keyframes.map((_, index) => editor.getFrameId(index));
function content(frame) { const value = clone(frame); delete value._styk.frameId; return value; }
function fixture() {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = [3, 2, 4, 1].map((duration, index) => {
    const frame = createFrame([createObject(figure, 17, 90 + index * 20, 120)], duration);
    frame._styk = {custom: {note: `native-${index}`}};
    return frame;
  });
  const editor = new Editor({demo: false}).load(document);
  return editor.load(editor.serialize());
}

test('loading native frames creates unique persistent IDs while preserving unknown frame metadata', () => {
  const editor = fixture(), originals = ids(editor);
  assert.equal(new Set(originals).size, 4);
  editor.report.keyframes.forEach((frame, index) => {
    assert.equal(editor.getFrameById(originals[index]), frame);
    assert.equal(editor.frameIndexForId(originals[index]), index);
    assert.equal(frame._styk.custom.note, `native-${index}`);
  });
  const reopened = new Editor({demo: false}).load(editor.serialize());
  assert.deepEqual(ids(reopened), originals);
  assert.deepEqual(reopened.report.keyframes.map(content), editor.report.keyframes.map(content));
  assert.equal(editor.getFrameById('missing-id'), null); assert.equal(editor.frameIndexForId('missing-id'), -1);
  assert.throws(() => editor.getFrameId(99), /existing source frame/);
});

for (const [name, insert, count] of [
  ['add', editor => editor.addFrame(), 1],
  ['duplicate', editor => editor.duplicateFrame(), 1],
  ['duplicate range', editor => editor.duplicateFrames([0, 2]), 2],
  ['copy and paste', editor => { editor.copyFrames([0, 2]); editor.pasteFrames(1); }, 2],
  ['insert duplicates before their sources', editor => editor.insertDuplicateFrames([0, 2]), 2],
  ['insert blank', editor => editor.insertBlankFrame(1), 1],
]) test(`${name} creates fresh IDs and preserves original identities through undo and redo`, () => {
  const editor = fixture(), before = editor.serialize(), originalIds = ids(editor);
  insert(editor); const after = editor.serialize(), afterIds = ids(editor);
  assert.equal(afterIds.length, originalIds.length + count); assert.equal(new Set(afterIds).size, afterIds.length);
  for (const id of originalIds) assert.equal(afterIds.filter(value => value === id).length, 1);
  const fresh = afterIds.filter(id => !originalIds.includes(id)); assert.equal(fresh.length, count);
  for (const id of originalIds) {
    const index = originalIds.indexOf(id);
    assert.deepEqual(editor.getFrameById(id), before.keyframes[index]);
  }
  for (const id of fresh) assert.ok(editor.getFrameById(id)._styk.custom, 'Cloning retains unknown frame metadata.');
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after); assert.deepEqual(ids(editor), afterIds);
});

test('reordering source frames moves IDs with their poses and selection, and restores the exact report on undo', () => {
  const editor = fixture(), before = editor.serialize(), originalIds = ids(editor);
  editor.selectFrame(1); const beforeSelection = editor.frameIndex;
  editor.moveFrame(1, 3);
  assert.deepEqual(ids(editor), [originalIds[0], originalIds[2], originalIds[3], originalIds[1]]);
  assert.equal(editor.frameIndex, 3); assert.equal(editor.getFrameId(), originalIds[1]);
  assert.equal(editor._undo.at(-1).kind, 'ranges'); assert.equal(editor._undo.at(-1).changes.length, 1);
  assert.equal(editor._undo.at(-1).changes[0].before.length, 3);
  for (let index = 0; index < 4; index++) assert.deepEqual(editor.getFrameById(originalIds[index]), before.keyframes[index]);
  const after = editor.serialize();
  editor.undo(); assert.deepEqual(editor.serialize(), before); assert.equal(editor.frameIndex, beforeSelection);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
  editor.moveFrame(3, 0); assert.equal(editor.getFrameId(0), originalIds[1]);
  assert.equal(editor.moveFrame(0, 0), false);
  assert.throws(() => editor.moveFrame(-1, 0), /valid keyframe positions/);
});

test('noncontiguous reversal and exposure edits preserve IDs while baking allocates unique source identities', () => {
  const editor = fixture(), originalIds = ids(editor), before = editor.serialize();
  editor.reverseFrames([0, 2]); assert.deepEqual(ids(editor), [originalIds[2], originalIds[1], originalIds[0], originalIds[3]]);
  assert.equal(editor.frameIndexForId(originalIds[0]), 2);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.setFramesDuration([0, 2], 2); assert.deepEqual(ids(editor), originalIds);
  editor.undo(); editor.bakeFrames([0, 2]);
  const bakedIds = ids(editor); assert.equal(new Set(bakedIds).size, bakedIds.length);
  for (const id of originalIds) assert.equal(bakedIds.filter(value => value === id).length, 1);
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
});

test('deleting referenced native frames retains only referenced poses and restores the source table exactly on undo', () => {
  const editor = fixture(), originalIds = ids(editor);
  editor.addAnimationKey({kind: 'layer', id: 'layer-1'}, 'pose', 0, {frameId: originalIds[1]});
  const before = editor.serialize(), referenced = clone(editor.getFrameById(originalIds[1]));
  editor.deleteFrames([0, 1]);
  assert.equal(editor.frameIndexForId(originalIds[1]), -1);
  assert.deepEqual(editor.getFrameById(originalIds[1]), referenced);
  assert.equal(editor.getFrameById(originalIds[0]), null);
  assert.deepEqual(Object.keys(editor.report._styk.frameSources), [originalIds[1]]);
  assert.equal(editor._undo.at(-1).frameSourceChanges.length, 1);
  const after = editor.serialize(), reopened = new Editor({demo: false}).load(after);
  assert.deepEqual(reopened.getFrameById(originalIds[1]), referenced);
  editor.undo(); assert.deepEqual(editor.serialize(), before); assert.equal(editor.report._styk.frameSources, undefined);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
});

test('clearing all native frames keeps authored references valid and gives the replacement a fresh ID', () => {
  const editor = fixture(), originalIds = ids(editor);
  editor.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
  const before = editor.serialize(); editor.deleteFrames([0, 1, 2, 3]);
  assert.equal(editor.report.keyframes.length, 1); assert.equal(editor.frame.objects.length, 0);
  assert.equal(originalIds.includes(editor.getFrameId()), false);
  assert.deepEqual(new Set(Object.keys(editor.report._styk.frameSources)), new Set(originalIds));
  for (let index = 0; index < originalIds.length; index++) assert.deepEqual(editor.getFrameById(originalIds[index]), before.keyframes[index]);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('captured sources are independent poses with fresh IDs and no transient geometry caches', () => {
  const editor = fixture(), originalIds = ids(editor), input = clone(editor.frame);
  input.objects[0].runtime_segments = [{temporary: true}];
  const id = editor.captureFrameSource(input), source = editor.getFrameById(id);
  assert.equal(originalIds.includes(id), false); assert.equal(editor.frameIndexForId(id), -1);
  assert.equal(source.objects[0].runtime_segments, undefined);
  input.objects[0].root_x += 100; assert.notEqual(source.objects[0].root_x, input.objects[0].root_x);
  const second = editor.captureFrameSource(); assert.notEqual(second, id);
  editor.duplicateFrame(); assert.notEqual(editor.getFrameId(), second);
  for (const missing of ['constructor', '__proto__', 'toString']) assert.equal(editor.getFrameById(missing), null);
});

test('frame lookups track history replacements and source reordering instead of stale frame objects', () => {
  const editor = fixture(), id = editor.getFrameId(), before = editor.frame;
  editor.updateObject({root_x: 222}); editor.undo();
  assert.equal(editor.getFrameById(id), editor.report.keyframes[0]);
  editor.setFrameDuration(6); editor.undo();
  assert.notEqual(editor.getFrameById(id), before); assert.equal(editor.getFrameById(id), editor.report.keyframes[0]);
  editor.moveFrame(0, 3); assert.equal(editor.frameIndexForId(id), 3);
  editor.undo(); assert.equal(editor.frameIndexForId(id), 0);
});

test('malformed or duplicate persisted identities reject load without replacing the current document', () => {
  const editor = fixture(), current = editor.report, before = editor.serialize();
  const invalid = [
    document => { document.keyframes[0]._styk.frameId = '../outside'; },
    document => { document.keyframes[0]._styk.frameId = 12; },
    document => { document.keyframes[0]._styk.frameId = document.keyframes[1]._styk.frameId; },
    document => { document._styk.frameSources = []; },
    document => { document._styk.frameSources = {'other-id': clone(document.keyframes[0])}; },
    document => { const frame = clone(document.keyframes[0]); document._styk.frameSources = {[frame._styk.frameId]: frame}; },
  ];
  for (const corrupt of invalid) {
    const document = clone(before); corrupt(document);
    assert.throws(() => editor.load(document), /identit|frame source/i);
    assert.equal(editor.report, current); assert.deepEqual(editor.serialize(), before);
  }
  assert.doesNotThrow(() => validateFrameIdentities(editor.report));
});
