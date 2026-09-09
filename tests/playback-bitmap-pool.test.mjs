import test from 'node:test';
import assert from 'node:assert/strict';
import {PlaybackBitmapPool,packetFootprint} from '../src/playback-bitmap-pool.mjs';
import {PlaybackCache} from '../src/playback.mjs';
import {createDemo} from '../src/demo.mjs';
const bitmap=()=>({width:10,height:10,closed:0,close(){this.closed++;}});
const packet=(tick,key='same',revision=0)=>({tick,revision,byteLength:464,compileMs:1,compatibility:[{artworkKey:key,bitmap:bitmap()}]});

test('bitmap residency counts shared storage once and releases only its last owner',()=>{
  const pool=new PlaybackBitmapPool(),a=packet(0),b=packet(1),incoming=b.compatibility[0].bitmap,original=a.compatibility[0].bitmap;
  pool.acquire(a);assert.equal(pool.incrementalBytes(b),64);pool.acquire(b);
  assert.equal(pool.bytes,528);assert.equal(incoming.closed,1);assert.equal(b.compatibility[0].bitmap,original);
  pool.release(a);assert.equal(pool.bytes,464);assert.equal(original.closed,0);
  pool.release(b);assert.equal(pool.bytes,0);assert.equal(original.closed,1);pool.release(b);assert.equal(original.closed,1);
});

test('revision changes, missing identity, and distinct artwork never share pixels',()=>{
  const pool=new PlaybackBitmapPool(),packets=[packet(0),packet(1,'changed'),packet(2,'same',1),packet(3)];
  delete packets[3].compatibility[0].artworkKey;
  for(const p of packets)pool.acquire(p);assert.equal(pool.bytes,464*4);
  for(const p of packets)pool.release(p);assert.equal(pool.bytes,0);
  for(const p of packets)assert.equal(p.compatibility[0].bitmap.closed,1);
});

test('an inconsistent incoming resource is rejected before changing ownership',()=>{
  const pool=new PlaybackBitmapPool(),a=packet(0),b=packet(1);pool.acquire(a);b.compatibility[0].bitmap.width=20;
  assert.throws(()=>pool.acquire(b),/dimensions/);assert.equal(pool.bytes,464);assert.equal(b.compatibility[0].bitmap.closed,0);
  pool.release(a);assert.equal(pool.bytes,0);
});

test('prefetch discovers overlap, retains shared frames, and bounds admission of different artwork',async()=>{
  const messages=[],cache=new PlaybackCache({maxBytes:750,maxFrames:4,workerFactory:()=>({postMessage:m=>messages.push(m),addEventListener(){},terminate(){}})});
  cache.report=createDemo();cache.totalTicks=6;
  const feed=async(tick,key='same')=>{const request=cache.prepareRange([tick]);await Promise.resolve();const p=packet(tick,key);cache._receive({type:'packet',tick,revision:0,packet:p});await request;return p;};
  try{
    const a=await feed(0);assert.deepEqual(cache._feasiblePrefetch([0,1,2,3]),[0,1]);
    await feed(1);await feed(2);await feed(3);
    assert.deepEqual(cache._feasiblePrefetch([0,1,2,3]),[0,1,2,3]);assert.equal(cache.stats.bytes,656);assert.equal(cache.stats.evictions,0);
    const footprint=packetFootprint(a);assert.equal(footprint.base,64);assert.equal(footprint.resources.length,1);
    await feed(4,'different');assert.equal(cache.cache.size,1);assert.equal(cache.stats.bytes,464);
    assert.equal(a.compatibility[0].bitmap.closed,1);cache.invalidate();assert.equal(cache.stats.bytes,0);assert.equal(cache.bitmapPool.resources.size,0);
  }finally{cache.dispose();}
});
