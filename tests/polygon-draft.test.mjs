import test from 'node:test';
import assert from 'node:assert/strict';
import {PolygonDraft} from '../src/polygon-draft.mjs';

const figure = () => ({segments: [
  {segment_id: 11, parent_id: 0},
  {segment_id: 33, parent_id: 11},
  {segment_id: 77, parent_id: 33},
  {segment_id: 99, parent_id: 11},
  {segment_id: 123456789, parent_id: 99},
]});

test('ordinary connections, closure and undo never mutate the figure or poses', () => {
  const graph = {fig: figure(), joints: new Map([[0, {x: 7, y: 9}]]), obj: {angles: [1, 2]}};
  const before = structuredClone(graph), draft = new PolygonDraft(graph);
  assert.equal(draft.undo(), false);
  assert.equal(draft.redo(), false);
  assert.equal(draft.append(0), true);
  assert.equal(draft.append(77), true); // Direct polygon edges need not be bones.
  assert.equal(draft.append(0), false); // Two connections cannot close a polygon.
  assert.equal(draft.append(99), true);
  assert.equal(draft.append(0, {chain: true}), true);
  assert.deepEqual(draft.handles, [0, 77, 99]);
  assert.equal(draft.complete, true);
  assert.equal(draft.append(11), false);
  assert.equal(draft.undo(), true);
  assert.equal(draft.complete, false);
  assert.deepEqual(draft.handles, [0, 77, 99]);
  assert.equal(draft.redo(), true);
  assert.equal(draft.complete, true);
  assert.deepEqual(graph, before); // Discarding the draft is an exact cancellation.
});

test('Ctrl follows the shortest bidirectional bone chain through sparse IDs and zero', () => {
  const graph = figure();
  graph.segments.push({segment_id: 200, parent_id: 0});
  const draft = new PolygonDraft(graph);
  draft.append(77);
  assert.equal(draft.append(200, {chain: true}), true);
  assert.deepEqual(draft.handles, [77, 33, 11, 0, 200]);
  assert.equal(draft.undo(), true);
  assert.deepEqual(draft.handles, [77]);
  assert.equal(draft.canRedo, true);
  draft.redo();
  assert.deepEqual(draft.handles, [77, 33, 11, 0, 200]);
  draft.undo(); draft.undo();
  assert.deepEqual(draft.handles, []);
  assert.equal(draft.canUndo, false);
  draft.redo(); draft.redo();
  assert.deepEqual(draft.handles, [77, 33, 11, 0, 200]);
});

test('Ctrl skips previously selected intermediates while keeping one atomic undo group', () => {
  const draft = new PolygonDraft(figure());
  draft.append(11); draft.append(77);
  draft.append(123456789, {chain: true});
  assert.deepEqual(draft.handles, [11, 77, 33, 99, 123456789]);
  draft.undo();
  assert.deepEqual(draft.handles, [11, 77]);
  draft.redo();
  assert.deepEqual(draft.handles, [11, 77, 33, 99, 123456789]);
});

test('repeats and invalid clicks preserve redo, while a new connection discards redo', () => {
  const draft = new PolygonDraft(figure());
  draft.append(0); draft.append(11); draft.append(33);
  draft.undo();
  for (const id of [11, 0, -1, NaN, Infinity, 12.5, '33', 999]) assert.equal(draft.append(id), false);
  assert.equal(draft.canRedo, true);
  assert.deepEqual(draft.handles, [0, 11]);
  draft.append(99, {chain: true});
  assert.equal(draft.canRedo, false);
  assert.equal(draft.redo(), false);
  assert.deepEqual(draft.handles, [0, 11, 99]);
});

test('cyclic/disconnected graphs terminate and choose minimum edge count deterministically', () => {
  const graph = {segments: [
    {segment_id: 1, parent_id: 3},
    {segment_id: 2, parent_id: 1},
    {segment_id: 3, parent_id: 2},
    {segment_id: 4, parent_id: 3},
    {segment_id: 100, parent_id: 0},
  ]};
  const draft = new PolygonDraft(graph);
  draft.append(1); draft.append(4, {chain: true});
  assert.deepEqual(draft.handles, [1, 3, 4]);
  assert.equal(draft.append(100, {chain: true}), false);
  assert.deepEqual(draft.handles, [1, 3, 4]);
  assert.equal(draft.append(100), true); // Direct polygon connection is valid.
});

test('large chains are iterative and a Ctrl action is retained as one history item', () => {
  const count = 30000, graph = {segments: []};
  for (let i = 1; i <= count; i++) graph.segments.push({segment_id: i * 17, parent_id: (i - 1) * 17});
  const draft = new PolygonDraft(graph);
  draft.append(0);
  assert.equal(draft.append(count * 17, {chain: true}), true);
  const ids = draft.handles;
  assert.equal(ids.length, count + 1);
  assert.equal(ids[0], 0);
  assert.equal(ids.at(-1), count * 17);
  draft.undo();
  assert.deepEqual(draft.handles, [0]);
  draft.redo();
  assert.equal(draft.handles.length, count + 1);
});

test('initial handles and exposed snapshots cannot change the private draft state', () => {
  const graph = figure(), initial = [0, 11, 33], draft = new PolygonDraft(graph, {handles: initial});
  initial.push(77);
  draft.handles.push(99);
  graph.segments[0].parent_id = 123456789; // The draft owns a topology snapshot.
  assert.deepEqual(draft.handles, [0, 11, 33]);
  assert.equal(draft.canUndo, false);
  draft.append(77, {chain: true});
  assert.deepEqual(draft.handles, [0, 11, 33, 77]);
  const closed = new PolygonDraft(figure(), {handles: [0, 11, 33, 0]});
  assert.equal(closed.complete, true);
  assert.deepEqual(closed.handles, [0, 11, 33]);
});

test('invalid initial topology or selections fail without altering caller input', () => {
  const graph = figure(), before = structuredClone(graph);
  for (const handles of [[0, 0], [0, 11, 0], [0, 11, 999], [0, 11, 33, 11]])
    assert.throws(() => new PolygonDraft(graph, {handles}), /distinct existing handles/);
  assert.throws(() => new PolygonDraft({segments: [{segment_id: 1, parent_id: 99}]}), /missing parent/);
  assert.throws(() => new PolygonDraft({segments: [{segment_id: NaN, parent_id: 0}]}), /integers/);
  assert.deepEqual(graph, before);
});
