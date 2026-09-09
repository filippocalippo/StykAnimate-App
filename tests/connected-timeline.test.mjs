import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {Timeline, buildChannelTimelineTracks} from '../src/timeline.mjs';
import {connectedTimelineGroups} from '../src/connected-timeline.mjs';

function fixture() {
  const editor = new Editor({demo:false}); editor.addFigure(); const root = editor.selectedUid;
  editor.duplicateFigure(); const child = editor.selectedUid; editor.joinTo(root, 4);
  editor.duplicateFrame(); editor.select(root); editor.moveSelection(20,0); editor.commitDrag();
  editor.addAnimationKey({kind:'figure',uid:child},'rotation',4,0.2);
  const descriptors = new Map(editor.animationChannels.map(c=>[c.id,c]));
  const project = () => buildChannelTimelineTracks(editor.layers,editor.animationChannels,editor.report,new Set(),{
    figurePoses:true,nativePoseChannel:target=>{const c=editor.nativePoseChannel(target);descriptors.set(c.id,c);return c;},
  });
  const p = project(), group = p.assemblyByUid.get(root); group.keys;
  const t = Object.assign(Object.create(Timeline.prototype), {editor,trackById:p.byId,assemblyByUid:p.assemblyByUid,
    _channelDescriptors:descriptors,selectedTrackId:group.id,_animationSelection:new Map(),update(){},_schedule(){},_updateToolbar(){}});
  return {editor,root,child,group,t,project};
}

test('connected assembly aggregates poses and offset property keys across separate layers',()=>{
  const {editor,root,child,group,project} = fixture();
  editor.createLayer(); editor.assignFiguresToLayer([child],editor.activeLayerId);
  const p=project(), g=p.assemblyByUid.get(root);
  assert.equal(g,p.assemblyByUid.get(child)); assert.equal(g.kind,'assembly');
  assert.equal(p.tracks.filter(t=>t.kind==='assembly').length,1);
  assert.equal(p.tracks.filter(t=>t.kind==='figure').length,0);
  assert.ok(g.keys.some(key=>key.tick===4));
  assert.ok(g.keys.some(key=>key.refs.filter(ref=>ref.channelId.endsWith(':pose')).length===2));
  editor.seek(0); assert.deepEqual(connectedTimelineGroups(editor.report)[0].figureUids,group.figureUids);
});

test('moving and deleting a group keeps all member keys together and undo is atomic',()=>{
  const {editor,group,t}=fixture(), before=editor.serialize();
  t._setAnimationSelection(group.keys.flatMap(key=>key.refs));
  const old=t._channelSelectionRecords().map(({channel,key})=>[channel.id,key.id,key.tick]);
  t._moveTrackKeys(6);
  for(const [id,keyId,tick] of old) assert.equal(editor.animationChannels.find(c=>c.id===id).keys.find(k=>k.id===keyId).tick,tick+6);
  editor.undo(); assert.deepEqual(editor.serialize(),before);
  editor.redo(); t.deleteTrackKeys(); assert.ok(editor.animationChannels.every(c=>!c.keys.length));
  editor.undo(); assert.ok(editor.animationChannels.some(c=>c.keys.length));
});

test('group collision or a locked member cannot produce a partial move',()=>{
  const {editor,group,t,child}=fixture();
  t._setAnimationSelection(group.keys.filter(k=>k.tick===0).flatMap(k=>k.refs));
  const next=group.keys.find(k=>k.tick>0&&k.refs.some(r=>r.channelId.endsWith(':pose')));
  const before=editor.serialize(); assert.throws(()=>t._moveTrackKeys(next.tick),/same|already|collision|occup/i); assert.deepEqual(editor.serialize(),before);
  editor.setLayerLocked(editor.layerForUid(child),true);
  assert.throws(()=>t._moveTrackKeys(20),/Unlock/);
});

test('timing scale preserves offsets across parts, rejects collisions and undoes in one step',()=>{
  const {editor,group,t}=fixture(); t._setAnimationSelection(group.keys.flatMap(k=>k.refs));
  const old=t._channelSelectionRecords().map(({channel,key})=>[channel.id,key.id,key.tick]),before=editor.serialize();
  editor.scaleAnimationKeys(t.selectedAnimationKeys,2,0);
  for(const [id,keyId,tick] of old) assert.equal(editor.animationChannels.find(c=>c.id===id).keys.find(k=>k.id===keyId).tick,tick*2);
  editor.undo(); assert.deepEqual(editor.serialize(),before);
  assert.throws(()=>editor.scaleAnimationKeys(t.selectedAnimationKeys,0.001,0),/same|already|collision|occup/i);
  assert.deepEqual(editor.serialize(),before);
});

test('group clipboard preserves offset keys, rejects occupied destinations and respects locks',()=>{
  const {editor,group,t}=fixture(); t._setAnimationSelection(group.keys.flatMap(k=>k.refs));
  t.copyTrackKeys(); const offsets=t._keyClipboard.entries.map(entry=>entry.tick),before=editor.serialize();
  editor.seek(20,{allowBeyondEnd:true}); t.pasteTrackKeys();
  for(const [i,entry] of t._keyClipboard.entries.entries()) {
    const channel=editor.animationChannel(entry.target,entry.property);
    assert.ok(channel.keys.some(key=>key.tick===20+offsets[i]));
  }
  editor.undo(); assert.deepEqual(editor.serialize(),before);
  editor.seek(0); assert.throws(()=>t.pasteTrackKeys(),/Destination occupied/);
  assert.deepEqual(editor.serialize(),before);
});

test('animated attachments group across poses but unused source snapshots cannot create phantom groups',()=>{
  const objects=[{unique_id:1,object_slot:0},{unique_id:2,object_slot:1,join:{target_object_slot:0}}];
  const report={keyframes:[{objects:objects.map(o=>({...o,join:null}))}],_styk:{frameSources:{pickup:{objects}}}};
  assert.deepEqual(connectedTimelineGroups(report),[]);
  report._styk.animation={channels:[{property:'pose',keys:[{value:{frameId:'pickup'}}]}]};
  assert.deepEqual(connectedTimelineGroups(report)[0].figureUids,[1,2]);
});
