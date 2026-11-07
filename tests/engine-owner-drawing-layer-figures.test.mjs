// A movieclip imported while a drawing layer is active is placed on it (a replacement, which opening has never checked as it checks a key's
// frame), and the base reopens the file with the instance on that layer. The repair opening makes of a figure on a drawing layer moves only
// what opening would refuse, so a save opens as it was written (found by the movieclip fuzz: a drawing layer created, a clip exported as a
// `.stykmov` file and imported again; the instance went to the first layer, silently).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DocumentExporter} from '../src/document-export.mjs';
import {snapshotDocument} from '../src/engine/engine-owner.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';
import {openBytes, attachRead} from '../src/engine/engine-open.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';
import {useExportWorker} from './support/export-worker.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

const options = {demo: false, layerTimeline: true, propertyChannels: true};
const fixture = JSON.parse(readFileSync(new URL('../engine/tests/edit/sheet-movieclip.document.json', import.meta.url), 'utf8'));

/** The assignments of the project as a file saved from `editor` opens, and the repairs the open made. */
async function reopened(editor) {
  const file = makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(editor.report)], scopes: [], name: 'Saved'}});
  const opening = await openBytes(new Uint8Array(file.bytes), 'saved.styk', {layerTimeline: true});
  try {
    const read = await opening.read();
    return {repairs: opening.repairs, assignments: JSON.parse(JSON.stringify(read.report._styk.layers.assignments))};
  } finally { opening.dispose(); }
}

test('a movieclip exported to a file and imported while a drawing layer is active stays on that layer when the project is saved and opened', {timeout: 30000}, async t => {
  useExportWorker(t);
  const codecHost = new FakeCodecHost(), exporter = new DocumentExporter({codecHost, idleMs: 0});
  t.after(() => { exporter.dispose(); codecHost.close(); });
  const {editor} = ownedEditorSync(options, fixture, {verify: false, recorded: false});
  const clip = editor.report.figure_types.find(figure => figure._styk?.movieclip);
  // The recorded calls: a clip is entered and left, a drawing layer is made, the clip is exported as a `.stykmov` file, and the file imported.
  editor.enterMovieclip(clip.figure_type_id);
  editor.leaveMovieclip();
  editor.createDrawingLayer();
  const drawingLayer = editor.activeLayerId;
  const blob = await exporter.export(editor.report, {format: 'stykmov', figureTypeId: clip.figure_type_id, revision: editor.revision});
  const opening = await openBytes(new Uint8Array(await blob.arrayBuffer()), 'clip.stykmov', {layerTimeline: false}), read = await opening.read();
  attachRead(read.report, read);
  const placed = editor.importFigure(structuredClone(read.report));
  const assigned = editor.report._styk.layers.assignments[placed.unique_id];
  assert.equal(assigned, drawingLayer, 'the gesture places the instance where the active layer is, as it always has');
  const file = await reopened(editor);
  assert.equal(file.repairs, 0, 'nothing to mend when the file opens');
  assert.equal(file.assignments[placed.unique_id], drawingLayer, 'and the instance is on the layer it was saved on');
  assert.deepEqual(file.assignments, JSON.parse(JSON.stringify(editor.report._styk.layers.assignments)), 'the file opens as it was written');
});
