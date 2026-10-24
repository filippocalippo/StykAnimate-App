// A brush stroke reaches the engine owner as tile buffers (megabytes for one stroke): the owner
// hands it to the editor's drawing store without ever turning the pixels into JSON for the
// session, and the stroke is one undoable entry, as without the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {DrawingHistory} from '../src/drawing-history.mjs';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt, nodeEngine} from './support/engine-node.mjs';

/** A drawing history whose spill files live in memory. */
const memoryDisk = () => {
  const records = new Map();
  return {
    async request(kind, data) {
      if (kind === 'begin') records.set(data.record, []);
      if (kind === 'append') records.get(data.record).push(structuredClone(data.tiles));
      if (kind === 'finish') return {result: {storedBytes: records.get(data.record).flat().length * TILE_BYTES}};
      if (kind === 'info') return {result: {parts: records.get(data.record).length, tiles: records.get(data.record).flat().length}};
      if (kind === 'read') return {tiles: structuredClone(records.get(data.record)[data.part])};
      if (kind === 'remove') records.delete(data.record);
      return {};
    },
    async close() { records.clear(); },
  };
};

test('a stroke\'s pixels never become JSON for the session', {skip: !engineBuilt}, async () => {
  await nodeEngine();
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true});
  const history = new DrawingHistory({disk: memoryDisk(), hotBytes: 0, minRecordBytes: 1});
  const resources = new DrawingResources(editor.report, {history, worker: {request: async () => ({}), dispose() {}}});
  resources.busy = true;
  const owner = installEngineOwner(editor);
  try {
    editor.createDrawingLayer();
    const target = editor.prepareDrawingCel();
    await resources.surface(target.figure);
    let serialized = 0;
    const tiles = Object.assign([{tx: 0, ty: 0, before: null, after: new Uint8ClampedArray(TILE_BYTES).fill(7)}], {toJSON() { serialized++; return []; }});
    editor.commitDrawingPixels(target, tiles, 'Brush stroke');
    assert.equal(serialized, 0, 'the owner turned the stroke into JSON');
    assert.equal(editor.undoLabel, 'Brush stroke');
    assert.equal(owner.editor?.commitDrawingPixels, 1, 'the editor applied the stroke');
  } finally {
    owner.release();
    resources.dispose();
    await history.dispose();
  }
});
