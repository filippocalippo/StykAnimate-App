// The engine's refusal of a document belongs to one revision of it (src/engine/engine-failure.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {failEngine, engineRefusal} from '../src/engine/engine-failure.mjs';

test('a refusal stands for the revision and document it was made for', () => {
  const side = {failed: null, failure: null}, report = {};
  assert.equal(engineRefusal(side, report, 1), null);
  failEngine(side, 'the engine refused the document', report, 1);
  assert.equal(engineRefusal(side, report, 1), 'the engine refused the document');
  assert.equal(side.failed, 'the engine refused the document', 'readers of the reason still see it');
});

test('the next revision of the document is tried afresh', () => {
  const side = {failed: null, failure: null}, report = {};
  failEngine(side, 'refused', report, 1);
  assert.equal(engineRefusal(side, report, 2), null);
  assert.equal(side.failed, null);
  assert.equal(side.failure, null);
  assert.equal(engineRefusal(side, report, 1), null, 'and the old refusal is forgotten, not remembered for later');
});

test('another document is tried afresh at the same revision', () => {
  const side = {failed: null, failure: null};
  failEngine(side, 'refused', {}, 0);
  assert.equal(engineRefusal(side, {}, 0), null);
  assert.equal(side.failed, null);
});
