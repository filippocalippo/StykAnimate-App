// A drawing's pixel commits under the engine owner: the session records the stroke (an erase, a fill, a pasted selection, a resample) as an
// ordinary history entry that names the cel and the record of the drawing store's history, and never takes the pixels, which are megabytes.
// The drawing store applies them around the session's call: strokes undo and redo as without the owner, a cold record loads from the disk
// first, and a failed or cancelled replay changes neither the pixels nor the history.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {DrawingHistory} from '../src/drawing-history.mjs';
import {drawingMetadata, migrateDrawingFigure} from '../src/drawing-model.mjs';
import {encodeDrawingPNG} from '../src/drawing-png.mjs';
import {drawingEngineOperation} from '../src/engine/engine-drawing-worker.mjs';
import {loadDrawingEngine} from '../src/engine/engine-drawing.mjs';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt, nodeEngine} from './support/engine-node.mjs';
import {ownedEditorWithDrawings} from './support/owned-editor.mjs';
import {canonical, ownerReferences} from './support/owner-references.mjs';

const refs = ownerReferences(import.meta.url);

/** A drawing history whose spill files live in memory (`reads`/`writes` gate and fail them). */
const memoryDisk = () => {
  const records = new Map();
  const disk = {
    records,
    async request(kind, data) {
      if (kind === 'begin') records.set(data.record, []);
      if (kind === 'append') {
        if (disk.writeGate) await disk.writeGate.promise;
        if (disk.writeError) throw disk.writeError;
        records.get(data.record).push(structuredClone(data.tiles));
      }
      if (kind === 'finish') return {result: {storedBytes: records.get(data.record).flat().length * TILE_BYTES}};
      if (kind === 'info') return {result: {parts: records.get(data.record).length, tiles: records.get(data.record).flat().length}};
      if (kind === 'read') {
        if (disk.readGate) await disk.readGate.promise;
        if (disk.readError) throw disk.readError;
        return {tiles: structuredClone(records.get(data.record)[data.part])};
      }
      if (kind === 'remove') records.delete(data.record);
      return {};
    },
    async close() { records.clear(); },
  };
  return disk;
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const stub = {request: async () => ({}), dispose() {}};
/** The pixel worker answered in this thread by the drawing raster engine. */
const engineWorker = () => ({
  async request(kind, data) {
    let reply;
    await drawingEngineOperation({id: 0, kind, ...structuredClone(data)}, message => { reply = message; });
    if (reply.error) throw Object.assign(new Error(reply.error), {messageKey: reply.messageKey});
    return reply;
  },
  dispose() {},
});
/** A tile painted `fill`, over `before` (a copy of what the cel held). */
const tile = (tx, ty, fill, before = null) => ({tx, ty, before: before && Uint8ClampedArray.from(before), after: new Uint8ClampedArray(TILE_BYTES).fill(fill)});

/** An editor the engine owns on a blank drawing layer, with a drawing store whose history spills to `disk`. */
async function painting({editorOptions = {}, historyOptions = {hotBytes: 0, minRecordBytes: 1}, setup = () => {}} = {}) {
  await nodeEngine();
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true});
  setup(editor);
  const disk = memoryDisk(), history = new DrawingHistory({disk, ...historyOptions});
  const resources = new DrawingResources(editor.report, {history, worker: stub, ...editorOptions});
  resources.busy = true;
  const owner = installEngineOwner(editor, {verify: true});
  assert.ok(owner.ready(), 'the document has its session');
  editor.createDrawingLayer();
  const target = editor.prepareDrawingCel();
  const surface = await resources.surface(target.figure);
  return {editor, owner, resources, history, disk, target, surface, async dispose() { owner.release(); resources.dispose(); await history.dispose(); }};
}
/** The event details a change listener sees, for comparing two editors. */
function watch(editor) {
  const seen = [];
  editor.addEventListener('change', ({detail}) => {
    if (['edit', 'history'].includes(detail.kind) && detail.drawing) seen.push([detail.kind, detail.label, detail.definition, detail.figureIndices?.length]);
  });
  return seen;
}

test('a stroke\'s pixels never become JSON for the session', {skip: !engineBuilt}, async () => {
  const {editor, owner, target, dispose} = await painting();
  try {
    let serialized = 0;
    const tiles = Object.assign([tile(0, 0, 7)], {toJSON() { serialized++; return []; }});
    editor.commitDrawingPixels(target, tiles, 'Brush stroke');
    assert.equal(serialized, 0, 'the owner turned the stroke into JSON');
    assert.equal(editor.undoLabel, 'Brush stroke');
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
    assert.deepEqual(editor._undo.map(entry => entry.kind), ['engine', 'engine'], 'the editor\'s stacks hold placeholders for the session\'s entries');
  } finally { await dispose(); }
});

refs.test('strokes, an erase and a fill undo and redo exactly as without the owner', {skip: !engineBuilt}, async take => {
  const owned = await painting({historyOptions: {minRecordBytes: Infinity}});
  // The editor without the owner (its references): made the first time one of them is recorded.
  let alone = null;
  const plainSide = async () => {
    if (alone) return alone;
    const {editor} = ownedEditorWithDrawings({demo: false, layerTimeline: true, propertyChannels: true});
    const history = new DrawingHistory({disk: memoryDisk(), minRecordBytes: Infinity});
    const resources = new DrawingResources(editor.report, {history, worker: stub});
    resources.busy = true;
    const target = editor.prepareDrawingCel();
    alone = {editor, resources, history, target, surface: await resources.surface(target.figure)};
    editor.markSaved();
    alone.events = watch(editor);
    return alone;
  };
  try {
    owned.editor.markSaved();
    const events = watch(owned.editor);
    // The same three commits on both: a brush stroke over two tiles, a fill over one of them, an erase of the other.
    const commits = [
      ['Brush stroke', () => [tile(0, 0, 10), tile(1, 0, 20)]],
      ['Fill', cel => [tile(0, 0, 30, cel.pixel(0, 0))]],
      ['Erase stroke', cel => [{...tile(1, 0, 0, cel.pixel(1, 0)), after: null}]],
    ];
    const snapshot = ({editor, resources}) => {
      const figure = editor.report.figure_types.find(drawingMetadata), d = figure && drawingMetadata(figure), cel = d && resources.entries.get(d.celId);
      // The owned editor's history starts with the entry that made the layer; the plain one starts with the strokes.
      const layerOnly = editor.undoLabel === 'New drawing layer';
      return {undo: layerOnly ? '' : editor.undoLabel, redo: editor.redoLabel, canUndo: editor.canUndo && !layerOnly, canRedo: editor.canRedo, dirty: editor.dirty,
        tiles: cel?.store && [...cel.store].map(t => [t.tx, t.ty, [...t.pixels.subarray(0, 4)]]), bounds: d?.bounds ?? null, cels: editor.report.figure_types.filter(drawingMetadata).length};
    };
    for (const [index, [label, make]] of commits.entries()) {
      owned.editor.commitDrawingPixels(index ? owned.editor.drawingTarget() : owned.target, make(owned.surface.store), label);
      const wanted = await take(`after ${label}`);
      assert.deepEqual(canonical(snapshot(owned)), wanted, `after ${label}`);
    }
    assert.equal(owned.editor.undoLabel, 'Erase stroke');
    const walk = async (move, steps) => {
      for (let step = 0; step < steps; step++) {
        const done = await owned.editor[move]();
        const wanted = await take(`${move} ${step + 1}`);
        assert.deepEqual([done, wanted.done], [true, true]);
        assert.deepEqual(canonical(snapshot(owned)), wanted.snapshot, `${move} ${step + 1}`);
      }
    };
    await walk('undo', 3);
    assert.equal(owned.editor.dirty, false, 'undoing every stroke returns to the saved revision');
    await walk('redo', 3);
    await walk('undo', 1);
    assert.deepEqual(canonical(events), await take('events'), 'the same drawing events reach the interface');
    assert.ok(events.some(([kind, label]) => kind === 'history' && label === 'Erase stroke'));
  } finally { owned.owner.release(); owned.resources.dispose(); await owned.history.dispose(); alone?.resources.dispose(); await alone?.history.dispose(); }
});

test('a created cel and its first stroke undo and redo as one entry, the pixels kept for the redo', {skip: !engineBuilt}, async () => {
  const {editor, target, surface, resources, dispose} = await painting();
  try {
    editor.commitDrawingPixels(target, [tile(0, 0, 9), tile(1, 0, 9)], 'Brush stroke');
    const cel = drawingMetadata(target.figure).celId, figures = () => editor.report.figure_types.filter(drawingMetadata).length;
    assert.equal(figures(), 1);
    assert.equal(editor.undoLabel, 'Brush stroke');
    assert.deepEqual(drawingMetadata(editor.report.figure_types.find(drawingMetadata)).bounds, surface.store.bounds);
    assert.equal(await editor.undo(), true);
    assert.equal(figures(), 0, 'the cel left the document with its first stroke');
    assert.equal(surface.store.size, 0, 'and its pixels are cleared');
    assert.equal(editor.redoLabel, 'Brush stroke');
    assert.equal(await editor.redo(), true);
    assert.equal(figures(), 1);
    assert.equal(drawingMetadata(editor.report.figure_types.find(drawingMetadata)).celId, cel);
    assert.equal(surface.store.size, 2, 'the redo brings the pixels back');
    assert.deepEqual(drawingMetadata(editor.report.figure_types.find(drawingMetadata)).bounds, surface.store.bounds);
    assert.equal(resources.entries.get(cel), surface);
  } finally { await dispose(); }
});

test('a cold undo loads its record from the disk first, and fails or cancels without a trace', {skip: !engineBuilt}, async () => {
  const {editor, owner, history, disk, target, surface, dispose} = await painting();
  try {
    editor.commitDrawingPixels(target, [tile(0, 0, 1), tile(1, 0, 2), tile(2, 0, 3), tile(3, 0, 4)], 'Brush stroke');
    await history.pumping;
    assert.equal(history.residentBytes, 0, 'the record went to the disk');
    const pixel = surface.store.pixel(0, 0), revision = editor.revision, depths = owner.depths();
    assert.equal(editor._undo.at(-1).kind, 'engine');
    assert.ok(history.needsLoad(editor.historyPixels('undo')), 'the controller sees the record is cold');
    disk.readError = Error('Corrupt undo chunk');
    await assert.rejects(editor.undo(), /Corrupt/);
    assert.equal(editor.revision, revision);
    assert.deepEqual(owner.depths(), depths);
    assert.equal(editor.undoLabel, 'Brush stroke');
    assert.deepEqual(surface.store.pixel(0, 0), pixel);
    disk.readError = null;
    disk.readGate = deferred();
    const abort = new AbortController(), undo = editor.undo({signal: abort.signal});
    abort.abort();
    disk.readGate.resolve();
    await assert.rejects(undo, {name: 'AbortError'});
    assert.deepEqual(owner.depths(), depths);
    assert.equal(editor.revision, revision);
    disk.readGate = null;
    assert.equal(await editor.undo(), true);
    assert.equal(surface.store.size, 0);
    assert.equal(history.residentBytes, 0, 'the replay let go of what it loaded');
    assert.equal(await editor.redo(), true);
    assert.deepEqual(surface.store.pixel(0, 0), pixel);
    assert.equal(surface.store.size, 4);
  } finally { await dispose(); }
});

test('an edit made while a cold undo loads prevents it from moving the newer history', {skip: !engineBuilt}, async () => {
  const {editor, owner, history, disk, target, surface, dispose} = await painting();
  try {
    editor.commitDrawingPixels(target, [tile(0, 0, 5)], 'Brush stroke');
    await history.pumping;
    disk.readGate = deferred();
    const undo = editor.undo();
    editor.renameLayer(editor.activeLayerId, 'Ink');
    const revision = editor.revision, depths = owner.depths(), pixel = surface.store.pixel(0, 0);
    disk.readGate.resolve();
    await assert.rejects(undo, {name: 'AbortError'});
    assert.equal(editor.revision, revision);
    assert.deepEqual(owner.depths(), depths);
    assert.equal(editor.undoLabel, 'Rename layer');
    assert.deepEqual(surface.store.pixel(0, 0), pixel);
  } finally { await dispose(); }
});

test('all the strokes of a cold grouped edit load before any pixels change', {skip: !engineBuilt}, async () => {
  const {editor, owner, history, disk, target, surface, dispose} = await painting();
  try {
    editor.movieclipBatch('Two pixel edits', () => {
      editor.commitDrawingPixels(target, [tile(0, 0, 1)]);
      editor.commitDrawingPixels(editor.drawingTarget(), [tile(1, 0, 2)]);
    });
    await history.pumping;
    const revision = editor.revision, depths = owner.depths();
    assert.equal(editor.undoLabel, 'Two pixel edits');
    disk.records.delete(2);
    await assert.rejects(editor.undo());
    assert.equal(editor.revision, revision);
    assert.deepEqual(owner.depths(), depths);
    assert.equal(surface.store.size, 2, 'neither stroke was undone');
    assert.equal(history.residentBytes, 0);
  } finally { await dispose(); }
});

test('a record that failed to reach the disk weighs on the history again, and the byte limit retires what it must', {skip: !engineBuilt}, async () => {
  const {editor, owner, history, disk, target, surface, dispose} = await painting({setup: editor => { editor.historyBytes = 8 * TILE_BYTES; }});
  const gate = disk.writeGate = deferred();
  try {
    // Five four-tile strokes whose disk writes are pending: each weighs its tiles until it is on the disk.
    for (let stroke = 0; stroke < 5; stroke++) {
      const before = [...surface.store].map(t => t.pixels.slice());
      editor.commitDrawingPixels(stroke ? editor.drawingTarget() : target, [0, 1, 2, 3].map(tx => tile(tx, 0, stroke + 1, before[tx])));
    }
    const strokes = owner.depths()[0];
    while (owner.depths()[0] > 1) assert.equal(await editor.undo(), true);
    const redo = owner.depths()[1];
    disk.writeError = Error('Disk became full');
    gate.resolve();
    await history.pumping;
    assert.ok(owner.depths()[1] < redo, 'the weights came back and the farthest redo entries were retired');
    assert.ok(owner.depths()[0] + owner.depths()[1] <= strokes);
    assert.equal(history.enabled, false);
    while (editor.canRedo) assert.equal(await editor.redo(), true);
    assert.equal(surface.store.pixel(0, 0)[0], 1, 'redoing everything that stayed in the history brings the strokes back');
  } finally { gate.resolve(); await dispose(); }
});

test('history that leaves the limit lets go of its records and their disk files', {skip: !engineBuilt}, async () => {
  const {editor, history, disk, target, surface, dispose} = await painting({setup: editor => { editor.historyLimit = 3; }});
  try {
    for (let stroke = 0; stroke < 4; stroke++) editor.commitDrawingPixels(stroke ? editor.drawingTarget() : target, [tile(stroke, 0, stroke + 1)], `Stroke ${stroke}`);
    await history.pumping;
    await Promise.resolve();
    assert.equal(editor.undoLabel, 'Stroke 3');
    assert.equal(history.records.size, 3, 'a record per entry still in the history');
    assert.equal(disk.records.size, 3);
    // The strokes that stayed undo; the one that left cannot.
    for (let step = 0; step < 3; step++) assert.equal(await editor.undo(), true);
    assert.equal(editor.canUndo, false);
    assert.equal(surface.store.size, 1, 'the oldest stroke and the entries before it are not in the history');
    // A new edit after the undos drops the redo entries and their records.
    editor.renameLayer(editor.activeLayerId, 'Ink');
    await Promise.resolve();
    await history.pumping;
    assert.equal(history.records.size, 0);
    assert.equal(disk.records.size, 0);
  } finally { await dispose(); }
});

refs.test('the first stroke on a v1 cel migrates it: the new cel, its pixels and the stroke are one entry', {skip: !engineBuilt}, async take => {
  await nodeEngine();
  await loadDrawingEngine();
  // A document whose drawing layer holds a v1 cel (a picture the size of its crop).
  // (made by an editor without the owner, once: its reference)
  const document = JSON.parse(await take('document'));
  const legacy = document.figure_types.find(drawingMetadata), asset = legacy.image_assets[0];
  asset.data_url = await encodeDrawingPNG(new Uint8ClampedArray(96 * 64 * 4).fill(200), 96, 64);
  Object.assign(asset, {width: 96, height: 64, display_width: 96, display_height: 64});
  delete asset.styk_tiles;
  legacy._styk.drawing = {version: 1, celId: 'cel-legacy-1', width: 96, height: 64, pixelsPerUnit: 1, origin: {x: 0, y: 0}, crop: {x: 0, y: 0, width: 96, height: 64}, revision: 0, empty: false};

  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(document);
  const history = new DrawingHistory({disk: memoryDisk(), minRecordBytes: Infinity});
  const resources = new DrawingResources(editor.report, {history, worker: engineWorker()});
  resources.busy = true;
  const owner = installEngineOwner(editor, {verify: true});
  try {
    assert.ok(owner.ready());
    const exposure = editor.drawingTarget(), cel = drawingMetadata(exposure.figure);
    assert.equal(cel.version, 1);
    const surface = await resources.surface(exposure.figure);
    assert.deepEqual(surface.store.bounds, {x: 0, y: 0, width: 96, height: 64});
    // The controller migrates lazily on the first pixel edit.
    const migrated = migrateDrawingFigure(exposure.figure, editor.report.figure_types.reduce((n, f) => Math.max(n, f.figure_type_id + 1), 1), {bounds: surface.store.bounds});
    resources.retarget(cel.celId, migrated);
    const target = {...exposure, figure: migrated, object: {...structuredClone(exposure.object), figure_type_id: migrated.figure_type_id}, migratedFrom: cel.celId};
    const original = surface.store.get(0, 0).pixels.slice();
    editor.commitDrawingPixels(target, [tile(0, 0, 9, original)], 'Fill');
    assert.equal(editor.undoLabel, 'Fill');
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
    const now = () => drawingMetadata(editor.drawingTarget().figure);
    assert.deepEqual([now().version, now().celId], [2, drawingMetadata(migrated).celId], 'the exposure shows the migrated cel');
    assert.equal(resources.entries.get(now().celId), surface, 'the pixels moved to the new cel');
    assert.equal(surface.store.pixel(0, 0)[0], 9);
    assert.equal(await editor.undo(), true);
    assert.deepEqual([now().version, now().celId], [1, 'cel-legacy-1'], 'one undo returns the legacy cel');
    assert.equal(surface.store.pixel(0, 0)[0], 200, 'with its pixels');
    assert.equal(await editor.redo(), true);
    assert.equal(now().celId, drawingMetadata(migrated).celId);
    assert.equal(surface.store.pixel(0, 0)[0], 9);
  } finally {
    owner.release();
    resources.dispose();
    await history.dispose();
  }
});

test('a resample is one entry: the new cel gets the resampled tiles and the old one stays for the undo', {skip: !engineBuilt}, async () => {
  const {editor, owner, target, resources, surface, dispose} = await painting();
  try {
    editor.commitDrawingPixels(target, [tile(0, 0, 8)], 'Brush stroke');
    const old = drawingMetadata(target.figure), exposure = editor.drawingTarget();
    const pixels = new Uint8ClampedArray(TILE_BYTES).fill(3);
    assert.equal(editor.resampleDrawing(exposure, {pixelsPerUnit: 2, tiles: [{tx: 0, ty: 0, pixels: pixels.buffer}], bounds: {x: 0, y: 0, width: 4, height: 4}, owned: true}), true);
    assert.equal(editor.undoLabel, 'Resample drawing');
    const figure = editor.drawingTarget().figure, d = drawingMetadata(figure);
    assert.deepEqual([d.pixelsPerUnit, d.revision, d.bounds], [2, 0, {x: 0, y: 0, width: 4, height: 4}]);
    assert.notEqual(d.celId, old.celId);
    assert.equal(resources.entry(figure).store.size, 1, 'the new cel holds the resampled tiles');
    assert.equal(surface.store.size, 1, 'the old cel keeps its pixels');
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
    assert.equal(await editor.undo(), true);
    assert.equal(drawingMetadata(editor.drawingTarget().figure).celId, old.celId);
    assert.equal(editor.undoLabel, 'Brush stroke');
    assert.equal(resources.entries.get(d.celId).store.size, 1, 'the new cel\'s pixels wait for the redo');
    assert.equal(await editor.redo(), true);
    assert.equal(drawingMetadata(editor.drawingTarget().figure).celId, d.celId);
  } finally { await dispose(); }
});

test('a gesture the session holds ends before a stroke is committed', {skip: !engineBuilt}, async () => {
  const {editor, owner, target, surface, dispose} = await painting();
  try {
    editor.commitDrawingPixels(target, [tile(0, 0, 4)], 'Brush stroke');
    editor.select(target.object.unique_id);
    editor.beginTranslationDrag('Move drawing');
    editor.moveSelection(6, 3, {fromStart: true});
    assert.ok(editor._drag?.engine, 'the session holds the drag');
    editor.commitDrawingPixels(editor.drawingTarget(), [tile(1, 0, 5)], 'Erase stroke');
    assert.equal(editor._drag, null, 'the drag ended with the stroke');
    assert.equal(editor.undoLabel, 'Erase stroke');
    assert.equal(await editor.undo(), true);
    assert.equal(editor.undoLabel, 'Move drawing', 'the drag is its own entry, before the stroke');
    assert.equal(surface.store.size, 1);
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
  } finally { await dispose(); }
});

test('a stroke the session refuses leaves no record behind and the pixels to the caller', {skip: !engineBuilt}, async () => {
  const {editor, history, target, dispose} = await painting();
  try {
    const layer = editor.activeLayerId;
    editor.setLayerVisible(layer, false);
    assert.throws(() => editor.commitDrawingPixels(target, [tile(0, 0, 1)], 'Brush stroke'), error => error.messageKey === 'errors.editorDrawing.showAndUnlockBeforeDrawing');
    assert.equal(history.records.size, 0, 'the refused commit holds no history record');
    assert.equal(editor.undoLabel, 'Set layer visibility');
  } finally { await dispose(); }
});

test('a stroke over a full drawing memory is refused before anything is recorded', {skip: !engineBuilt}, async () => {
  const {editor, history, owner, resources, target, dispose} = await painting({editorOptions: {tileBytes: TILE_BYTES, hardBytes: 2 * TILE_BYTES}});
  try {
    const depths = owner.depths();
    const many = [0, 1, 2, 3, 4].map(tx => tile(tx, 0, 1));
    assert.throws(() => editor.commitDrawingPixels(target, many, 'Brush stroke'), /memory is full/);
    assert.deepEqual(owner.depths(), depths);
    assert.equal(history.records.size, 0);
    void resources;
  } finally { await dispose(); }
});

test('the pose sources collected when a failed disk write retires entries leave the read view too', {skip: !engineBuilt}, async () => {
  const {editor, owner, history, disk, target, surface, dispose} = await painting({setup: editor => { editor.historyBytes = 8 * TILE_BYTES; }});
  const gate = disk.writeGate = deferred();
  const sources = () => Object.keys(editor.report._styk.frameSources ?? {});
  try {
    // The move replaces the pose the cel's first stroke made; only the history keeps that pose alive.
    editor.commitDrawingPixels(target, [tile(0, 0, 1)], 'First stroke');
    editor.select(target.object.unique_id);
    editor.beginTranslationDrag('Move drawing');
    editor.moveSelection(6, 3, {fromStart: true});
    editor.commitDrag();
    assert.equal(sources().length, 2);
    // Strokes whose disk writes are pending weigh their tiles; the write fails and they weigh them for good.
    for (let stroke = 0; stroke < 5; stroke++) {
      const before = [...surface.store].map(t => t.pixels.slice());
      editor.commitDrawingPixels(editor.drawingTarget(), [0, 1, 2, 3].map(tx => tile(tx, 0, stroke + 2, before[tx])));
    }
    const entries = owner.depths()[0];
    disk.writeError = Error('Disk became full');
    gate.resolve();
    await history.pumping;
    assert.ok(owner.depths()[0] < entries, 'the byte limit retired the oldest entries');
    assert.equal(sources().length, 1, 'the pose only the retired entries kept alive was collected');
    assert.equal(JSON.stringify(editor.report), owner.session().report_json(), 'the read view is the engine document');
    // The next call finds the read view and the engine's document the same (the owner verifies it).
    editor.renameLayer(editor.activeLayerId, 'Ink');
  } finally { gate.resolve(); await dispose(); }
});

test('a grouped edit that commits strokes and then fails takes their pixels back with their entries', {skip: !engineBuilt}, async () => {
  const {editor, owner, history, target, surface, dispose} = await painting();
  try {
    // A stroke of its own first, so the group is not the cel's creation alone.
    editor.commitDrawingPixels(target, [tile(0, 0, 1)], 'First stroke');
    const depths = owner.depths(), revision = editor.revision, size = surface.store.size;
    assert.throws(() => editor.movieclipBatch('Failing group', () => {
      editor.commitDrawingPixels(editor.drawingTarget(), [tile(1, 0, 2)], 'Second stroke');
      editor.commitDrawingPixels(editor.drawingTarget(), [tile(2, 0, 3)], 'Third stroke');
      assert.equal(surface.store.size, size + 2);
      throw new Error('The group failed');
    }), /The group failed/);
    assert.equal(surface.store.size, size, 'the strokes of the group are not in the cel');
    assert.deepEqual(owner.depths(), depths);
    assert.equal(editor.revision, revision);
    assert.equal(editor.undoLabel, 'First stroke');
    await history.pumping;
    await Promise.resolve();
    assert.deepEqual([...history.records.keys()], [1], 'the aborted strokes\' records were let go');
    // The history goes on from where it was.
    editor.commitDrawingPixels(editor.drawingTarget(), [tile(3, 0, 4)], 'Fourth stroke');
    assert.equal(await editor.undo(), true);
    assert.equal(surface.store.size, size);
    assert.equal(editor.undoLabel, 'First stroke');
    assert.equal(JSON.stringify(editor.report), owner.session().report_json());
  } finally { await dispose(); }
});

test('a cel created by a grouped edit that fails is gone with its pixels', {skip: !engineBuilt}, async () => {
  const {editor, owner, resources, target, surface, dispose} = await painting();
  try {
    const depths = owner.depths(), cels = () => editor.report.figure_types.filter(drawingMetadata).length;
    assert.throws(() => editor.movieclipBatch('Failing group', () => {
      editor.commitDrawingPixels(target, [tile(0, 0, 1)], 'Brush stroke');
      assert.equal(cels(), 1);
      throw new Error('The group failed');
    }), /The group failed/);
    assert.equal(cels(), 0);
    assert.deepEqual(owner.depths(), depths);
    assert.equal(surface.store.size, 0, 'the stroke was taken off the surface');
    void resources;
  } finally { await dispose(); }
});

test('a commit whose pixels cannot be applied leaves no entry in the session and no record identity to reuse', {skip: !engineBuilt}, async () => {
  const {editor, owner, resources, history, target, surface, dispose} = await painting();
  try {
    const depths = owner.depths(), revision = editor.revision, label = editor.undoLabel, cels = () => editor.report.figure_types.filter(drawingMetadata).length;
    resources.apply = () => { throw new Error('The pixels cannot be applied'); };
    assert.throws(() => editor.commitDrawingPixels(target, [tile(0, 0, 1)], 'Brush stroke'), /The pixels cannot be applied/);
    delete resources.apply;
    assert.deepEqual(owner.depths(), depths, 'the session holds no entry the history has no record for');
    assert.equal(editor.revision, revision);
    assert.equal(editor.undoLabel, label);
    assert.equal(cels(), 0, 'the cel the commit would have created is not in the document');
    assert.equal(JSON.stringify(editor.report), owner.session().report_json(), 'the read view is the engine\'s document');
    assert.equal(history.records.size, 0);
    // The next commit is a commit as any: its record is a new one and it undoes.
    editor.commitDrawingPixels(target, [tile(0, 0, 2)], 'Brush stroke');
    assert.deepEqual([...history.records.keys()], [2], 'the failed commit\'s identity is not used again');
    assert.equal(surface.store.size, 1);
    // A stroke on an existing cel that fails is taken back alone.
    const after = owner.depths();
    resources.apply = () => { throw new Error('The pixels cannot be applied'); };
    assert.throws(() => editor.commitDrawingPixels(editor.drawingTarget(), [tile(1, 0, 3)], 'Erase stroke'), /The pixels cannot be applied/);
    delete resources.apply;
    assert.deepEqual(owner.depths(), after);
    assert.equal(editor.undoLabel, 'Brush stroke');
    editor.commitDrawingPixels(editor.drawingTarget(), [tile(1, 0, 3)], 'Erase stroke');
    assert.deepEqual([...history.records.keys()], [2, 4]);
    assert.equal(await editor.undo(), true);
    assert.equal(surface.store.size, 1);
    assert.equal(await editor.undo(), true);
    assert.equal(surface.store.size, 0);
  } finally { await dispose(); }
});
