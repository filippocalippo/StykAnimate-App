import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingWorker} from '../src/drawing-worker-client.mjs';

function workerEnvironment(run){
  const previous=globalThis.Worker,instances=[];
  class Worker {
    constructor(url,options){this.url=url;this.options=options;this.sent=[];this.terminated=false;instances.push(this);}
    postMessage(data,transfer){this.sent.push({data,transfer});if(this.failure)throw this.failure;}
    terminate(){this.terminated=true;}
    reply(data){this.onmessage({data});}
  }
  globalThis.Worker=Worker;
  return Promise.resolve().then(()=>run(instances)).finally(()=>{globalThis.Worker=previous;});
}

test('drawing worker remains lazy and enforces its existing pending limit',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker();assert.equal(instances.length,0);assert.equal(owner.active,false);
  const one=owner.request('one'),two=owner.request('two');assert.equal(owner.active,true);
  await assert.rejects(owner.request('three'),/busy/);
  assert.equal(instances.length,1);assert.equal(instances[0].sent.length,2);
  instances[0].reply({id:1,value:'first'});instances[0].reply({id:2,value:'second'});
  assert.equal((await one).value,'first');assert.equal((await two).value,'second');
  assert.equal(owner.pending.size,0);owner.dispose();assert.equal(owner.active,false);
}));

test('individual drawing failures retain the worker and close unexpected bitmap results',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),pending=owner.request('preview');let closed=0;
  instances[0].reply({id:1,error:'Invalid bounds',bitmap:{close(){closed++;}}});
  await assert.rejects(pending,/Invalid bounds/);assert.equal(closed,1);
  const retry=owner.request('preview');assert.equal(instances.length,1);
  instances[0].reply({id:2,value:true});assert.equal((await retry).value,true);owner.dispose();
}));

test('worker failures preserve only string error codes for renderer recovery',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),first=owner.request('preview');
  instances[0].reply({id:1,error:'Working memory exceeded',code:'preview_raster_budget'});
  await assert.rejects(first,error=>error.code==='preview_raster_budget');
  const second=owner.request('preview');instances[0].reply({id:2,error:'Invalid operation',code:{value:'unsupported'}});
  await assert.rejects(second,error=>error.code===undefined);assert.equal(owner.pending.size,0);owner.dispose();
}));

test('postMessage failures reject all requests and release their listeners before retry',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),signal=new AbortController().signal;
  let added=0,removed=0;
  const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
  signal.addEventListener=(...args)=>{added++;add(...args);};signal.removeEventListener=(...args)=>{removed++;remove(...args);};
  const one=owner.request('one',{}, {signal}),settled=assert.rejects(one,/Transfer failed/);
  instances[0].failure=Error('Transfer failed');
  await assert.rejects(owner.request('two'),/Transfer failed/);await settled;
  assert.equal(added,1);assert.equal(removed,1);assert.equal(owner.pending.size,0);
  assert.equal(owner.worker,null);assert.equal(instances[0].terminated,true);
  const retry=owner.request('retry');instances[1].reply({id:3,value:'ready'});
  assert.equal((await retry).value,'ready');owner.dispose();
}));

test('cancellation releases every pending operation and late bitmaps cannot reach a replacement',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),abort=new AbortController();let closed=0;
  const one=owner.request('one',{}, {signal:abort.signal}),two=owner.request('two');
  const rejected=Promise.all([assert.rejects(one,{name:'AbortError'}),assert.rejects(two,{name:'AbortError'})]);
  abort.abort();await rejected;assert.equal(owner.pending.size,0);assert.equal(instances[0].terminated,true);
  const replacement=owner.request('new');
  instances[0].reply({id:1,bitmap:{close(){closed++;}}});
  instances[0].reply({id:2,error:'Late fatal error',fatal:true});
  instances[0].onerror({message:'Late crash',preventDefault(){}});instances[0].onmessageerror();
  assert.equal(owner.worker,instances[1]);assert.equal(closed,1);
  instances[1].reply({id:3,value:'fresh'});assert.equal((await replacement).value,'fresh');owner.dispose();
}));

test('unclaimed bitmap messages close their pixels while claimed bitmaps transfer to the caller',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),pending=owner.request('preview');let closed=0;
  const bitmap={close(){closed++;}};
  instances[0].reply({id:1,bitmap});assert.equal((await pending).bitmap,bitmap);assert.equal(closed,0);
  instances[0].reply({id:1,bitmap:{close(){closed++;}}});assert.equal(closed,1);
  bitmap.close();owner.dispose();
}));

test('fatal worker load errors release all pending operations and permit a lazy restart',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),one=owner.request('one'),two=owner.request('two');
  const rejected=Promise.all([assert.rejects(one,/Module failed/),assert.rejects(two,/Module failed/)]);
  instances[0].reply({id:1,error:'Module failed',fatal:true});await rejected;
  assert.equal(owner.worker,null);assert.equal(owner.pending.size,0);assert.equal(instances[0].terminated,true);
  const retry=owner.request('retry');instances[1].reply({id:3});await retry;owner.dispose();
}));

test('a pre-cancelled request does not create a worker',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),abort=new AbortController();abort.abort();
  await assert.rejects(owner.request('preview',{}, {signal:abort.signal}),{name:'AbortError'});
  assert.equal(instances.length,0);assert.equal(owner.pending.size,0);owner.dispose();
}));

test('worker construction failures leave no pending operation and retry lazily',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(),WorkingWorker=globalThis.Worker;
  globalThis.Worker=class {constructor(){throw Error('Worker unavailable');}};
  await assert.rejects(owner.request('preview'),/Worker unavailable/);
  assert.equal(owner.pending.size,0);assert.equal(owner.worker,undefined);
  globalThis.Worker=WorkingWorker;
  const retry=owner.request('preview');instances[0].reply({id:1,value:'recovered'});
  assert.equal((await retry).value,'recovered');owner.dispose();
}));

test('a drawing worker with nothing to do ends after its rest, and the next request starts another',()=>workerEnvironment(async instances=>{
  const owner=new DrawingWorker(undefined,{idleMs:20});
  const one=owner.request('one');assert.equal(owner.instance,1);
  instances[0].reply({id:1,value:'first'});await one;
  // A request within the rest keeps the worker.
  const two=owner.request('two');await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(owner.worker,instances[0],'a pending request is never ended');instances[0].reply({id:2});await two;
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(owner.active,false);assert.equal(instances[0].terminated,true);
  const three=owner.request('three');assert.equal(instances.length,2);assert.equal(owner.instance,2,'whoever kept state in the first worker can tell');
  instances[1].reply({id:3,value:'again'});assert.equal((await three).value,'again');owner.dispose();
}));
