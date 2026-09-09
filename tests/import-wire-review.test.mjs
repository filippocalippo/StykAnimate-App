import test from 'node:test';
import assert from 'node:assert/strict';
import {ImportClient} from '../src/import-client.mjs';
import {materializeNativeFrames,unpackNativeFrameResponse} from '../src/import-wire.mjs';

function transfer(count=3){
  const buffer=new ArrayBuffer(4+count*8),view=new DataView(buffer);view.setUint32(0,count,true);
  for(let i=0;i<count;i++){const offset=4+i*8;view.setUint16(offset,1,true);view.setUint8(offset+7,1);}
  return {buffer,offset:0,result:{document:{version:5,figure_types:[],keyframes:[]},nativeFrames:{version:1,sourceOffset:100,byteLength:buffer.byteLength}}};
}

test('native materialization cancellation never installs a partial frame table',async()=>{
  const packet=transfer(5),before=packet.result.document.keyframes;let cancelled=false,yields=0;
  await assert.rejects(materializeNativeFrames(packet.result,packet.buffer,0,{timeBudgetMs:0,
    isCancelled:()=>cancelled,yieldControl:async()=>{yields++;cancelled=true;}}),{name:'AbortError'});
  assert.equal(yields,1);assert.equal(packet.result.document.keyframes,before);
  assert.equal(before.length,0);assert.ok(packet.result.nativeFrames);
});

test('truncated and trailing native payloads reject without publishing partial frames',async()=>{
  for(const delta of[-1,1]){
    const packet=transfer(),buffer=new ArrayBuffer(packet.buffer.byteLength+delta);
    new Uint8Array(buffer).set(new Uint8Array(packet.buffer,0,Math.min(buffer.byteLength,packet.buffer.byteLength)));
    packet.result.nativeFrames.byteLength=buffer.byteLength;
    await assert.rejects(materializeNativeFrames(packet.result,buffer,0),/Truncated|Unexpected bytes/);
    assert.deepEqual(packet.result.document.keyframes,[]);
  }
  const packet=transfer();new DataView(packet.buffer).setUint32(0,1000001,true);
  await assert.rejects(materializeNativeFrames(packet.result,packet.buffer,0),/frame count/);
});

test('a disposed import client cannot resolve an in-flight native materialization',async()=>{
  const old=globalThis.Worker;let worker;
  class FakeWorker{
    handlers=new Map();sent=[];
    constructor(){worker=this;}
    addEventListener(type,fn){this.handlers.set(type,fn);}
    postMessage(message){this.sent.push(message);}
    terminate(){this.terminated=true;}
    receive(message){this.handlers.get('message')({data:message});}
  }
  globalThis.Worker=FakeWorker;
  try{
    const client=new ImportClient({baseURL:'http://localhost',timeoutMs:0}),promise=client.openSample('sample.piv'),packet=transfer(30000);
    worker.receive({id:1,ok:true,result:packet.result,nativeFrames:{buffer:packet.buffer,offset:0}});
    client.dispose();await assert.rejects(promise,/disposed/);
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(client.pending.size,0);assert.equal(worker.terminated,true);
    assert.deepEqual(packet.result.document.keyframes,[]);
  }finally{globalThis.Worker=old;}
});

test('oversized and invalid response header extents fail before frame allocation',()=>{
  const buffer=new ArrayBuffer(16),bytes=new Uint8Array(buffer);bytes.set(new TextEncoder().encode('STYKPIV1'));
  new DataView(buffer).setUint32(8,0xffffffff,true);
  assert.throws(()=>unpackNativeFrameResponse(buffer),/Truncated/);
});
