import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {Timeline} from '../src/layer-timeline.mjs';

function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [createFrame([1, 2, 3].map(uid => createObject(figure, uid, uid * 100, 100)), 10)];
  const editor = newOwnedEditor({demo: false, layerTimeline: true}).load(report);
  for (const name of ['Second', 'Third', 'Empty']) editor.createLayer(name);
  editor.assignFiguresToLayer([2], 'layer-2'); editor.assignFiguresToLayer([3], 'layer-3');
  editor.setActiveLayer('layer-1'); editor.select(1);
  let hostTrack = 'layer-1';
  const timeline = Object.assign(Object.create(Timeline.prototype), {
    editor, tracks: [editor.getLayer('camera'), editor.getLayer('scene'), ...editor.layers.filter(row => row.kind === 'layer').reverse()],
    selectedTrackId: 'layer-1', selectedLayers: new Set(['layer-1']), start: 0, end: 0,
    revealSelectedLayer() {}, update() {}, onTrackSelect(track) { hostTrack = track.id; },
  });
  timeline.trackById = new Map(timeline.tracks.map(row => [row.id, row]));
  editor.addEventListener('change', event => timeline._syncLayerSelection(event.detail));
  return {editor, timeline, refreshHost: () => timeline.selectTrack(hostTrack)};
}

for (const modifier of ['ctrlKey', 'metaKey']) test(`${modifier} adds nonempty and empty layers across editor and host selection updates`, () => {
  const {editor, timeline, refreshHost} = fixture();
  timeline._selectLayer('layer-2', {[modifier]: true}); refreshHost();
  assert.deepEqual(timeline.ids, ['layer-1', 'layer-2']); assert.equal(editor.selectedUid, 2);
  timeline._selectLayer('layer-4', {[modifier]: true}); refreshHost();
  assert.deepEqual(timeline.ids, ['layer-1', 'layer-2', 'layer-4']); assert.equal(editor.selectedUid, null);
  assert.equal(timeline.selectedTrackId, 'layer-4');
});

test('removing the active selected row publishes a remaining member to the host', () => {
  const {editor, timeline, refreshHost} = fixture();
  timeline._selectLayer('layer-2', {ctrlKey: true}); refreshHost();
  timeline._selectLayer('layer-2', {ctrlKey: true}); refreshHost();
  assert.deepEqual(timeline.ids, ['layer-1']); assert.equal(editor.activeLayerId, 'layer-1');
  assert.equal(timeline.selectedTrackId, 'layer-1'); assert.equal(editor.selectedUid, 1);
  timeline._selectLayer('layer-1', {ctrlKey: true}); refreshHost();
  assert.deepEqual(timeline.ids, ['layer-1'], 'The timeline retains one editing layer');
});

test('repeated Shift clicks extend and shrink from the original layer', () => {
  const {timeline, refreshHost} = fixture();
  timeline._selectLayer('layer-4');
  timeline._selectLayer('layer-2', {shiftKey: true}); refreshHost();
  assert.deepEqual(timeline.ids, ['layer-4', 'layer-3', 'layer-2']);
  timeline._selectLayer('layer-1', {shiftKey: true}); refreshHost();
  assert.deepEqual(timeline.ids, ['layer-4', 'layer-3', 'layer-2', 'layer-1']);
  timeline._selectLayer('layer-3', {shiftKey: true}); refreshHost();
  assert.deepEqual(timeline.ids, ['layer-4', 'layer-3']);
});

test('the first Shift click retains the initial active layer as its anchor', () => {
  const {timeline} = fixture();
  timeline._selectLayer('layer-2', {shiftKey: true});
  timeline._selectLayer('layer-4', {shiftKey: true});
  assert.deepEqual(timeline.ids, ['layer-4', 'layer-3', 'layer-2', 'layer-1']);
});

test('range selection excludes folders and effect or motion rows while keeping Scene and Camera', () => {
  const {timeline} = fixture();
  timeline.tracks.splice(1, 0, {id: 'motion-1', kind: 'motion'});
  timeline.tracks.splice(4, 0, {id: 'folder-1', kind: 'folder'}, {id: 'vfx-1', kind: 'vfx'});
  timeline._selectLayer('camera'); timeline._selectLayer('layer-1', {shiftKey: true});
  assert.deepEqual([...timeline.selectedLayers], ['camera', 'scene', 'layer-4', 'layer-3', 'layer-2', 'layer-1']);
});

test('cell ranges retain layer identity when the projected rows change', () => {
  const {timeline} = fixture();
  timeline._selectCell({row: 2, tick: 2});
  timeline.tracks.splice(2, 0, {id: 'folder-1', kind: 'folder'});
  timeline._selectCell({row: timeline.tracks.findIndex(row => row.id === 'layer-2'), tick: 5}, {extend: true});
  assert.deepEqual([...timeline.selectedLayers], ['layer-4', 'layer-3', 'layer-2']);
  assert.deepEqual(timeline.selectedTimeRange, {start: 2, end: 6});
  timeline._selectCell({row: timeline.tracks.findIndex(row => row.id === 'layer-1'), tick: 7}, {extend: true});
  assert.deepEqual([...timeline.selectedLayers], ['layer-4', 'layer-3', 'layer-2', 'layer-1']);
  assert.deepEqual(timeline.selectedTimeRange, {start: 2, end: 8});
});

test('explicit figure selection still selects and anchors its own layer', () => {
  const {editor, timeline} = fixture();
  timeline._selectLayer('layer-2', {ctrlKey: true});
  editor.select(3);
  assert.deepEqual(timeline.ids, ['layer-3']); assert.equal(timeline.selectedTrackId, 'layer-3');
  timeline._selectLayer('layer-1', {shiftKey: true});
  assert.deepEqual(timeline.ids, ['layer-3', 'layer-2', 'layer-1']);
});

test('passive host selection refresh preserves the visible search selection', () => {
  const {timeline} = fixture();
  timeline._selectLayer('layer-2');
  timeline.tracks = timeline.tracks.filter(row => row.id !== 'layer-1');
  timeline.trackById = new Map(timeline.tracks.map(row => [row.id, row]));
  timeline.selectTrack('layer-1', {reveal: false});
  assert.deepEqual(timeline.ids, ['layer-2']); assert.equal(timeline.selectedTrackId, 'layer-2');
  timeline.selectTrack('layer-3', {reveal: false});
  assert.deepEqual(timeline.ids, ['layer-3']);
  timeline.selectTrack('layer-1');
  assert.equal(timeline.selectedTrackId, 'layer-1', 'Explicit selection can still reveal an excluded layer');
});
