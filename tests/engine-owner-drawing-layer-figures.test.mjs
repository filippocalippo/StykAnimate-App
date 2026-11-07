// A drawing layer holds only drawing cels. A movieclip imported while one is active used to be assigned to it, and the file saved so was
// mended when it opened: the instance moved to the first layer, silently, so a save did not open as it was written (found by the movieclip
// fuzz: a drawing layer created, a clip exported as a `.stykmov` file and imported again). The figure is not placed on a drawing layer now, as
// a movieclip is not by `addFigure`, whichever way it comes.
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
const REFUSAL = 'errors.editorLayerSheet.drawingLayersAcceptOneDrawingCelAtA';

/** The assignments of the project as a file saved from `editor` opens, and the repairs the open made. */
async function reopened(editor) {
  const file = makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(editor.report)], scopes: [], name: 'Saved'}});
  const opening = await openBytes(new Uint8Array(file.bytes), 'saved.styk', {layerTimeline: true});
  try {
    const read = await opening.read();
    return {repairs: opening.repairs, assignments: JSON.parse(JSON.stringify(read.report._styk.layers.assignments))};
  } finally { opening.dispose(); }
}

test('a movieclip exported to a file and imported while a drawing layer is active is refused, and the project saves as it is', {timeout: 30000}, async t => {
  useExportWorker(t);
  const codecHost = new FakeCodecHost(), exporter = new DocumentExporter({codecHost, idleMs: 0});
  t.after(() => { exporter.dispose(); codecHost.close(); });
  const {editor} = ownedEditorSync(options, fixture, {verify: false, recorded: false});
  const clip = editor.report.figure_types.find(figure => figure._styk?.movieclip);
  // The recorded calls: a drawing layer is made, the clip is exported as a `.stykmov` file, and the file imported.
  editor.createDrawingLayer();
  const blob = await exporter.export(editor.report, {format: 'stykmov', figureTypeId: clip.figure_type_id, revision: editor.revision});
  const opening = await openBytes(new Uint8Array(await blob.arrayBuffer()), 'clip.stykmov', {layerTimeline: false}), read = await opening.read();
  attachRead(read.report, read);
  const before = JSON.stringify(editor.report);
  assert.throws(() => editor.importFigure(structuredClone(read.report)), error => error.messageKey === REFUSAL);
  assert.equal(JSON.stringify(editor.report), before, 'and changes nothing');
  // Where it may go, it is saved where it was placed.
  editor.setActiveLayer('layer-1');
  editor.importFigure(structuredClone(read.report));
  const file = await reopened(editor);
  assert.equal(file.repairs, 0, 'nothing to mend when the file opens');
  assert.deepEqual(file.assignments, JSON.parse(JSON.stringify(editor.report._styk.layers.assignments)), 'the file opens as it was written');
});
