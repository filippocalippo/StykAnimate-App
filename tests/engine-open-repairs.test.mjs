// A project whose frame joins name no figure is refused by an older app and opens in this one, mended from the clip's neighbouring frame, and the
// opening says how much it mended (`Opening.repairs`, which the app tells the person). A project that needed nothing says none and is as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openJson} from '../src/engine/engine-open.mjs';
import {engineBuilt} from './support/engine-node.mjs';

const document = () => JSON.parse(readFileSync(new URL('../engine/tests/edit/camera-chain.document.json', import.meta.url), 'utf8'));
const parents = frame => frame.objects.map(o => [o.unique_id, o.join ? frame.objects[o.join.target_object_slot]?.unique_id : null]);

test('a project whose first frame joins figures to nothing opens, mended, and the opening says so', {skip: !engineBuilt}, async () => {
  const healthy = document(), damaged = document();
  delete damaged.keyframes[0].objects[1].join.target_object_slot;
  delete damaged.keyframes[0].objects[1].join.target_unique_id;
  damaged.keyframes[0].objects[2].join.target_object_slot = 2;
  delete damaged.keyframes[0].objects[2].join.target_unique_id;
  const opening = await openJson(damaged, 'damaged.styk', {layerTimeline: false});
  try {
    assert.equal(opening.repairs, 1);
    const {report} = await opening.read();
    assert.deepEqual(parents(report.keyframes[0]), parents(healthy.keyframes[0]));
    assert.deepEqual(parents(report.keyframes[1]), parents(healthy.keyframes[1]));
  } finally { opening.dispose(); }
});

test('a project that needs no mending opens with nothing mended', {skip: !engineBuilt}, async () => {
  const opening = await openJson(document(), 'healthy.styk', {layerTimeline: false});
  try { assert.equal(opening.repairs, 0); } finally { opening.dispose(); }
});
