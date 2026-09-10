import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument,createFrame,createObject} from '../src/demo.mjs';
import {packPoseSequences,expandPoseSequencesSteps} from '../src/pose-sequence-storage.mjs';
import {snapshotPoseFrame} from '../src/pose-snapshot.mjs';
import {buildGeometry,buildGeometrySteps,evaluatedFrame,evaluatedNativeFrame} from '../src/pivot/geometry.mjs';
import {projectNativePropertyChannel} from '../src/native-property-projection.mjs';
import {ArtworkRegistry} from '../src/render-artwork.mjs';
import {compileVectorObject,compileVectorObjectSteps} from '../src/renderer-geometry.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {buildChannelTimelineTracks} from './helpers/legacy-timeline-projection.mjs';
import {ThumbnailRenderer} from '../src/thumbnail-renderer.mjs';

function fixture(frames=12,parts=8) {
  const report=emptyDocument(),figure=report.figure_types[0];
  report.keyframes=Array.from({length:frames},(_,i)=>createFrame(Array.from({length:parts},(_,slot)=>
    createObject(figure,slot+1,i*2+slot*10,100,{join:slot===1?{target_object_slot:0,target_handle_id:1}:null})),3));
  return new Editor({demo:false,propertyChannels:true}).load(report);
}
const complete = iterator => {let result;do{result=iterator.next();}while(!result.done);return result.value;};

test('compact pose storage round trips aliases, unknown fields and independent edits without mutating live data',()=>{
  const e=fixture(200,40);e.select(1);e.beginTranslationDrag();e.moveSelection(4,3);e.commitDrag();
  const animation=e.report._styk.animation,keys=animation.channels[0].keys;
  // Reproduce a large shared rig without increasing native fixture geometry.
  animation.channels=Array.from({length:40},(_,i)=>({...animation.channels[0],id:`figure:${i+1}:pose`,target:{kind:'figure',uid:i+1}}));
  const before=JSON.stringify(e.report),packed=packPoseSequences(e.report),text=JSON.stringify(packed);
  assert.equal(packed._styk.animation.version,2);assert.equal(packed._styk.animation.poseSequences.length,1);
  assert.equal(e.report._styk.animation.version,1);assert.equal(JSON.stringify(e.report),before);
  assert.ok(JSON.stringify(packed._styk.animation).length < JSON.stringify(animation).length/15);
  const reopened=new Editor({demo:false,propertyChannels:true}).load(JSON.parse(text));
  assert.deepEqual(reopened.report._styk.animation,animation);
  assert.equal(new Set(reopened.animationChannels.map(c=>c.keys)).size,1);
  const first=reopened.animationChannels[0];reopened.setAnimationKey(first.id,first.keys[0].id,{interpolation:'hold'});
  assert.notEqual(reopened.animationChannels[0].keys,reopened.animationChannels[1].keys);
  assert.deepEqual(e.animationChannels[0].keys,keys);
});

test('stored pose references reject corruption atomically and old array documents remain unchanged',()=>{
  for(const reference of [{sequence:-1},{sequence:1},{sequence:.2},{sequence:0,extra:true},[]]){
    const animation={version:2,poseSequences:[[]],channels:[{property:'pose',keys:reference}]},report={_styk:{animation}},before=structuredClone(animation);
    assert.throws(()=>complete(expandPoseSequencesSteps(report)),/reference/);assert.deepEqual(animation,before);
  }
  const old={_styk:{animation:{version:1,channels:[]}}};const animation=old._styk.animation;
  complete(expandPoseSequencesSteps(old));assert.equal(old._styk.animation,animation);
  const keys=[{id:'a',tick:0,value:{frameId:null}}],animation2={version:1,channels:[{property:'pose',keys}]};
  const nested={_styk:{animation:animation2},figure_types:[]};
  const parent={_styk:{simpleFrameDraft:{animationBaseline:animation2}},figure_types:[{_styk:{movieclip:{document:nested}}}]};
  const packed=packPoseSequences(parent);assert.equal(packed._styk.simpleFrameDraft.animationBaseline.version,2);
  assert.equal(packed.figure_types[0]._styk.movieclip.document._styk.animation.version,2);
  assert.equal(nested._styk.animation.version,1);
});

test('scoped pose snapshots preserve ancestor geometry and paint order with independent records',()=>{
  const e=fixture(),frame=e.frame;frame.object_draw_order=[7,1,0,3,4,5,6,2];
  frame.objects[0].unknown={nested:[1,2]};
  Object.defineProperty(frame.objects[7],'runtime_segments',{enumerable:true,get(){throw Error('Unrelated geometry visited');}});
  const captured=snapshotPoseFrame(frame,new Set([2])),before=buildGeometry(e.report,{...frame,objects:frame.objects.slice(0,2)});
  assert.deepEqual(captured.objects.map(o=>o.unique_id),[1,2]);assert.deepEqual(captured.object_draw_order,[1,0]);
  const after=buildGeometry(e.report,captured);
  assert.deepEqual(after.objects.get(1).root,before.objects.get(1).root);
  assert.deepEqual(after.objects.get(1).joints,before.objects.get(1).joints);
  captured.objects[0].unknown.nested.push(3);assert.deepEqual(frame.objects[0].unknown.nested,[1,2]);
  const remapped=snapshotPoseFrame(frame,new Set([4]));assert.equal(remapped.objects[0].object_slot,0);
});

test('scoped native interpolation evaluates requested objects and both endpoint ancestor chains exactly',()=>{
  const e=fixture(),r=e.report; r.keyframes[1].objects[1].join={target_object_slot:2,target_handle_id:1};
  for(const fraction of [.1,.5,.9]){
    const scoped=evaluatedNativeFrame(r,0,fraction,undefined,new Set([2])),full=evaluatedNativeFrame(r,0,fraction);
    for(const slot of [0,1,2])assert.deepEqual(scoped.objects[slot],full.objects[slot]);
    assert.equal(scoped.objects[7],r.keyframes[0].objects[7]);
    assert.deepEqual(buildGeometry(r,scoped).objects.get(1).joints,buildGeometry(r,full).objects.get(1).joints);
  }
});

test('attached coordinate projection shares X/Y history evaluations and invalidates after an edit',()=>{
  const e=fixture(200,100),target={kind:'figure',uid:2};let calls=0;
  const evaluate=tick=>{calls++;return evaluatedFrame(e.report,Math.floor(tick/3),0,tick);};
  const x=projectNativePropertyChannel(e,target,'x',{},evaluate),first=calls;
  const y=projectNativePropertyChannel(e,target,'y',{},evaluate);
  assert.equal(first,200);assert.equal(calls,200,'Y must reuse the coordinates computed for X even beyond the 64-frame LRU.');
  for(const i of [0,65,199]){const root=buildGeometry(e.report,e.report.keyframes[i]).objects.get(1).root;
    assert.equal(x.keys[i].value,root.x);assert.equal(y.keys[i].value,root.y);}
  e.addAnimationKey({kind:'figure',uid:1},'x',0,400);
  const changed=projectNativePropertyChannel(e,target,'x',{},evaluate);
  assert.notEqual(changed.keys[0].value,x.keys[0].value);assert.ok(calls>200);
});

test('dense single figures yield inside geometry, artwork signatures and GPU vector compilation without changing output',()=>{
  const e=fixture(1,1),figure=e.report.figure_types[0],template=figure.segments[0];
  figure.segments=Array.from({length:1024},(_,i)=>({...template,segment_id:i+1,parent_id:0,z_order:i}));
  figure.segment_count=figure.segments.length;e.frame.objects[0].angles=figure.segments.map(s=>s.angle_rad);
  const steps=buildGeometrySteps(e.report,e.frame);let result,progress=[];
  do{result=steps.next();if(!result.done)progress.push(result.value);}while(!result.done);
  const geometry=result.value,full=buildGeometry(e.report,e.frame);assert.deepEqual(geometry,full);
  assert.ok(progress.length>5);
  const g=geometry.objects.get(0),items=g.drawables??g.segments,registry=new ArtworkRegistry();
  const signature=registry.getSteps(g,items);let yields=0;
  do{result=signature.next();if(!result.done)yields++;}while(!result.done);
  assert.ok(yields>=7);assert.equal(registry.get(g,items),result.value);
  const vectors=compileVectorObjectSteps(items,g.root);yields=0;
  do{result=vectors.next();if(!result.done)yields++;}while(!result.done);
  assert.ok(yields>=8);assert.deepEqual(result.value,compileVectorObject(items,g.root));
  let reads=0;Object.defineProperty(figure,'revisionProbe',{enumerable:true,get(){reads++;return true;}});
  registry.begin(1);registry.definition(figure);registry.begin(1);registry.definition(figure);assert.equal(reads,1);
  registry.begin(2);registry.definition(figure);assert.equal(reads,2);
});

test('playback document transfer yields to an active gesture and resumes every waiting sender',async()=>{
  const cache=Object.create(PlaybackCache.prototype);cache.setInteractionActive(true);
  let completed=0;const tasks=[cache._yieldLoad().then(()=>completed++),cache._yieldLoad().then(()=>completed++)];
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(completed,0);
  cache.setInteractionActive(false);await Promise.all(tasks);assert.equal(completed,2);
});

test('Simple pose undo identifies its changed native frame and retains thumbnail patches',()=>{
  const e=new Editor({demo:false}).load(fixture().report);e.enableFrameDrafts({mode:'update'});e.select(1);
  const thumbnails=new ThumbnailRenderer(e);thumbnails.fullSnapshot=false;thumbnails.loadedVersion=1;
  const events=[];e.addEventListener('change',event=>{if(event.detail.kind==='history')events.push(event.detail);});
  e.beginDrag();e.moveSelection(10,2);e.commitDrag();e.undo();
  assert.deepEqual(events.at(-1).frameIndices,[0]);assert.equal(thumbnails.fullSnapshot,false);
  assert.deepEqual([...thumbnails.changedFrames],[0]);thumbnails.destroy();
});


