import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingHistory} from '../src/drawing-history.mjs';
import {pixelChangeBytes} from '../src/drawing-pixels.mjs';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function diskFixture(){
  const records=new Map();return {records,async request(kind,data){
    const id=data.record;
    if(kind==='begin')records.set(id,[]);
    if(kind==='append'){if(this.writeGate)await this.writeGate.promise;if(this.writeError)throw this.writeError;records.get(id).push(structuredClone(data.tiles));}
    if(kind==='finish')return {result:{storedBytes:records.get(id).flat().length*TILE_BYTES}};
    if(kind==='info')return {result:{parts:records.get(id).length,tiles:records.get(id).flat().length}};
    if(kind==='read'){if(this.readGate)await this.readGate.promise;if(this.readError)throw this.readError;return {tiles:structuredClone(records.get(id)[data.part])};}
    if(kind==='remove')records.delete(id);return {};
  },async close(){records.clear();}};
}
function command(n=4){const tiles=Array.from({length:n},(_,tx)=>({tx,ty:0,before:null,after:new Uint8ClampedArray(TILE_BYTES).fill(tx+1)}));return {kind:'drawing-pixels',celId:'test',tiles,bytes:pixelChangeBytes(tiles)};}

test('history stays in RAM until its disk commit, then reloads exact bytes',async()=>{
  const disk=diskFixture(),gate=disk.writeGate=deferred(),history=new DrawingHistory({disk,hotBytes:0,minRecordBytes:1}),root=command(),expected=structuredClone(root.tiles),original=root.bytes;
  try{
    history.track(root);assert.ok(root.bytes<original);await Promise.resolve();assert.ok(root.tiles);assert.equal(history.residentBytes,4*TILE_BYTES);
    gate.resolve();await history.pumping;assert.equal(root.tiles,null);assert.equal(history.residentBytes,0);
    await history.prepare(root);assert.deepEqual(root.tiles,expected);assert.equal(history.residentBytes,4*TILE_BYTES);
    history.trim(0);assert.ok(root.tiles,'replay pins loaded bytes');history.release(root);assert.equal(root.tiles,null);assert.equal(history.residentBytes,0);
  }finally{await history.dispose();}
});

test('quota failure retains exact RAM history and restores its chronological weight',async()=>{
  const disk=diskFixture();disk.writeError=new DOMException('Full','QuotaExceededError');const warnings=[],history=new DrawingHistory({disk,hotBytes:0,minRecordBytes:1,onWarning:e=>warnings.push(e.message)}),root=command(),original=root.bytes;let delta=0;
  try{history.track(root,n=>delta+=n);await history.pumping;assert.ok(root.tiles);assert.equal(root.bytes,original);assert.equal(delta,4*TILE_BYTES);assert.equal(history.enabled,false);assert.equal(warnings.length,1);assert.equal(history.prepare(root),null);history.release(root);}finally{await history.dispose();}
});

test('small and fallback RAM histories stay accounted without starting a disk worker',async()=>{
  let calls=0;const disk={request(){calls++;throw Error('Unexpected disk request');},async close(){}},history=new DrawingHistory({disk,minRecordBytes:1024*1024}),small=command(1),large=command(80),weight=small.bytes;
  try{
    history.track(small);assert.equal(small.bytes,weight);assert.equal(history.residentBytes,TILE_BYTES);assert.equal(history.pumping,undefined);
    history.enabled=false;history.track(large);assert.equal(history.residentBytes,81*TILE_BYTES);history.trim(0);assert.ok(small.tiles&&large.tiles);
    history.retain([]);assert.equal(history.residentBytes,0);assert.equal(calls,0);
  }finally{await history.dispose();}
});

test('repeated disposal joins the same outstanding disk cleanup',async()=>{
  const gate=deferred(),disk=diskFixture();let calls=0;disk.close=()=>{calls++;return gate.promise;};const history=new DrawingHistory({disk});
  const first=history.dispose(),second=history.dispose();assert.equal(first,second);assert.equal(calls,1);assert.equal(history.disposed,true);gate.resolve();await first;
});

test('history eviction removes disk records and does not retain retired pixel arrays',async()=>{
  const disk=diskFixture(),history=new DrawingHistory({disk,minRecordBytes:1}),first=command(),second=command();
  try{history.track(first);history.track(second);await history.pumping;history.retain([second]);await Promise.resolve();assert.equal(history.records.size,1);assert.equal(history.residentBytes,4*TILE_BYTES);assert.equal(first.tiles,null);assert.equal(disk.records.size,1);}finally{await history.dispose();}
});

test('retiring a command keeps an unfinished writer in the memory budget',async()=>{
  const disk=diskFixture(),gate=disk.writeGate=deferred(),history=new DrawingHistory({disk,minRecordBytes:1}),root=command();
  try{
    history.track(root);await Promise.resolve();await Promise.resolve();history.retain([]);
    assert.equal(root.tiles,null);assert.equal(history.residentBytes,4*TILE_BYTES);
    gate.resolve();await history.pumping;assert.equal(history.residentBytes,0);assert.equal(history.records.size,0);
  }finally{gate.resolve();await history.dispose();}
});

test('concurrent cold readers share one load and release their own pins',async()=>{
  const disk=diskFixture(),history=new DrawingHistory({disk,hotBytes:0,minRecordBytes:1}),root=command();
  try{
    history.track(root);await history.pumping;disk.readGate=deferred();const first=history.prepare(root),second=history.prepare(root);
    disk.readGate.resolve();await Promise.all([first,second]);assert.equal(history.residentBytes,4*TILE_BYTES);
    history.release(root);assert.ok(root.tiles);history.release(root);assert.equal(root.tiles,null);assert.equal(history.residentBytes,0);
  }finally{await history.dispose();}
});

