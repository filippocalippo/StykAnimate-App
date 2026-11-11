import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorWithDrawings} from './support/owned-editor.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {DrawingHistory} from '../src/drawing-history.mjs';
import {drawingMetadata,createDrawingFigure} from '../src/drawing-model.mjs';
import {TILE_BYTES} from '../src/drawing-tiles.mjs';
import {loadDrawingEngine} from '../src/engine/engine-drawing.mjs';
import {drawingEngineOperation} from '../src/engine/engine-drawing-worker.mjs';

// The pixel worker's `prepare-tiles`, answered by the drawing raster engine in this thread.
await loadDrawingEngine();
const materializeDrawingTiles=async tiles=>{let reply;await drawingEngineOperation({id:0,kind:'prepare-tiles',tiles},message=>{reply=message;});if(reply.error)throw new Error(reply.error);return reply.tiles;};

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function workerFixture(){
  return{calls:[],async request(kind,payload,{transfer=[]}={}){
    assert.equal(kind,'prepare-tiles');const inputBytes=transfer.reduce((n,b)=>n+b.byteLength,0),data=structuredClone(payload,{transfer});
    this.calls.push({inputBytes,tiles:data.tiles.length});await this.before?.(this.calls.length);
    const tiles=await materializeDrawingTiles(data.tiles);this.outputBytes=Math.max(this.outputBytes??0,tiles.reduce((n,t)=>n+(t.pixels?.byteLength??0),0));
    return this.corrupt?.({tiles})??{tiles};
  },dispose(){}};
}
async function fixture(options={}){
  const {editor}=ownedEditorWithDrawings({demo:false,layerTimeline:true}),worker=workerFixture(),owner=new DrawingResources(editor.report,{worker,history:false,...options});owner.busy=true;owner.flush=async()=>{};
  const target=editor.prepareDrawingCel(),surface=await owner.surface(target.figure);
  return{editor,worker,owner,target,surface};
}
// More tiles than the interface thread applies in the commit itself (4 MiB), so they are prepared in the pixel worker.
const TILES=300;
const changes=(color=[127,5,249,1])=>Array.from({length:TILES},(_,tx)=>({tx,ty:-1,before:null,after:new Uint8ClampedArray(color)}));
const command=(target,tiles)=>({kind:'drawing-pixels',celId:drawingMetadata(target.figure).celId,tiles});

test('preparation reuses private full-tile allocations and expands only compact colors',async()=>{
  const full=new Uint8ClampedArray(TILE_BYTES);for(let i=0;i<full.length;i+=4)full.set([127,5,249,0],i);
  full.set([31,63,95,1],(21*64+11)*4);
  const expected=full.slice(),uniform=new Uint8ClampedArray([17,23,41,255]),empty=new Uint8ClampedArray(TILE_BYTES);
  const tiles=await materializeDrawingTiles([{tx:-2,ty:3,pixels:full.buffer},{tx:1,ty:2,pixels:uniform.buffer},{tx:7,ty:8,pixels:empty.buffer},{tx:9,ty:10,pixels:null}]);
  assert.equal(tiles[0].pixels,full.buffer,'worker returns the existing private allocation');assert.deepEqual(new Uint8ClampedArray(tiles[0].pixels),expected);
  assert.deepEqual(tiles[0].alphaBounds,{x:11,y:21,width:1,height:1});
  assert.notEqual(tiles[1].pixels,uniform.buffer);assert.equal(tiles[1].pixels.byteLength,TILE_BYTES);assert.ok(new Uint8ClampedArray(tiles[1].pixels).every((v,i)=>v===uniform[i%4]));
  assert.equal(tiles[2].pixels,null);assert.equal(tiles[3].pixels,null);
});

test('cancellation and a late worker failure leave live pixels and history untouched',async()=>{
  for(const failure of ['abort','error']){
    const {editor,worker,owner,target,surface}=await fixture(),controller=new AbortController(),tiles=changes(),revision=editor.revision,history=editor._undo.slice();
    worker.before=count=>{if(count===2){if(failure==='abort')controller.abort();else throw Error('worker failed');}};
    try{
      await assert.rejects(owner.prepareChanges(command(target,tiles),'after',{signal:controller.signal}),failure==='abort'?{name:'AbortError'}:/worker failed/);
      assert.equal(surface.store.size,0);assert.equal(editor.revision,revision);assert.deepEqual(editor._undo,history);assert.equal(owner.workingBytes,0);assert.equal(surface.preparing,0);
    }finally{owner.dispose();}
  }
});

test('the full replacement and one transfer batch are reserved before allocating pixels',async()=>{
  const {owner,worker,target,surface}=await fixture({tileBytes:(TILES+64)*TILE_BYTES,hardBytes:(TILES+64)*TILE_BYTES-1});
  try{
    await assert.rejects(owner.prepareChanges(command(target,changes()),'after'),/memory is full/);assert.equal(worker.calls.length,0);assert.equal(owner.workingBytes,0);assert.equal(surface.preparing,0);
    owner.hardBudget++;const prepared=await owner.prepareChanges(command(target,changes()),'after');prepared.release();assert.equal(owner.workingBytes,0);
  }finally{owner.dispose();}
});

test('invalid worker results cannot partially install or retain reservations',async()=>{
  for(const corrupt of [result=>({tiles:result.tiles.slice(1)}),result=>{result.tiles[0].tx++;return result;},result=>{result.tiles[0].alphaBounds.width=65;return result;}]){
    const {owner,worker,target,surface}=await fixture();worker.corrupt=corrupt;
    try{await assert.rejects(owner.prepareChanges(command(target,changes()),'after'),/prepared drawing tile/);assert.equal(surface.store.size,0);assert.equal(surface.preparing,0);assert.equal(owner.workingBytes,0);}finally{owner.dispose();}
  }
});

test('owned resample installation adopts buffers while ordinary installation isolates its caller',()=>{
  const f=createDrawingFigure(),g=createDrawingFigure(),owner=new DrawingResources({figure_types:[f,g]},{history:false});owner.busy=true;
  try{
    const pixels=new Uint8ClampedArray(TILE_BYTES).fill(127),owned=owner.install(f,[{tx:0,ty:0,pixels:pixels.buffer}],{owned:true});
    assert.equal(owned.store.get(0,0).pixels.buffer,pixels.buffer);
    const copied=owner.install(g,[{tx:0,ty:0,pixels:pixels.buffer}]);assert.notEqual(copied.store.get(0,0).pixels.buffer,pixels.buffer);
  }finally{owner.dispose();}
});

test('retired history keeps pinned source buffers accounted until preparation releases them',async()=>{
  const history=new DrawingHistory({disk:{async close(){}},minRecordBytes:Infinity}),tiles=changes(),root={kind:'drawing-pixels',tiles,bytes:99999};
  try{
    history.track(root);history.prepare(root);history.retain([]);
    assert.equal(root.tiles,null);assert.equal(history.residentBytes,TILES*4);
    history.release(root);assert.equal(history.residentBytes,0);
  }finally{await history.dispose();}
});

test('source stores stay resident while a prepared replacement owns their snapshots',async()=>{
  const {owner,worker,target,surface}=await fixture({tileBytes:TILE_BYTES,hardBytes:(TILES+65)*TILE_BYTES});
  const pixels=new Uint8ClampedArray([1,2,3,255]);surface.store.set(0,0,pixels);surface.published={revision:surface.revision,url:null};
  const source=surface.store,gate=deferred(),started=deferred();worker.before=async count=>{if(count===1){started.resolve();await gate.promise;}};
  try{
    const pending=owner.prepareChanges(command(target,changes()),'after');await started.promise;
    assert.equal(surface.store,source);assert.throws(()=>owner.reserve(TILE_BYTES),/memory is full/);assert.equal(surface.store,source);
    gate.resolve();const prepared=await pending;prepared.release();owner.reserve((TILES+65)*TILE_BYTES);assert.equal(surface.store,null,'released clean stores are evictable again');
  }finally{gate.resolve();owner.dispose();}
});

test('a stroke-sized replay is applied in the commit itself, a larger one is prepared in the worker',async()=>{
  const {owner,worker,target,surface}=await fixture();
  const full=()=>new Uint8ClampedArray(TILE_BYTES).fill(9),sides=count=>Array.from({length:count},(_,tx)=>({tx,ty:0,before:full(),after:full()}));
  try{
    // A stroke touches about a hundred tiles: its undo and redo must not wait for a worker (behind a publication, or still loading).
    for(const direction of ['before','after']){
      assert.equal(owner.needsPreparation(command(target,sides(100)),direction),false);
      assert.equal(owner.needsPreparation(command(target,sides(256)),direction),false);
      assert.equal(owner.needsPreparation(command(target,sides(257)),direction),true);
    }
    assert.equal(await owner.prepareChanges(command(target,sides(100)),'before'),null);assert.equal(worker.calls.length,0);
    const tiles=sides(100);owner.apply(target.figure,tiles,'after');assert.equal(surface.store.size,100);
    owner.apply(target.figure,tiles.map(t=>({...t,after:null})),'after');assert.equal(surface.store.size,0);
  }finally{owner.dispose();}
});
