import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {validateScene} from '../src/pivot/model.mjs';

const sample=(editor,tick,uid)=>{editor.seek(tick);const object=editor.evaluatedFrame.objects.find(object=>object.unique_id===uid);if(!object)return null;const {object_slot,...rest}=object;return structuredClone(rest);};
test('retiming a native figure pose leaves other figures in its layer and source frames untouched',()=>{
  const editor=new Editor(),target={kind:'figure',uid:1};
  const frames=structuredClone(editor.report.keyframes),before=Array.from({length:9},(_,tick)=>[sample(editor,tick,2),sample(editor,tick,3)]);
  const channel=editor.nativePoseChannel(target),key=channel.keys[1];
  editor.moveAnimationKeys([{channelId:channel.id,keyIds:[key.id]}],1);
  assert.equal(editor.animationChannels.length,1);assert.deepEqual(editor.animationChannels[0].target,target);
  assert.deepEqual(editor.report.keyframes,frames);
  assert.deepEqual(Array.from({length:9},(_,tick)=>[sample(editor,tick,2),sample(editor,tick,3)]),before);
  validateScene(editor.serialize());editor.undo();assert.equal(editor.animationChannels.length,0);editor.redo();assert.equal(editor.animationChannels[0].keys[1].tick,key.tick+1);
});
test('a figure action inherits an already retimed layer and can then move independently',()=>{
  const editor=new Editor(),layer=editor.nativePoseChannel({kind:'layer',id:editor.layerForUid(1)});
  editor.moveAnimationKeys([{channelId:layer.id,keyIds:[layer.keys[1].id]}],1);
  const before=Array.from({length:9},(_,tick)=>sample(editor,tick,1));
  editor.adoptNativePoseTrack({kind:'figure',uid:1});
  assert.deepEqual(Array.from({length:9},(_,tick)=>sample(editor,tick,1)),before);
  assert.deepEqual(editor.animationChannel({kind:'figure',uid:1},'pose').keys.map(k=>k.tick),editor.animationChannel(layer.target,'pose').keys.map(k=>k.tick));
});
test('canvas edits after figure retiming update that figure action instead of being hidden by it',()=>{
  const editor=new Editor(),target={kind:'figure',uid:1};editor.adoptNativePoseTrack(target);editor.seek(2);editor.select(1);
  const before=sample(editor,2,1).root_x,other=sample(editor,2,2);
  editor.moveSelection(12,0);editor.commitDrag();
  assert.equal(sample(editor,2,1).root_x,before+12);assert.deepEqual(sample(editor,2,2),other);
  assert.equal(editor.animationChannels.filter(c=>c.target.kind==='layer').length,0);
  editor.undo();assert.equal(sample(editor,2,1).root_x,before);validateScene(editor.serialize());
});
