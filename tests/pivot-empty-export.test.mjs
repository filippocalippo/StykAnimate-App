import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {Editor} from '../src/editor.mjs';
import {createObject,emptyDocument} from '../src/demo.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {storedFrameReport} from '../src/pivot-frame-draft.mjs';
import {NATIVE_FRAME_CONTENT_TYPE,unpackNativeFrameResponse,materializeNativeFrames} from '../src/import-wire.mjs';
import backendModule from '../desktop/backend.cjs';
import {documentChunks} from '../src/document-transport.mjs';
function working(){
  const editor=new Editor({demo:false}).load(emptyDocument()),report=editor.report;
  report.keyframes[0].objects.push(createObject(report.figure_types[0],1,123,234));
  report._styk.simpleFrameDraft={version:1,mode:'add',index:0,frameId:report.keyframes[0]._styk.frameId,empty:true};
  return report;
}
test('zero stored-frame materialization excludes the internal working pose and dormant authoring',()=>{
  const report=working();report._styk.animation={version:1,nextKeyId:2,channels:[{id:'figure:1:x',target:{kind:'figure',uid:1},property:'x',keys:[{id:'key-1',tick:100,value:999}]}]};
  const before=structuredClone(report),stored=storedFrameReport(report),native=materializePivotDocument(report);
  assert.deepEqual(stored.keyframes,[]);assert.equal(stored.total_output_frames,0);assert.equal(stored.duration_seconds,0);
  assert.deepEqual(native.keyframes,[]);assert.equal(native._styk.animation,undefined);assert.equal(native._styk.simpleFrameDraft,undefined);
  assert.equal(native.figure_types,report.figure_types);assert.deepEqual(report,before);
});

async function service(t){const value=await backendModule.startBackend({appRoot:fileURLToPath(new URL('..',import.meta.url))});t.after(()=>value.stop());return value;}
async function importBytes(server,bytes,name){
  const response=await fetch(`${server.origin}/api/import?filename=${encodeURIComponent(name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Accept:NATIVE_FRAME_CONTENT_TYPE},body:bytes});
  assert.equal(response.status,200,await(response.status===200?Promise.resolve(''):response.text()));
  if(response.headers.get('content-type')?.startsWith(NATIVE_FRAME_CONTENT_TYPE)){
    const buffer=await response.arrayBuffer(),packet=unpackNativeFrameResponse(buffer);
    return materializeNativeFrames(packet.result,buffer,packet.offset);
  }
  return response.json();
}
async function exportBytes(server,request){const response=await fetch(`${server.origin}/api/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  assert.equal(response.status,200,await(response.status===200?Promise.resolve(''):response.text()));return Buffer.from(await response.arrayBuffer());}
test('native zero-frame PIV negotiates wire format through HTTP and re-exports its original bytes',async t=>{
  const server=await service(t),payload=Buffer.alloc(22);payload[0]=5;payload.writeUInt32LE(640,1);payload.writeUInt32LE(480,5);
  payload.writeUInt16LE(1,9);payload.writeUInt16LE(2,11);payload.writeUInt32LE(0,13);payload.writeUInt32LE(24,17);payload[21]=1;
  const source=deflateSync(payload),result=await importBytes(server,source,'zero.piv');
  assert.equal(result.timings.transport,'native-v5-frames');assert.deepEqual(result.document.keyframes,[]);assert.equal(result.document.total_output_frames,0);
  assert.deepEqual(await exportBytes(server,{...result,format:'piv'}),source);
});
test('actual native writer saves zero stored keys while STYK preserves the editable working pose',async t=>{
  const server=await service(t),report=working(),before=structuredClone(report);
  const piv=await exportBytes(server,{document:materializePivotDocument(report),format:'piv'}),opened=await importBytes(server,piv,'empty-export.piv');
  assert.deepEqual(opened.document.keyframes,[]);assert.equal(opened.document.total_output_frames,0);
  const styk=await exportBytes(server,{document:report,format:'styk'}),saved=await importBytes(server,styk,'working.styk');
  assert.equal(saved.document.keyframes.length,1);assert.equal(saved.document.keyframes[0].objects[0].root_x,123);assert.equal(saved.document._styk.simpleFrameDraft.empty,true);
  assert.deepEqual(materializePivotDocument(saved.document).keyframes,[]);assert.deepEqual(report,before);
});

test('actual document export worker validates and writes zero stored PIV frames',async t=>{
  const server=await service(t),worker=new Worker(new URL('./document-export-node-worker.mjs',import.meta.url));t.after(()=>worker.terminate());
  assert.equal((await once(worker,'message'))[0].ready,true);let id=0;
  const send=async request=>{const pending=once(worker,'message');worker.postMessage({id:++id,...request});const result=(await pending)[0];assert.equal(result.ok,true,result.error?.message);return result;};
  await send({operation:'start',options:{format:'piv',name:'empty-worker',baseURL:server.origin}});
  for(const chunk of documentChunks(working()))await send({operation:'chunk',chunk});
  const result=await send({operation:'export'}),opened=await importBytes(server,Buffer.from(await result.blob.arrayBuffer()),'empty-worker.piv');
  assert.equal(result.timings.export_keyframes,0);assert.deepEqual(opened.document.keyframes,[]);assert.equal(opened.document.total_output_frames,0);
});
