import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {connectedTimelineGroups} from '../src/connected-timeline.mjs';
import {buildChannelTimelineTracks} from './helpers/legacy-timeline-projection.mjs';
import {authoredKeyTimes} from './helpers/legacy-key-times.mjs';

function fixture({connected=false}={}) {
  const report=emptyDocument(),figure=report.figure_types[0];figure.name='Fig 107';
  report.keyframes=[0,10,20].map(x=>createFrame([
    createObject(figure,1,x,200),
    ...(connected?[createObject(figure,2,x,200,{join:{target_object_slot:0,target_unique_id:1,target_handle_id:1}})]:[]),
  ],10));
  return new Editor({demo:false,propertyChannels:true}).load(report);
}
const projection=e=>buildChannelTimelineTracks(e.layers,e.animationChannels,e.report,new Set(),{figurePoses:true,nativePoseChannel:t=>e.nativePoseChannel(t)});
const pose=(e,tick)=>{e.seek(tick);return e.evaluatedFrame.objects.map(o=>({uid:o.unique_id,x:o.root_x,join:o.join}));};

for(const connected of [false,true])test(`inserting and moving ${connected?'connected':'single'} poses preserves IDs and interpolates both sides`,()=>{
  const e=fixture({connected}),uids=e.frame.objects.map(o=>o.unique_id),before=e.serialize();
  for(const uid of uids)e.nativePoseChannel({kind:'figure',uid});
  e.addAnimationKeys(uids.map(uid=>({target:{kind:'figure',uid},property:'pose',tick:5})));
  assert.equal(pose(e,7)[0].x,7);
  const selection=e.animationChannels.map(c=>({channelId:c.id,keyIds:[c.keys.find(k=>k.tick===5).id]}));
  e.moveAnimationKeys(selection,3);
  assert.equal(pose(e,4)[0].x,2.5);
  assert.equal(pose(e,9)[0].x,7.5);
  for(let tick=0;tick<30;tick++)assert.deepEqual(pose(e,tick).map(o=>o.uid),uids);
  const reopened=new Editor({demo:false,propertyChannels:true}).load(e.serialize());
  assert.deepEqual(pose(reopened,9),pose(e,9));
  e.undo();e.undo();assert.deepEqual(e.serialize().keyframes,before.keyframes);assert.equal(e.animationChannels.length,0);
  for(let tick=0;tick<=20;tick++)assert.equal(pose(e,tick)[0].x,tick);
});

test('new pose keys inherit deliberate Constant and Bezier easing',()=>{
  for(const easing of [{interpolation:'constant'},{interpolation:'bezier',bezier:[.1,.2,.8,.9]}]){
    const e=fixture(),target={kind:'figure',uid:1},c=e.nativePoseChannel(target);
    e.setAnimationKeysEasing([{channelId:c.id,keyIds:[c.keys[0].id]}],easing);
    const key=e.addAnimationKey(target,'pose',5);
    assert.equal(key.interpolation,easing.interpolation);
    if(easing.bezier)assert.deepEqual(key.bezier,easing.bezier);
  }
});

test('figure markers describe its own lifetime and do not advertise absent poses',()=>{
  const e=fixture(),report=e.serialize(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:7},(_,i)=>createFrame(i>=2&&i<=3?[createObject(figure,1,i*10,200)]:[],10));
  e.load(report);const target={kind:'figure',uid:1},c=e.nativePoseChannel(target);
  assert.deepEqual(c.keys.map(k=>[k.tick,k.value.frameId===null]),[[0,true],[20,false],[30,false],[40,true]]);
  const before=Array.from({length:70},(_,i)=>pose(e,i));e.adoptNativePoseTrack(target);
  assert.deepEqual(Array.from({length:70},(_,i)=>pose(e,i)),before);
  assert.deepEqual(projection(e).byId.get('figure:1').keys.map(k=>k.tick),[0,20,30,40]);
});

test('new figures invalidate cached native lifetime projections without a timing change',()=>{
  const e=new Editor({demo:false,propertyChannels:true});e.addFigure();
  e.nativePoseChannel({kind:'figure',uid:e.selectedUid});
  e.addFigure();const uid=e.selectedUid;
  assert.equal(e.nativePoseChannel({kind:'figure',uid}).keys.length,1);
  e.undo();assert.equal(e.nativePoseChannel({kind:'figure',uid}).keys.length,0);
  e.redo();assert.equal(e.nativePoseChannel({kind:'figure',uid}).keys.length,1);
});

test('only authoritative pose owners contribute attachment membership',()=>{
  const e=fixture({connected:true}),report=e.report,groups=connectedTimelineGroups(report);
  const stale=structuredClone(report.keyframes[0]);stale.objects[1].join=null;
  const staleId=e.captureFrameSource(stale);
  e.nativePoseChannel({kind:'figure',uid:1});
  e.addAnimationKey({kind:'figure',uid:1},'pose',5,{frameId:staleId});
  assert.deepEqual(connectedTimelineGroups(report,{nativeGroups:groups}).map(g=>g.figureUids),[[1,2]],'A root snapshot cannot override the child attachment');
  e.nativePoseChannel({kind:'figure',uid:2});e.addAnimationKey({kind:'figure',uid:2},'pose',5,{frameId:staleId});
  assert.deepEqual(connectedTimelineGroups(report,{nativeGroups:groups}),[],'A real detach remains independently addressable');
});

test('authoring attachments can replace stale native grouping and same-name instances remain distinguishable',()=>{
  const e=fixture(),r=e.serialize(),figure=r.figure_types[0];
  r.keyframes.forEach(f=>{f.objects.push(createObject(figure,2,100,200));f.objects[1].object_slot=1;f.object_draw_order=[0,1];f.object_draw_order_unique_ids=[1,2];});
  e.load(r);const native=connectedTimelineGroups(e.report),p=projection(e);
  assert.notEqual(p.byId.get('figure:1').name,p.byId.get('figure:2').name);
  const joined=structuredClone(e.frame);joined.objects[1].join={target_object_slot:0,target_unique_id:1,target_handle_id:1};
  const id=e.captureFrameSource(joined);
  e.addAnimationKey({kind:'figure',uid:2},'pose',0,{frameId:id});
  assert.deepEqual(connectedTimelineGroups(e.report,{nativeGroups:native}).map(g=>g.figureUids),[[1,2]]);
});

test('retiming a temporary attachment follows the parent at the new time without duplicating either owner',()=>{
  const e=fixture(),r=e.serialize(),figure=r.figure_types[0];
  r.keyframes.forEach(f=>{f.objects.push(createObject(figure,2,300,200));f.objects[1].object_slot=1;f.object_draw_order=[0,1];f.object_draw_order_unique_ids=[1,2];});
  e.load(r);e.nativePoseChannel({kind:'figure',uid:1});e.addAnimationKey({kind:'figure',uid:1},'pose',5);
  e.seek(10);e.select(2);e.joinTo(1,1);
  const c=e.nativePoseChannel({kind:'figure',uid:2});
  e.moveAnimationKeys([{channelId:c.id,keyIds:[c.keys.find(k=>k.tick===10).id]}],5);
  for(const tick of [0,9,10,14,15,19,20]){
    e.seek(tick);const objects=e.evaluatedFrame.objects;
    assert.deepEqual(objects.map(o=>o.unique_id).sort(),[1,2]);
    const parent=objects.find(o=>o.unique_id===1),child=objects.find(o=>o.unique_id===2);
    assert.equal(Boolean(child.join),tick>=15&&tick<20);
    if(child.join)assert.deepEqual(e.geometry.objects.get(child.object_slot).root,e.geometry.objects.get(parent.object_slot).joints.get(1));
  }
  e.undo();e.seek(10);assert.ok(e.evaluatedFrame.objects.find(o=>o.unique_id===2).join);
  e.undo();e.seek(10);assert.equal(e.evaluatedFrame.objects.find(o=>o.unique_id===2).join,null);
});

test('Simple navigation uses all distinct authored times, ignores hidden keys and refreshes after retiming',()=>{
  const e=fixture(),target={kind:'figure',uid:1};e.nativePoseChannel(target);e.addAnimationKey(target,'pose',5);
  e.addAnimationKey(target,'scale',7,2);
  const before=authoredKeyTimes(e.animationChannels);assert.ok(before.includes(5)&&before.includes(7));
  const c=e.animationChannel(target,'pose'),key=c.keys.find(k=>k.tick===5);
  e.moveAnimationKeys([{channelId:c.id,keyIds:[key.id]}],3);
  const after=authoredKeyTimes(e.animationChannels);assert.ok(!after.includes(5)&&after.includes(7)&&after.includes(8));
  const shared=[{tick:4},{tick:6,hidden:true}];
  assert.deepEqual(authoredKeyTimes([{keys:shared},{keys:shared},{keys:[{tick:4},{tick:2}]}]),[2,4]);
});
