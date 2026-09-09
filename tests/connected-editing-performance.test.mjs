import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {composePoseChannels} from '../src/animation-pose.mjs';
import {evaluatedNativeFrame,buildGeometry} from '../src/pivot/geometry.mjs';
import {documentChunks,applyDocumentChunk} from '../src/document-transport.mjs';
import {buildChannelTimelineTracks} from '../src/timeline.mjs';
import {connectedTimelineGroups} from '../src/connected-timeline.mjs';

function fixture({frames=30,parts=24}={}) {
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:frames},(_,i)=>createFrame(Array.from({length:parts},(_,slot)=>{
    const object=createObject(figure,slot+1,100+i,200);
    if(slot)object.join={target_object_slot:slot-1,target_unique_id:slot,target_handle_id:1};
    return object;
  }),3));
  const editor=new Editor({demo:false,propertyChannels:true}).load(report);editor.select(1);return editor;
}
function move(e){e.beginTranslationDrag();e.moveSelection(20,5);e.commitDrag();}

test('connected edits share one immutable pose sequence and history stays proportional to that sequence',()=>{
  const e=fixture({frames:500});move(e);
  const channels=e.animationChannels;assert.equal(channels.length,24);
  assert.equal(new Set(channels.map(c=>c.keys)).size,1);
  assert.ok(channels.every(c=>c.nativeProperties&&c.property==='pose'));
  assert.ok(e.historySize<400000,'History must not charge 24 copies of 500 pose keys.');
  const before=structuredClone(e.report._styk.animation),shared=channels[0].keys;
  e.setAnimationKey(channels[0].id,shared[1].id,{tick:4});
  assert.strictEqual(e.animationChannels[1].keys,shared);
  assert.notStrictEqual(e.animationChannels[0].keys,shared);
  assert.equal(shared[1].tick,3);e.undo();assert.deepEqual(e.report._styk.animation,before);
  e.undo();assert.equal(e.animationChannels.length,0);e.redo();assert.equal(new Set(e.animationChannels.map(c=>c.keys)).size,1);
});

test('connected composition samples a shared trajectory once and keeps every attachment',()=>{
  const e=fixture();move(e);let samples=0;
  const frame=composePoseChannels(e.report,e.report.keyframes[0],1,{sampleNative(...args){samples++;return evaluatedNativeFrame(...args);},resolveGeometry:buildGeometry});
  assert.equal(samples,1);assert.equal(frame.objects.length,24);
  const geometry=buildGeometry(e.report,frame);
  frame.objects.slice(1).forEach((object,i)=>assert.deepEqual(geometry.objects.get(i+1).root,geometry.objects.get(i).segments[0].end));
});

test('multiple edits of one target in a batch do not mutate a sibling shared sequence',()=>{
  const e=fixture();move(e);const first=e.animationChannels[0],second=e.animationChannels[1],value=first.keys[0].value;
  e.addAnimationKeys([{target:first.target,property:'pose',tick:1,value},{target:second.target,property:'pose',tick:1,value},
    {target:first.target,property:'pose',tick:2,value}]);
  assert.ok(e.animationChannel(first.target,'pose').keys.some(k=>k.tick===2));
  assert.ok(!e.animationChannel(second.target,'pose').keys.some(k=>k.tick===2));
});

test('file reopening and bounded worker transfer retain shared pose sequences',()=>{
  const e=fixture({frames:200});move(e);
  const saved=JSON.parse(JSON.stringify(e.serialize())),reopened=new Editor({demo:false,propertyChannels:true}).load(saved);
  assert.equal(new Set(reopened.animationChannels.map(c=>c.keys)).size,1);
  let output,aliases=0;
  for(const chunk of documentChunks(reopened.report,{maxBytes:4096})){
    assert.ok(!chunk.estimatedBytes||chunk.estimatedBytes<=4096);
    aliases+=(chunk.operations??[]).filter(op=>op.reference).length;
    output=applyDocumentChunk(output,structuredClone(chunk));
  }
  assert.ok(aliases>=23);assert.deepEqual(output,reopened.report);
  assert.equal(new Set(output._styk.animation.channels.map(c=>c.keys)).size,1);
  assert.throws(()=>applyDocumentChunk(output,{operations:[{path:['_styk','animation','channels',0,'keys'],reference:['missing']}]}),/not arrived/);
});

test('a large connected timeline exposes compact shared properties and lazy key references',()=>{
  const e=fixture({frames:1000,parts:40});
  const project=buildChannelTimelineTracks(e.layers,e.animationChannels,e.report,new Set(['assembly:1']),{
    figurePoses:true,nativePoseChannel:target=>e.nativePoseChannel(target)});
  const group=project.assemblyByUid.get(1);
  assert.equal(group.children.length,1);assert.equal(group.children[0].kind,'assembly-property');
  assert.equal(group.children[0].property,'pose');assert.ok(project.tracks.every(row=>row.kind!=='figure'));
  assert.equal(group.keys.length,1000);assert.equal(group.keys[0]._blocks.length,1);
  assert.equal(group.keys[0].refs.length,40);
  assert.equal(new Set([...e._nativeAnimationChannels.values()].map(c=>c.keys)).size,1);
});

test('cached native topology agrees with a full rebuild as authored joins appear and disappear',()=>{
  const e=fixture({parts:3}),native=connectedTimelineGroups({...e.report,_styk:{}});
  const frame=structuredClone(e.frame);frame.objects.push({...createObject(e.figure,99,0,0),object_slot:3,join:{target_object_slot:2,target_handle_id:1}});
  e.report._styk.frameSources={new:frame};e.report._styk.animation={channels:[{property:'pose',keys:[{value:{frameId:'new'}}]}]};
  assert.deepEqual(connectedTimelineGroups(e.report,{nativeGroups:native}),connectedTimelineGroups(e.report));
  e.report._styk.animation.channels=[];
  assert.deepEqual(connectedTimelineGroups(e.report,{nativeGroups:native}),native);
});

test('focused projection lazily resolves a connected group without constructing unrelated groups',()=>{
  const e=fixture({parts:4}),groups=connectedTimelineGroups(e.report);
  const project=buildChannelTimelineTracks(e.layers,[],e.report,new Set(),{focused:true,connectedGroups:groups,
    figurePoses:true,nativePoseChannel:target=>e.nativePoseChannel(target)});
  assert.equal(project.assemblyByUid.size,0);assert.equal(e._nativeAnimationChannels,null);
  const group=project.assemblyByUid.get(4);
  assert.equal(group.id,'assembly:1');assert.equal(project.byId.get(group.id),group);
  assert.equal(project.byId.get('assembly:1:pose').kind,'assembly-property');
  assert.equal(project.assemblyByUid.get(1),group);
});
