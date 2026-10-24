import test from 'node:test';
import assert from 'node:assert/strict';
import {frameImageDrawables} from '../src/scene-preparation.mjs';

test('image preparation retains scaled instance records and never flattens the scene', () => {
  const asset={asset_url:'sprite.png',anchor_length:5},image={type:'image',asset,start:{x:0,y:0},end:{x:20,y:0}};
  const nested={...image,end:{x:40,y:0}},items=[{type:'line'},image,nested,{type:'text'}];
  const scene={orderedObjects:[{drawables:items}],get drawables(){throw new Error('Flattened the scene');}};
  assert.deepEqual(frameImageDrawables(scene),[image,nested]);
  Object.defineProperty(items[0],'type',{get(){throw new Error('Rescanned unchanged artwork');}});
  assert.deepEqual(frameImageDrawables(scene),[image,nested]);
  assert.deepEqual(frameImageDrawables({orderedObjects:[{drawables:[{type:'line'}]}]}),[]);
});
