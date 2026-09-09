import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame} from '../src/demo.mjs';
import {animationChannelId,sampleAnimationChannel} from '../src/animation-channels.mjs';

const target={kind:'figure',uid:1},id=animationChannelId(target,'x');
function fixture(){
  const report=emptyDocument();report.keyframes=[createFrame([createObject(report.figure_types[0],1,25,100)],20)];
  report._styk.animation={version:1,nextKeyId:4,channels:[{id,target,property:'x',keys:[
    {id:'key-1',tick:0,value:200,interpolation:'linear',passthrough:true},
    {id:'key-2',tick:5,value:300,interpolation:'hold',passthrough:true},
    {id:'key-3',tick:10,value:400,interpolation:'hold'}]}]};
  return new Editor({demo:false}).load(report);
}

test('explicit value replacement activates passthrough keys while preserving neighboring intervals and undo',()=>{
  for(const operation of ['add','set']){
    const editor=fixture(),before=structuredClone(editor.report._styk.animation),history=editor._undo.length;
    assert.equal(editor.evaluatedFrame.objects[0].root_x,25);
    if(operation==='add')editor.addAnimationKey(target,'x',0,200);
    else editor.setAnimationKey(id,'key-1',{value:200});
    const channel=editor.animationChannel(target,'x');
    assert.equal(channel.keys[0].passthrough,undefined);assert.equal(sampleAnimationChannel(channel,0),200);
    assert.equal(channel.keys[1].passthrough,true);assert.equal(sampleAnimationChannel(channel,6),undefined);
    assert.equal(editor.evaluatedFrame.objects[0].root_x,200);assert.equal(editor._undo.length,history+1);
    editor.undo();assert.deepEqual(editor.report._styk.animation,before);assert.equal(editor.evaluatedFrame.objects[0].root_x,25);
    editor.redo();assert.equal(editor.evaluatedFrame.objects[0].root_x,200);
  }
});

test('scalar passthrough preview activates immediately and cancel restores exact references',()=>{
  const editor=fixture(),before=editor.report._styk.animation,history=editor._undo.length;
  editor.beginAnimationEdit(target,'x');editor.previewAnimationEdit(200);
  assert.equal(editor.evaluatedFrame.objects[0].root_x,200);assert.equal(editor._undo.length,history);
  editor.cancelAnimationEdit();assert.equal(editor.report._styk.animation,before);
  editor.beginAnimationEdit(target,'x');editor.previewAnimationEdit(200);assert.equal(editor.commitAnimationEdit(),true);
  assert.equal(editor._undo.length,history+1);editor.undo();assert.deepEqual(editor.report._styk.animation,before);
});
