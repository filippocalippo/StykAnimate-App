import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NATIVE_FRAME_CONTENT_TYPE,unpackNativeFrameResponse,materializeNativeFrames} from '../src/import-wire.mjs';
import {missingFixture} from './helpers/local-fixtures.mjs';
import {nodeCodec} from './support/codec.mjs';
const app=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Every corpus file the codec answers with the native frame transport, and its canonical JSON import.
async function* corpusTransfers() {
  const workspace=path.dirname(app), codec=nodeCodec();
  const manifest=JSON.parse(await readFile(path.join(workspace,'docs/piv_corpus_manifest.json'),'utf8'));
  for(const item of manifest.fixtures){
    const source=path.join(workspace,item.path), data=await readFile(source), name=path.basename(source);
    const request=accept=>codec.fetch(`/api/import?filename=${encodeURIComponent(name)}`,{method:'POST',headers:{Accept:accept},body:data});
    const wire=await request(`${NATIVE_FRAME_CONTENT_TYPE}, application/json`);
    if(wire.headers.get('Content-Type')!==NATIVE_FRAME_CONTENT_TYPE)continue;
    yield {name,buffer:await wire.arrayBuffer(),expected:await (await request('application/json')).json()};
  }
}
test('all native v5 corpus wire frames recreate every canonical field exactly',{skip:missingFixture('../docs/piv_corpus_manifest.json')},async()=>{
  {
    let rows=0;
    for await(const row of corpusTransfers()) {
      rows++;
      const buffer=row.buffer, packet=unpackNativeFrameResponse(buffer), expected=row.expected;
      const result=await materializeNativeFrames(packet.result,buffer,packet.offset,{yieldControl:()=>Promise.resolve()});
      assert.deepEqual(result.document,expected.document,row.name);
      // Preserve enumerable field ordering too: existing native-save comparisons
      // and diagnostic clients use the canonical parser's JSON property order.
      assert.equal(JSON.stringify(result.document),JSON.stringify(expected.document),row.name);
      const invalid=buffer.slice(0,-1); assert.throws(()=>unpackNativeFrameResponse(invalid),/metadata/);
      const fresh=unpackNativeFrameResponse(buffer);
      await assert.rejects(materializeNativeFrames(fresh.result,buffer,fresh.offset,{isCancelled:()=>true}),{name:'AbortError'});
    }
    assert.equal(rows,23);
  }
});
test('malformed transfer metadata and signatures fail before materialization',()=>{
  assert.throws(()=>unpackNativeFrameResponse(new ArrayBuffer(5)),/size/);
  assert.throws(()=>unpackNativeFrameResponse(new ArrayBuffer(16)),/signature/);
});
test('frame inventory above the former 256 MiB budget reaches payload validation',async()=>{
  const buffer=new ArrayBuffer(4);new DataView(buffer).setUint32(0,600000,true);
  const result={document:{figure_types:[],keyframes:[]},nativeFrames:{version:1,sourceOffset:0,byteLength:4}};
  await assert.rejects(materializeNativeFrames(result,buffer,0),/Truncated native frame table/);
  assert.deepEqual(result.document.keyframes,[]);
});
test('one maximum-size native figure yields inside every large pose array',async()=>{
  const segments=30000, buffer=new ArrayBuffer(segments*20+100), view=new DataView(buffer);let p=0;
  const n=(size,value)=>{if(size===1)view.setUint8(p,value);else if(size===2)view.setUint16(p,value,true);else view.setUint32(p,value,true);p+=size;};
  const f=(size,value)=>{if(size===4)view.setFloat32(p,value,true);else view.setFloat64(p,value,true);p+=size;};
  n(4,1);n(2,1);n(1,0);n(2,0);n(2,1);
  n(4,1);n(2,1);f(4,1);n(4,0);n(1,0);
  for(let i=0;i<segments;i++)f(8,i/1000);f(4,100);f(4,100);
  n(2,1);for(let i=0;i<segments;i++)f(4,i+1);
  n(2,1);for(let i=0;i<segments;i++)f(8,-i/1000);
  n(1,0);n(2,0);n(1,1);
  const result={document:{figure_types:[{figure_type_id:1,segment_count:segments}],keyframes:[]},
    nativeFrames:{version:1,sourceOffset:10,byteLength:p}};
  let yields=0;
  await materializeNativeFrames(result,buffer.slice(0,p),0,{timeBudgetMs:0,yieldControl:async()=>{yields++;assert.equal(result.document.keyframes.length,0);}});
  assert.ok(yields>=21,'large arrays must yield before completing the single object');
  const object=result.document.keyframes[0].objects[0];
  assert.equal(object.angles[29999],29.999);assert.equal(object.lengths[29999],30000);assert.equal(object.bends[29999],-29.999);
  assert.equal(result.timings.native_materialize_tasks,yields+1);
});
