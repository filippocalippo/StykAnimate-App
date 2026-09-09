import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {DocumentExporter} from '../src/document-export.mjs';
import {installNativeFrameClipboard} from '../src/frame-clipboard-storage.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function nativeStore(){const saved=[],parts=[];return{saved,api:{beginClipboardRead:async()=>null,
  beginClipboardWrite:async()=>({token:'owned-clipboard',maxChunkBytes:256*1024}),
  writeFileChunk:async(_token,bytes)=>parts.push(new Uint8Array(bytes)),
  finishFileWrite:async()=>{saved.push(await new Blob(parts.splice(0)).text());return{saved:true};},cancelFileWrite:async()=>{parts.length=0;}}};}

test('cancelled new Copy does not abort persistence of the previous successful clipboard',async t=>{
  const e=new Editor(),native=nativeStore(),jobs=[];
  t.mock.method(DocumentExporter.prototype,'export',function(report,{signal}){return new Promise((resolve,reject)=>{
    const job={report,signal,resolve,reject,aborted:false};jobs.push(job);signal.addEventListener('abort',()=>{job.aborted=true;reject(new DOMException('Cancelled','AbortError'));},{once:true});});});
  const storage=installNativeFrameClipboard(e,native.api,{baseURL:'http://127.0.0.1:47831'});t.after(()=>storage.dispose());await storage.ready;
  e.copyFrames([0]);await turn();assert.equal(jobs.length,1);const old=e._frameClipboard;
  e.setFrameClipboardWorker({run:async()=>{throw new DOMException('Cancelled','AbortError');}});
  await assert.rejects(e.copyFramesAsync([0]),{name:'AbortError'});
  assert.equal(e._frameClipboard,old);assert.equal(jobs[0].aborted,false);
  jobs[0].resolve(new Blob(['previous-completed-copy']));await storage.flush();
  assert.deepEqual(native.saved,['previous-completed-copy']);assert.equal(storage.error,null);
});

test('a newer successful Copy supersedes an older pending native write without stale persistence',async t=>{
  const e=new Editor(),native=nativeStore(),jobs=[];
  t.mock.method(DocumentExporter.prototype,'export',function(report,{signal}){return new Promise((resolve,reject)=>{
    const job={report,signal,resolve,aborted:false};jobs.push(job);signal.addEventListener('abort',()=>{job.aborted=true;reject(new DOMException('Cancelled','AbortError'));},{once:true});});});
  const storage=installNativeFrameClipboard(e,native.api,{baseURL:'http://127.0.0.1:47831'});t.after(()=>storage.dispose());await storage.ready;
  e.copyFrames([0]);await turn();e.copyFrames([0]);await turn();
  assert.equal(jobs.length,2);assert.equal(jobs[0].aborted,true);assert.equal(jobs[1].aborted,false);
  jobs[1].resolve(new Blob(['newest-copy']));await storage.flush();assert.deepEqual(native.saved,['newest-copy']);
});
