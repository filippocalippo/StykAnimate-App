import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {engineEditor} from './support/owned-editor.mjs';
import {createFrame,createObject,emptyDocument} from '../src/demo.mjs';
import {storedFrameReport} from '../src/pivot-frame-draft.mjs';
import {NATIVE_FRAME_CONTENT_TYPE,unpackNativeFrameResponse,materializeNativeFrames} from '../src/import-wire.mjs';
import {nodeCodec, codecPort} from './support/codec.mjs';
import {registeredEngine} from '../src/engine/engine-open.mjs';
import {pivotDocument} from './support/engine-export.mjs';
/** A new animation whose only pose is the working frame of an empty Simple animation, in an editor the engine owns. */
function workingEditor(edit=null){
  const base=emptyDocument(),report=structuredClone(base);
  report.keyframes=[{...createFrame([createObject(report.figure_types[0],1,123,234)]),_styk:{easing:{interpolation:'hold'}}}];
  report.keyframes[0]._styk={...report.keyframes[0]._styk,frameId:'frame-1'};
  report._styk.simpleFrameDraft={version:1,mode:'add',index:0,frameId:'frame-1',empty:true};
  edit?.(report);
  return engineEditor({demo:false}, report);
}
test('zero stored-frame materialization excludes the internal working pose and dormant authoring',()=>{
  const editor=workingEditor(report=>{report._styk.animation={version:1,nextKeyId:2,channels:[{id:'figure:1:x',target:{kind:'figure',uid:1},property:'x',keys:[{id:'key-1',tick:100,value:999}]}]};}),report=editor.report;
  assert.ok(report._styk.animation,'the dormant authoring is in the document');
  const before=structuredClone(report),stored=storedFrameReport(report),native=pivotDocument(editor);
  assert.deepEqual(stored.keyframes,[]);assert.equal(stored.total_output_frames,0);assert.equal(stored.duration_seconds,0);
  assert.deepEqual(native.keyframes,[]);assert.equal(native._styk.animation,undefined);assert.equal(native._styk.simpleFrameDraft,undefined);
  assert.deepEqual(native.figure_types,report.figure_types);assert.deepEqual(report,before);
});

// The codec the app runs (in Node), with its own source cache for one test.
function service(){return nodeCodec();}
async function importBytes(server,bytes,name){
  const response=await server.fetch(`/api/import?filename=${encodeURIComponent(name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Accept:NATIVE_FRAME_CONTENT_TYPE},body:bytes});
  assert.equal(response.status,200,await(response.status===200?Promise.resolve(''):response.text()));
  if(response.headers.get('content-type')?.startsWith(NATIVE_FRAME_CONTENT_TYPE)){
    const buffer=await response.arrayBuffer(),packet=unpackNativeFrameResponse(buffer);
    return materializeNativeFrames(packet.result,buffer,packet.offset);
  }
  return response.json();
}
async function exportBytes(server,request){const response=await server.fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  assert.equal(response.status,200,await(response.status===200?Promise.resolve(''):response.text()));return Buffer.from(await response.arrayBuffer());}
test('native zero-frame PIV negotiates wire format through the codec and re-exports its original bytes',async()=>{
  const server=service(),payload=Buffer.alloc(22);payload[0]=5;payload.writeUInt32LE(640,1);payload.writeUInt32LE(480,5);
  payload.writeUInt16LE(1,9);payload.writeUInt16LE(2,11);payload.writeUInt32LE(0,13);payload.writeUInt32LE(24,17);payload[21]=1;
  const source=deflateSync(payload),result=await importBytes(server,source,'zero.piv');
  assert.equal(result.timings.transport,'native-v5-frames');assert.deepEqual(result.document.keyframes,[]);assert.equal(result.document.total_output_frames,0);
  assert.deepEqual(await exportBytes(server,{...result,format:'piv'}),source);
});
test('actual native writer saves zero stored keys while STYK preserves the editable working pose',async()=>{
  const server=service(),editor=workingEditor(),report=editor.report,before=structuredClone(report);
  const piv=await exportBytes(server,{document:pivotDocument(editor),format:'piv'}),opened=await importBytes(server,piv,'empty-export.piv');
  assert.deepEqual(opened.document.keyframes,[]);assert.equal(opened.document.total_output_frames,0);
  const styk=await exportBytes(server,{document:report,format:'styk'}),saved=await importBytes(server,styk,'working.styk');
  assert.equal(saved.document.keyframes.length,1);assert.equal(saved.document.keyframes[0].objects[0].root_x,123);assert.equal(saved.document._styk.simpleFrameDraft.empty,true);
  assert.deepEqual(pivotDocument(saved.document).keyframes,[]);assert.deepEqual(report,before);
});

test('actual document export worker validates and writes zero stored PIV frames',async t=>{
  const server=service(),link=codecPort(server),worker=new Worker(new URL('./document-export-node-worker.mjs',import.meta.url),{execArgv:[]});t.after(()=>{worker.terminate();link.close();});
  assert.equal((await once(worker,'message'))[0].ready,true);let id=0;
  const send=async request=>{const pending=once(worker,'message');worker.postMessage({id:++id,...request});const result=(await pending)[0];assert.equal(result.ok,true,result.error?.message);return result;};
  const started=once(worker,'message');worker.postMessage({id:++id,operation:'start',options:{format:'piv',name:'empty-worker',engine:{join:registeredEngine().join},codecPort:link.port}},[link.port]);
  assert.equal((await started)[0].ok,true);
  const editor=workingEditor();
  const result=await send({operation:'export',engine:{address:registeredEngine().handle.address(),revision:editor.revision},cancel:new Int32Array(new SharedArrayBuffer(4))}),opened=await importBytes(server,Buffer.from(await result.blob.arrayBuffer()),'empty-worker.piv');
  assert.deepEqual(opened.document.keyframes,[]);assert.equal(opened.document.total_output_frames,0);
});
