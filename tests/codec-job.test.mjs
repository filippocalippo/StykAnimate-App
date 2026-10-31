import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {codecJob} from '../src/codec-job.mjs';
import {DocumentExporter} from '../src/document-export.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {createDemo} from '../src/demo.mjs';

/** A document the engine owns: a .styk save is written from the snapshot of its session. */
const project=()=>ownedEditorFor({demo:false},createDemo()).report;

async function until(check){const deadline=Date.now()+5000;while(!check()){if(Date.now()>deadline)throw new Error('Worker did not reach export');await delay(5);}}

test('a codec job cancels once with its private identity, and a finished job never cancels',t=>{
  const host=new FakeCodecHost();t.after(()=>host.close());
  const job=codecJob({host});
  assert.match(job.id,/^[a-f0-9]{32}$/);
  assert.ok(job.link().fields.codecPort instanceof MessagePort);
  job.cancel();job.cancel();job.finish();
  assert.deepEqual(host.cancelled,[job.id]);
  assert.deepEqual(host.events.filter(([type])=>type==='release'),[],'a cancelled job has nothing left to release');
  const completed=codecJob({host});completed.finish();completed.cancel();
  assert.deepEqual(host.cancelled,[job.id]);
  assert.deepEqual(host.events.at(-1),['release',completed.id]);
});

function exporter(t,onExport,options={}){
  const workers=[],host=new FakeCodecHost();
  class Worker extends EventTarget{
    constructor(){super();this.messages=[];workers.push(this);}
    postMessage(message){
      this.messages.push(message);
      queueMicrotask(()=>{
        if(message.operation==='export'){onExport(this,message);return;}
        this.reply(message,{ok:true});
      });
    }
    reply(message,result){this.dispatchEvent(new MessageEvent('message',{data:{id:message.id,...result}}));}
    terminate(){this.terminated=true;}
  }
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{value:Worker,configurable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'Worker',descriptor);else delete globalThis.Worker;});
  const owner=new DocumentExporter({codecHost:host,timeoutMs:0,engine:{join:{}},...options});
  t.after(()=>{owner.dispose();host.close();});return {owner,workers,host};
}

test('terminating a busy document worker still cancels its codec job',async t=>{
  const {owner,workers,host}=exporter(t,()=>{}),controller=new AbortController();
  const pending=owner.export(project(),{format:'styk',signal:controller.signal});
  pending.catch(()=>{});
  await until(()=>workers[0]?.messages.some(message=>message.operation==='export'));
  controller.abort();await assert.rejects(pending,{name:'AbortError'});owner.dispose();
  // The worker joined the engine: it is told to give its thread back, and ended once it has.
  assert.ok(workers[0].messages.some(message=>message.operation==='release'));
  workers[0].dispatchEvent(new MessageEvent('message',{data:{released:true}}));
  assert.equal(workers[0].terminated,true);
  assert.deepEqual(host.cancelled,[workers[0].messages[0].options.jobId]);
  assert.equal(owner.jobs.size,0);
});

test('a worker that joined the engine stops its work and gives its thread back before it ends',async t=>{
  const engine={join:{},handle:{address:()=>1,try_document_identity:()=>[0,0,7]}};
  const {owner,workers,host}=exporter(t,()=>{},{engine}),controller=new AbortController();
  const pending=owner.export({figure_types:[],keyframes:[]},{format:'piv',revision:7,signal:controller.signal});
  pending.catch(()=>{});
  await until(()=>workers[0]?.messages.some(message=>message.operation==='export'));
  const request=workers[0].messages.find(message=>message.operation==='export');
  assert.deepEqual(request.engine,{address:1,revision:7});
  assert.equal(Atomics.load(request.cancel,0),0);
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(Atomics.load(request.cancel,0),1,'the work in the engine is told to stop');
  assert.ok(workers[0].messages.some(message=>message.operation==='release'));
  assert.equal(workers[0].terminated,undefined,'a thread inside the engine is not ended mid-call');
  workers[0].dispatchEvent(new MessageEvent('message',{data:{released:true}}));
  assert.equal(workers[0].terminated,true);
  assert.deepEqual(host.cancelled,[workers[0].messages[0].options.jobId]);
});

test('a Pivot or figure export names the revision of the document it exports',async t=>{
  const {owner}=exporter(t,()=>{});
  await assert.rejects(owner.export({figure_types:[],keyframes:[]},{format:'stkz'}),{messageKey:'errors.documentExport.exportRequiresTheEditorRevision'});
});

test('a completed document export does not cancel and a superseded result never publishes',async t=>{
  let revision=0,change=false;
  const {owner,host}=exporter(t,(worker,message)=>{
    if(change)revision++;
    worker.reply(message,{ok:true,blob:new Blob(['native bytes'])});
  });
  const report=project();
  const result=await owner.export(report,{getRevision:()=>revision});assert.equal(await result.text(),'native bytes');
  assert.equal(host.cancelled.length,0);
  change=true;await assert.rejects(owner.export(report,{getRevision:()=>revision}),{name:'AbortError'});
  assert.equal(host.cancelled.length,1);assert.equal(owner.jobs.size,0);
});
