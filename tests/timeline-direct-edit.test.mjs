import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';

test('replacement moves preserve source identity and undo restores the overwritten key', () => {
  const e = new Editor(), target = {kind:'figure', uid:1};
  const a = e.addAnimationKey(target, 'x', 2, 100);
  const b = e.addAnimationKey(target, 'x', 5, 200);
  const channel = e.animationChannel(target, 'x');
  e.moveAnimationKeys([{channelId:channel.id,keyIds:[a.id]}], 3, {replace:true});
  assert.deepEqual(e.animationChannel(target,'x').keys.map(k=>[k.id,k.tick,k.value]), [[a.id,5,100]]);
  e.undo(); assert.deepEqual(e.animationChannel(target,'x').keys.map(k=>k.id), [a.id,b.id]);
  e.redo(); assert.equal(e.animationChannel(target,'x').keys.length,1);
});

test('overlapping group moves retain every selected key', () => {
  const e = new Editor(), target = {kind:'figure',uid:1};
  const keys = [0,1,2].map(t=>e.addAnimationKey(target,'x',t,t*10));
  const c = e.animationChannel(target,'x');
  e.moveAnimationKeys([{channelId:c.id,keyIds:keys.slice(0,2).map(k=>k.id)}],1,{replace:true});
  assert.deepEqual(e.animationChannel(target,'x').keys.map(k=>[k.tick,k.value]),[[1,0],[2,10]]);
});

test('copy onto an occupied frame replaces the destination and retains the source', () => {
  const e = new Editor(), target = {kind:'figure',uid:1};
  const a=e.addAnimationKey(target,'x',0,100); e.addAnimationKey(target,'x',10,200);
  e.duplicateAnimationKeys([{channelId:e.animationChannel(target,'x').id,keyIds:[a.id]}],10,{replace:true});
  assert.deepEqual(e.animationChannel(target,'x').keys.map(k=>[k.tick,k.value]),[[0,100],[10,100]]);
});

test('browsing beyond the end is read-only; placing a key extends duration', () => {
  const e=new Editor(), before=JSON.stringify(e.serialize()), end=e.totalTicks;
  e.seek(5000,{allowBeyondEnd:true}); assert.equal(e.tick,5000);
  assert.equal(e.totalTicks,end); assert.equal(JSON.stringify(e.serialize()),before);
  assert.ok(e.evaluatedFrame.objects.length);
  e.addAnimationKey({kind:'figure',uid:1},'x',e.tick,400);
  assert.ok(e.totalTicks>=5001);
  e.undo(); assert.equal(e.totalTicks,end);
});
