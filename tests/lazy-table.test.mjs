// The read view's lazy tables (src/lazy-table.mjs): an array to its readers whose records come from the session when read, held
// in a bounded cache, and kept in step with the session by its patches (src/engine/engine-patch.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchedRecords, holdingAll, lazyTable, tableOf} from '../src/lazy-table.mjs';
import {applyDocumentPatch} from '../src/engine/engine-patch.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

/** A source of `count` keyframes that counts what it is asked for. */
function source(count) {
  const asked = [], records = Array.from({length: count}, (_, index) => ({duration_raw: 1, _styk: {frameId: `frame-${index}`}, objects: [{unique_id: index + 1}]}));
  return {asked, records, fetch(name, index) { asked.push(index); return structuredClone(records[index]); }};
}
const table = (count, limit) => {
  const from = source(count);
  return {from, array: lazyTable('keyframes', count, from.records.map(record => record._styk.frameId), from, limit)};
};
const held = array => fetchedRecords({keyframes: array}).keyframes;

test('a lazy table is an array that fetches a record when it is read, once', () => {
  const {from, array} = table(5);
  assert.ok(Array.isArray(array) && array.length === 5 && tableOf(array));
  assert.deepEqual(from.asked, [], 'nothing is read at first');
  assert.equal(array[3].objects[0].unique_id, 4);
  assert.equal(array[3], array[3], 'a held record is the same object');
  assert.deepEqual(from.asked, [3]);
  assert.deepEqual(array.map(frame => frame._styk.frameId), ['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4']);
  assert.equal(array.find(frame => frame.objects[0].unique_id === 5)._styk.frameId, 'frame-4');
  assert.equal([...array].length, 5);
  assert.equal(array.slice(1, 3).length, 2);
  assert.equal(JSON.stringify(array), JSON.stringify(from.records));
  assert.deepEqual(structuredClone(array), from.records);
  assert.deepEqual(held(array), [0, 1, 2, 3, 4]);
  assert.throws(() => { array[0] = {}; }, 'the view is not written in place');
});

test('a table holds at most its limit of records, the oldest given back', () => {
  const {from, array} = table(20, 4);
  for (let index = 0; index < 20; index++) array[index];
  assert.ok(held(array).length <= 4);
  assert.deepEqual(array[0], from.records[0], 'a record given back is fetched again, equal');
  const recent = array[19];
  array[0]; array[1];
  assert.equal(array[19], recent, 'a record read lately stays');
  assert.equal(holdingAll(() => { for (let index = 0; index < 20; index++) array[index]; return held(array).length; }), 20, 'a read of the whole document gives nothing back meanwhile');
});

test('a table finds a record by its identity without fetching the others', () => {
  const {from, array} = table(50);
  const keyframes = tableOf(array);
  assert.equal(keyframes.positionOf('frame-41'), 41);
  assert.equal(keyframes.positionOf('nothing'), -1);
  assert.equal(keyframes.positionOf(null), -1);
  assert.deepEqual(from.asked, []);
  const root = {keyframes: array};
  applyDocumentPatch(root, [{p: ['keyframes', 7], v: {_styk: {frameId: 'frame-41'}, objects: []}}]);
  assert.equal(tableOf(root.keyframes).positionOf('frame-41'), 7, 'the first with an identity');
  assert.equal(tableOf(root.keyframes).positionOf('frame-41', true), 41, 'the last with an identity');
  assert.equal(from.asked.length, 0);
});

test('a patch changes the records the view holds, replaces one it does not, and rebuilds the table around those it keeps', () => {
  const {array} = table(6);
  const root = {keyframes: array};
  array[1]; array[2];
  // A change inside a record the view lacks is the session's to send whole.
  assert.throws(() => applyDocumentPatch(root, [{p: ['keyframes', 4, 'duration_raw'], v: 9}]), /not fetched/);
  const before = array[1], kept = array[2];
  applyDocumentPatch(root, [{p: ['keyframes', 1, 'duration_raw'], v: 7}, {p: ['keyframes', 4], v: {_styk: {frameId: 'frame-4'}, duration_raw: 3, objects: []}}]);
  assert.notEqual(root.keyframes, array, 'the table is replaced');
  assert.equal(root.keyframes[1].duration_raw, 7);
  assert.equal(before.duration_raw, 1, 'the record before is not changed');
  assert.equal(root.keyframes[2], kept, 'a record the patch left is the same object');
  assert.equal(root.keyframes[4].duration_raw, 3);
  assert.throws(() => array[0], /changed since/, 'the table the patch replaced is read no more');
  // Inserting a keyframe moves the others along: a record not fetched is still the session's, at its new place.
  const fetched = root.keyframes[1], untouched = tableOf(root.keyframes);
  applyDocumentPatch(root, [{p: ['keyframes'], a: [0, 1, {v: {_styk: {frameId: 'inserted'}, objects: []}}, 2, 3, 4, 5]}]);
  assert.equal(root.keyframes.length, 7);
  assert.equal(root.keyframes[1], fetched);
  assert.equal(tableOf(root.keyframes).positionOf('inserted'), 2);
  assert.equal(tableOf(root.keyframes).positionOf('frame-5'), 6);
  assert.ok(untouched.retired);
  assert.deepEqual(held(root.keyframes), [1, 2, 3, 5], 'what was held moved along, and the record the patch carried is held');
});

test('a patch over the session\'s own document fetches the record it changes and leaves the table in use', () => {
  const {array} = table(4);
  const copy = {keyframes: array};
  applyDocumentPatch(copy, [{p: ['keyframes', 2, 'duration_raw'], v: 5}], null, {strict: false});
  assert.equal(copy.keyframes[2].duration_raw, 5);
  assert.equal(array[0].objects[0].unique_id, 1, 'the table the variation was made from is still the document\'s');
  assert.equal(array[2].duration_raw, 1);
});

test('the engine owns a document whose view fetches its keyframes: edits, undo and redo agree with the session at every step', () => {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = Array.from({length: 150}, (_, index) => createFrame([createObject(figure, 1, 100 + index, 100)], 2));
  const {editor, owner} = ownedEditorSync({demo: false, layerTimeline: true}, document, {verify: false});
  assert.ok(tableOf(editor.report.keyframes), 'the keyframes are a lazy table');
  assert.ok(held(editor.report.keyframes).length <= 2, 'opening reads the frame on show and nothing else');
  assert.equal(editor.frame.objects[0].root_x, 100);
  const session = owner.session(), now = () => holdingAll(() => JSON.stringify(editor.report));
  // Edits of a record the view holds, of one it fetched and gave back, and of one it never read.
  editor.selectFrame(120);
  assert.equal(editor.frame.objects[0].root_x, 220);
  editor.select(1);
  editor.moveSelection(12, -4);
  assert.equal(now(), session.report_json());
  const moved = now();
  editor.selectFrame(7);
  editor.setFrameDuration(9);
  assert.equal(now(), session.report_json());
  assert.ok(editor.undo() && editor.undo());
  assert.equal(now(), session.report_json());
  assert.ok(editor.redo());
  assert.ok(editor.redo());
  assert.equal(now(), session.report_json());
  assert.notEqual(now(), moved);
  assert.ok(held(editor.report.keyframes).length <= 64, 'the cache is bounded');
  const counted = new Map(editor._layerUidCounts);
  holdingAll(() => editor._initializeLayers());
  assert.deepEqual([...counted], [...editor._layerUidCounts], 'the layer index the patches kept is the one counted from the whole document');
});
