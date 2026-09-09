import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChannelTimelineTracks} from '../src/timeline.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';

test('summary keys retain exact scoped engine references and hidden leaf keys', () => {
  const layers = [{id: 'scene', kind: 'scene'}, {id: 'camera', kind: 'camera'}, {id: 'layer-1', kind: 'layer', name: 'Characters', figureUids: [7]}];
  const channels = [
    {id: 'layer:layer-1:pose', target: {kind: 'layer', id: 'layer-1'}, property: 'pose', keys: [{id: 'hidden', tick: 0, hidden: true}, {id: 'pose-0', tick: 0}, {id: 'pose-4', tick: 4, value: {frameId: null}}]},
    {id: 'figure:7:x', target: {kind: 'figure', uid: 7}, property: 'x', keys: [{id: 'x-4', tick: 4}, {id: 'x-9', tick: 9}]},
  ];
  const expanded = new Set(['layer-1', 'figure:7']);
  const projection = buildChannelTimelineTracks(layers, channels, {keyframes: []}, expanded);
  const summary = projection.byId.get('layer-1');
  assert.deepEqual(summary.keys.map(key => key.tick), [0, 4, 9]);
  assert.deepEqual(summary.keys[1].refs, [{channelId: 'layer:layer-1:pose', keyId: 'pose-4'}, {channelId: 'figure:7:x', keyId: 'x-4'}]);
  assert.equal(summary.keys[1].blank, true, 'Blank pose markers survive summary aggregation with a scalar key at the same tick');
  assert.deepEqual(projection.byId.get('channel:layer:layer-1:pose').keys.map(key => key.id), ['hidden', 'pose-0', 'pose-4']);
  assert.equal(projection.byId.get('channel:figure:7:opacity').keys.length, 0, 'Editable empty property rows must not fabricate keys');
});

test('20,000 collapsed user layers lazily materialize native key descriptors', () => {
  const layers = Array.from({length: 20_000}, (_, index) => ({id: `layer-${index + 1}`, kind: 'layer', name: `Layer ${index + 1}`, figureUids: []}));
  let requested = 0;
  const projection = buildChannelTimelineTracks(layers, [], {keyframes: []}, new Set(), {nativePoseChannel: target => {
    requested++; return {keys: [{id: `${target.id}:a`, tick: 0}, {id: `${target.id}:b`, tick: 1200}]};
  }});
  assert.equal(projection.tracks.length, 20_000);
  assert.equal(requested, 0, 'Indexing collapsed tracks must not allocate native frame key tables');
  for (const track of projection.tracks.slice(0, 6)) assert.equal(track.keys.length, 2);
  assert.equal(requested, 6, 'Only visible root tracks should request native descriptors');
  for (const track of projection.tracks.slice(0, 6)) assert.equal(track.keys.length, 2);
  assert.equal(requested, 6, 'Repeated painting should reuse cached key tables');
});

test('50,000 collapsed figures create no figure or property rows while root summaries retain authored keys', () => {
  const layers = [{id: 'scene', kind: 'scene'}, {id: 'camera', kind: 'camera'},
    {id: 'layer-1', kind: 'layer', figureUids: Array.from({length: 50_000}, (_, index) => index + 1)}];
  const pose = {id: 'layer:layer-1:pose', target: {kind: 'layer', id: 'layer-1'}, property: 'pose', keys: [{id: 'a', tick: 0}]};
  const position = {id: 'figure:7:x', target: {kind: 'figure', uid: 7}, property: 'x', keys: [{id: 'b', tick: 5}]};
  const projection = buildChannelTimelineTracks(layers, [pose, position], {keyframes: []});
  assert.equal(projection.tracks.length, 3); assert.equal(projection.byId.size, 3);
  assert.deepEqual(projection.tracks[2].keys.map(key => key.tick), [0, 5]); assert.equal(projection.byId.size, 3);
  assert.equal(projection.byId.get('channel:layer:layer-1:pose').keys[0].id, 'a'); assert.ok(projection.byId.size < 10);
  assert.equal(projection.byId.get('channel:figure:7:x').keys[0].id, 'b'); assert.ok(projection.byId.size < 20);
  assert.equal(projection.byId.has('figure:50001'), false); assert.equal(projection.byId.get('figure:7').hasChildren, true);
});

test('collapsed hierarchy summaries refresh moved, deleted and cross-layer figure keys without stale references', () => {
  const layers = [{id: 'layer-1', kind: 'layer', figureUids: [7]}, {id: 'layer-2', kind: 'layer', figureUids: [8]}];
  const source = {id: 'figure:7:x', target: {kind: 'figure', uid: 7}, property: 'x', keys: [{id: 'key-1', tick: 3, value: 4}]};
  const original = buildChannelTimelineTracks(layers, [source], {keyframes: []}); assert.equal(original.roots[0].keys[0].tick, 3);
  const changed = {...source, keys: [{...source.keys[0], tick: 9}]};
  const next = buildChannelTimelineTracks(layers, [changed], {keyframes: []}, new Set(), {figureNames: original.figureNames});
  assert.deepEqual(next.roots[0].keys.map(key => key.tick), [9]); assert.deepEqual(next.roots[1].keys, []);
  assert.equal(next.byId.get('channel:figure:7:x').keys[0].tick, 9); assert.equal(original.roots[0].keys[0].tick, 3);
  const removed = buildChannelTimelineTracks(layers, [], {keyframes: []}); assert.deepEqual(removed.roots[0].keys, []);
  const reassigned = buildChannelTimelineTracks([{...layers[0], figureUids: []}, {...layers[1], figureUids: [8, 7]}], [changed], {keyframes: []});
  assert.deepEqual(reassigned.roots[0].keys, []); assert.equal(reassigned.roots[1].keys[0].tick, 9);
});

test('expanding a layer creates figure rows, but properties only materialize for expanded or directly addressed figures', () => {
  const layer = {id: 'layer-1', kind: 'layer', figureUids: [1, 2, 3]}, projection = buildChannelTimelineTracks([layer], [], {keyframes: []}, new Set(['layer-1', 'figure:2']));
  assert.equal(projection.tracks.filter(track => track.kind === 'figure').length, 3);
  assert.equal(projection.tracks.filter(track => track.parentId === 'figure:1').length, 0);
  assert.ok(projection.tracks.some(track => track.parentId === 'figure:2'));
  const size = projection.byId.size; projection.byId.get('figure:1').keys; assert.equal(projection.byId.size, size);
});

test('sparse segment styles appear under their owning figure, with stable handles and exact summary key references', () => {
  const layers = [{id: 'layer-1', kind: 'layer', figureUids: [7], locked: true}], report = {
    figure_types: [{figure_type_id: 3, name: 'Rig', segments: [{segment_id: 42}, {segment_id: 600, secondary: {a: 0, rgb: 0}}]}],
    keyframes: [{objects: [{unique_id: 7, figure_type_id: 3}]}],
  };
  const target = {kind: 'segment', uid: 7, handleId: 600}, channel = {id: animationChannelId(target, 'gradientOpacity'), target,
    property: 'gradientOpacity', keys: [{id: 'gradient-key', tick: 8, value: .3}]};
  let nativeCalls = 0;
  const projection = buildChannelTimelineTracks(layers, [channel], report, new Set(), {nativePoseChannel: () => {nativeCalls++; return {keys: []};}});
  assert.equal(projection.byId.size, 1, 'Collapsed layers must not create segment/property rows');
  assert.deepEqual(projection.roots[0].keys[0].refs, [{channelId: channel.id, keyId: 'gradient-key'}]);
  assert.deepEqual(projection.byId.get('figure:7').keys[0].refs, projection.roots[0].keys[0].refs);
  const leaf = projection.byId.get(`channel:${channel.id}`);
  assert.equal(leaf.name, 'Gradient opacity'); assert.equal(leaf.parentId, 'segment:7:600'); assert.equal(leaf.locked, true);
  assert.equal(projection.byId.get('segment:7:600').name, 'Segment 600');
  assert.equal(projection.byId.get('channel:segment:7%2F42:gradientOpacity'), undefined, 'Plain segments must not fabricate gradient controls');
  assert.equal(projection.byId.get('channel:segment:7%2F42:opacity').keys.length, 0);
  assert.equal(projection.byId.get('channel:figure:7:outlineOpacity').name, 'Outline opacity');
  assert.equal(nativeCalls, 1, 'Only the layer may request a native pose channel');
  const expanded = buildChannelTimelineTracks(layers, [channel], report, new Set(['layer-1', 'figure:7', 'segment:7:600']));
  assert.deepEqual(expanded.tracks.filter(row => row.kind === 'segment').map(row => row.handleId), [42, 600]);
  assert.equal(expanded.tracks.filter(row => row.parentId === 'segment:7:600').length, 2);
});
