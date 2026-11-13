import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingPreviewCache} from '../src/drawing-preview-cache.mjs';
import {TileStore} from '../src/drawing-tiles.mjs';
const rect={x:0,y:0,width:64,height:64};
const idle=async()=>{for(let i=0;i<4;i++)await Promise.resolve();};
function fixture(options={}){
  const jobs=[],closed=[],worker={request(kind,data){return new Promise((resolve,reject)=>jobs.push({kind,data,resolve,reject}));},dispose(){}},cache=new DrawingPreviewCache(worker,{budgetBytes:64*64*4,...options}),entry={id:'preview',store:new TileStore(),stamp:0,pixelStamp:0};
  entry.store.set(0,0,new Uint8ClampedArray([12,34,56,255]));
  const finish=i=>{const bitmap={width:64,height:64,close(){closed.push(i);this.width=this.height=0;}};jobs[i].resolve({bitmap});return bitmap;};
  return{jobs,cache,entry,finish,closed};
}
test('preview displays completed revisions while input continues and sends only changed tiles',async()=>{
  const {jobs,cache,entry,finish,closed}=fixture();try{
    assert.equal(cache.scratch(entry,rect),null);assert.equal(jobs[0].data.tiles.length,1);
    entry.store.set(0,0,new Uint8ClampedArray([255,0,0,255]));entry.pixelStamp++;
    const first=finish(0);await idle();assert.deepEqual(closed,[]);assert.equal(cache.cache.size,1);
    const partial=cache.scratch(entry,rect);assert.equal(partial.canvas,first);assert.equal(partial.version,0);
    entry.stamp++;assert.equal(cache.scratch(entry,rect).stamp,partial.stamp,'new input does not change the completed bitmap upload stamp');
    assert.equal(jobs[1].data.reset,false);assert.equal(new Uint8ClampedArray(jobs[1].data.tiles[0].pixels)[0],255);
    finish(1);await idle();assert.ok(cache.scratch(entry,rect));
    cache.scratch(entry,rect,{level:1});assert.equal(jobs[2].data.tiles.length,0,'a new mip reuses the worker source');finish(2);await idle();
    assert.ok(cache.bytes<=cache.budgetBytes);assert.ok(closed.includes(1),'LRU eviction closes the old bitmap');
  }finally{cache.dispose();}assert.ok(closed.includes(2));
});

test('growing covers reuse the newest overlapping snapshot and still request the new cover',async()=>{
  const {jobs,cache,entry,finish}=fixture({budgetBytes:1024*1024});try{
    cache.scratch(entry,rect);const first=finish(0);await idle();
    entry.store.set(1,0,new Uint8ClampedArray([1,2,3,255]));entry.pixelStamp++;
    assert.equal(cache.scratch(entry,{...rect,width:128}).canvas,first);assert.equal(jobs.length,2);
    finish(1);await idle();assert.equal(cache.scratch(entry,{...rect,width:128}).version,1);
    // A newly uncovered anchor needs work even when the pixels did not change.
    entry.store.set(3,0,new Uint8ClampedArray([1,2,3,255]));
    cache.scratch(entry,{...rect,width:256});assert.equal(jobs.length,3);
    finish(2);await idle();
  }finally{cache.dispose();}
});

test('yielding source copies preserve one snapshot while in-place writes continue',async()=>{
  const holds=new Map(),{jobs,cache,entry,finish}=fixture({budgetBytes:64*1024*1024,hold:(key,bytes)=>bytes?holds.set(key,bytes):holds.delete(key)});
  for(let tx=1;tx<130;tx++)entry.store.set(tx,0,new Uint8ClampedArray([12,34,56,255]));
  try{
    const cover={x:0,y:0,width:130*64,height:64};cache.scratch(entry,cover,{level:2});
    assert.equal(jobs.length,0,'copy yielded before submitting the full viewport');
    const old=entry.store.get(129,0);entry.store.writable(129,0).pixels[0]=255;entry.pixelStamp++;
    assert.notEqual(entry.store.get(129,0),old);assert.equal(old.pixels[0],12);
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(jobs.length,1);
    assert.equal(new Uint8Array(jobs[0].data.tiles.at(-1).pixels)[0],12);
    finish(0);await idle();assert.equal(holds.size,1,'temporary snapshot/transfer reservation released');
    assert.equal(cache.scratch(entry,cover,{level:2}).version,0);assert.equal(jobs[1].data.tiles.length,1);
    assert.equal(new Uint8Array(jobs[1].data.tiles[0].pixels)[0],255);finish(1);await idle();
  }finally{cache.dispose();}assert.equal(holds.size,0);
});

for(const invalidation of ['drop','replace','dispose'])test(`preview rejects a completed snapshot after ${invalidation}`,async()=>{
  const {jobs,cache,entry,finish,closed}=fixture();
  cache.scratch(entry,rect);
  if(invalidation==='drop')cache.drop(entry);else if(invalidation==='replace')entry.store=entry.store.fork();else cache.dispose();
  finish(0);await idle();assert.deepEqual(closed,[0]);assert.equal(cache.cache.size,0);assert.equal(cache.source,null);
  if(invalidation!=='dispose'){cache.scratch(entry,rect);assert.equal(jobs[1].data.reset,true);finish(1);await idle();assert.ok(cache.scratch(entry,rect));}
  cache.dispose();
});
test('preview worker failures back off until source pixels change',async()=>{
  let calls=0,errors=0;const cache=new DrawingPreviewCache({request(){calls++;return Promise.reject(Error('worker lost'));},dispose(){}},{onError:()=>errors++}),entry={id:'failed',store:new TileStore(),stamp:0,pixelStamp:0};entry.store.set(0,0,new Uint8ClampedArray([1,2,3,255]));
  try{cache.scratch(entry,rect);await idle();cache.scratch(entry,rect);await idle();assert.equal(calls,1);assert.equal(errors,1);entry.pixelStamp++;cache.scratch(entry,rect);await idle();assert.equal(calls,2);}finally{cache.dispose();}
});

test('dropping a yielding copy cancels it before submission and releases reservations',async()=>{
  const holds=new Map(),{jobs,cache,entry}=fixture({budgetBytes:64*1024*1024,hold:(key,bytes)=>bytes?holds.set(key,bytes):holds.delete(key)});
  for(let tx=1;tx<130;tx++)entry.store.set(tx,0,new Uint8ClampedArray([1,2,3,255]));
  cache.scratch(entry,{x:0,y:0,width:130*64,height:64},{level:2});assert.equal(jobs.length,0);assert.equal(holds.size,2);
  cache.drop(entry);await new Promise(resolve=>setTimeout(resolve,5));assert.equal(jobs.length,0);assert.equal(holds.size,0);cache.dispose();
});

test('snapshot reservation failure leaves source pixels unchanged and starts no worker request',async()=>{
  const holds=new Map();let error;
  const {jobs,cache,entry}=fixture({hold:(key,bytes)=>{if(bytes&&key!==cache)throw Error('snapshot budget');bytes?holds.set(key,bytes):holds.delete(key);},onError:e=>error=e});
  const tile=entry.store.get(0,0),pixels=tile.pixels.slice();cache.scratch(entry,rect);await idle();
  assert.match(error.message,/snapshot budget/);assert.equal(jobs.length,0);assert.equal(tile.frozen,false);assert.deepEqual(tile.pixels,pixels);assert.equal(holds.size,0);cache.dispose();
});

test('fallback snapshots never come from a different surface with the same cel id',async()=>{
  const {cache,entry,finish,jobs}=fixture();cache.scratch(entry,rect);finish(0);await idle();
  const other={...entry,store:entry.store.fork()};assert.equal(cache.scratch(other,rect),null);assert.equal(jobs[1].data.reset,true);finish(1);await idle();
  assert.equal(cache.scratch(other,rect).entry,other);cache.dispose();
});

test('a failed update retains its last completed image without retrying the failed revision',async()=>{
  const {cache,entry,finish,jobs}=fixture();cache.scratch(entry,rect);const first=finish(0);await idle();
  entry.pixelStamp++;assert.equal(cache.scratch(entry,rect).canvas,first);jobs[1].reject(Error('preview lost'));await idle();
  assert.equal(cache.scratch(entry,rect).canvas,first);assert.equal(jobs.length,2);
  entry.pixelStamp++;cache.scratch(entry,rect);assert.equal(jobs.length,3);assert.equal(jobs[2].data.reset,true);finish(2);await idle();cache.dispose();
});

test('zooming to a new mip level shows the nearest level until its own snapshot is ready',async()=>{
  const {jobs,cache,entry,finish}=fixture({budgetBytes:1024*1024});try{
    cache.scratch(entry,rect);const level0=finish(0);await idle();
    // Nothing exists at level 1 yet: the level 0 snapshot stands in, scaled,
    // instead of a blank frame, and level 1 is requested.
    const stand=cache.scratch(entry,rect,{level:1});
    assert.equal(stand.canvas,level0);assert.equal(stand.level,0);assert.equal(jobs.at(-1).data.level,1);
    const level1=finish(jobs.length-1);await idle();
    assert.equal(cache.scratch(entry,rect,{level:1}).canvas,level1,'the right level replaces the stand-in');
    // A snapshot of a replaced store never stands in.
    entry.store=new TileStore();entry.store.set(0,0,new Uint8ClampedArray([1,1,1,255]));
    assert.equal(cache.scratch(entry,rect,{level:2}),null);
  }finally{cache.dispose();}
});

test('a preview worker that ended is sent every tile again, not only the changed ones',async()=>{
  const {jobs,cache,entry,finish}=fixture({budgetBytes:1024*1024});
  const worker=cache.worker;worker.instance=1;worker.active=true;
  entry.store.set(1,0,new Uint8ClampedArray([1,2,3,255]));
  try{
    cache.scratch(entry,{...rect,width:128});finish(0);await idle();
    entry.store.set(1,0,new Uint8ClampedArray([4,5,6,255]));entry.pixelStamp++;
    cache.scratch(entry,{...rect,width:128});assert.deepEqual([jobs[1].data.reset,jobs[1].data.tiles.length],[false,1],'the same worker gets the changed tile');finish(1);await idle();
    // The worker ended while idle; the next one starts empty.
    worker.instance=2;entry.store.set(1,0,new Uint8ClampedArray([7,8,9,255]));entry.pixelStamp++;
    cache.scratch(entry,{...rect,width:128});assert.deepEqual([jobs[2].data.reset,jobs[2].data.tiles.length],[true,2]);finish(2);await idle();
  }finally{cache.dispose();}
});
