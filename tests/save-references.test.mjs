// A save writes the files the repository records. `engine/tests/containers/` holds a file of each kind the container makes (arrays,
// arrays shared by several records, pose channels, pictures, a drawing, a figure, two movieclips): the project files are opened as the
// app opens them and saved through the editing session on the real export worker, and the figure files are saved from the documents
// they were made from. Every one comes out as the bytes in the repository, which are the bytes the JavaScript writer wrote, so an
// unchanged document saves to the file it was opened from (the one file the editor's load changes, `project-shared-arrays.styk`,
// is compared as a document here and byte for byte by `engine/crates/styk-engine/tests/save.rs`). `engine/tools/container-fixtures.mjs` regenerates them from the same
// recipes; `scripts/engine-parity.mjs` runs it.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';
import {DocumentExporter} from '../src/document-export.mjs';
import {attachRead, openBytes} from '../src/engine/engine-open.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';
import {useExportWorker} from './support/export-worker.mjs';
import {decodeDocument, openDocument} from './support/native-files.mjs';
import {newOwnedEditor} from './support/owned-editor.mjs';

const containers = new URL('../engine/tests/containers/', import.meta.url);
const fixtures = new URL('../engine/crates/styk-eval/tests/fixtures/', import.meta.url);
const recorded = name => new Uint8Array(readFileSync(new URL(name, containers)));

function exporterFor(t) {
  useExportWorker(t);
  const codecHost = new FakeCodecHost(), exporter = new DocumentExporter({codecHost, idleMs: 0});
  t.after(() => { exporter.dispose(); codecHost.close(); });
  return exporter;
}

/** The editor the engine owns on the project in `bytes`, opened as the app opens a file. */
async function opened(bytes, filename) {
  const opening = await openBytes(bytes, filename, {layerTimeline: false});
  const read = await opening.read();
  attachRead(read.report, read);
  const editor = newOwnedEditor({demo: false, propertyChannels: true});
  editor.load(read.report);
  return editor;
}

const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

/** The arrays of a document that are the same instance in more than one place. */
function sharedArrays(root) {
  const seen = new Set(), shared = new Set(), walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.length >= 32 && value.every(item => typeof item === 'number')) {
      if (seen.has(value)) shared.add(value); else seen.add(value);
      return;
    }
    for (const item of Array.isArray(value) ? value : Object.values(value)) walk(item);
  };
  walk(root);
  return shared;
}

// The editor gives the frames of a movieclip kept inside a project an identity when it loads one, which the recorded file lacks
// (`project-shared-arrays.styk`); the byte comparison of that file is `engine/crates/styk-engine/tests/save.rs`, from the session's tree.
const versionTwo = readdirSync(containers).filter(name => name.endsWith('.styk') && !['project-version-1.styk', 'project-shared-arrays.styk'].includes(name));

for (const name of versionTwo) {
  test(`${name}, opened and saved again, is the file in the repository byte for byte`, {timeout: 30000}, async t => {
    const exporter = exporterFor(t), file = recorded(name), editor = await opened(file, name);
    const saved = await bytesOf(await exporter.export(editor.report, {revision: editor.revision}));
    assert.ok(Buffer.from(saved).equals(file), `${name}: ${saved.length} bytes saved, ${file.length} recorded`);
  });
}

/** The document without the identities the editor gives frames when it loads one. */
function withoutFrameIds(value) {
  if (Array.isArray(value)) return value.map(withoutFrameIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'frameId').map(([key, item]) => [key, withoutFrameIds(item)]));
}

test('arrays that several records share are stored once when the project is saved, and read back shared', {timeout: 30000}, async t => {
  const exporter = exporterFor(t), file = recorded('project-shared-arrays.styk'), editor = await opened(file, 'project-shared-arrays.styk');
  const saved = await bytesOf(await exporter.export(editor.report, {revision: editor.revision}));
  const [before, after] = (await Promise.all([file, saved].map(bytes => decodeDocument(bytes, 'styk')))).map(({document}) => document);
  assert.ok(sharedArrays(before).size >= 4, 'the recorded file shares the mesh of the figure with the movieclip that holds it again');
  assert.equal(sharedArrays(after).size, sharedArrays(before).size, 'what the file shared, the save shares');
  assert.deepEqual(withoutFrameIds(after), withoutFrameIds(before));
});

test('a version 1 file saves as a version 2 container of the same document', {timeout: 30000}, async t => {
  const exporter = exporterFor(t), file = recorded('project-version-1.styk'), editor = await opened(file, 'project-version-1.styk');
  const saved = await bytesOf(await exporter.export(editor.report, {revision: editor.revision}));
  assert.equal(saved[5], 2, 'a container of the current version');
  const [before, after] = (await Promise.all([file, saved].map(bytes => decodeDocument(bytes, 'styk')))).map(({document}) => document);
  assert.deepEqual({...after, _styk: {...after._styk, format: undefined, format_version: undefined}}, {...before, _styk: {...before._styk, format: undefined, format_version: undefined}});
});

// The figure and movieclip files are made of documents the repository keeps, as `engine/tools/container-fixtures.mjs` makes them.
const figureFiles = [
  ['figure.stkz', 'spatial/mesh-views.json', {format: 'stkz', name: 'Mesh figure', figureTypeId: 1, tick: 0}],
  ['movieclip-effects.stykmov', 'generators/movieclip.json', {format: 'stykmov', name: 'Effects clip', figureTypeId: 2, tick: 0}],
  ['movieclip-motion.stykmov', 'channels/channels-in-movieclip.json', {format: 'stykmov', name: 'Motion clip', figureTypeId: 3, tick: 0}],
];
for (const [name, source, request] of figureFiles) {
  test(`${name}, made again from the document it was made of, is the file in the repository byte for byte`, {timeout: 30000}, async t => {
    const exporter = exporterFor(t), document = await openDocument(new Uint8Array(readFileSync(new URL(source, fixtures))), 'styk', {verifySource: false});
    const editor = newOwnedEditor({demo: false, propertyChannels: true, layerTimeline: Boolean(document._styk?.layerSheet)});
    editor.load(structuredClone(document));
    const saved = await bytesOf(await exporter.export(editor.report, {...request, revision: editor.revision}));
    assert.ok(Buffer.from(saved).equals(Buffer.from(recorded(name))), `${name}: ${saved.length} bytes made, ${recorded(name).length} recorded`);
  });
}
