import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingController} from '../src/drawing-controller.mjs';
import {ownedEditorWithDrawings} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([createObject(figure, 1, 100, 100)], 1)];
  const {editor, layers: [{id: drawingLayer}]} = ownedEditorWithDrawings({demo: false, layerTimeline: true, propertyChannels: true}, report);
  const figureLayer = 'layer-1';
  editor.selectSheetLayer(figureLayer); editor.select(1, 0);
  const drawing = Object.assign(Object.create(DrawingController.prototype), {editor,
    state: {tool: 'pose', handles: true, view: {rotation: .2, flip: true}},
    beforeEdit() {}, bind() {}, sync() {}, prepareVisible() {}, onUI() {}, onRender() {}, closePalette() {}, settle() {},
    getTimeline: () => ({selectTrack: id => { drawing.timelineLayer = id; }})});
  return {editor, drawing, figureLayer, drawingLayer};
}

test('leaving Draw restores the prior figure layer and joint without changing content or history', () => {
  const {editor, drawing, figureLayer, drawingLayer} = fixture(), before = editor.serialize(), history = editor._undo.length;
  drawing.enter(); assert.equal(editor.activeLayerId, drawingLayer);
  drawing.exit();
  assert.equal(editor.activeLayerId, figureLayer); assert.equal(editor.selectedUid, 1); assert.equal(editor.selectedJoint, 0);
  assert.equal(drawing.timelineLayer, figureLayer); assert.equal(drawing.state.selectedTrackId, figureLayer);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, history);
  assert.equal(drawing.state.tool, 'pose'); assert.equal(drawing.state.handles, true);
  assert.equal(drawing.state.view.rotation, .2); assert.equal(drawing.state.view.flip, true);
});

test('Draw exit preserves a figure layer deliberately selected while drawing', () => {
  const {editor, drawing} = fixture(); drawing.enter();
  const alternate = editor.createLayer('Another figure layer'); editor.selectSheetLayer(alternate.id);
  drawing.exit(); assert.equal(editor.activeLayerId, alternate.id);
});

test('Draw exit preserves an empty figure selection so Build can create a new figure', () => {
  const {editor, drawing, figureLayer} = fixture(); editor.select(null);
  drawing.enter(); drawing.exit();
  assert.equal(editor.activeLayerId, figureLayer); assert.equal(editor.selectedUid, null);
});

test('Draw exit waits for pending pixels before changing selection', async () => {
  const {editor, drawing, figureLayer, drawingLayer} = fixture(); drawing.enter();
  let done; const gate = new Promise(resolve => {done = resolve;});
  drawing.settle = () => {drawing.settle = () => null; return gate;}; drawing.run = fn => fn();
  const leaving = drawing.exit(); assert.equal(editor.activeLayerId, drawingLayer); assert.equal(drawing.active, true);
  done(); await leaving; assert.equal(editor.activeLayerId, figureLayer); assert.equal(drawing.active, false);
});

test('Draw exit does not select a hidden or locked prior layer', () => {
  const {editor, drawing, figureLayer} = fixture(); drawing.enter();
  editor.setLayerVisible(figureLayer, false);
  const alternate = editor.createLayer('Visible figure layer');
  editor.selectSheetLayer(drawing.editor.layers.find(layer => layer.drawing).id);
  drawing.exit(); assert.equal(editor.activeLayerId, alternate.id);
});
