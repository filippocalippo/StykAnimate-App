import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackGeometryCache} from '../src/playback-geometry-cache.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {createDemo} from '../src/demo.mjs';
const drawing=g=>JSON.parse(JSON.stringify(g.drawables,(key,value)=>key==='record_offset'||key==='record_end'?undefined:value));
const exact=(cache,report,frame,revision=1)=>{const g=cache.get(report,frame,revision),fresh=buildGeometry(report,frame);assert.deepEqual(drawing(g),drawing(fresh));assert.deepEqual(g.warnings,fresh.warnings);return g;};

test('worker geometry reuses equal native objects across wire metadata and painter-order changes',()=>{
  const report=createDemo(),cache=new PlaybackGeometryCache(),a=exact(cache,report,report.keyframes[0]);
  const next=structuredClone(report.keyframes[0]);next.objects.forEach(o=>{o.record_offset=1234;o.record_end=4567;});next.object_draw_order.reverse();
  next.objects.forEach(o=>{o.runtime_segments=undefined;});
  const b=exact(cache,report,next);assert.equal(cache.reusedObjects,3);
  for(const [slot,g] of a.objects)assert.equal(b.objects.get(slot),g);
});

test('fractional pose changes rebuild affected objects and joined descendants only',()=>{
  const report=createDemo(),cache=new PlaybackGeometryCache(),frame=structuredClone(report.keyframes[0]);
  frame.objects[2].join={target_object_slot:0,target_segment_id:1};const a=exact(cache,report,frame);
  const next=structuredClone(frame);next.objects[0].root_x+=.000000001;next.objects[0].angles[0]+=.13;
  const b=exact(cache,report,next);assert.equal(b.objects.get(1),a.objects.get(1));assert.notEqual(b.objects.get(2),a.objects.get(2));
  assert.equal(cache.reusedObjects,1);
});

test('membership changes retain survivors while definition revisions and replacement discard the baseline',()=>{
  const report=createDemo(),cache=new PlaybackGeometryCache();exact(cache,report,report.keyframes[0]);
  const next=structuredClone(report.keyframes[0]);next.objects.pop();next.object_draw_order.pop();next.object_draw_order_unique_ids.pop();
  assert.equal(exact(cache,report,next).objects.size,2);assert.equal(cache.reusedObjects,2);
  report.figure_types[0].segments[0].thickness+=5;exact(cache,report,next,2);assert.equal(cache.reusedObjects,0);
  const replacement=structuredClone(report);exact(cache,replacement,replacement.keyframes[0],2);assert.equal(cache.reusedObjects,0);
  cache.clear();exact(cache,replacement,replacement.keyframes[0],2);assert.equal(cache.reusedObjects,0);
});

test('alternating exact poses reuse independent objects and joined descendants with matching anchors',()=>{
  const report=createDemo(),cache=new PlaybackGeometryCache(),a=structuredClone(report.keyframes[0]);
  a.objects[2].join={target_object_slot:0,target_handle_id:1};
  const first=exact(cache,report,a),b=structuredClone(a);b.objects[0].angles[0]+=.01;
  const second=exact(cache,report,b);assert.notEqual(first.objects.get(0),second.objects.get(0));
  const restored=exact(cache,report,a);assert.equal(restored.objects.get(0),first.objects.get(0));assert.notEqual(restored.objects.get(2),second.objects.get(2));
  assert.strictEqual(restored.objects.get(2),first.objects.get(2));
  assert.ok(restored.changedSlots.has(0));assert.ok(restored.changedSlots.has(2));
  const repeated=exact(cache,report,b);assert.equal(repeated.objects.get(0),second.objects.get(0));
  cache.retainRevision(2);const edited=structuredClone(b);edited.objects[1].root_x+=3;
  assert.equal(exact(cache,report,edited,2).objects.get(0),second.objects.get(0));
});

test('insertions, deletion, and slot remapping retain exact joined geometry and reusable artwork',()=>{
  const report=createDemo(),cache=new PlaybackGeometryCache(),frame=structuredClone(report.keyframes[0]);
  frame.objects[2].join={target_object_slot:0,target_handle_id:1};
  const initial=exact(cache,report,frame);
  const next=structuredClone(frame),extra=structuredClone(next.objects[1]);extra.unique_id=900;extra.object_slot=0;
  next.objects.unshift(extra);
  next.objects.forEach((object,slot)=>{object.object_slot=slot;if(object.join)object.join.target_object_slot++;});
  next.object_draw_order=next.objects.map((_,i)=>i);next.object_draw_order_unique_ids=next.objects.map(o=>o.unique_id);
  const added=exact(cache,report,next);assert.equal(cache.reusedObjects,3);
  assert.strictEqual(added.objects.get(1).renderSource,initial.objects.get(0));
  assert.strictEqual(added.objects.get(3).joints,initial.objects.get(2).joints);
  const restored=exact(cache,report,frame);assert.equal(cache.reusedObjects,3);
  assert.deepEqual(restored.objects.get(2).root,initial.objects.get(2).root);
});

test('alternate object residency is bounded and eviction cannot change geometry',()=>{
  const report=createDemo(),cache=new PlaybackGeometryCache({maxAlternateDrawables:20,maxAlternates:1}),a=structuredClone(report.keyframes[0]);
  exact(cache,report,a);const b=structuredClone(a);for(const o of b.objects)o.root_x+=1;
  exact(cache,report,b);assert.ok(cache.alternateDrawables<=20);assert.ok(cache.alternates.size<=1);
  exact(cache,report,a);assert.ok(cache.alternateDrawables<=20);assert.ok(cache.alternates.size<=1);
});
