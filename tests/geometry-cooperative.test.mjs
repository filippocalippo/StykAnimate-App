import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildGeometry,buildGeometrySteps,buildGeometryAsync} from '../src/pivot/geometry.mjs';
import {geometryFixture,geometrySummary} from './geometry-cooperative-fixture.mjs';

const baseline=JSON.parse(await readFile(new URL('./geometry-cooperative-baseline.json',import.meta.url),'utf8'));
const json=value=>JSON.parse(JSON.stringify(value));
function manyFigures(count=400) {
  const report=geometryFixture(),frame=report.keyframes[0],template=frame.objects[0];
  frame.objects=Array.from({length:count},(_,slot)=>({...structuredClone(template),object_slot:slot,
    unique_id:slot+1,root_x:slot*2,root_y:slot%10,join:null}));
  frame.object_draw_order=Array.from({length:count},(_,index)=>count-index-1);
  return {report,frame};
}

test('sync and cooperative builders preserve all pre-change mixed primitive, legacy and warning fields', async()=>{
  for(const entry of baseline) {
    const report=geometryFixture(entry.options),frame=report.keyframes[0];
    const before=structuredClone(report),sync=buildGeometry(report,frame),steps=[];
    const asyncGeometry=await buildGeometryAsync(report,frame,null,{sliceMs:0,
      yieldControl:()=>Promise.resolve(),onProgress:step=>steps.push(step)});
    assert.deepEqual(json(geometrySummary(sync)),entry.geometry);
    assert.deepEqual(json(geometrySummary(asyncGeometry)),entry.geometry);
    assert.deepEqual(asyncGeometry,sync,'Every returned field and lazy drawable view must agree');
    assert.deepEqual(report,before,'Preparation must not alter the document');
    assert.ok(steps.some(step=>step.stage==='objects'));assert.ok(steps.some(step=>step.stage==='drawables'));
    for(const object of asyncGeometry.objects.values())if(object) {
      assert.equal(object.obj,frame.objects[object.slot]);
      assert.equal(object.fig,report.figure_types[0]);
    }
  }
});

test('incremental preparation retains unaffected references and exact joined descendant geometry',async()=>{
  const report=geometryFixture(),frame=report.keyframes[0],initial=buildGeometry(report,frame),baseline=json(geometrySummary(initial));
  frame.objects[0].root_x+=13;frame.objects[1].angles[0]-=.4;
  const incremental={previous:initial,dirtySlots:[0,1,2]},sync=buildGeometry(report,frame,incremental);
  const prepared=await buildGeometryAsync(report,frame,incremental,{sliceMs:0,yieldControl:()=>Promise.resolve()});
  assert.deepEqual(prepared,sync);assert.deepEqual(prepared.drawables,buildGeometry(report,frame).drawables);
  assert.equal(prepared.objects.get(3),initial.objects.get(3));assert.notEqual(prepared.objects.get(0),initial.objects.get(0));
  assert.equal(prepared.previousToken,initial.token);assert.notEqual(prepared.token,initial.token);
  assert.deepEqual([...prepared.changedSlots],[0,1,2]);assert.equal(prepared.previous,undefined);
  // The original source object references intentionally observe the caller's
  // edits, but completed geometric coordinates in the previous cache stay fixed.
  assert.deepEqual(initial.objects.get(0).root,baseline.objects.find(([slot])=>slot===0)[1].root);
  assert.deepEqual(initial.objects.get(1).joints.get(2),baseline.objects.find(([slot])=>slot===1)[1].joints.find(([id])=>id===2)[1]);
});

test('many-figure preparation yields between private units and reports measured task durations',async()=>{
  const {report,frame}=manyFigures();let yields=0,timing;const progress=[];
  const geometry=await buildGeometryAsync(report,frame,null,{sliceMs:0,yieldControl:()=>{yields++;return Promise.resolve();},
    onProgress:step=>progress.push(step),onTiming:value=>{timing=value;}});
  assert.equal(geometry.objects.size,400);assert.equal(geometry.orderedObjects.length,400);
  assert.deepEqual(geometry.orderedObjects.map(object=>object.slot),frame.object_draw_order);
  assert.ok(yields>=800);assert.equal(timing.yields,yields);assert.equal(progress.length,yields);
  assert.equal(timing.completed,true);assert.ok(timing.steps>yields);assert.ok(timing.slices>0);
  for(const key of ['elapsedMs','cpuMs','maxTaskMs'])assert.ok(Number.isFinite(timing[key])&&timing[key]>=0);
  assert.ok(timing.maxTaskMs<=timing.cpuMs);assert.ok(progress.every(step=>step.phase==='geometry'));
});

test('abort and supersession stop unpublished work and close the generator',async()=>{
  const {report,frame}=manyFigures(),before=structuredClone(report),controller=new AbortController();
  let yields=0,timing;
  await assert.rejects(buildGeometryAsync(report,frame,null,{sliceMs:0,signal:controller.signal,
    yieldControl:()=>{if(++yields===3)controller.abort();return Promise.resolve();},onTiming:value=>{timing=value;}}),{name:'AbortError'});
  assert.equal(yields,3);assert.equal(timing.completed,false);assert.ok(timing.steps<frame.objects.length);
  assert.deepEqual(report,before);
  let current=true;
  await assert.rejects(buildGeometryAsync(report,frame,null,{sliceMs:0,checkCurrent:()=>current,
    yieldControl:()=>{current=false;return Promise.resolve();}}),{name:'AbortError'});
  assert.deepEqual(report,before);
  const iterator=buildGeometrySteps(report,frame);assert.equal(iterator.next().done,false);
  iterator.return();assert.equal(iterator.next().done,true);
});

test('early abort, scheduler failure and invalid slice options cannot publish geometry',async()=>{
  const controller=new AbortController();controller.abort();let reads=0;
  const unread=new Proxy({}, {get(){reads++;throw new Error('Aborted work must not read scene data');}});
  await assert.rejects(buildGeometryAsync(unread,unread,null,{signal:controller.signal}),{name:'AbortError'});assert.equal(reads,0);
  const report=geometryFixture(),frame=report.keyframes[0];let timing;
  await assert.rejects(buildGeometryAsync(report,frame,null,{sliceMs:0,yieldControl:()=>Promise.reject(new Error('scheduler stopped')),
    onTiming:value=>{timing=value;}}),/scheduler stopped/);assert.equal(timing.completed,false);
  for(const sliceMs of [-1,NaN,Infinity])await assert.rejects(buildGeometryAsync(report,frame,null,{sliceMs}),/slice duration/);
});
