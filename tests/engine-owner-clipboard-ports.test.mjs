// Clipboard, import and clip calls with drawings, animation origins and broken-apart movieclips that the engine session used
// to refuse (and the editor ran instead): each now runs in the session and leaves the document, the history entries and the
// undo and redo of the editor alone (tests/support/owned-vs-plain.mjs).
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {drawingMetadata} from '../src/drawing-model.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {bothWays, recordedDocument} from './support/owned-vs-plain.mjs';
import {ownerReferences} from './support/owner-references.mjs';
import {paintedDocument} from './support/painted-document.mjs';

const opts = {skip: !engineBuilt};
const refs = ownerReferences(import.meta.url);
const cels = report => report.figure_types.filter(drawingMetadata).map(figure => drawingMetadata(figure).celId);

/** A document with a movieclip broken apart at a frame: its parts are figures of a layer that name the instance. */
async function brokenApart() {
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true}).load(recordedDocument('clip-break-sheet'));
  const owner = installEngineOwner(editor);
  try {
    editor.seek(3);
    editor.select(4, -1);
    await editor.breakApartMovieclip();
    editor.createLayer('Other');
    editor.seek(0);
    return structuredClone(editor.report);
  } finally { owner.release(); }
}

refs.test('a copied drawing pastes as a cel of its own on a new definition', opts, async take => {
  const {document, layer, cels: original} = await paintedDocument();
  for (const how of ['copy', 'cut']) {
    const {owned} = await bothWays(take, document, editor => {
      const [figure] = editor.getLayerFigureUids(layer);
      editor.select(figure, -1);
      const before = cels(editor.report);
      assert.equal(how === 'cut' ? editor.cutSelection() : editor.copySelection(), 1);
      editor.setActiveLayer('layer-1');
      editor.seek(1);
      editor.pasteSelection();
      const after = cels(editor.report);
      assert.equal(after.length, before.length + 1, 'one cel was made');
      assert.ok(!original.includes(after.at(-1)), 'the copy is a cel of its own');
      return after.at(-1);
    });
    // The pixels of the cel it copies go to the new cel in the interface.
    assert.ok(owned.editor.drawingResources.entries.has(owned.result), 'the new cel takes the pixels of the old one');
  }
});

refs.test('importing figures with animation origins finds their pivots again', opts, async take => {
  await bothWays(take, recordedDocument('sheet-layers'), editor => {
    const source = recordedDocument('branch-thickness-origin-sheet');
    assert.ok(source.figure_types.some(figure => figure._styk?.animationOrigin), 'the file holds a figure with an origin');
    const figure = editor.importFigure(source, {position: {x: 300, y: 200}});
    assert.ok(figure?._stykAnimationOrigin, 'the first figure is selected and has its pivot');
    assert.equal(editor.undoLabel, 'Import figure');
  }, {expectEntries: 1});
});

refs.test('importing a drawing makes it a cel of the project', opts, async take => {
  const {document} = await paintedDocument();
  const cel = document.figure_types.find(drawingMetadata);
  await bothWays(take, recordedDocument('sheet-layers'), editor => {
    const known = cels(editor.report);
    editor.importFigure({figure_types: [structuredClone(cel)]});
    const after = cels(editor.report);
    assert.equal(after.length, known.length + 1);
    assert.notEqual(after.at(-1), drawingMetadata(cel).celId, 'the imported cel has an identity of its own');
  }, {expectEntries: 1});
});

refs.test('importing a movieclip validates its document and puts it on the presence clock', opts, async take => {
  const source = recordedDocument('clip-break-native');
  assert.ok(source.keyframes[0].objects.some(object => object._stykMovieclip), 'the file shows a movieclip');
  await bothWays(take, recordedDocument('sheet-layers'), editor => {
    const clip = editor.importFigure(source);
    assert.equal(clip._stykMovieclip.clock, 'presence');
    assert.ok(editor.report.figure_types.some(figure => figure._styk?.movieclip), 'its definition came with it');
    assert.equal(editor.undoLabel, 'Import figure');
  });
});

refs.test('pasting frames of a drawing layer pastes drawing keys as cels of their own', opts, async take => {
  const {document, layer, second, cels: original} = await paintedDocument();
  await bothWays(take, document, editor => {
    editor.sheetCopyFrames([layer], 0, 5);
    assert.equal(editor.sheetPasteFrames([second], 0), true);
    assert.equal(editor.undoLabel, 'Paste frames');
    const made = cels(editor.report).filter(id => !original.includes(id));
    assert.equal(made.length, original.length, 'every pasted cel is a new one');
  }, {expectEntries: 1});
  await bothWays(take, document, editor => {
    editor.sheetCopyFrames([layer], 0, 2);
    editor.sheetPasteFrames([layer], 8, {insert: true});
  }, {expectEntries: 1});
});

refs.test('moving or copying frames of a drawing layer onto another layer is one step', opts, async take => {
  const {document, layer, second} = await paintedDocument();
  for (const copy of [false, true]) {
    await bothWays(take, document, editor => {
      editor.sheetTransferFrames([layer], [second], 0, 5, 1, {copy});
      assert.equal(editor.undoLabel, copy ? 'Copy frames to layer' : 'Move frames to layer');
    }, {expectEntries: 1});
  }
});

refs.test('copying drawing keys along their layer makes cels of their own', opts, async take => {
  const {document, layer, cels: original} = await paintedDocument();
  const {owned} = await bothWays(take, document, editor => {
    editor.sheetMoveFrames([layer], 0, 5, 12, {copy: true});
    assert.equal(editor.undoLabel, 'Copy frames');
    const made = cels(editor.report).filter(id => !original.includes(id));
    assert.equal(made.length, original.length, 'every copied cel is a new one');
  }, {expectEntries: 1});
  assert.ok(owned.states.length);
});

refs.test('pasting frames with the parts of a broken-apart movieclip keeps them with their instance', opts, async take => {
  const document = await brokenApart();
  const parted = Object.values(document._styk.frameSources ?? {}).some(frame => frame.objects.some(object => object._stykMovieclipPart));
  assert.ok(parted, 'the document holds movieclip parts');
  await bothWays(take, document, editor => {
    const other = editor.report._styk.layers.order.find(id => id !== 'layer-1');
    editor.sheetCopyFrames(['layer-1'], 0, 6);
    editor.sheetPasteFrames([other], 0);
    assert.equal(editor.undoLabel, 'Paste frames');
  }, {expectEntries: 1});
});

refs.test('capturing a drawing layer into a movieclip gives the clip cels and drawing keys of its own', opts, async take => {
  const {document, cels: original} = await paintedDocument();
  const {owned} = await bothWays(take, document, editor => {
    const clip = editor.createMovieclip({start: 0, end: 6, uids: []});
    const inside = clip._styk.movieclip.document;
    assert.ok(cels(inside).length > 0, 'the clip holds cels');
    assert.ok(cels(inside).every(id => !original.includes(id)), 'none of them is a cel of the project');
    assert.ok(Object.keys(inside._styk.layerSheet.tracks).length > 2, 'the clip has a layer sheet');
    assert.equal(editor.undoLabel, 'Create movieclip');
  });
  assert.ok(owned.states.length);
});

refs.test('handle edit moves the root and the end handle of a movieclip instance', opts, async take => {
  for (const joint of [-1, 0]) {
    await bothWays(take, recordedDocument('sheet-movieclip'), editor => {
      editor.select(4, joint);
      const at = editor.geometry.objects.get(editor.selectedSlot).joints.get(joint < 0 ? 0 : editor.figure.segments[joint].segment_id);
      assert.equal(editor.editHandlePosition(at.x + 30, at.y + 20), true);
      assert.equal(editor.undoLabel, 'Reposition handle');
    }, {expectEntries: 1});
  }
});

refs.test('a handle gesture on a movieclip instance commits as one step', opts, async take => {
  await bothWays(take, recordedDocument('sheet-movieclip'), editor => {
    editor.select(4, 0);
    const at = editor.geometry.objects.get(editor.selectedSlot).joints.get(editor.figure.segments[0].segment_id);
    assert.equal(editor.beginHandleEditDrag(), true);
    editor.editHandlePosition(at.x + 10, at.y + 5);
    editor.editHandlePosition(at.x + 40, at.y - 15);
    assert.equal(editor.commitHandleEditDrag(), true);
  }, {expectEntries: 1});
});
