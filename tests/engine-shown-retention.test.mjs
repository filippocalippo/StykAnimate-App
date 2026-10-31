// The interface keeps the geometry on show, not the ones before it: reading another must let the previous one go
// (a getter made inside `geometry()` once kept every geometry ever read alive through the closure's shared context).
import test from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import {createShown} from '../src/engine/engine-shown.mjs';

v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');

test('a geometry the interface replaced is not kept alive by the one that replaced it', async () => {
  let serial = 0;
  const shown = createShown({
    ask: kind => kind === 'geometry' ? JSON.stringify({token: ++serial, full: true, count: 0, slots: [], warnings: []}) : 'null',
    source: () => null,
    report: () => ({figure_types: []}),
  });
  const frame = {objects: []};
  let first = new WeakRef(shown.geometry(frame));
  const second = shown.geometry(frame);
  assert.notEqual(second, first.deref());
  for (let turn = 0; turn < 3 && first.deref(); turn++) { await new Promise(resolve => setImmediate(resolve)); collect(); }
  assert.equal(first.deref(), undefined, 'the first geometry was collected while the second is held');
  assert.deepEqual(second.drawables, [], 'the replacement still gives its drawables');
});
