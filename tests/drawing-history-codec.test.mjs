import test from 'node:test';
import assert from 'node:assert/strict';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';
import {HISTORY_CHUNK_BYTES,historyChunks} from '../src/drawing-history-codec.mjs';
import {loadDrawingEngine,encodeHistoryChunk,decodeHistoryChunk} from '../src/engine/engine-drawing.mjs';

// Undo chunks are encoded by the drawing raster engine.
await loadDrawingEngine();

test('history chunks round-trip exact null, uniform and full RGBA sides',()=>{
  const pixels=Uint8ClampedArray.from({length:TILE_BYTES},(_,i)=>(i*17)%256),tiles=[{tx:-12345,ty:90,before:null,after:new Uint8ClampedArray([127,5,249,1])},{tx:12345,ty:-90,before:pixels,after:null},{tx:0,ty:0,before:pixels,after:pixels.slice()}];
  assert.deepEqual(decodeHistoryChunk(encodeHistoryChunk(tiles)),tiles);
});
test('large history records stream in bounded independently decodable chunks',()=>{
  const tiles=Array.from({length:1000},(_,tx)=>({tx,ty:0,before:new Uint8ClampedArray(TILE_BYTES).fill(tx%256),after:new Uint8ClampedArray(TILE_BYTES).fill((tx+1)%256)})),restored=[];
  let count=0;for(const chunk of historyChunks(tiles)){const bytes=encodeHistoryChunk(chunk);assert.ok(bytes.length<=HISTORY_CHUNK_BYTES);restored.push(...decodeHistoryChunk(bytes));count++;}
  assert.ok(count>30);assert.deepEqual(restored,tiles);
});
test('invalid or truncated undo bytes are rejected before decoding tile buffers',()=>{
  const good=encodeHistoryChunk([{tx:0,ty:0,before:null,after:new Uint8ClampedArray([1,2,3,4])}]);
  assert.throws(()=>decodeHistoryChunk(good.slice(0,-1)),/damaged|truncated/);
  const invalid=good.slice();new DataView(invalid.buffer).setUint32(24,0xffffffff,true);assert.throws(()=>decodeHistoryChunk(invalid),/damaged/);
  assert.throws(()=>encodeHistoryChunk([{tx:0,ty:0,before:new Uint8Array(7),after:null}]),/Invalid/);
});
