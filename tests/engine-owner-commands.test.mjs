// The editing commands that used to run in the editor now run in the engine session (D19): what the interface reads of
// each after the call, the errors it shows and what undo takes back. The expectations are stated here; nothing is
// compared with the editor alone.
import '../engine/tools/v8-pin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Editor} from '../src/editor.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {drawingMetadata} from '../src/drawing-model.mjs';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';
import {installEngineOwner} from '../src/engine/engine-owner.mjs';
import {engineBuilt, nodeEngine} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const folder = new URL('../engine/tests/edit/', import.meta.url);
/** An owned editor on the first document of a recorded tape. */
async function owned(name) {
  const scenario = JSON.parse(readFileSync(new URL(`${name}.scenario.json`, folder), 'utf8'));
  const document = JSON.parse(readFileSync(new URL(scenario.document, folder), 'utf8'));
  const made = await ownedEditor({demo: false, ...scenario.editor}, document, {recorded: false});
  made.editor.autoKey = Boolean(scenario.editor?.autoKey);
  return made;
}
const shown = (editor, uid = 1) => editor.evaluatedFrame.objects.find(object => object.unique_id === uid);

test('perspective and part proportions of a 3D figure run in the session and undo with it', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('recolor-mesh-sheet');
  editor.select(1, -1);
  assert.equal(editor.setSpatialCamera({strength: 0.4}), true);
  assert.equal(shown(editor)._stykSpatial.camera.strength, 0.4);
  assert.equal(editor.undoLabel, 'Adjust perspective');
  assert.equal(editor.setSpatialCamera({strength: 0.4}), false, 'the same value changes nothing');
  assert.throws(() => editor.setSpatialCamera({strength: 2}), error => error.messageKey === 'errors.spatialProjection.perspectiveNeedsStrength01AndDistance10');
  assert.equal(shown(editor)._stykSpatial.camera.strength, 0.4, 'a refused value leaves the figure alone');
  editor.select(1, 5);
  assert.equal(editor.setSpatialProportions({width: 2, taper: 0.5}), true);
  assert.deepEqual(shown(editor)._stykSpatial.shape[6], {width: 2, taper: 0.5});
  assert.equal(editor.undoLabel, 'Adjust rig proportions');
  assert.throws(() => editor.setSpatialProportions({width: 9}), error => error.messageKey === 'errors.editorSpatialShape.chooseProportionsWithinTheControlRange');
  assert.equal(editor.resetSpatialProportions(), true);
  assert.deepEqual(shown(editor)._stykSpatial.shape[6], {width: 1, taper: 0});
  editor.undo();
  assert.deepEqual(shown(editor)._stykSpatial.shape[6], {width: 2, taper: 0.5});
  editor.undo(); editor.undo();
  assert.equal(shown(editor)._stykSpatial?.camera?.strength, 0.5, 'back to the perspective the document had');
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('a scene background is imported and named in the session; each is one history entry', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('add-figure-sheet');
  const before = editor.report.backgrounds?.length ?? 0;
  const asset = editor.importSceneBackground({kind: 2, color: 0xff3366ff, name: ''});
  assert.equal(asset.name, 'Background', 'an unnamed background is called Background');
  assert.equal(editor.report.backgrounds.length, before + 1);
  assert.equal(editor.undoLabel, 'Import scene background');
  assert.equal(editor.evaluatedFrame.background_id, asset.background_id, 'the chosen frame shows it');
  assert.throws(() => editor.importSceneBackground({kind: 9}), error => error.messageKey === 'errors.editorScene.expectedADecodedImageColorOrGradientBackground');
  assert.equal(editor.renameSceneBackground(asset.background_id, '  Sky  '), true);
  assert.equal(editor.report.backgrounds.at(-1).name, 'Sky', 'the name is trimmed');
  assert.equal(editor.undoLabel, 'Rename background');
  assert.equal(editor.renameSceneBackground(asset.background_id, 'Sky'), false, 'the same name changes nothing');
  assert.throws(() => editor.renameSceneBackground(asset.background_id, ''), error => error.messageKey === 'errors.editorScene.backgroundNamesMustContain1160Characters');
  assert.throws(() => editor.renameSceneBackground(99, 'x'), error => error.messageKey === 'errors.editorScene.chooseAnExistingBackground');
  editor.undo();
  assert.equal(editor.report.backgrounds.at(-1).name, 'Background');
  editor.undo();
  assert.equal(editor.report.backgrounds.length, before, 'one undo takes the background and the frame showing it');
  assert.equal(editor.evaluatedFrame.background_id, 0);
  editor.redo(); editor.redo();
  assert.equal(editor.report.backgrounds.at(-1).name, 'Sky');
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('the exposure under the playhead is set in the session', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('add-figure-sheet');
  const length = () => { const {start, end} = editor.sheetSpan(); return end - start; };
  const first = length();
  assert.equal(editor.setFrameDuration(first + 3), true);
  assert.equal(length(), first + 3);
  assert.equal(editor.setFrameDuration(first + 3), false, 'the same length changes nothing');
  assert.throws(() => editor.setFrameDuration(0), error => error.messageKey === 'errors.editorLayerSheet.exposureMustBe165535Frames');
  editor.undo();
  assert.equal(length(), first);
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('figures move to another layer and a layer is deleted in the session, with the figures\' poses', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('add-figure-layers-sheet');
  const layers = () => [...editor.report._styk.layers.order];
  const first = layers();
  assert.deepEqual(first, ['layer-1', 'layer-2']);
  assert.equal(await editor.assignFiguresToLayerAsync([1], 'layer-2'), true);
  assert.equal(editor.layerForUid(1), 'layer-2');
  assert.equal(editor.undoLabel, 'Move figures to layer');
  assert.equal(await editor.assignFiguresToLayerAsync([1], 'layer-2'), false, 'figures already there stay');
  await assert.rejects(editor.assignFiguresToLayerAsync([99], 'layer-2'), error => error.messageKey === 'errors.editorLayerAsync.chooseFiguresPresentInThisAnimation');
  await assert.rejects(editor.assignFiguresToLayerAsync([1], 'nope'), error => error.messageKey === 'errors.editorLayerSheet.figuresBelongToUserLayers');
  assert.equal(await editor.deleteLayerAsync('layer-1'), true);
  assert.deepEqual(layers(), ['layer-2']);
  assert.equal(editor.undoLabel, 'Delete layer');
  await assert.rejects(editor.deleteLayerAsync('layer-2'), error => error.messageKey === 'errors.editorLayerAsync.keepAtLeastOneUserLayer');
  editor.undo();
  assert.deepEqual(layers(), first);
  editor.undo();
  assert.equal(editor.layerForUid(1), 'layer-1', 'back on the layer it was');
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(editor.deleteLayerAsync('layer-1', {signal: cancelled.signal}), error => error.name === 'AbortError');
  assert.deepEqual(layers(), first, 'a cancelled deletion changes nothing');
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('baking camera motion keys the camera on every frame and silences the clips there', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('camera-motion-sheet');
  const camera = () => editor.report._styk.layerSheet.tracks.camera.keys.map(key => key.tick);
  assert.deepEqual(camera(), [0]);
  assert.equal(editor.bakeCameraMotion({start: 4, end: 9}), true);
  assert.deepEqual(camera(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(editor.getCameraMotions()[0].mutedRanges, [{start: 4, end: 9}]);
  assert.equal(editor.undoLabel, 'Bake camera motion');
  assert.throws(() => editor.bakeCameraMotion({start: 3, end: 3}), error => error.messageKey === 'errors.editorCameraMotion.bakeAValidRangeOfAtMost100');
  editor.undo();
  assert.deepEqual(camera(), [0]);
  assert.equal(editor.getCameraMotions()[0].mutedRanges, undefined);
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('figures are pasted into the chosen frames in the session', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('figure-clipboard-sheet');
  editor.select(1, -1);
  assert.equal(editor.copySelection(), 1);
  const result = editor.pasteFiguresInFrames([0, 1]);
  assert.deepEqual([result.changedFrames, result.changedTicks, result.insertedUids], [2, [0, 6], [4]]);
  assert.equal(editor.undoLabel, 'Paste figures across frames');
  assert.deepEqual([...editor.selectedUids], [4], 'the copy is selected');
  for (const tick of [0, 6]) assert.ok(editor.getFrameById(editor.layerFrameKeys('layer-1').find(key => key.tick === tick).value.frameId).objects.some(object => object.unique_id === 4), `frame ${tick} holds the copy`);
  assert.throws(() => editor.pasteFiguresInFrames([1], {pasteMode: 'bogus'}), error => error.messageKey === 'errors.editorRangeCommands.chooseAValidFigurePasteMode');
  editor.undo();
  assert.equal(editor.layerForUid(4), 'layer-1', 'the identity is still the default layer\'s');
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('a copied drawing takes the pixels of the cel it copies', {skip: !engineBuilt}, async () => {
  await nodeEngine();
  const editor = new Editor({demo: false, layerTimeline: true, propertyChannels: true});
  const resources = new DrawingResources(editor.report, {worker: {request: async () => ({}), dispose() {}}});
  resources.busy = true;
  const owner = installEngineOwner(editor);
  try {
    assert.ok(owner.ready());
    const layer = editor.createDrawingLayer('Ink');
    assert.equal(layer.name, 'Ink');
    assert.equal(editor.undoLabel, 'New drawing layer');
    const target = editor.prepareDrawingCel();
    await resources.surface(target.figure);
    editor.commitDrawingPixels(target, [{tx: 0, ty: 0, before: null, after: new Uint8ClampedArray(TILE_BYTES).fill(7)}], 'Brush stroke');
    const cels = () => editor.report.figure_types.filter(drawingMetadata);
    assert.equal(cels().length, 1);
    // The copy is a cel of its own in the document and in the pixel store, with the same tiles.
    assert.equal(editor.nextDrawing([layer.id], {blank: false}), true);
    assert.equal(cels().length, 2);
    assert.equal(editor.undoLabel, 'Next copied drawing');
    const [first, copy] = cels().map(figure => resources.entries.get(drawingMetadata(figure).celId));
    assert.equal(first.store.size, 1);
    assert.equal(copy.store.size, 1, 'the copy has the tiles of the cel it copies');
    assert.notEqual(copy.id, first.id);
    assert.ok(editor.tick > 0, 'the playhead is on the new cel');
    // A blank cel has no pixels to take.
    assert.equal(editor.addDrawingFrame(layer.id, 30), true);
    assert.equal(cels().length, 2);
    assert.deepEqual(owner.refused, {}, 'the session refused nothing');
  } finally {
    owner.release();
    resources.dispose();
  }
});

test('the drawing commands refuse what the editor refused', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('add-figure-sheet');
  assert.throws(() => editor.drawingKey(['layer-1'], 2), error => error.messageKey === 'errors.editorDrawing.chooseADrawingLayerOrCreateANew');
  const layer = editor.createDrawingLayer();
  editor.setLayerVisible(layer.id, false);
  assert.throws(() => editor.nextDrawing([layer.id]), error => error.messageKey === 'errors.editorDrawing.showAndUnlockBeforeDrawing' && error.messageParams?.name === 'Drawing');
  assert.equal(editor.autoKeyDrawing(layer.id), false, 'auto key is off');
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});

test('the paint of a segment is read and keyed in the session, whether the segment has a style override or not', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await owned('branch-thickness-sheet');
  const {segmentPaint} = await import('../src/paint.mjs');
  const segments = editor.report.figure_types[0].segments;
  // Segment 44 has a gradient of its own, segment 11 a plain colour: both read as `segmentPaint` gives them.
  for (const handleId of [44, 11]) {
    const target = {kind: 'segment', uid: 1, handleId};
    assert.deepEqual(editor.animationValue(target, 'paint'), segmentPaint(segments.find(segment => segment.segment_id === handleId)));
  }
  const target = {kind: 'segment', uid: 1, handleId: 44};
  const green = {type: 'solid', angle: 0, stops: [{offset: 0, color: [10, 200, 30], opacity: 1}]};
  editor.addAnimationKey(target, 'paint', 0, green);
  editor.seek(0);
  assert.deepEqual(editor.animationValue(target, 'paint'), green, 'the keyed paint is read once there is one');
  assert.deepEqual(owner.refused, {}, 'the session refused nothing');
});
