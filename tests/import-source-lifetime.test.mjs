import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTask} from 'node:timers/promises';
import {ImportClient} from '../src/import-client.mjs';
import {decodeSourceRecord} from '../src/source-record.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';

// The codec runs in a worker of the page: leases are released by requests over a codec port,
// and cancelling a job flags it there at once.
function environment(t,{release}={}) {
  const workers=[],host=new FakeCodecHost(request=>request.path==='/api/source/release'&&release?release(request):{status:204});
  class Worker extends EventTarget {
    constructor(){super();workers.push(this);this.messages=[];}
    postMessage(message){this.messages.push(message);}
    terminate(){this.terminated=true;}
    reply(message,result){this.dispatchEvent(new MessageEvent('message',{data:{id:message.id,ok:true,result}}));}
    fail(){const event=new Event('error',{cancelable:true});event.message='Worker failed';this.dispatchEvent(event);}
  }
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Worker');
  Object.defineProperty(globalThis,'Worker',{value:Worker,configurable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'Worker',descriptor);else delete globalThis.Worker;});
  const client=new ImportClient({baseURL:'http://localhost',timeoutMs:0,codecHost:host,
    readSample:path=>({ok:true,name:path,bytes:new Uint8Array([1])})});
  t.after(()=>{client.dispose();host.close();});
  /** Starts a sample import and returns [its promise, the message its worker received]. */
  const open=async(name,options)=>{
    const pending=client.openSample(name,options);pending.catch(()=>{});
    await nextTask();return [pending,workers.at(-1).messages.at(-1)];
  };
  return {client,workers,host,open};
}
function complete(worker,message,sourceId=String(message.id)) {
  const result={document:{},sourceId,sourceOwner:message.sourceOwner};worker.reply(message,result);return result;
}
const released=host=>host.sent('/api/source/release').map(request=>JSON.parse(request.text).ownerId);

test('library imports do not retain originals while accepted project owners survive unrelated imports',async t=>{
  const {client,workers,host,open}=environment(t),worker=workers[0];
  const [project,request]=await open('project.piv',{project:true});
  assert.match(request.sourceOwner,/^[a-f0-9]{32}$/);assert.notEqual(request.sourceOwner,request.jobId);
  complete(worker,request);const result=await project;client.adoptSource(result);
  for(let i=0;i<40;i++){
    const [pending,library]=await open(`figure-${i}.stk`);
    assert.equal(library.sourceOwner,undefined);complete(worker,library);await pending;
  }
  assert.equal(client.activeSourceOwner,result.sourceOwner);assert.equal(client.sourceOwners.size,1);assert.deepEqual(released(host),[]);
  client.adoptSource(null);await client.sourceRelease;assert.deepEqual(released(host),[result.sourceOwner]);
  assert.equal(host.sent('/api/source/release').at(-1).method,'POST');
});

test('project results have distinct owners and release only the replaced or rejected result',async t=>{
  const {client,workers,host,open}=environment(t),worker=workers[0];
  const [first,a]=await open('a.piv',{project:true}),[second,b]=await open('b.piv',{project:true});
  assert.notEqual(a.sourceOwner,b.sourceOwner);
  complete(worker,a);complete(worker,b);const [one,two]=await Promise.all([first,second]);
  client.adoptSource(one);await client.releaseSource(two);assert.equal(client.activeSourceOwner,one.sourceOwner);
  const [third,c]=await open('c.piv',{project:true});complete(worker,c);client.adoptSource(await third);
  await client.sourceRelease;assert.deepEqual(released(host),[two.sourceOwner,one.sourceOwner]);
  await client.releaseSource(two);assert.equal(released(host).length,2);
  client.dispose();await client.sourceRelease;assert.deepEqual(released(host),[two.sourceOwner,one.sourceOwner,c.sourceOwner]);
});

test('a cancelled queued import cancels its codec job before releasing its lease, including on disposal',async t=>{
  const {client,workers,host,open}=environment(t),worker=workers[0];
  const [pending,message]=await open('queued.piv',{project:true});
  client.cancelPending();client.dispose();await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(host.cancelled,[message.jobId]);
  complete(worker,message);assert.equal(client.activeSourceOwner,null);
  await client.sourceRelease;assert.deepEqual(released(host),[message.sourceOwner]);
  const cleanup=host.sent('/api/source/release')[0];
  assert.deepEqual(JSON.parse(cleanup.text),{ownerId:message.sourceOwner,jobId:message.jobId},'cleanup repeats the cancelled job');
  const cancelledAt=host.events.findIndex(([type,id])=>type==='cancel'&&id===message.jobId);
  const releaseLinked=host.events.findIndex(([type,id],index)=>type==='link'&&index>cancelledAt&&id===cleanup.jobId);
  assert.ok(cancelledAt>=0&&releaseLinked>cancelledAt,'the job is flagged before its lease is released');
});

test('import worker failure cleans pending owners and keeps the accepted original',async t=>{
  const {client,workers,host,open}=environment(t),worker=workers[0];
  const [project,a]=await open('accepted.piv',{project:true});complete(worker,a);client.adoptSource(await project);
  const [pending,b]=await open('failed.piv',{project:true});worker.fail();
  await assert.rejects(pending,{telemetryCode:'worker_failed'});await client.sourceRelease;
  assert.equal(client.activeSourceOwner,a.sourceOwner);assert.deepEqual(released(host),[b.sourceOwner]);
});

test('cleanup of a cancelled import keeps the accepted original and ignores the late result',async t=>{
  const {client,workers,host,open}=environment(t),worker=workers[0];
  const [project,a]=await open('accepted.piv',{project:true});complete(worker,a);client.adoptSource(await project);
  const [pending,b]=await open('queued.piv',{project:true});
  client.cancelPending();await assert.rejects(pending,{name:'AbortError'});await client.sourceRelease;
  assert.deepEqual(JSON.parse(host.sent('/api/source/release')[0].text),{ownerId:b.sourceOwner,jobId:b.jobId});
  assert.equal(client.activeSourceOwner,a.sourceOwner);assert.deepEqual(released(host),[b.sourceOwner]);
  complete(worker,b);assert.equal(client.activeSourceOwner,a.sourceOwner);
});

test('bulk source cleanup is serialized and retries a temporary codec failure',async t=>{
  let active=0,maxActive=0,attempts=0;
  const {client,workers,host,open}=environment(t,{release:async()=>{
    active++;maxActive=Math.max(maxActive,active);await nextTask();active--;attempts++;
    return {status:attempts===1?503:204};
  }}),worker=workers[0],results=[];
  for(let i=0;i<8;i++){
    const [pending,message]=await open(`project-${i}.piv`,{project:true});
    complete(worker,message);results.push(await pending);
  }
  await Promise.all(results.map(result=>client.releaseSource(result)));
  assert.equal(maxActive,1);assert.equal(attempts,9);assert.equal(client.sourceOwners.size,0);
  assert.deepEqual(new Set(released(host)),new Set(results.map(result=>result.sourceOwner)));
});

test('pending and releasing originals share a bounded owner budget',async t=>{
  let finish;const releasing=new Promise(resolve=>finish=resolve);
  const {client,workers,open}=environment(t,{release:async()=>{await releasing;return {status:204};}}),pending=[];
  for(let i=0;i<16;i++)pending.push((await open(`project-${i}.piv`,{project:true}))[0]);
  await assert.rejects(client.openSample('over-budget.piv',{project:true}),{code:'source_retention_limit',status:413});
  assert.equal(workers[0].messages.length,16);assert.equal(client.sourceOwners.size,16);
  client.cancelPending();await Promise.all(pending.map(request=>assert.rejects(request,{name:'AbortError'})));
  await assert.rejects(client.openSample('cleanup-still-pending.piv',{project:true}),{code:'source_retention_limit'});
  finish();await client.sourceRelease;assert.equal(client.sourceOwners.size,0);
  const [next,message]=await open('available-again.piv',{project:true});complete(workers[0],message);await next;
});

test('a codec result without the requested lease cannot replace an accepted original',async t=>{
  const {client,workers,host,open}=environment(t),worker=workers[0];
  const [project,a]=await open('accepted.piv',{project:true});complete(worker,a);client.adoptSource(await project);
  const [pending,b]=await open('unretained.piv',{project:true});
  worker.reply(b,{document:{},sourceId:'unsafe-expiring-source'});
  await assert.rejects(pending,/invalid source record/);await client.sourceRelease;
  assert.equal(client.activeSourceOwner,a.sourceOwner);assert.deepEqual(released(host),[b.sourceOwner]);
});

function envelope(metadata,bytes=new Uint8Array([1,2,3])) {
  const text=new TextEncoder().encode(JSON.stringify(metadata)),buffer=new ArrayBuffer(12+text.length+bytes.length);
  const output=new Uint8Array(buffer);output.set(new TextEncoder().encode('STYKSRC1'));new DataView(buffer).setUint32(8,text.length,true);
  output.set(text,12);output.set(bytes,12+text.length);return buffer;
}
const metadata={kind:'piv',version:5,sha256:'a'.repeat(64),document_sha256:'b'.repeat(64),document_digest_version:3};
test('original-source envelopes reject malformed bounds and metadata before use',()=>{
  const valid=envelope(metadata);assert.deepEqual(decodeSourceRecord(valid),{metadata,bytes:new Uint8Array([1,2,3])});
  const badLength=valid.slice(0);new DataView(badLength).setUint32(8,0xffffffff,true);
  for(const buffer of [new ArrayBuffer(8),badLength,envelope(metadata,new Uint8Array()),envelope({...metadata,sha256:'wrong'}),envelope({...metadata,kind:'styk'})])assert.throws(()=>decodeSourceRecord(buffer),/invalid source record/);
});
