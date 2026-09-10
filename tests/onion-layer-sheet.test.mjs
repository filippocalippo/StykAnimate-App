import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {OnionSkinCache} from '../src/onion-skin.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';

function fixture() {
  const report = emptyDocument();
  report.keyframes = [100, 200, 300].map(x => createFrame([createObject(report.figure_types[0], 1, x, 250)], 10));
  const editor = new Editor({demo: false, layerTimeline: true}).load(report);
  editor.sheetSetEasing(['layer-1'], 0, 20, {interpolation: 'constant'});
  editor.select(1);
  return editor;
}
const roots = skins => skins.map(s => s.frame.objects.map(o => o.root_x));
const settings = normalizeEditorSettings({onionBefore: 1, onionAfter: 1});

test('persistent onion skin follows Simple append and edits without changing native source frames', () => {
  const editor = fixture(), cache = new OnionSkinCache(), source = structuredClone(editor.report.keyframes);
  editor.seek(20);
  assert.deepEqual(roots(cache.get(editor, settings)), [[200]]);
  editor.sheetAppendFrame();
  assert.deepEqual(roots(cache.get(editor, settings)), [[300]]);
  editor.updateObject({root_x: 400});
  editor.sheetAppendFrame();
  assert.deepEqual(roots(cache.get(editor, settings)), [[400]]);
  editor.seek(21); editor.updateObject({root_x: 450}); editor.seek(22);
  assert.deepEqual(roots(cache.get(editor, settings)), [[450]]);
  editor.undo(); editor.seek(22);
  assert.deepEqual(roots(cache.get(editor, settings)), [[400]]);
  editor.redo(); editor.seek(22);
  assert.deepEqual(roots(cache.get(editor, settings)), [[450]]);
  assert.deepEqual(editor.report.keyframes, source);
});

test('layer key insertion, retiming, removal, blanks and history refresh the enabled cache', () => {
  const editor = fixture(), cache = new OnionSkinCache();
  editor.seek(10);
  assert.deepEqual(roots(cache.get(editor, settings)), [[100], [300]]);
  editor.sheetInsertKey(['layer-1'], 15); editor.seek(15); editor.updateObject({root_x: 250}); editor.seek(10);
  assert.deepEqual(roots(cache.get(editor, settings)), [[100], [250]]);
  editor.sheetMoveFrames(['layer-1'], 15, 15, 3);
  editor.seek(16);
  assert.deepEqual(roots(cache.get(editor, settings)), [[200], [250]]);
  editor.sheetClearKeys(['layer-1'], 18);
  assert.deepEqual(roots(cache.get(editor, settings)), [[200], [300]]);
  editor.undo();
  assert.deepEqual(roots(cache.get(editor, settings)), [[200], [250]]);
  editor.redo();
  assert.deepEqual(roots(cache.get(editor, settings)), [[200], [300]]);
  editor.sheetInsertKey(['layer-1'], 18, {blank: true});
  assert.deepEqual(roots(cache.get(editor, settings)), [[200], []]);
});

test('key sampling uses the union of layer keys and output sampling uses ticks', () => {
  const editor = fixture(), cache = new OnionSkinCache();
  const overlay = editor.createLayer('Overlay');
  editor.sheetInsertKey([overlay.id], 5, {blank: true});
  editor.seek(10);
  assert.deepEqual(roots(cache.get(editor, settings)), [[100], [300]]);
  assert.deepEqual(roots(cache.get(editor, {...settings, onionStep: 2})), [[100]]);
  editor.sheetInsertKey(['layer-1'], 15); editor.seek(15); editor.select(1); editor.updateObject({root_x: 250});
  editor.sheetSetEasing(['layer-1'], 10, 15, {interpolation: 'linear'});
  editor.seek(12);
  assert.deepEqual(roots(cache.get(editor, settings)), [[200], [250]]);
  const output = {...settings, onionMode: 'frames'};
  assert.deepEqual(roots(cache.get(editor, output)), [[210], [230]]);
  editor.seek(15); editor.updateObject({root_x: 300}); editor.seek(12);
  assert.deepEqual(roots(cache.get(editor, output)), [[220], [260]]);
  assert.deepEqual(cache.get(editor, output).map(s => s.geometry.drawables),
    new OnionSkinCache().get(editor, output).map(s => s.geometry.drawables));
});

test('a held-cell edit refreshes its preceding key and seeking or changing opacity retains samples', () => {
  const editor = fixture(), cache = new OnionSkinCache();
  editor.seek(15); cache.get(editor, settings);
  editor.updateObject({root_x: 240});
  assert.deepEqual(roots(cache.get(editor, settings)), [[240], [300]]);
  const builds = cache.stats.builds;
  cache.get(editor, {...settings, onionOpacity: .8});
  editor.seek(16); cache.get(editor, settings);
  assert.equal(cache.stats.builds, builds);
  editor.undo();
  assert.deepEqual(roots(cache.get(editor, settings)), [[200], [300]]);
});

test('layer gestures retain committed ghosts during posing, then refresh on commit and history', () => {
  const editor = fixture(), cache = new OnionSkinCache();
  editor.seek(15);
  const before = cache.get(editor, settings), builds = cache.stats.builds;
  editor.beginDrag();
  for (let i = 0; i < 8; i++) { editor.moveSelection(5, 0); assert.equal(cache.get(editor, settings), before); }
  assert.equal(cache.stats.builds, builds);
  editor.commitDrag();
  assert.deepEqual(roots(cache.get(editor, settings)), [[240], [300]]);
  editor.undo(); assert.deepEqual(roots(cache.get(editor, settings)), [[200], [300]]);
  editor.redo(); assert.deepEqual(roots(cache.get(editor, settings)), [[240], [300]]);
  editor.beginDrag(); editor.moveSelection(10, 0); editor.cancelDrag();
  assert.deepEqual(roots(cache.get(editor, settings)), [[240], [300]]);
});

test('duplicating and pasting layer frames changes neighboring key ghosts', () => {
  const editor = fixture(), cache = new OnionSkinCache();
  editor.seek(10); cache.get(editor, settings);
  editor.sheetDuplicateFrameAfter(['layer-1']);
  editor.updateObject({root_x: 260}); editor.seek(10);
  assert.deepEqual(roots(cache.get(editor, settings)), [[100], [260]]);
  editor.sheetCopyFrames(['layer-1'], 11, 11);
  editor.sheetPasteFrames(['layer-1'], 9); editor.seek(10);
  assert.deepEqual(roots(cache.get(editor, settings)), [[260], [260]]);
  editor.undo(); editor.seek(10);
  assert.deepEqual(roots(cache.get(editor, settings)), [[100], [260]]);
});
