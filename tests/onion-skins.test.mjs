// Onion skins are the engine's (docs/onion-skin.md): the session plans which poses around the frame on show the stage draws
// and how, from the committed document and the interface's settings. These tests read the plan (`editor._shown.skins`) of an
// editor the engine owns: which ticks, in what order, how they fade and tint, and which figures of each are drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {normalizeEditorSettings} from '../src/settings.mjs';
import {OnionController} from '../src/onion-controller.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const options = {demo: false, layerTimeline: true};
const PLANNED = ['onionMode', 'onionStep', 'onionRangeBefore', 'onionRangeAfter', 'onionScope', 'onionJoined', 'onionOpacity', 'onionFade', 'onionTint',
  'onionBeforeColor', 'onionAfterColor', 'onionShowOnTop', 'onionBefore', 'onionAfter'];

/** Three stored poses of one figure at x = 100, 200 and 300, ten ticks each; the first two held (constant) over twenty ticks. */
function fixture({count = 3, objects = 1, duration = 10} = {}) {
  const report = emptyDocument();
  report.keyframes = Array.from({length: count}, (_, i) => createFrame(Array.from({length: objects}, (_, j) => createObject(report.figure_types[0], j + 1, 100 + i * 100 + j * 200, 250)), duration));
  return report;
}
async function open(report = fixture(), steps = editor => editor.sheetSetEasing(['layer-1'], 0, 20, {interpolation: 'constant'})) {
  const {editor, owner} = await ownedEditor(options, report);
  steps?.(editor);
  editor.select(1);
  return {editor, owner};
}

/** What the engine plans for the settings (counts, not fixed distances, unless the settings say otherwise). */
const plan = (editor, settings = {}, {hidden = [], selected = []} = {}) => {
  const normalized = normalizeEditorSettings({onionBefore: 1, onionAfter: 1, ...settings});
  return editor._shown.skins({...Object.fromEntries(PLANNED.map(key => [key, normalized[key] ?? null])), hidden, selected});
};
/** The x of the first figure's origin in each skin. */
const roots = skins => skins.ghosts.map(ghost => ghost.roots.filter((_, at) => at % 3 === 1)[0]);
/** The slots of each skin that are not drawn. */
const hidden = skins => skins.ghosts.map(ghost => ghost.hidden);

test('a skin follows its layer: the stored poses either side of the playhead, and the edits and history that change them', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    editor.seek(20);
    assert.deepEqual(roots(plan(editor)), [200], 'the pose before; none after the last');
    editor.sheetAppendFrame();
    assert.deepEqual(roots(plan(editor)), [300]);
    editor.updateObject({root_x: 400});
    editor.sheetAppendFrame();
    assert.deepEqual(roots(plan(editor)), [400]);
    editor.seek(21); editor.updateObject({root_x: 450}); editor.seek(22);
    assert.deepEqual(roots(plan(editor)), [450]);
    editor.undo(); editor.seek(22);
    assert.deepEqual(roots(plan(editor)), [400]);
    editor.redo(); editor.seek(22);
    assert.deepEqual(roots(plan(editor)), [450]);
  } finally { owner.release(); }
});

test('layer key insertion, retiming, removal, blanks and history change the skins', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    editor.seek(10);
    assert.deepEqual(roots(plan(editor)), [100, 300]);
    editor.sheetInsertKey(['layer-1'], 15); editor.seek(15); editor.updateObject({root_x: 250}); editor.seek(10);
    assert.deepEqual(roots(plan(editor)), [100, 250]);
    editor.sheetMoveFrames(['layer-1'], 15, 15, 3);
    editor.seek(16);
    assert.deepEqual(roots(plan(editor)), [200, 250]);
    editor.sheetClearKeys(['layer-1'], 18);
    assert.deepEqual(roots(plan(editor)), [200, 300]);
    editor.undo();
    assert.deepEqual(roots(plan(editor)), [200, 250]);
    editor.redo();
    assert.deepEqual(roots(plan(editor)), [200, 300]);
    editor.sheetInsertKey(['layer-1'], 18, {blank: true});
    assert.deepEqual(roots(plan(editor)), [200, 300], 'a blank cell is not a pose to show');
  } finally { owner.release(); }
});

test('key sampling follows each layer independently and output sampling uses ticks', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    const overlay = editor.createLayer('Overlay');
    editor.sheetInsertKey([overlay.id], 5, {blank: true});
    editor.seek(10);
    assert.deepEqual(roots(plan(editor)), [100, 300]);
    assert.deepEqual(roots(plan(editor, {onionStep: 2})), [], 'every second key of a layer with one neighbour each side');
    editor.sheetInsertKey(['layer-1'], 15); editor.seek(15); editor.select(1); editor.updateObject({root_x: 250});
    editor.sheetSetEasing(['layer-1'], 10, 15, {interpolation: 'linear'});
    editor.seek(12);
    assert.deepEqual(roots(plan(editor)), [200, 250]);
    assert.deepEqual(roots(plan(editor, {onionMode: 'frames'})), [210, 230], 'the ticks either side, interpolated');
    editor.seek(15); editor.updateObject({root_x: 300}); editor.seek(12);
    assert.deepEqual(roots(plan(editor, {onionMode: 'frames'})), [220, 260]);
  } finally { owner.release(); }
});

test('camera and blank layer keys do not replace the neighbouring figure poses, and a range is a distance in ticks', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open(fixture({duration: 10}));
  try {
    const overlay = editor.createLayer('Overlay');
    for (const tick of [9, 11]) editor.sheetInsertKey(['camera'], tick);
    editor.sheetInsertKey([overlay.id], 12, {blank: true});
    editor.seek(10);
    assert.deepEqual(roots(plan(editor)), [100, 300]);
    assert.deepEqual(roots(plan(editor, {onionRangeBefore: 10, onionRangeAfter: 10})), [100, 300]);
    assert.deepEqual(roots(plan(editor, {onionRangeBefore: 1, onionRangeAfter: 1})), [], 'the neighbours are further than a tick away');
  } finally { owner.release(); }
});

test('a held cell edit changes the skin it precedes, and so does the history', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    editor.seek(15);
    editor.updateObject({root_x: 240});
    assert.deepEqual(roots(plan(editor)), [240, 300]);
    editor.undo();
    assert.deepEqual(roots(plan(editor)), [200, 300]);
  } finally { owner.release(); }
});

test('a gesture leaves the skins as committed; they change when it commits and with the history', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    editor.seek(15);
    const before = plan(editor);
    editor.beginDrag();
    for (let i = 0; i < 8; i++) { editor.moveSelection(5, 0); assert.deepEqual(plan(editor), before); }
    editor.commitDrag();
    assert.deepEqual(roots(plan(editor)), [240, 300]);
    editor.undo(); assert.deepEqual(roots(plan(editor)), [200, 300]);
    editor.redo(); assert.deepEqual(roots(plan(editor)), [240, 300]);
    editor.beginDrag(); editor.moveSelection(10, 0); editor.cancelDrag();
    assert.deepEqual(roots(plan(editor)), [240, 300]);
  } finally { owner.release(); }
});

test('duplicating and pasting layer frames changes the neighbouring skins', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    editor.seek(10);
    editor.sheetDuplicateFrameAfter(['layer-1']);
    editor.updateObject({root_x: 260}); editor.seek(10);
    assert.deepEqual(roots(plan(editor)), [100, 260]);
    editor.sheetCopyFrames(['layer-1'], 11, 11);
    editor.sheetPasteFrames(['layer-1'], 9); editor.seek(10);
    assert.deepEqual(roots(plan(editor)), [260, 260]);
    editor.undo(); editor.seek(10);
    assert.deepEqual(roots(plan(editor)), [100, 260]);
  } finally { owner.release(); }
});

test('counts, spacing and fade are independent and zero removes either direction', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open(fixture({count: 12}), null);
  try {
    editor.seek(12);
    const skins = plan(editor, {onionBefore: 2, onionAfter: 1, onionOpacity: .4});
    assert.equal(skins.ghosts.length, 3);
    assert.deepEqual(skins.ghosts.map(ghost => ghost.opacity), [.2, .4, .4], 'the farthest fades most');
    assert.equal(plan(editor, {onionBefore: 0, onionAfter: 0}).ghosts.length, 0);
    assert.equal(plan(editor, {onionBefore: 0, onionAfter: 2}).ghosts.length, 2);
    assert.deepEqual(plan(editor, {onionBefore: 2, onionAfter: 0, onionStep: 2}).ghosts.map(ghost => ghost.tick), [0]);
  } finally { owner.release(); }
});

test('opacity and colour only restyle the skins, and a document is never changed by showing them', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open(fixture({count: 12}), null);
  try {
    editor.seek(12);
    const original = JSON.stringify(editor.report), skins = plan(editor);
    assert.deepEqual(plan(editor, {onionOpacity: .7}).ghosts.map(ghost => ghost.tick), skins.ghosts.map(ghost => ghost.tick));
    const red = plan(editor, {onionBeforeColor: '#ff0000'});
    assert.deepEqual(red.ghosts[0].tint, [255, 0, 0]);
    assert.deepEqual(red.ghosts.at(-1).tint, [0x54, 0x9d, 0xe7], 'the other side keeps its colour');
    assert.equal(plan(editor, {onionTint: false}).ghosts[0].tint, null);
    assert.equal(JSON.stringify(editor.report), original);
  } finally { owner.release(); }
});

test('the scope of the selected figures takes the figures joined to them and leaves out the hidden ones', {skip: !engineBuilt}, async () => {
  const report = fixture({count: 12, objects: 3});
  for (const frame of report.keyframes) frame.objects[1].join = {target_object_slot: 0, target_handle_id: 1};
  const {editor, owner} = await open(report, null);
  try {
    editor.seek(12);
    const everything = plan(editor, {onionScope: 'all'});
    assert.ok(hidden(everything).every(slots => slots.length === 0), 'all figures');
    const selected = plan(editor, {onionScope: 'selected'}, {selected: [1]});
    assert.ok(hidden(selected).every(slots => slots.join() === '2'), 'the figure and the one joined to it; not the third');
    assert.ok(hidden(plan(editor, {onionScope: 'selected', onionJoined: false}, {selected: [1]})).every(slots => slots.join() === '1,2'));
    assert.ok(hidden(plan(editor, {onionScope: 'selected'}, {selected: [1, 3], hidden: [3]})).every(slots => slots.join() === '2'), 'a hidden figure is not shown');
    assert.ok(hidden(plan(editor, {}, {hidden: [1]})).every(slots => slots.includes(0)));
  } finally { owner.release(); }
});

test('a hidden layer shows none of its figures in a skin, and showing it again brings them back', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open(fixture({count: 12, objects: 3}), null);
  try {
    editor.seek(12);
    assert.ok(hidden(plan(editor)).every(slots => slots.length === 0));
    editor.setLayerVisible('layer-1', false);
    assert.equal(plan(editor).ghosts.length, 0, 'a hidden layer has no skins of its own');
    editor.undo();
    assert.ok(plan(editor).ghosts.length > 0 && hidden(plan(editor)).every(slots => slots.length === 0));
  } finally { owner.release(); }
});

test('show on top changes the composition and nothing else', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open(fixture({count: 12}), null);
  try {
    editor.seek(12);
    const behind = plan(editor), top = plan(editor, {onionShowOnTop: true});
    assert.ok(behind.ghosts.every(ghost => !ghost.showOnTop) && top.ghosts.every(ghost => ghost.showOnTop));
    assert.deepEqual(top.ghosts.map(ghost => ghost.tick), behind.ghosts.map(ghost => ghost.tick));
  } finally { owner.release(); }
});

test('ranges beyond ten show all the samples there are, and no more than the limit however many there could be', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open(fixture({count: 120, duration: 1}), null);
  try {
    editor.seek(60);
    assert.equal(plan(editor, {onionBefore: 20, onionAfter: 18, onionFade: false}).ghosts.length, 38);
    const most = plan(editor, {onionBefore: Number.MAX_SAFE_INTEGER, onionAfter: Number.MAX_SAFE_INTEGER, onionFade: false});
    assert.equal(most.ghosts.length, 48, 'the nearest forty-eight');
    assert.deepEqual(most.ghosts.slice(-2).map(ghost => ghost.tick).sort((a, b) => a - b), [59, 61], 'the nearest are the ones kept');
    const frames = plan(editor, {onionMode: 'frames', onionBefore: 20, onionAfter: 20});
    assert.equal(frames.ghosts.length, 40);
    assert.deepEqual([frames.ghosts.at(-1).tick, frames.ghosts.at(-2).tick].sort(), [59, 61]);
  } finally { owner.release(); }
});

test('the controller builds what the engine plans from: the range the settings reach in this document, the selection and the hidden figures', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open(fixture({count: 12}), null);
  const settings = normalizeEditorSettings({onionBefore: 2, onionAfter: 2, onionRangeBefore: 30, onionRangeAfter: 30, onionScope: 'selected'});
  const controller = new OnionController({editor, getSettings: () => settings, getEnabled: () => true, onCommit() {}, onToggle() {}, onRender() {}, onError(error) { throw error; }});
  try {
    editor.seek(50);
    const request = controller.request({selected: new Set([1]), hidden: new Set([2])});
    assert.deepEqual([request.hidden, request.selected], [[2], [1]]);
    assert.equal(request.onionBefore, 3, 'the poses within thirty ticks before: 40, 30 and 20');
    assert.equal(request.onionAfter, 3);
    assert.equal(editor._shown.skins(request).ghosts.length, 6);
    assert.deepEqual(controller.request({selected: new Set([1]), hidden: new Set()}).hidden, []);
    assert.deepEqual(controller.request({selected: new Set([1]), hidden: new Set()}).selected, [1]);
  } finally { controller.destroy(); owner.release(); }
});
