import test from 'node:test';
import assert from 'node:assert/strict';
import {newOwnedEditor} from './support/owned-editor.mjs';

test('browsing beyond the end is read-only; placing a key extends duration', () => {
  const e=newOwnedEditor(), before=JSON.stringify(e.serialize()), end=e.totalTicks;
  e.seek(5000,{allowBeyondEnd:true}); assert.equal(e.tick,5000);
  assert.equal(e.totalTicks,end); assert.equal(JSON.stringify(e.serialize()),before);
  assert.ok(e.evaluatedFrame.objects.length);
  e.addAnimationKey({kind:'figure',uid:1},'x',e.tick,400);
  assert.ok(e.totalTicks>=5001);
  e.undo(); assert.equal(e.totalTicks,end);
});
