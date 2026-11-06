import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {DrawingHistory} from '../src/drawing-history.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {TILE_BYTES,TileStore,tileTransparent} from '../src/drawing-tiles.mjs';
import {TileEncodeCache,decodeTileBlob,TILE_BLOB_PREFIX} from '../src/drawing-tile-codec.mjs';
import {encodeDrawingPNG,drawingPNGBytes,decodeDrawingPNGBytes} from '../src/drawing-png.mjs';
import {crc32} from '../src/sticknodes/decoder/archive.mjs';

test('tight tile bounds match a full alpha scan for sparse, translucent and dense pixels',()=>{
  let seed=13;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/2**32);
  for(let trial=0;trial<300;trial++){
    const pixels=new Uint8ClampedArray(TILE_BYTES);let x0=64,y0=64,x1=-1,y1=-1;
    for(let y=0;y<64;y++)for(let x=0;x<64;x++){
      const i=(y*64+x)*4;pixels[i]=127;pixels[i+2]=249;
      const visible=trial<64?x===trial&&y===63-trial:random()<[0,.001,.01,.2,1][trial%5];
      if(visible){pixels[i+3]=trial%2?1:255;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
    }
    const store=new TileStore();store.set(-2,3,pixels);
    assert.deepEqual(store.bounds,x1<0?null:{x:x0-128,y:y0+192,width:x1-x0+1,height:y1-y0+1},`trial ${trial}`);
    assert.equal(tileTransparent(store.get(-2,3)),x1<0);
  }
});

test('empty alpha bounds stay cached until writable invalidates them',()=>{
  const store=new TileStore();store.set(0,0,new Uint8ClampedArray([127,5,249,0]));
  const tile=store.get(0,0),pixels=tile.pixels;assert.equal(tileTransparent(tile),true);
  Object.defineProperty(tile,'pixels',{configurable:true,get(){throw new Error('rescan');}});
  assert.equal(tileTransparent(tile),true);assert.equal(store.bounds,null);
  Object.defineProperty(tile,'pixels',{configurable:true,value:pixels,writable:true});
  const fork=store.fork();store.writable(0,0).pixels.set([127,5,249,1],(20*64+12)*4);
  assert.deepEqual(store.bounds,{x:12,y:20,width:1,height:1});assert.equal(fork.bounds,null);
});

function workerStub(afterResponse=()=>{}){
  const cache=new TileEncodeCache(),calls=[];
  return{calls,async request(kind,payload,{transfer=[]}={}){
    assert.equal(kind,'encode-tiles');
    const bytes=transfer.reduce((n,b)=>n+b.byteLength,0),data=structuredClone(payload,{transfer});calls.push({bytes,partial:data.partial,tiles:data.tiles.length,pngs:data.tiles.filter(t=>t.png).length});
    const result=await cache.encode(data.celId,data.keep??null,data.tiles,{partial:data.partial});
    const reply={...result,tiles:result.tiles.map(t=>({...t,png:t.png.slice().buffer}))};
    if(result.bytes)reply.blobUrl=TILE_BLOB_PREFIX+Buffer.from(result.bytes).toString('base64');
    await afterResponse({data,reply,call:calls.length});return reply;
  },dispose(){}};
}
function fixture({worker=workerStub(),...options}={}){
  const figure=createDrawingFigure({celId:'publication'}),resources=new DrawingResources({figure_types:[figure]},{worker,history:false,...options});resources.busy=true;
  const entry=resources.install(figure,Array.from({length:130},(_,tx)=>({tx,ty:-2,pixels:new Uint8ClampedArray([tx,5,249,tx%2?1:255])})));
  return{figure,resources,entry,worker};
}
async function assertPublication(fixture){
  const {figure,entry}=fixture,tiles=await decodeTileBlob(figure.image_assets[0].styk_tiles);
  assert.equal(tiles.length,entry.store.size);
  for(const t of tiles)assert.deepEqual(t.pixels,entry.store.get(t.tx,t.ty).pixels);
  assert.equal(entry.published.revision,entry.revision);
}

test('publication transfers at most 1 MiB at once and publishes only the complete cel',async()=>{
  let f,peak=0;const worker=workerStub(({data})=>{
    peak=Math.max(peak,f.resources.workingBytes);
    if(data.partial)assert.equal(f.figure.image_assets[0].styk_tiles,undefined);
    for(const tile of f.entry.store)assert.equal(tile.pixels.byteLength,TILE_BYTES,'main pixels remain owned');
  });f=fixture({worker});
  try{
    await Promise.all([f.resources.flush(),f.resources.flush()]);
    assert.deepEqual(worker.calls.map(c=>c.tiles),[64,64,2]);assert.equal(peak,1024*1024);
    assert.ok(worker.calls.every(c=>c.bytes<=1024*1024));assert.equal(f.resources.workingBytes,0);
    assert.deepEqual(f.resources.lastEncode,{encoded:130,reused:0});await assertPublication(f);
  }finally{f.resources.dispose();}
});

test('cancelled publication retains committed pixels and retries after worker cache loss',async()=>{
  const controller=new AbortController();let f;
  f=fixture({worker:workerStub(({call})=>{if(call===2)controller.abort();})});
  try{
    const before=[...f.entry.store].map(t=>t.pixels.slice());
    await assert.rejects(f.resources.flush({signal:controller.signal}),{name:'AbortError'});
    assert.equal(f.figure.image_assets[0].styk_tiles,undefined);assert.equal(f.resources.workingBytes,0);
    assert.deepEqual([...f.entry.store].map(t=>t.pixels),before);
    f.resources.worker=workerStub();await f.resources.flush();
    assert.ok(f.resources.worker.calls.some(c=>c.pngs===64),'acknowledged PNGs restore the lost cache');
    assert.deepEqual(f.resources.lastEncode,{encoded:66,reused:64});await assertPublication(f);
  }finally{f.resources.dispose();}
});

test('a newer edit supersedes a partial publication without publishing mixed revisions',async()=>{
  let f;f=fixture({worker:workerStub(({call})=>{if(call===1)f.resources.apply(f.figure,[{tx:0,ty:-2,after:new Uint8ClampedArray([31,63,95,1])}],'after');})});
  try{
    await f.resources.flush();assert.deepEqual(f.entry.store.pixel(0,-128),[31,63,95,1]);
    assert.equal(f.worker.calls.length,4,'one obsolete batch then three current batches');await assertPublication(f);
  }finally{f.resources.dispose();}
});

test('publication waits for an undo or redo being prepared and never finishes the revision it replaces',async()=>{
  const ticks=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
  const replay=()=>{const history=new DrawingHistory({disk:{async close(){}},minRecordBytes:Infinity}),root={kind:'drawing-pixels',celId:'publication',tiles:[{tx:0,ty:-2,before:null,after:new Uint8ClampedArray([31,63,95,1])}]};history.track(root);return {history,root};};
  // The replay applies: the revision it replaces is never encoded, the new one is published once.
  let {history,root}=replay(),f=fixture({history});
  try{
    history.prepare(root);const flush=f.resources.flush();await ticks();
    assert.equal(f.worker.calls.length,0,'nothing is encoded while the replay is prepared');
    f.resources.apply(f.figure,root.tiles,'after');history.release(root);await flush;
    assert.deepEqual(f.worker.calls.map(c=>c.tiles),[64,64,2]);assert.deepEqual(f.entry.store.pixel(0,-128),[31,63,95,1]);await assertPublication(f);
  }finally{f.resources.dispose();await history.dispose();}
  // The replay fails: the unchanged revision is published once it ends.
  ({history,root}=replay());f=fixture({history});
  try{
    history.prepare(root);const flush=f.resources.flush();await ticks();
    assert.equal(f.worker.calls.length,0);history.release(root);await flush;
    assert.deepEqual(f.worker.calls.map(c=>c.tiles),[64,64,2]);await assertPublication(f);
  }finally{f.resources.dispose();await history.dispose();}
});

test('failed batch preserves the previous publication and retry reuses acknowledged PNGs',async()=>{
  const f=fixture();try{
    await f.resources.flush();const url=f.figure.image_assets[0].styk_tiles;
    f.resources.apply(f.figure,[...f.entry.store].map(t=>({tx:t.tx,ty:t.ty,after:new Uint8ClampedArray([3,6,9,1])})),'after');
    f.resources.worker=workerStub(({call})=>{if(call===2)throw new Error('worker stopped');});
    await assert.rejects(f.resources.flush(),/worker stopped/);assert.equal(f.figure.image_assets[0].styk_tiles,url);assert.equal(f.resources.workingBytes,0);
    await f.resources.flush();await assertPublication(f);
    assert.ok(f.resources.lastEncode.encoded<130);
  }finally{f.resources.dispose();}
});

test('publication reserves its transfer before copying and keeps the edit on budget failure',async()=>{
  const f=fixture({tileBytes:200*TILE_BYTES,hardBytes:194*TILE_BYTES-1});try{
    await assert.rejects(f.resources.flush(),/memory is full/);assert.equal(f.worker.calls.length,0);
    assert.equal(f.resources.workingBytes,0);assert.equal(f.entry.store.size,130);
    f.resources.hardBudget++;await f.resources.flush();await assertPublication(f);
  }finally{f.resources.dispose();}
});

test('closing a document during a partial publication releases the transfer and publishes nothing',async()=>{
  let f;f=fixture({worker:workerStub(({call})=>{if(call===1)f.resources.dispose();})});
  await assert.rejects(f.resources.flush(),{name:'AbortError'});
  assert.equal(f.worker.calls.length,1);assert.equal(f.resources.workingBytes,0);
  assert.equal(f.figure.image_assets[0].styk_tiles,undefined);assert.equal(f.resources.entries.size,0);
});

test('cache recovery re-encodes legacy PNGs with oversized ancillary data within the transfer bound',async()=>{
  const f=fixture();try{
    const tile=f.entry.store.get(0,-2),png=drawingPNGBytes(await encodeDrawingPNG(tile.pixels,64,64));
    const chunk=Buffer.alloc(2*1024*1024+12);chunk.writeUInt32BE(chunk.length-12);chunk.write('teXt',4);chunk.write('note',8);chunk.fill(65,13,chunk.length-4);chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);
    const large=Uint8Array.from(Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]));
    assert.deepEqual((await decodeDrawingPNGBytes(large)).pixels,tile.pixels);tile.png=large;
    await f.resources.flush();assert.ok(f.worker.calls.every(c=>c.bytes<=1024*1024));await assertPublication(f);
    assert.ok(tile.png.byteLength<1024*1024,'the publication retains a compact exact PNG');
  }finally{f.resources.dispose();}
});
