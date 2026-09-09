import test from 'node:test';
import assert from 'node:assert/strict';
import {composeSceneGroups} from '../src/scene-order.mjs';
const scene = uids => {
  const objects = new Map(uids.map((uid, slot) => [slot, {slot, obj: {unique_id: uid}, drawables: [{}]}]));
  return {objects, orderedObjects: [...objects.values()]};
};

test('show-on-top skins draw after current artwork, including anchored skins', () => {
  const groups = composeSceneGroups(scene([1, 2]), [
    {geometry: scene([8]), showOnTop: true, opacity: .3},
    {geometry: scene([9])},
    {geometry: scene([2]), beforeUid: 2, showOnTop: true},
  ]);
  assert.deepEqual(groups.map(group => group.key), ['onion-1:9', 1, 2, 'onion-0:8', 'onion-2:2']);
  assert.equal(groups[3].opacity, .3);
  assert.equal(groups[3].isOnion, true);
});
test('default skins remain behind the whole scene and anchored skins retain input order immediately before their figure', () => {
  const current = scene([1, 2, 3]), skins = [
    {geometry: scene([9]), opacity: .2},
    {geometry: scene([2, 20]), beforeUid: 2, opacity: .1},
    {geometry: scene([2]), beforeUid: 2, opacity: .3},
  ];
  const groups = composeSceneGroups(current, skins);
  assert.deepEqual(groups.map(group => group.key), ['onion-0:9', 1, 'onion-1:2', 'onion-1:20', 'onion-2:2', 2, 3]);
  assert.deepEqual(groups.map(group => group.opacity), [.2, 1, .1, .1, .3, 1, 1]);
  assert.equal(groups[2].isOnion, true); assert.equal(groups[5].isOnion, false);
});
test('empty current artwork still anchors its skin at the native figure position', () => {
  const current = scene([1, 2, 3]); current.objects.get(1).drawables = []; current.orderedObjects.splice(1, 1);
  const frame = {objects: [{}, {}, {}], object_draw_order: [0, 1, 2]};
  assert.deepEqual(composeSceneGroups(current, [{geometry: scene([2]), beforeUid: 2}], frame).map(group => group.key), [1, 'onion-0:2', 3]);
  assert.deepEqual(composeSceneGroups(current, [{geometry: scene([9]), beforeUid: 9}], frame).map(group => group.key), [1, 3]);
});
