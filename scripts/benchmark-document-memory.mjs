/** Calibrate document inventory estimates; this is not a process-memory cap. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setImmediate as yieldTask} from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import {Editor} from '../src/editor.mjs';
import {materializeNativeFrames,unpackNativeFrameResponse,NATIVE_FRAME_CONTENT_TYPE} from '../src/import-wire.mjs';
import {nodeCodec} from '../tests/support/codec.mjs';

// A benchmark-only conservative graph inventory. Count shared containers once;
// string storage is deliberately an upper estimate without engine internals.
async function inventory(root){
  const seen=new WeakSet(),stack=[{value:root}],counts={objects:0,arrays:0,slots:0,stringUnits:0,buffers:0};
  let steps=0,slices=0,workMs=0,maxSliceMs=0,at=performance.now();
  const started=at;
  while(stack.length){
    const entry=stack.at(-1);
    if(!entry.keys){
      const value=entry.value;stack.pop();
      if(typeof value==='string'){counts.stringUnits+=value.length;continue;}
      if(!value||typeof value!=='object'||seen.has(value))continue;
      seen.add(value);
      if(ArrayBuffer.isView(value)){counts.buffers+=value.byteLength;continue;}
      if(value instanceof ArrayBuffer){counts.buffers+=value.byteLength;continue;}
      if(Array.isArray(value)){counts.arrays++;entry.array=true;entry.keys=value.length;}
      else{counts.objects++;entry.keys=Object.keys(value);}
      entry.length=entry.array?entry.keys:entry.keys.length;entry.index=0;
      counts.slots+=entry.length;if(entry.length)stack.push(entry);
    }else{
      if(entry.index>=entry.length){stack.pop();continue;}
      const key=entry.array?entry.index++:entry.keys[entry.index++],value=entry.value[key];
      if(typeof value==='string')counts.stringUnits+=value.length;
      else if(value&&typeof value==='object')stack.push({value});
    }
    if(++steps%1024===0&&performance.now()-at>=2){
      const ms=performance.now()-at;workMs+=ms;maxSliceMs=Math.max(maxSliceMs,ms);slices++;
      await yieldTask();at=performance.now();
    }
  }
  const ms=performance.now()-at;workMs+=ms;maxSliceMs=Math.max(maxSliceMs,ms);
  return {counts,estimatedBytes:counts.objects*64+counts.arrays*32+counts.slots*16+counts.stringUnits*2+counts.buffers,
    elapsedMs:performance.now()-started,workMs,maxSliceMs,slices};
}

assert.ok(globalThis.gc,'Use node --expose-gc');
const source=path.resolve(process.argv[2]),output=process.argv[3]||'artifacts/document-memory.json';
const bytes=await readFile(source),sha=bytes=>createHash('sha256').update(bytes).digest('hex'),sourceDigest=sha(bytes);
{
  globalThis.gc();const before=process.memoryUsage();
  const response=await nodeCodec().fetch(`/api/import?filename=${encodeURIComponent(path.basename(source))}`,
    {method:'POST',headers:{Accept:NATIVE_FRAME_CONTENT_TYPE,'Content-Type':'application/octet-stream'},body:bytes});
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),NATIVE_FRAME_CONTENT_TYPE);
  const wire=await response.arrayBuffer(),{result,offset}=unpackNativeFrameResponse(wire);
  await materializeNativeFrames(result,wire,offset);
  const editor=new Editor({demo:false,propertyChannels:true,layerTimeline:true}).load(result.document);
  const {_stykSource,...renderReport}=editor.report;
  if(renderReport._styk?.audio){const {audio,...rest}=renderReport._styk;renderReport._styk=rest;}
  globalThis.gc();const loaded=process.memoryUsage(),rows=[];
  for(let i=0;i<3;i++){
    globalThis.gc();const memoryBefore=process.memoryUsage();
    const row=await inventory(renderReport),memoryAfter=process.memoryUsage();
    globalThis.gc();rows.push({...row,memoryBefore,memoryAfter,afterGC:process.memoryUsage()});
  }
  const report={source:{name:path.basename(source),bytes:bytes.length,sha256:sourceDigest,frames:editor.report.keyframes.length},
    environment:{node:process.version,v8:process.versions.v8,cpu:os.cpus()[0].model,ramBytes:os.totalmem()},before,loaded,
    heapDeltaBytes:loaded.heapUsed-before.heapUsed,wireBytes:wire.byteLength,rows,
    limitations:['Node heap calibration, not Electron/GPU working-set measurement. Import also initializes modules/runtime caches.',
      'Explicit GC outside inventory timings. Object/slot weights are conservative estimates, not V8 object sizes.',
      'Original wire buffer remains retained and is reported separately. Other workstation activity is uncontrolled.']};
  assert.equal(sha(await readFile(source)),sourceDigest);
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({heapDeltaBytes:report.heapDeltaBytes,wireBytes:wire.byteLength,rows:rows.map(({counts,estimatedBytes,elapsedMs,workMs,maxSliceMs})=>({counts,estimatedBytes,elapsedMs,workMs,maxSliceMs}))}));
}
