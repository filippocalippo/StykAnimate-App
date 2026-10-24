import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTask} from 'node:timers/promises';
import {ImportClient} from '../src/import-client.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';

function environment(t,options={}) {
  const workers=[],host=new FakeCodecHost();
  class Worker extends EventTarget {
    constructor(){super();workers.push(this);this.messages=[];}
    postMessage(message){this.messages.push(message);}
    terminate(){this.terminated=true;}
    emit(type,data){const event=new Event(type,{cancelable:true});Object.assign(event,data);this.dispatchEvent(event);}
    complete(result){this.emit('message',{data:{id:this.messages.at(-1).id,ok:true,result}});}
  }
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{value:Worker,configurable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'Worker',descriptor);else delete globalThis.Worker;});
  const client=new ImportClient({baseURL:'http://localhost',timeoutMs:0,codecHost:host,
    readSample:path=>({ok:true,name:path,bytes:new Uint8Array([1,2,3])}),...options});
  t.after(()=>{client.dispose();host.close();});
  // A sample import reaches the worker once the desktop has read the file. (Wrapped: awaiting the import itself would wait for its result.)
  const open=async(name,settings)=>{const pending=client.openSample(name,settings);pending.catch(()=>{});await nextTask();return [pending];};
  return {workers,client,host,open};
}

for(const event of ['error','messageerror'])test(`the next import recovers after a worker ${event}`,async t=>{
  const {client,workers,host,open}=environment(t),[first]=await open('sample.piv');
  workers[0].emit(event,{message:'Worker stopped'});
  await assert.rejects(first,{telemetryCode:event==='error'?'worker_failed':'snapshot_failed'});
  assert.equal(workers[0].terminated,true);assert.equal(client.pending.size,0);
  assert.deepEqual(host.cancelled,[workers[0].messages[0].jobId]);
  const [next]=await open('next.piv');assert.equal(workers.length,2);
  workers[0].emit('error',{message:'Late error from old worker'});
  workers[0].emit('message',{data:{id:2,ok:true,result:{wrong:true}}});
  assert.equal(workers[1].terminated,undefined);
  workers[1].complete({document:{keyframes:[]}});
  assert.deepEqual(await next,{document:{keyframes:[]}});
  assert.equal(workers[0].messages.length,1,'failed work is never silently retried');
  assert.equal(host.cancelled.length,1,'successful replacement work is not cancelled');
});

test('cancelling pending imports cancels each codec job once and rejects stale completion',async t=>{
  const {client,workers,host,open}=environment(t);
  const [first]=await open('a.piv'),[second]=await open('b.piv');
  const ids=workers[0].messages.map(message=>message.jobId);
  assert.equal(new Set(ids).size,2);
  client.cancelPending();client.dispose();
  await assert.rejects(first,{name:'AbortError'});await assert.rejects(second,{name:'AbortError'});
  workers[0].emit('message',{data:{id:1,ok:true,result:{stale:true}}});
  assert.deepEqual(host.cancelled,ids);
  assert.equal(client.pending.size,0);
});

test('a timed-out worker releases all pending work and the next import gets a fresh worker',async t=>{
  const {client,workers,open}=environment(t,{timeoutMs:10});
  await assert.rejects((await open('stalled.piv'))[0],{code:'import_timeout',telemetryStage:'decode'});
  assert.equal(workers[0].terminated,true);assert.equal(client.pending.size,0);
  const [next]=await open('valid.piv');workers[1].complete({ok:true});assert.deepEqual(await next,{ok:true});
});

test('worker rejection preserves diagnostics and does not discard a healthy worker',async t=>{
  const {client,workers,open}=environment(t),[pending]=await open('bad.piv');
  workers[0].emit('message',{data:{id:1,ok:false,error:{message:'Bad file',name:'TypeError',telemetryCode:'invalid_document',telemetryStage:'decode',telemetryFrames:[{module:'import-worker.mjs',line:55}]}}});
  await assert.rejects(pending,error=>error.name==='TypeError'&&error.telemetryCode==='invalid_document'&&error.telemetryFrames[0].line===55);
  const [next]=await open('valid.piv');workers[0].complete({ok:true});
  assert.deepEqual(await next,{ok:true});assert.equal(workers.length,1);
  client.dispose();await assert.rejects(client.openSample('next.piv'),/disposed/);assert.equal(workers.length,1);
});

test('a sample is imported from the bytes the desktop read, under its own name',async t=>{
  const read=[],{workers,open}=environment(t,{readSample:path=>{read.push(path);return {ok:true,name:'sheep.stk',bytes:new Uint8Array([7,8,9]).subarray(1)};}});
  const [pending]=await open('Pivot Animator v5/Figures/sheep.stk',{project:false});
  assert.deepEqual(read,['Pivot Animator v5/Figures/sheep.stk']);
  const message=workers[0].messages[0];
  assert.equal(message.operation,'import');assert.equal(message.filename,'sheep.stk');
  assert.deepEqual([...new Uint8Array(message.bytes)],[8,9],'exactly the file bytes, not the view\'s whole buffer');
  workers[0].complete({ok:true});assert.deepEqual(await pending,{ok:true});
});

test('a sample the desktop refuses fails with the codec service\'s own answer and starts no import',async t=>{
  const {workers,client}=environment(t,{readSample:()=>({ok:false,status:404,code:'file_not_found',error:'This project file no longer exists.'})});
  await assert.rejects(client.openSample('gone.piv',{project:true}),error=>error.message==='This project file no longer exists.'&&error.code==='file_not_found'&&
    error.status===404&&error.telemetryCode==='backend_rejected'&&error.telemetryStage==='request');
  assert.equal(workers[0].messages.length,0);assert.equal(client.sourceOwners.size,0);
});
