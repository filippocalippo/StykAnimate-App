// The editor's read view names the pictures a file holds instead of reading them (src/lazy-payload.mjs): a field
// is the picture's text when something reads it, from the engine. Opened, edited, undone, redone and saved, a
// picture is the bytes it was, and verify mode (the session's document against the view, after every call) holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageFigure} from '../src/media-authoring.mjs';
import {emptyDocument} from '../src/demo.mjs';
import {bytesToBase64} from '../src/base64.mjs';
import {attachRead, openBytes, openJson} from '../src/engine/engine-open.mjs';
import {copyRecord} from '../src/lazy-payload.mjs';
import {applyDocumentPatch} from '../src/engine/engine-patch.mjs';
import {buildContainerV2} from './support/native-files.mjs';
import {newOwnedEditor} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

const PICTURE = (seed, size = 70_000) => bytesToBase64(Uint8Array.from({length: size}, (_, i) => (i * seed + (i >> 3)) & 255));

/** A project holding a large picture as a figure (`figure_type_id` 2), in both of the fields a file lifts. */
function projectWithPicture(base64) {
  const document = emptyDocument();
  const figure = createImageFigure({dataUrl: `data:image/png;base64,${base64}`, width: 32, height: 24, name: 'Photo', figureTypeId: 2});
  figure.image_assets[0].data_base64 = base64;
  document.figure_types.push(figure);
  return document;
}
const pictureOf = editor => editor.report.figure_types.find(figure => figure.figure_type_id === 2).image_assets[0];
const isLazy = (object, key) => typeof Object.getOwnPropertyDescriptor(object, key)?.get === 'function';

/** The editor the engine owns on the project in `file`, opened as the app opens a file. */
async function openedEditor(file) {
  const opening = await openBytes(file, 'photo.styk', {layerTimeline: true});
  const read = await opening.read();
  attachRead(read.report, read);
  const editor = newOwnedEditor({demo: false});
  editor.load(read.report);
  return {editor, read};
}

test('an opened picture is named by the view and read from the engine when something asks', async () => {
  const base64 = PICTURE(7), url = `data:image/png;base64,${base64}`;
  const {editor} = await openedEditor(await buildContainerV2(projectWithPicture(base64), 'styk'));
  const asset = pictureOf(editor);
  assert.ok(isLazy(asset, 'data_url') && isLazy(asset, 'data_base64'), 'both fields wait to be read');
  assert.ok(Object.keys(asset).includes('data_url'), 'the field is an ordinary enumerable one');
  assert.equal(asset.data_url, url);
  assert.equal(asset.data_base64, base64);
  assert.equal(asset.data_url, asset.data_url, 'asked again, the same text');
  assert.throws(() => { asset.data_url = 'data:,'; }, TypeError, 'the view is not written in place');
  assert.equal(JSON.parse(JSON.stringify(asset)).data_base64, base64, 'JSON and copies read the picture');
});

test('a picture added, undone and redone is the same bytes at every step', async () => {
  const base64 = PICTURE(11), {editor} = await openedEditor(await buildContainerV2(projectWithPicture(PICTURE(5)), 'styk'));
  const sprite = createImageFigure({dataUrl: `data:image/png;base64,${base64}`, width: 1, height: 1, name: 'Added', figureTypeId: 3});
  const added = () => editor.report.figure_types.flatMap(figure => figure.image_assets ?? []).filter(asset => asset.data_url?.includes(base64.slice(0, 200)));
  const before = editor.report.figure_types.length;
  editor.importFigure(sprite, {position: {x: 300, y: 200}});
  assert.equal(added().length, 1);
  assert.equal(added()[0].data_url, `data:image/png;base64,${base64}`);
  editor.undo();
  assert.equal(added().length, 0);
  assert.equal(editor.report.figure_types.length, before);
  editor.redo();
  assert.equal(added().length, 1);
  assert.equal(added()[0].data_url, `data:image/png;base64,${base64}`);
});

test('a patch that carries an opened picture names it, and undo gives its bytes back', async () => {
  const base64 = PICTURE(3), {editor} = await openedEditor(await buildContainerV2(projectWithPicture(base64), 'styk'));
  const url = `data:image/png;base64,${base64}`;
  const definition = structuredClone(editor.report.figure_types.find(figure => figure.figure_type_id === 2));
  definition.name = 'Renamed';
  definition.image_assets[0].width = 33;
  editor.replaceFigureDefinition(2, definition);
  assert.equal(pictureOf(editor).width, 33);
  assert.equal(pictureOf(editor).data_url, url);
  editor.undo();
  assert.equal(pictureOf(editor).width, 32);
  assert.ok(isLazy(pictureOf(editor), 'data_url'), 'the engine names the picture the undo restores');
  assert.equal(pictureOf(editor).data_url, url);
  assert.equal(pictureOf(editor).data_base64, base64);
  editor.redo();
  assert.equal(pictureOf(editor).width, 33);
  assert.equal(pictureOf(editor).data_url, url);
});

test('a patch copies and rebuilds records around a picture without reading it', async () => {
  const base64 = PICTURE(9), {editor} = await openedEditor(await buildContainerV2(projectWithPicture(base64), 'styk'));
  const asset = pictureOf(editor);
  const copy = copyRecord(asset);
  assert.ok(isLazy(copy, 'data_url'), 'a copy keeps the picture unread');
  assert.deepEqual(Object.keys(copy), Object.keys(asset));
  const figure = editor.report.figure_types.find(figure => figure.figure_type_id === 2);
  applyDocumentPatch(editor.report, [{p: ['figure_types', editor.report.figure_types.indexOf(figure), 'image_assets', 0, 'width'], v: 40}]);
  assert.ok(isLazy(pictureOf(editor), 'data_url') && pictureOf(editor).width === 40, 'a small change leaves the picture lazy');
  assert.notEqual(pictureOf(editor), asset, 'the record on the path is a copy');
});

test('a view with its pictures unread reads as the document that was opened', async () => {
  const base64 = PICTURE(13);
  const first = await openJson(projectWithPicture(base64), 'photo', {layerTimeline: true});
  const plain = (await first.read()).report;
  const {read} = await openedEditor(await buildContainerV2(plain, 'styk'));
  const asset = read.report.figure_types.find(figure => figure.figure_type_id === 2).image_assets[0];
  assert.ok(isLazy(asset, 'data_url'));
  const materialized = JSON.parse(JSON.stringify(read.report)), same = materialized.figure_types.find(figure => figure.figure_type_id === 2).image_assets[0];
  assert.equal(same.data_base64, base64);
  assert.equal(same.data_url, `data:image/png;base64,${base64}`);
  assert.deepEqual(Object.keys(asset), Object.keys(same), 'the fields keep their order, which the bytes of a save depend on');
});

test('a string that looks like a payload marker stays a string', async () => {
  const document = projectWithPicture(PICTURE(1));
  document.figure_types[0].name = 'S2P:12';
  document.figure_types[1].name = 'S2E:S2P:3';
  const {editor} = await openedEditor(await buildContainerV2(document, 'styk'));
  assert.equal(editor.report.figure_types[0].name, 'S2P:12');
  assert.equal(editor.report.figure_types[1].name, 'S2E:S2P:3');
  const figure = structuredClone(editor.report.figure_types[0]);
  figure.name = 'S2P:99';
  editor.replaceFigureDefinition(figure.figure_type_id, figure);
  editor.undo();
  assert.equal(editor.report.figure_types[0].name, 'S2P:12');
  editor.redo();
  assert.equal(editor.report.figure_types[0].name, 'S2P:99');
});
