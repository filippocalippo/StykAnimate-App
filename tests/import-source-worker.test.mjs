import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {base64ToBytes} from '../src/base64.mjs';
import {buildContainerV2,decodeDocument} from './support/native-files.mjs';

async function worker(t) {
  const prior=Object.getOwnPropertyDescriptor(globalThis,'self'),scope=new EventTarget(),messages=[];
  let resolve;
  const result=new Promise(yes=>resolve=yes);
  scope.postMessage=message=>{messages.push(message);if(message.ok===false||message.result)resolve(message);};
  Object.defineProperty(globalThis,'self',{value:scope,configurable:true});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'self',prior);else delete globalThis.self;});
  await import(`../src/import-worker.mjs?source-test=${crypto.randomUUID()}`);
  return {messages,result,send(message){scope.dispatchEvent(new MessageEvent('message',{data:message}));}};
}
const original=new Uint8Array([1,2,3,4]),owner='a'.repeat(32),sourceId='source';
const metadata={kind:'piv',version:5,sha256:createHash('sha256').update(original).digest('hex'),
  document_sha256:'b'.repeat(64),document_digest_version:3};
function record(meta=metadata) {
  const text=new TextEncoder().encode(JSON.stringify(meta)),output=new Uint8Array(12+text.length+original.length);
  output.set(new TextEncoder().encode('STYKSRC1'));new DataView(output.buffer).setUint32(8,text.length,true);
  output.set(text,12);output.set(original,12+text.length);return output;
}
function response(port,id,status,body) {
  const bytes=body instanceof Uint8Array?body:new TextEncoder().encode(JSON.stringify(body));
  port.postMessage({id,status,headers:{'Content-Type':'application/json'},body:bytes.buffer},[bytes.buffer]);
}

test('browser project publication embeds and verifies the original before releasing its codec lease',async t=>{
  const task=await worker(t),{port1,port2}=new MessageChannel(),requests=[];
  t.after(()=>{port1.close();port2.close();});
  const document={version:5,canvas_width:640,canvas_height:480,fps:24,figure_types:[],keyframes:[],unknown:{retained:true}};
  port2.on('message',message=>{
    requests.push(message);
    if(message.path.startsWith('/api/import')){
      assert.equal(message.headers['x-styk-source-owner'],owner);
      response(port2,message.id,200,{ok:true,kind:'piv',sourceId,sourceOwner:owner,document,timings:{document_bytes:200}});
    }else if(message.path.startsWith('/api/source?'))response(port2,message.id,200,record());
    else if(message.path==='/api/source/release'){
      assert.equal(task.messages.length,0,'The editable document must wait for verified source adoption');
      assert.deepEqual(JSON.parse(new TextDecoder().decode(message.body)),{ownerId:owner});
      response(port2,message.id,204,new Uint8Array());
    }else throw new Error(`Unexpected request ${message.path}`);
  });
  task.send({id:1,operation:'import',filename:'project.piv',bytes:original.slice().buffer,embedSource:true,
    sourceOwner:owner,jobId:'c'.repeat(32),codecPort:port1});
  const message=await task.result;assert.equal(message.ok,true);
  const result=message.result;assert.equal(result.sourceId,null);assert.equal(result.sourceOwner,undefined);
  assert.deepEqual(base64ToBytes(result.document._stykSource.source_base64),original);
  assert.deepEqual(result.document._stykSource,{...metadata,source_base64:'AQIDBA=='});
  assert.deepEqual(result.document.unknown,{retained:true});assert.equal(requests.length,3);
  const saved=await buildContainerV2(result.document,'styk'),loaded=await decodeDocument(saved,'styk');
  assert.deepEqual(loaded.document._stykSource,result.document._stykSource);
});

test('a corrupt browser original never publishes an editable project',async t=>{
  const task=await worker(t),{port1,port2}=new MessageChannel();t.after(()=>{port1.close();port2.close();});
  port2.on('message',message=>{
    if(message.path.startsWith('/api/import'))response(port2,message.id,200,{ok:true,kind:'piv',sourceId,sourceOwner:owner,
      document:{version:5},timings:{document_bytes:50}});
    else response(port2,message.id,200,record({...metadata,sha256:'d'.repeat(64)}));
  });
  task.send({id:1,operation:'import',filename:'project.piv',bytes:original.slice().buffer,embedSource:true,
    sourceOwner:owner,jobId:'c'.repeat(32),codecPort:port1});
  const message=await task.result;assert.equal(message.ok,false);assert.match(message.error.message,/fingerprint does not match/);
  assert.equal(task.messages.some(message=>message.result),false);
});

test('codec-decoded native JSON aliases clear the cache id because the document owns its embedded original',async t=>{
  const task=await worker(t),document={version:5,_stykSource:{...metadata,source_base64:'AQIDBA=='}},{port1,port2}=new MessageChannel();
  t.after(()=>{port1.close();port2.close();});
  port2.on('message',message=>response(port2,message.id,200,{ok:true,kind:'styk',sourceId:'evictable-native-json',document,timings:{document_bytes:500}}));
  task.send({id:1,operation:'import',filename:'project.json',bytes:new ArrayBuffer(2),codecPort:port1});
  const message=await task.result;assert.equal(message.ok,true);assert.equal(message.result.sourceId,null);
  assert.deepEqual(message.result.document._stykSource,document._stykSource);
});

test('a desktop project keeps its original in the codec\'s lease: no source request, no embedded copy',async t=>{
  const task=await worker(t),{port1,port2}=new MessageChannel(),requests=[];
  t.after(()=>{port1.close();port2.close();});
  const document={version:5,canvas_width:640,canvas_height:480,fps:24,figure_types:[],keyframes:[]};
  port2.on('message',message=>{
    requests.push(message.path);
    response(port2,message.id,200,{ok:true,kind:'piv',sourceId,sourceOwner:owner,document,timings:{document_bytes:200}});
  });
  task.send({id:1,operation:'import',filename:'project.piv',bytes:original.slice().buffer,
    sourceOwner:owner,jobId:'c'.repeat(32),codecPort:port1});
  const message=await task.result;assert.equal(message.ok,true);
  assert.deepEqual(requests,['/api/import?filename=project.piv']);
  assert.equal(message.result.sourceId,sourceId);assert.equal(message.result.sourceOwner,owner);
  assert.equal(message.result.document._stykSource,undefined);
});
