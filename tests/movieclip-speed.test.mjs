// The movieclip commands the performance work changed (docs/engine/editing.md, "Movieclips"): a clip of many figures replaces each in
// one pass, the figure a creation answers is read from the document only when asked for more than its name, and none of it changes
// what is saved or what undo and redo give back. The saved bytes after each step of a scripted session are those the engine saved before
// the change (tests/fixtures/movieclip-save-bytes.json, recorded at engine-rust 0ad32e9a with STYK_RECORD_MOVIECLIP_BYTES): a pose array of
// 32 numbers or more that two records share is stored once, so a small document would not show a difference in how the clips share them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {tableOf} from '../src/lazy-table.mjs';
import {snapshotDocument} from '../src/engine/engine-owner.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';
import {createFrame, createObject, emptyDocument} from '../src/demo.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

const options = {demo: false, layerTimeline: true, propertyChannels: true};
const savedBytes = editor => Buffer.from(makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(editor.report)], scopes: [], name: 'Saved'}}).bytes);
const FIXTURE = new URL('./fixtures/movieclip-save-bytes.json', import.meta.url);
const digest = editor => createHash('sha256').update(savedBytes(editor)).digest('hex');

/** Six frames of `count` figures of 70 joints each: every pose array holds well over 32 numbers. */
function crowd(count) {
  const document = emptyDocument(), figure = document.figure_types[0];
  for (let id = 11; id < 71; id++) figure.segments.push({...figure.segments[2], segment_id: id, parent_id: 1, z_order: id});
  figure.segment_count = figure.segments.length;
  document.keyframes = Array.from({length: 6}, (_, index) => createFrame(Array.from({length: count}, (_, slot) => createObject(figure, slot + 1, 100 + index + slot * 40, 100)), 1));
  assert.ok(document.keyframes[0].objects[0].angles.length >= 32);
  return document;
}

function session(count) {
  const {editor, owner} = ownedEditorSync(options, crowd(count), {verify: false});
  return {editor, owner};
}

test('a clip of several figures of one layer is made, undone and redone exactly', async () => {
  const {editor, owner} = session(5);
  const before = owner.session().report_json();
  editor.select(null);
  const clip = editor.createMovieclip({start: 0, end: 4, uids: []});
  const made = owner.session().report_json();
  assert.notEqual(made, before);
  // Every figure of the layer was replaced by the clip.
  assert.equal(editor.evaluatedFrame.objects.length, 1);
  assert.equal(editor.evaluatedFrame.objects[0].figure_type_id, clip.figure_type_id);
  await editor.undo();
  assert.equal(owner.session().report_json(), before, 'undone to the document before');
  await editor.redo();
  assert.equal(owner.session().report_json(), made, 'redone to the clip as made');
  assert.deepEqual(owner.refused, {});
});

test('a clip entered, edited and left, then placed twice, is undone and redone exactly', async () => {
  const {editor, owner} = session(4);
  editor.select(null);
  const clip = editor.createMovieclip({start: 0, end: 4, uids: []});
  editor.enterMovieclip(clip.figure_type_id);
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(25, 10);
  editor.leaveMovieclip();
  const left = owner.session().report_json();
  editor.seek(2);
  editor.select(null);
  editor.addFigure(clip.figure_type_id);
  editor.seek(3);
  editor.select(null);
  editor.addFigure(clip.figure_type_id);
  const placed = owner.session().report_json();
  await editor.undo();
  await editor.undo();
  assert.equal(owner.session().report_json(), left, 'the instances undone');
  await editor.redo();
  await editor.redo();
  assert.equal(owner.session().report_json(), placed, 'and redone');
  assert.deepEqual(owner.refused, {});
});

test('a clip left with no edit changes nothing, and one entered again and left after an edit is one entry', async () => {
  const {editor, owner} = session(3);
  editor.select(null);
  const clip = editor.createMovieclip({start: 0, end: 3, uids: []});
  const made = owner.session().report_json(), depth = editor._undo.length;
  editor.enterMovieclip(clip.figure_type_id);
  editor.leaveMovieclip();
  assert.equal(owner.session().report_json(), made, 'nothing was given back');
  assert.equal(editor._undo.length, depth);
  editor.enterMovieclip(clip.figure_type_id);
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(5, 5);
  editor.leaveMovieclip();
  assert.equal(editor._undo.length, depth + 1);
  await editor.undo();
  assert.equal(owner.session().report_json(), made);
});

test('the figure a clip creation answers is its definition, read from the document only when something asks for more than its name', () => {
  const {editor} = session(3);
  editor.select(null);
  const clip = editor.createMovieclip({start: 0, end: 4, uids: [], name: 'Crowd'});
  const figures = editor.report.figure_types, table = tableOf(figures);
  assert.equal(clip.name, 'Crowd');
  assert.equal(clip.figure_type_id, table ? table.rowAt(figures.length - 1).id : figures.at(-1).figure_type_id);
  if (table) {
    // Reading the answer's identity and name fetched nothing; the definition is fetched on the first other read.
    const index = table.positionOf(clip.figure_type_id, true);
    assert.ok(!table.fetched().includes(index), 'the clip definition was not read');
    assert.equal(clip._styk.movieclip.duration, 4);
    assert.ok(table.fetched().includes(index), 'and is read once something needs it');
  } else assert.equal(clip._styk.movieclip.duration, 4);
  assert.ok(Object.keys(clip).includes('_styk') && 'segments' in clip);
});

/** The saved bytes after each step of a session over crowds whose records share pose arrays of 70 numbers: a clip made of several figures, entered,
 * edited and left, nested, placed twice, and undone and redone through all of it. */
async function savedAtEachStep() {
  const hashes = {};
  const {editor} = session(4);
  const step = name => { hashes[name] = digest(editor); };
  step('opened');
  editor.select(null);
  const clip = editor.createMovieclip({start: 0, end: 4, uids: []});
  step('made');
  editor.enterMovieclip(clip.figure_type_id);
  step('entered');
  editor.select(null);
  const inner = editor.createMovieclip({start: 0, end: 3, uids: []});
  step('inner made');
  editor.enterMovieclip(inner.figure_type_id);
  editor.select(editor.evaluatedFrame.objects[0].unique_id, -1);
  editor.moveSelection(25, 10);
  step('edited in the inner clip');
  editor.leaveMovieclip();
  step('inner left');
  editor.leaveMovieclip();
  step('left');
  editor.seek(2);
  editor.select(null);
  editor.addFigure(clip.figure_type_id);
  editor.seek(3);
  editor.select(null);
  editor.addFigure(clip.figure_type_id);
  step('placed twice');
  for (let i = 0; i < 4; i++) await editor.undo();
  step('undone');
  for (let i = 0; i < 4; i++) await editor.redo();
  step('redone');
  return hashes;
}

test('the bytes saved after each step of a scripted clip session are those the engine saved before the speed work', async () => {
  const hashes = await savedAtEachStep();
  if (process.env.STYK_RECORD_MOVIECLIP_BYTES) { writeFileSync(FIXTURE, JSON.stringify(hashes, null, 1) + String.fromCharCode(10)); return; }
  assert.deepEqual(hashes, JSON.parse(readFileSync(FIXTURE, 'utf8')));
});
