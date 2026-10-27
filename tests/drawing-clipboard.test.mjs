import test from 'node:test';
import assert from 'node:assert/strict';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';
import {validatePixelClipboard} from '../src/drawing-clipboard.mjs';
import {indexedTileCoverage} from '../src/drawing-transform.mjs';
import {encodeDrawingPNG} from '../src/drawing-png.mjs';
import {clipboardWireChunks,createClipboardWireDecoder} from '../src/clipboard-wire.mjs';
import {restoreClipboard} from '../src/shared-clipboard.mjs';

const clip=(tiles,bounds={x:-6400000,y:0,width:12800064,height:64})=>({version:2,pixelsPerUnit:1,world:{x:10,y:20},matrix:[1,0,0,1,10,20],bounds,tiles});
const pixels=()=>Uint8ClampedArray.from({length:TILE_BYTES},(_,i)=>i%4===3?i%256:(i*7)%256);
const tilePNG=async(tx,ty)=>({tx,ty,png:await encodeDrawingPNG(pixels(),64,64)});

test('sparse clipboard crosses the wire without flattening distant pixels or changing exact RGBA',async()=>{
  const tiles=[await tilePNG(-100000,0),await tilePNG(100000,0)];
  const data=clip(tiles),decoder=createClipboardWireDecoder({maxBytes:1024*1024,maxResidentBytes:1024*1024});
  for await(const part of clipboardWireChunks(data))await decoder.push(part);
  const restored=decoder.finish();decoder.dispose();assert.deepEqual(restored,data);
  assert.equal(validatePixelClipboard(restored).pixelBytes,TILE_BYTES*2);
});

test('clipboard metadata rejects invalid indices and poses without replacing a previous copy',async()=>{
  const tiles=[await tilePNG(0,0)],data=clip(tiles,{x:0,y:0,width:64,height:64}),editor={_drawingPixelClipboard:'before',_emit:()=>{}};
  const cases=[{version:3},{tiles:[...tiles,...tiles]},{tiles:[{...tiles[0],tx:.5}]},{tiles:[{...tiles[0],tx:0x80000000}]},{bounds:null},{bounds:{x:1000,y:0,width:2,height:2}},{matrix:[0,0,0,0,0,0]},{world:{x:NaN,y:0}},{tiles:[{...tiles[0],png:'data:text/plain,hi'}]}];
  for(const change of cases){await assert.rejects(restoreClipboard(editor,{format:'StykAnimate clipboard',version:1,kind:'drawing-pixels',data:{...data,...change}}));assert.equal(editor._drawingPixelClipboard,'before');}
  await restoreClipboard(editor,{format:'StykAnimate clipboard',version:1,kind:'drawing-pixels',data});assert.deepEqual(editor._drawingPixelClipboard,data);
});

test('serialized tile index plans sparse paste support and keeps filtering neighbors',()=>{
  const keys=indexedTileCoverage([{tx:-100000,ty:0},{tx:100000,ty:0}],[1,0,0,1,64,0],'nearest');
  assert.equal(keys.size,2);assert.ok(keys.has('-99999,0'));assert.ok(keys.has('100001,0'));assert.ok(!keys.has('0,0'));
  const smooth=indexedTileCoverage([{tx:0,ty:0}],[1,0,0,1,0,0],'smooth');assert.ok(smooth.has('-1,0'));assert.ok(smooth.has('1,0'));
  assert.throws(()=>indexedTileCoverage([{tx:0,ty:0}],[1e9,0,0,1e9,0,0]),/memory/);
});

test('empty sparse selections remain empty without manufacturing a dense image',()=>{
  const data=clip([],null);assert.equal(validatePixelClipboard(data).pixelBytes,0);
});
