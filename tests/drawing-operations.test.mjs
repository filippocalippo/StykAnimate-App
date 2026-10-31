import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingController} from '../src/drawing-controller.mjs';
import {restoreClipboard} from '../src/shared-clipboard.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {TILE_BYTES,TileStore} from '../src/drawing-tiles.mjs';

function fixture(){
  const d=Object.create(DrawingController.prototype),holds=new Map();
  Object.assign(d,{owner:{busy:false,needsPreparation:()=>false,hold:(k,n)=>n?holds.set(k,n):holds.delete(k)},editor:{revision:1},sequence:0,overlay:{hasPointerCapture:()=>false},onStatus:()=>{},onRender:()=>{},onOverlayRender:()=>{},finish:()=>{},applySelection:()=>{},holds});
  return d;
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('hover requests only feedback while drawing interaction includes pending pixel work',()=>{
  const d=fixture();let renders=0,overlays=0;d.onRender=()=>renders++;d.onOverlayRender=()=>overlays++;
  const event={pointerId:7,clientX:30,clientY:50,timeStamp:12};
  d.move(event);assert.equal(renders,0);assert.equal(overlays,1);assert.equal(d.interacting,false);
  d.loading={id:7,samples:[]};d.move(event);assert.equal(d.interacting,true);assert.equal(d.loading.samples.length,1);
  d.up(event,true);assert.equal(d.loading.released,true,'pointer interruption finishes queued ink');d.loading=null;
  for(const key of ['gesture','loading','operation']){d[key]={};assert.equal(d.interacting,true);d[key]=null;}
});

test('input tile copying shares one reservation across source and destination',async()=>{
  const d=fixture(),store=new TileStore();store.set(0,0,new Uint8ClampedArray([1,2,3,255]));
  const op={maxBytes:TILE_BYTES,check:()=>{}};
  const tiles=await d.copyWorkerTiles({store},op);assert.equal(tiles[0].pixels.byteLength,TILE_BYTES);
  await assert.rejects(d.copyWorkerTiles({store},op),/memory/);assert.equal(op.copiedBytes,TILE_BYTES);assert.equal(store.pixel(0,0)[0],1);
});

test('small warm history keeps synchronous command behavior and avoids a pixel operation',()=>{
  const d=fixture();d.owner.history={needsLoad:()=>false};d.editor.historyPixels=()=>({});d.editor.undo=()=>true;
  assert.equal(d.history('undo'),true);assert.equal(d.operation,undefined);assert.equal(d.owner.busy,false);
});

test('large warm history owns the pixel-operation gate and accepts Escape cancellation',async()=>{
  const d=fixture(),gate=deferred();d.owner.needsPreparation=()=>true;d.editor.historyPixels=()=>({});
  d.editor.redo=async({signal})=>{await gate.promise;if(signal.aborted)throw new DOMException('Cancelled','AbortError');return true;};
  const pending=d.history('redo');await Promise.resolve();assert.ok(d.operation?.history);assert.equal(d.owner.busy,true);
  d.cancel();gate.resolve();await assert.rejects(pending,{name:'AbortError'});assert.equal(d.owner.busy,false);assert.equal(d.operation,null);
});

test('save and command barriers wait for pixel transaction publication',async()=>{
  const d=fixture(),gate=deferred();let published=false,settled=false;
  const work=d.pixelOperation('Paste',async op=>{await gate.promise;op.check();published=true;});
  const wait=d.settle().then(()=>{assert.ok(published);settled=true;});
  await Promise.resolve();assert.equal(settled,false);assert.equal(d.owner.busy,true);
  gate.resolve();await work;await wait;assert.equal(d.operation,null);assert.equal(d.owner.busy,false);
});

test('cancelled pixel operations release work and reject late publication',async()=>{
  const d=fixture(),gate=deferred();let published=false;
  const work=d.pixelOperation('Resample',async op=>{d.owner.hold(op,100);await gate.promise;op.check();published=true;});
  await Promise.resolve();d.cancel();gate.resolve();
  await assert.rejects(work,{name:'AbortError'});assert.equal(published,false);assert.equal(d.operation,null);assert.equal(d.owner.busy,false);assert.equal(d.holds.size,0);
  await d.pixelOperation('Paste',op=>{op.check();published=true;});assert.ok(published);
});

test('a pen gesture queued behind a pixel operation keeps its samples and release',async()=>{
  const d=fixture(),gate=deferred(),event={pointerId:12,pointerType:'pen',clientX:1,clientY:2,pressure:.4};
  const work=d.pixelOperation('Resample',()=>gate.promise);
  await d.down(event);d.move({...event,clientX:5});d.up(event);
  let replay;d.down=async e=>{replay=e;};d.run=fn=>fn();
  gate.resolve();await work;assert.equal(replay.pointerId,12);assert.equal(replay.samples[0].clientX,5);assert.equal(replay.released,true);
});

test('a failed operation discards its queued gesture and releases its reservation',async()=>{
  const d=fixture();let replayed=false;d.resumeQueuedPointer=()=>{replayed=true;};
  await assert.rejects(d.pixelOperation('Paste',()=>{d.loading={queued:true};throw Error('Budget exceeded');}),/Budget/);
  assert.equal(replayed,false);assert.equal(d.loading,null);assert.equal(d.owner.busy,false);
});

test('pixel clipboard validates world coordinates and affine poses before replacing it',async()=>{
  const editor={_drawingPixelClipboard:'previous',_emit:()=>{}},data={width:1,height:1,pixelsPerUnit:1,dataUrl:'data:image/png;base64,AA==',world:{x:1,y:2}},packet={format:'StykAnimate clipboard',version:1,kind:'drawing-pixels',data};
  await assert.rejects(restoreClipboard(editor,{...packet,data:{...data,world:{x:NaN,y:2}}}),/origin/);
  await assert.rejects(restoreClipboard(editor,{...packet,data:{...data,matrix:[0,0,0,0,1,2]}}),/singular/);
  assert.equal(editor._drawingPixelClipboard,'previous');
  await restoreClipboard(editor,{...packet,data:{...data,matrix:[0,-1,1,0,1,2]}});assert.deepEqual(editor._drawingPixelClipboard.matrix,[0,-1,1,0,1,2]);
});

test('a small operation reserves available memory alongside other unpublished cels',async()=>{
  const first=createDrawingFigure(),second=createDrawingFigure(),report={figure_types:[first,second]},worker={dispose:()=>{},request:()=>{throw Error('Pinned cels must not encode');}};
  const owner=new DrawingResources(report,{worker,tileBytes:TILE_BYTES,hardBytes:8*TILE_BYTES}),d=fixture();d.owner=owner;
  try{
    const other=owner.install(first,[{tx:0,ty:0,pixels:new Uint8ClampedArray(TILE_BYTES)},{tx:1,ty:0,pixels:new Uint8ClampedArray(TILE_BYTES)}]);other.pinned=true;
    const surface=owner.install(second,[]);surface.pinned=true;
    await d.pixelOperation('Fill',op=>{op.reserve(surface,owner.hardBudget);assert.equal(op.maxBytes,6*TILE_BYTES);assert.equal(owner.stats.bytes+owner.workingBytes,owner.hardBudget);});
    assert.equal(owner.workingBytes,0);assert.equal(other.store.size,2);
  }finally{owner.dispose();}
});

test('sample-all fill checks dense capture memory before allocating a canvas',async()=>{
  const d=fixture(),surface={store:new TileStore()},figure={};let requested=false;
  Object.assign(d,{settings:{sampleAll:true},fillBounds:()=>({x:0,y:0,width:4096,height:4096})});
  Object.assign(d.owner,{hardBudget:16*1024*1024,stats:{bytes:0,historyBytes:0,deferredBytes:0,workingBytes:0},reserve:()=>{},discard:()=>{},worker:{request:()=>{requested=true;}}});
  await assert.rejects(d.fill({figure},surface,{x:0,y:0}),/working memory/);
  assert.equal(requested,false);assert.equal(surface.pinned,false);assert.equal(d.holds.size,0);assert.equal(d.operation,null);
});

test('sample-all publication can reserve memory before fill owns the remaining budget',async()=>{
  const figure=createDrawingFigure(),report={figure_types:[figure]},owner=new DrawingResources(report,{hardBytes:16*TILE_BYTES,history:false}),d=fixture();
  d.owner=owner;d.editor.report=report;const surface=owner.install(figure,[]),marker={};let entered=false;
  Object.assign(d,{settings:{sampleAll:true},fillBounds:()=>({x:0,y:0,width:64,height:64}),barrierForComposite:async()=>{
    assert.equal(surface.pinned,false);owner.hold(marker,TILE_BYTES);entered=true;owner.hold(marker,0);throw Error('Publication completed');
  }});
  try{await assert.rejects(d.fill({figure},surface,{x:0,y:0}),/Publication completed/);assert.ok(entered);assert.equal(owner.workingBytes,0);}
  finally{owner.dispose();}
});

test('point filters reserve only intersecting tile replacements beside a larger cel',async()=>{
  const d=fixture(),store=new TileStore(),mask={x:-60,y:7,width:4,height:5,max:255,mask:new Uint8Array(20).fill(128)};
  store.set(-1,0,new Uint8ClampedArray([20,40,60,255]));
  for(let tx=5;tx<25;tx++)store.set(tx,0,new Uint8ClampedArray([70,90,110,255]));
  const surface={store},budget=2*TILE_BYTES+mask.mask.byteLength;
  Object.assign(d.owner,{hardBudget:store.bytes+budget,stats:{bytes:store.bytes,historyBytes:0,deferredBytes:0,workingBytes:0},reserve:()=>{},discard:()=>{},worker:{request:async(kind,data)=>{
    assert.equal(kind,'filter');assert.equal(data.tiles.length,1);assert.equal(data.tiles[0].tx,-1);
    // The engine's answer: the undo record of the one tile it was sent.
    return {tiles:[{tx:-1,ty:0,before:new Uint8ClampedArray([20,40,60,255]),after:new Uint8ClampedArray([235,215,195,255])}]};
  }}});
  let committed;
  d.commitPixels=async(target,tiles,label,op)=>{op.check();committed=tiles;return true;};
  const result=await d.pixelTool({figure:{}},surface,'filter',{bounds:mask,options:{kind:'invert',mask}},'Invert colours');
  assert.equal(result,true);assert.equal(committed.length,1);assert.equal(committed[0].tx,-1);
  assert.deepEqual(store.pixel(-60,7),[20,40,60,255],'the worker cannot change live pixels before commit');
  assert.equal(d.holds.size,0);assert.equal(surface.pinned,false);assert.equal(d.operation,null);
});

test('point filters reject unavailable replacement memory before copying or requesting work',async()=>{
  const d=fixture(),store=new TileStore();store.set(0,0,new Uint8ClampedArray([20,40,60,255]));
  const surface={store};let requested=false,copied=false;
  Object.assign(d.owner,{hardBudget:2*TILE_BYTES-1,stats:{bytes:store.bytes,historyBytes:0,deferredBytes:0,workingBytes:0},reserve:()=>{},discard:()=>{},worker:{request:()=>{requested=true;}}});
  d.copyWorkerTiles=()=>{copied=true;};
  await assert.rejects(d.pixelTool({figure:{}},surface,'filter',{bounds:{x:0,y:0,width:64,height:64},options:{kind:'invert'}},'Invert colours'),/working memory/);
  assert.equal(requested,false);assert.equal(copied,false);assert.equal(surface.pinned,false);assert.equal(d.holds.size,0);
});

test('whole-cel point filters accept sparse distant paint while blur keeps the dense area limit',async()=>{
  const d=fixture(),store=new TileStore();store.set(-100000,0,new Uint8ClampedArray([20,40,60,255]));store.set(100000,0,new Uint8ClampedArray([20,40,60,255]));
  const target={figure:{}};d.editor.drawingTarget=()=>target;d.owner.surface=async()=>({store});d.settings={filterRadius:4};d.marqueeOn=()=>false;d.settleFloating=async()=>{};
  let bounds;
  d.pixelTool=async(t,s,kind,payload)=>{bounds=payload.bounds;return true;};
  assert.equal(await d.applyFilter('invert'),true);assert.equal(bounds.width,12800064);
  await assert.rejects(d.applyFilter('blur'),/smaller area/);
});

test('cancelled point filters reject a late worker reply and retain the original cel',async()=>{
  const d=fixture(),gate=deferred(),store=new TileStore();store.set(0,0,new Uint8ClampedArray([20,40,60,255]));
  const surface={store};let committed=false,requested=false;
  Object.assign(d.owner,{hardBudget:4*TILE_BYTES,stats:{bytes:store.bytes,historyBytes:0,deferredBytes:0,workingBytes:0},reserve:()=>{},discard:()=>{},worker:{request:async()=>{requested=true;return gate.promise;}}});
  d.commitPixels=()=>{committed=true;};
  const pending=d.pixelTool({figure:{}},surface,'filter',{bounds:{x:0,y:0,width:64,height:64},options:{kind:'invert'}},'Invert colours');
  while(!requested)await Promise.resolve();d.cancel();gate.resolve({tiles:[{tx:0,ty:0,before:new Uint8ClampedArray([20,40,60,255]),after:new Uint8ClampedArray([235,215,195,255])}]});
  await assert.rejects(pending,{name:'AbortError'});assert.equal(committed,false);assert.deepEqual(store.pixel(0,0),[20,40,60,255]);
  assert.equal(surface.pinned,false);assert.equal(d.holds.size,0);assert.equal(d.operation,null);
});

test('the colour a stroke painted joins the recent colours after the stroke, not on the pen going down',async()=>{
  const {recentColors}=await import('../src/color-palette.mjs');
  const d=fixture(),before=recentColors()[0],color=before==='#123456'?'#654321':'#123456';
  d.rememberColor(color);
  assert.equal(recentColors()[0],before,'the palette refresh waits for a later task');
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(recentColors()[0],color);
});
