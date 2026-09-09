import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackRasterCache} from '../src/playback-raster-cache.mjs';
const bitmap=()=>({width:2,height:2,closed:0,close(){this.closed++;}});
test('worker raster reuse gives packets independent owners and evicts within budget',async()=>{
  const cache=new PlaybackRasterCache({maxBytes:32,clone:async()=>bitmap()}),originals=[];
  const rasterize=()=>{const b=bitmap();originals.push(b);return b;};
  const a=await cache.packetBitmap('a',rasterize),b=await cache.packetBitmap('a',rasterize);
  assert.notEqual(a,b);a.close();assert.equal(b.closed,0);assert.equal(originals.length,1);
  await cache.packetBitmap('b',rasterize);await cache.packetBitmap('a',rasterize);await cache.packetBitmap('c',rasterize);
  assert.equal(originals[1].closed,1);assert.equal(originals[0].closed,0);assert.equal(cache.bytes,32);
  assert.equal(cache.hits,2);cache.dispose();cache.dispose();assert.equal(originals[0].closed,1);assert.equal(b.closed,0);
  await assert.rejects(cache.packetBitmap('a',rasterize),{name:'AbortError'});
});
test('oversized and unidentified rasters pass ownership directly without cache growth',async()=>{
  const cache=new PlaybackRasterCache({maxBytes:8,clone:()=>{throw Error('Should not clone');}}),a=bitmap();
  assert.equal(await cache.packetBitmap('a',()=>a),a);assert.equal(cache.bytes,0);cache.dispose();assert.equal(a.closed,0);
});
test('invalidation during an asynchronous clone closes both owners',async()=>{
  let resolve;const original=bitmap(),packet=bitmap(),cache=new PlaybackRasterCache({clone:()=>new Promise(r=>resolve=r)});
  const pending=cache.packetBitmap('a',()=>original);cache.dispose();resolve(packet);
  await assert.rejects(pending,{name:'AbortError'});assert.equal(original.closed,1);assert.equal(packet.closed,1);assert.equal(cache.bytes,0);
});
