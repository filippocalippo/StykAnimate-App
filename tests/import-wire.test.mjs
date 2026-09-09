import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {unpackNativeFrameResponse,materializeNativeFrames} from '../src/import-wire.mjs';
const app=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const py=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
root=Path(sys.argv[1]); store=server.ProjectStore(server.WORKSPACE)
manifest=json.loads((server.WORKSPACE/'docs/piv_corpus_manifest.json').read_text())
rows=[]
for i,item in enumerate(manifest['fixtures']):
    source=server.WORKSPACE/item['path']; data=source.read_bytes()
    wire=store.import_bytes(data,source.name,as_json=True,prefer_native=True)
    if not wire.startswith(b'STYKPIV1'): continue
    original=store.import_bytes(data,source.name,as_json=True)
    (root/f'{i}.wire').write_bytes(wire);(root/f'{i}.json').write_bytes(original)
    rows.append({'index':i,'name':source.name})
print(json.dumps(rows))
`;
test('all native v5 corpus wire frames recreate every canonical field exactly',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'styk-wire-'));
  try {
    const candidate=backend.pythonCandidates()[0];
    const generated=spawnSync(candidate.command,[...candidate.args,'-c',py,temp],{cwd:app,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
    assert.equal(generated.status,0,generated.error?.message||generated.stderr);
    const rows=JSON.parse(generated.stdout); assert.equal(rows.length,23);
    for(const row of rows) {
      const raw=await readFile(path.join(temp,`${row.index}.wire`)), buffer=raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength);
      const packet=unpackNativeFrameResponse(buffer), expected=JSON.parse(await readFile(path.join(temp,`${row.index}.json`),'utf8'));
      const result=await materializeNativeFrames(packet.result,buffer,packet.offset,{yieldControl:()=>Promise.resolve()});
      assert.deepEqual(result.document,expected.document,row.name);
      // Preserve enumerable field ordering too: existing native-save comparisons
      // and diagnostic clients use the canonical parser's JSON property order.
      assert.equal(JSON.stringify(result.document),JSON.stringify(expected.document),row.name);
      const invalid=buffer.slice(0,-1); assert.throws(()=>unpackNativeFrameResponse(invalid),/metadata/);
      const fresh=unpackNativeFrameResponse(buffer);
      await assert.rejects(materializeNativeFrames(fresh.result,buffer,fresh.offset,{isCancelled:()=>true}),{name:'AbortError'});
    }
  } finally {await rm(temp,{recursive:true,force:true});}
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
