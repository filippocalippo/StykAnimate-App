// The read view's lazy tables (src/lazy-table.mjs): an array to its readers whose records come from the session when read, held
// in a bounded cache, and kept in step with the session by its patches (src/engine/engine-patch.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchedRecords, figureRow, frameRow, frameSummary, holdingAll, lazyKeyedTable, lazyTable, tableOf, useRecords} from '../src/lazy-table.mjs';
import {drawingFigures, figureForCel, figureRows, findFigureType, hasDrawingFigures, movieclipFigures, nextFigureTypeId} from '../src/figure-types.mjs';
import {createImageFigure} from '../src/media-authoring.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
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
  return {from, array: lazyTable('keyframes', count, from.records.map(frameRow), from, limit)};
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
  const kept = [...editor._layerGroups].map(([id, members]) => [id, [...members].sort()]);
  holdingAll(() => editor._initializeLayers());
  assert.deepEqual(kept, [...editor._layerGroups].map(([id, members]) => [id, [...members].sort()]), 'the layer index the patches kept is the one counted from the whole document');
});

// --- the figure types and the pose sources -------------------------------------------------------------------------------------------

const figureOf = (id, extra = {}) => ({figure_type_id: id, name: `Figure ${id}`, segments: [{segment_id: 1}, {segment_id: 2}], ...extra});
function figureSource(figures) {
  const asked = [];
  return {asked, fetch(name, index) { asked.push(index); return structuredClone(figures[index]); }};
}
const figureTable = (figures, limit) => {
  const from = figureSource(figures);
  return {from, array: lazyTable('figure_types', figures.length, figures.map(figureRow), from, limit)};
};

test('a figure type is found by its id, and the figures are listed, without fetching the others', () => {
  const figures = [figureOf(3), figureOf(8, {image_assets: [{}]}), figureOf(5, {_styk: {drawing: {celId: 'cel-a', version: 2}}}), figureOf(9, {_styk: {movieclip: {}}})];
  const {from, array} = figureTable(figures);
  assert.equal(findFigureType(array, 5)?.figure_type_id, 5);
  assert.equal(findFigureType(array, 77), undefined);
  assert.deepEqual(from.asked, [2], 'only the type asked for');
  assert.deepEqual(figureRows(array).map(row => [row.id, row.kind, row.cel, row.segments]), [[3, 'Figure', null, 2], [8, 'Image', null, 2], [5, 'Figure', 'cel-a', 2], [9, 'Movieclip', null, 2]]);
  assert.equal(nextFigureTypeId(array), 10);
  assert.equal(hasDrawingFigures(array), true);
  assert.equal(figureForCel(array, 'cel-a').figure_type_id, 5);
  assert.deepEqual(drawingFigures(array).map(figure => figure.figure_type_id), [5]);
  assert.deepEqual(movieclipFigures(array).map(figure => figure.figure_type_id), [9]);
  assert.deepEqual(from.asked, [2, 3], 'the cel type and the movieclip type, nothing else');
  assert.deepEqual(figureRows(figures), figureRows(array), 'a plain array answers the same');
  assert.equal(findFigureType(figures, 8).figure_type_id, 8);
});

test('the rows the open sends are the rows of the records, for every kind of figure', async () => {
  const document = emptyDocument();
  document.figure_types.push(createImageFigure({dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 8, height: 8, name: 'Photo', figureTypeId: 2}), createDrawingFigure({figureTypeId: 3}));
  const {editor} = ownedEditorSync({demo: false}, document, {verify: false});
  const table = tableOf(editor.report.figure_types);
  assert.ok(table, 'the figure types are a lazy table');
  const sent = table.rows();
  assert.deepEqual(holdingAll(() => editor.report.figure_types.map(figureRow)), sent);
  assert.deepEqual(sent.map(row => row.kind), ['Figure', 'Image', 'Image']);
  assert.equal(sent[2].cel !== null, true);
  assert.equal(sent[1].pictures, true);
});

test('pose sources are keys until something reads one, and a patch gives keys, not records', () => {
  const records = {asked: [], fetch(name, key) { this.asked.push(key); return {objects: [{unique_id: key.length}], key}; }};
  const root = {_styk: {frameSources: lazyKeyedTable('_styk.frameSources', ['a', 'bb'], records)}};
  useRecords(root, records);
  assert.deepEqual(Object.keys(root._styk.frameSources), ['a', 'bb']);
  assert.equal(Object.hasOwn(root._styk.frameSources, 'bb'), true);
  assert.deepEqual(records.asked, []);
  assert.equal(root._styk.frameSources.bb.objects[0].unique_id, 2);
  applyDocumentPatch(root, [{p: ['_styk', 'frameSources', 'bb', 'objects', 0, 'x'], v: 5}, {p: ['_styk', 'frameSources', 'a'], lz: 1}, {p: ['_styk', 'frameSources', 'ccc'], lz: 1}]);
  assert.deepEqual(Object.keys(root._styk.frameSources), ['a', 'bb', 'ccc']);
  assert.equal(root._styk.frameSources.bb.objects[0].x, 5, 'a change inside a record the view holds');
  assert.deepEqual(records.asked, ['bb'], 'the others are not read');
  assert.equal(root._styk.frameSources.ccc.key, 'ccc');
  assert.deepEqual(fetchedRecords(root)['_styk.frameSources'], ['bb', 'ccc']);
  assert.throws(() => applyDocumentPatch(root, [{p: ['_styk', 'frameSources', 'a', 'objects'], v: []}]), /not fetched/);
  applyDocumentPatch(root, [{p: ['_styk', 'frameSources'], o: [['bb'], ['d', null, 1], ['ccc']]}, {p: ['_styk', 'frameSources', 'bb'], x: 1}]);
  assert.deepEqual(Object.keys(root._styk.frameSources), ['d', 'ccc']);
  applyDocumentPatch(root, [{p: ['_styk', 'frameSources'], lz: ['x', 'y']}]);
  assert.deepEqual(Object.keys(root._styk.frameSources), ['x', 'y']);
  assert.deepEqual(JSON.parse(JSON.stringify(root._styk.frameSources.y)), {objects: [{unique_id: 1}], key: 'y'});
});

test('duplicating a frame answers with the new frame, not with a copy of every pose the layer sheet captures', () => {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = Array.from({length: 120}, (_, index) => createFrame(Array.from({length: 30}, (_, slot) => createObject(figure, slot + 1, index + slot, 100)), 2));
  const {editor, owner} = ownedEditorSync({demo: false, layerTimeline: true}, document, {verify: false});
  const session = owner.session(), call = session.call.bind(session);
  let bytes = 0;
  session.call = (method, args, view) => { const answer = call(method, args, view); if (method === 'sheetDuplicateFrameAfter') bytes = answer.length; return answer; };
  editor.selectFrame(5);
  editor.sheetDuplicateFrameAfter();
  const text = holdingAll(() => JSON.stringify(editor.report));
  assert.equal(text, session.report_json(), 'the view is the session\'s document');
  assert.ok(bytes > 0 && bytes < 300_000, `the answer is ${bytes} bytes`);
  assert.ok(editor.undo());
  assert.equal(holdingAll(() => JSON.stringify(editor.report)), session.report_json());
});

test('a patch names a record the view does not hold by its row, and the view fetches it when it is read', () => {
  const {from, array} = table(6);
  const root = {keyframes: array};
  array[1];
  applyDocumentPatch(root, [{p: ['keyframes', 1], lz: {id: 'frame-1b', background: 0, color: null, figures: 1}}, {p: ['keyframes'], a: [0, {lz: {id: 'inserted', background: 0, color: null, figures: 1}}, 1, 2, 3, 4, 5]}]);
  assert.deepEqual(held(root.keyframes), [], 'the record replaced is given up, and the one the patch names is not read');
  const keyframes = tableOf(root.keyframes);
  assert.equal(keyframes.positionOf('inserted'), 1);
  assert.equal(keyframes.positionOf('frame-1b'), 2, 'the identity a patch names is the identity of the place');
  assert.equal(keyframes.positionOf('frame-1'), -1);
  assert.deepEqual(from.asked, [1]);
  assert.equal(root.keyframes[1].objects[0].unique_id, 2, 'read: fetched from the session at its place');
  assert.deepEqual(from.asked, [1, 1]);
});

test('verify mode sees a record written in place, even with more records than the table holds', () => {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = Array.from({length: 150}, (_, index) => createFrame([createObject(figure, 1, 100 + index, 100)], 2));
  const {editor} = ownedEditorSync({demo: false, layerTimeline: true}, document, {verify: true});
  editor.selectFrame(3);
  editor.frame.objects[0].root_x = 999;
  editor.selectFrame(140);
  editor.select(1);
  assert.throws(() => editor.moveSelection(1, 1), /differs from the read view/, 'the write is not given back by the comparison that counts the figures of every pose');
});

test('what the interface shows of the frame on show is read from the table, not from the record', () => {
  const {from, array} = table(5);
  from.records[3].background_id = 7; from.records[3]._stykBackgroundColor = 0xff112233;
  const rows = lazyTable('keyframes', 5, from.records.map(frameRow), from);
  assert.deepEqual(frameSummary(rows, 3), {id: 'frame-3', background: 7, color: 0xff112233, figures: 1});
  assert.deepEqual(from.asked, [], 'no record was read');
  assert.deepEqual(frameSummary(from.records, 3), frameSummary(rows, 3), 'a plain array answers the same');
  void array;
});

test('playback and scrubbing read no keyframe: a seek that does not evaluate, the summary of the frame on show', () => {
  const document = emptyDocument(), figure = document.figure_types[0];
  document.keyframes = Array.from({length: 80}, (_, index) => createFrame([createObject(figure, 1, 100 + index, 100)], 2));
  const {editor} = ownedEditorSync({demo: false, layerTimeline: true}, document, {verify: false});
  const table = tableOf(editor.report.keyframes), reads = [];
  const records = table.records, fetch = records.fetch.bind(records);
  records.fetch = (name, at) => { reads.push(at); return fetch(name, at); };
  for (let tick = 0; tick < 160; tick += 2) {
    assert.equal(editor.seek(tick, {evaluate: false}), undefined);
    assert.equal(editor.frameSummary.figures, 1);
  }
  assert.deepEqual(reads, [], 'the frames passed were not fetched');
  assert.equal(editor.frame.objects.length, 1);
  assert.equal(reads.length, 1, 'the one read of a frame is the one asked for');
});
