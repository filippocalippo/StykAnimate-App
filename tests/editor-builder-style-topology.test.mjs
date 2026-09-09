import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createObject,createFrame,defaultFigure} from '../src/demo.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';

const target=handleId=>({kind:'segment',uid:1,handleId});
function fixture(){
  const report=emptyDocument(),figure=report.figure_types[0];figure.segments[7].secondary={rgb:[0,150,255],a:0};
  report.figure_types.push(defaultFigure(2));
  report.keyframes=[0,1].map(i=>createFrame([createObject(figure,1,200+i*20,240),createObject(report.figure_types[1],2,420,250)],i?1:4));
  for(const frame of report.keyframes)frame.objects[0]._stykStyle={outlineOpacity:.7,segments:{7:{opacity:.25},8:{opacity:.55,gradientOpacity:.35},9:{opacity:.8}}};
  const editor=new Editor({demo:false}).load(report);editor.captureFrameSource(editor.report.keyframes[1]);
  editor.addAnimationKeys([
    ...[7,8,9].flatMap(handleId=>[{target:target(handleId),property:'opacity',tick:0,value:handleId/10},{target:target(handleId),property:'opacity',tick:4,value:.1}]),
    {target:target(8),property:'gradientOpacity',tick:0,value:.4},{target:target(8),property:'gradientOpacity',tick:4,value:.9},
    {target:{kind:'segment',uid:2,handleId:7},property:'opacity',tick:0,value:.3},
  ]);
  editor.select(1,6);return editor;
}
const channel=(editor,handleId,property='opacity')=>editor.animationChannel(target(handleId),property);
for(const operation of['deleteSingleSegment','unsplitSegment'])test(`${operation} removes only the deleted handle’s style and preserves surviving channels/pose overrides`,()=>{
  const editor=fixture(),before=editor.serialize(),kept=structuredClone(channel(editor,8)),other=structuredClone(channel(editor,9)),history=editor._undo.length;
  editor[operation]();assert.equal(editor._undo.length,history+1);assert.equal(channel(editor,7),null);
  assert.deepEqual(channel(editor,8),kept);assert.deepEqual(channel(editor,9),other);
  assert.equal(editor.animationChannel({kind:'segment',uid:2,handleId:7},'opacity').keys[0].value,.3);
  for(const frame of editor._allSourceFrames()){
    const style=frame.objects.find(o=>o.unique_id===1)._stykStyle;
    assert.equal(style.segments[7],undefined);assert.deepEqual(style.segments[8],{opacity:.55,gradientOpacity:.35});assert.deepEqual(style.segments[9],{opacity:.8});assert.equal(style.outlineOpacity,.7);
  }
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});
test('duplicating a branch copies captured and authored styles onto new handles with independent key identities',()=>{
  const editor=fixture(),before=editor.serialize(),originals=new Map([7,8,9].map(id=>[id,structuredClone(channel(editor,id))]));
  const oldKeys=new Set(editor.animationChannels.flatMap(channel=>channel.keys.map(key=>key.id))),history=editor._undo.length;
  const result=editor.duplicateSegmentBranch({angleOffset:.2}),[first,second]=result.handleIds;
  assert.equal(editor._undo.length,history+1);assert.equal(result.handleIds.length,2);
  for(const[id,copy]of[[7,first],[8,second]]){
    const actual=channel(editor,copy),source=originals.get(id);assert.ok(actual);assert.equal(actual.id,animationChannelId(target(copy),'opacity'));
    assert.deepEqual(actual.keys.map(({id,...key})=>key),source.keys.map(({id,...key})=>key));assert.ok(actual.keys.every(key=>!oldKeys.has(key.id)));
    assert.deepEqual(channel(editor,id),source);
  }
  const gradient=channel(editor,second,'gradientOpacity');assert.ok(gradient.keys.every(key=>!oldKeys.has(key.id)));assert.deepEqual(gradient.keys.map(key=>key.value),[.4,.9]);
  assert.deepEqual(channel(editor,9),originals.get(9));
  for(const frame of editor._allSourceFrames()){
    const style=frame.objects.find(o=>o.unique_id===1)._stykStyle;
    assert.deepEqual(style.segments[first],style.segments[7]);assert.deepEqual(style.segments[second],style.segments[8]);
    assert.notEqual(style.segments[first],style.segments[7]);assert.notEqual(style.segments[second],style.segments[8]);
  }
  const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);editor.redo();assert.deepEqual(editor.serialize(),after);
});
