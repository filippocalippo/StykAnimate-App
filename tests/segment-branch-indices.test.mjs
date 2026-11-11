import test from 'node:test';
import assert from 'node:assert/strict';
import {segmentBranchIndices} from '../src/pivot/structure.mjs';

test('30,000 reverse-ordered joints use linear branch discovery without recursion', () => {
  const count = 30000; let reads = 0;
  const segments = Array.from({length: count}, (_, i) => {
    const id = count - i;
    return {segment_id: id, get parent_id() { reads++; return id - 1; }};
  });
  const indices = segmentBranchIndices(segments, 1);
  assert.equal(indices.length, count); assert.equal(indices[0], 0); assert.equal(indices.at(-1), count - 1);
  assert.ok(reads <= count * 2, `Expected linear hierarchy reads; observed ${reads}.`);
  assert.deepEqual(segmentBranchIndices(segments, count - 1), [0, 1]);
});

test('a branch keeps the document order of its segments and follows sparse handle IDs', () => {
  const segments = [{segment_id: 9, parent_id: 3}, {segment_id: 7, parent_id: 0}, {segment_id: 3, parent_id: 0}];
  assert.deepEqual(segmentBranchIndices(segments, 3), [0, 2]);
  assert.deepEqual(segmentBranchIndices(segments, 7), [1]);
});
