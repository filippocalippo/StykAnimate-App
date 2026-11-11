import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {createHash} from 'node:crypto';

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
const original=new Uint8Array([1,2,3,4]);
const metadata={kind:'piv',version:5,sha256:createHash('sha256').update(original).digest('hex'),
  document_sha256:'b'.repeat(64),document_digest_version:3};
function response(port,id,status,body) {
  const bytes=body instanceof Uint8Array?body:new TextEncoder().encode(JSON.stringify(body));
  port.postMessage({id,status,headers:{'Content-Type':'application/json'},body:bytes.buffer},[bytes.buffer]);
}

test('codec-decoded native JSON aliases clear the cache id because the document owns its embedded original',async t=>{
  const task=await worker(t),document={version:5,_stykSource:{...metadata,source_base64:'AQIDBA=='}},{port1,port2}=new MessageChannel();
  t.after(()=>{port1.close();port2.close();});
  port2.on('message',message=>response(port2,message.id,200,{ok:true,kind:'styk',sourceId:'evictable-native-json',document,timings:{document_bytes:500}}));
  task.send({id:1,operation:'import',filename:'project.json',bytes:new ArrayBuffer(2),codecPort:port1});
  const message=await task.result;assert.equal(message.ok,true);assert.equal(message.result.sourceId,null);
  assert.deepEqual(message.result.document._stykSource,document._stykSource);
});
