// Execute the actual worker source with controlled native result and browser
// primitives: transport source selection must follow its receipt, not cpu().
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/engine/engine-preview-worker.mjs',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
async function harness({pixels=true,cancel=false,queued=false}={}) {
  let receive,finish;const answers=[],copies=[];let ended=0,closed=0,draws=0;
  const values=[0,0,960,540,16,16,24,255,.25,0,0,.25,15,0,15,0,240,135,1];
  const previews={probe(){},cpu:()=>false,backend:()=> 'controlled GPU owner',monitor_begin(){},monitor:()=>{draws++;return 0;},
    monitor_background:()=>new Float64Array(values),monitor_pixels:()=>pixels,picture(data){data.fill(11);},monitor_end(){ended++;}};
  class Canvas {constructor(w,h){this.width=w;this.height=h;}getContext(){return{drawImage(){},getImageData(){return{data:[255,0,255,255]};},putImageData(){assert.fail('direct sources cannot use the old Canvas conversion');}};}transferToImageBitmap(){copies.push('gpu');return{close(){closed++;}};}}
  class Data {constructor(w,h){this.width=w;this.height=h;this.data=new Uint8ClampedArray(w*h*4);}}
  const ctx=vm.createContext({initSync:()=>({}),Previews:{create:async()=>previews},OffscreenCanvas:Canvas,ImageData:Data,performance,Atomics,Int32Array,Float64Array,Uint8ClampedArray,DOMException,setTimeout,
    createImageBitmap(image){copies.push(['ImageData',image.data[0]]);return new Promise(resolve=>finish=()=>resolve({close(){closed++;}}));},
    self:{addEventListener(_name,listener){receive=listener;},postMessage(message){answers.push(message);}}});
  vm.runInContext(source,ctx);
  const send=data=>receive({data});send({operation:'start',id:0,memory:{buffer:new SharedArrayBuffer(16)},progress:0});
  await new Promise(resolve=>setImmediate(resolve));
  send({operation:'monitor',id:1,address:9,width:2,height:2,zoom:.25,panX:15,panY:0,dpr:1});
  await new Promise(resolve=>setImmediate(resolve));
  if (cancel)send({operation:'cancel',request:1});
  if (queued) {
    send({operation:'monitor',id:2,address:10,width:2,height:2,zoom:.25,panX:15,panY:0,dpr:1});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(draws,1,'no next native monitor may overwrite pixels while the first bitmap is pending');
  }
  finish?.();await new Promise(resolve=>setImmediate(resolve));
  if (queued) { assert.equal(draws,2);finish?.();await new Promise(resolve=>setImmediate(resolve)); }
  return{answers,copies,ended,closed,values};
}
test('direct result receipt converts existing pixels from ImageData even on the GPU worker',async()=>{
  const h=await harness();const answer=h.answers.find(x=>x.id===1);
  assert.equal(answer.ok,true);assert.equal(answer.gpuSource,false);assert.equal(answer.rootBackground.dpr,1);assert.deepEqual(Array.from(answer.rootBackground.matrix),h.values.slice(8,14));
  assert.deepEqual(h.copies,['gpu',['ImageData',11]],'only startup probe uses the GPU canvas');assert.equal(h.ended,1);
});
test('completed GPU source receipt transfers the same existing GPU canvas picture',async()=>{
  const h=await harness({pixels:false});const answer=h.answers.find(x=>x.id===1);
  assert.equal(answer.ok,true);assert.equal(answer.gpuSource,true);assert.deepEqual(h.copies,['gpu','gpu']);assert.equal(h.ended,1);
});
test('cancel during ImageData bitmap creation closes it before any successful packet',async()=>{
  const h=await harness({cancel:true});const answer=h.answers.find(x=>x.id===1);
  assert.equal(answer.ok,false);assert.equal(answer.name,'AbortError');assert.equal(answer.bitmap,undefined);assert.equal(h.closed,2,'startup probe and cancelled result released');assert.equal(h.ended,1);
});

test('the existing worker queue retains each extracted packet across bitmap creation',async()=>{
  const h=await harness({queued:true});assert.equal(h.answers.filter(x=>x.id>0&&x.ok).length,2);assert.equal(h.ended,2);
  assert.deepEqual(h.copies,['gpu',['ImageData',11],['ImageData',11]]);
});
