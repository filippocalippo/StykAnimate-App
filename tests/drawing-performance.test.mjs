import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBrush} from '../src/drawing-brush.mjs';
import {TileStore} from '../src/drawing-tiles.mjs';
import {DrawingController} from '../src/drawing-controller.mjs';
import {applyTileChanges} from '../src/drawing-pixels.mjs';
import {loadDrawingEngine,StrokeEngine,RustBrushStroke,paintStroke} from '../src/engine/engine-drawing.mjs';

// The stroke worker's engine and the brush model are the drawing raster engine's.
await loadDrawingEngine();
/** A dab of a round tip at (x, y), as the brush model emits them. */
const dab=(x,y,radius=20)=>({x,y,radius,opacity:1,flow:1,cos:1,sin:0,left:Math.floor(x-radius),top:Math.floor(y-radius),right:Math.ceil(x+radius),bottom:Math.ceil(y+radius)});

function controller(){
  const c=Object.create(DrawingController.prototype),messages=[];
  const owner={strokeWorker:{post:m=>messages.push(m)},present(){}};
  const s={id:1,pending:[],queue:[],qi:0,paths:[],brush:normalizeBrush({size:4,color:[200,40,60],opacity:.5,pressureSize:false}),sent:new Set(),before:new Map(),posted:new Map(),seq:0,outstanding:0,owner,surface:{store:new TileStore()}};
  Object.assign(c,{sessions:new Map([[1,s]]),owner,strokeStats:{batches:0,maxQueueDepth:0},onRender(){},cancel(){},onError(e){throw e;}});
  return {c,s,messages};
}
test('worker batches seed existing pixels along cross-batch bridges',()=>{
  const {c,s,messages}=controller(),engine=new StrokeEngine();
  for(let x=0;x<8;x++)s.surface.store.set(x,0,new Uint8ClampedArray([10,20,30,255]));
  const expected=s.surface.store.fork(),actual=s.surface.store.fork(),settings={size:4,color:[200,40,60],opacity:.5,pressureSize:false},samples=[];
  const pipeline=new RustBrushStroke(settings,p=>s.pending.push(p));engine.begin(1,settings);
  for(const x of [10,230,450]){
    const point={x,y:30,pressure:1,time:x};samples.push(point);pipeline.sample(point);s.outstanding=0;c.flushStroke(s);
    const m=messages.at(-1);engine.dabs(1,m.seq,m.dabs,m.tiles);
  }
  pipeline.finish();s.outstanding=0;c.flushStroke(s);const last=messages.at(-1);engine.dabs(1,last.seq,last.dabs,last.tiles);
  // The batches, seeded tile by tile as the controller sends them, paint what one stroke painted whole.
  applyTileChanges(actual,engine.end(1),'after');engine.engine.free();
  paintStroke(expected,settings,samples);
  assert.deepEqual(actual.readRect(-64,-64,640,192),expected.readRect(-64,-64,640,192));
});

test('backpressure keeps one bounded dab batch in flight and ends after its acknowledgement',()=>{
  const {c,s,messages}=controller();
  // A tip this size batches 512 dabs; smaller tips batch more per round trip.
  s.brush=normalizeBrush({size:40,color:[200,40,60],pressureSize:false});
  for(let i=0;i<1200;i++)s.pending.push(dab(i,20));c.flushStroke(s);
  assert.equal(s.outstanding,1);assert.equal(messages[0].dabs.length,512);assert.equal(s.pending.length,688);
  s.ended=true;c.flushStroke(s);assert.equal(messages.length,1);
  for(let seq=1;seq<=3;seq++)c.strokeMessage({kind:'tiles',stroke:1,seq,tiles:[]});
  assert.deepEqual(messages.map(m=>m.kind),['dabs','dabs','dabs','end']);
  assert.equal(messages.filter(m=>m.kind==='dabs').flatMap(m=>m.dabs).length,1200);assert.equal(c.strokeStats.maxQueueDepth,1);
});
test('a long fast stroke with a fine brush queues samples instead of overflowing the dab queue',()=>{
  // The Pencil preset at 2× spaces its dabs a quarter pixel apart: this path
  // produces well over 65,536 dabs, which once cancelled the whole stroke.
  globalThis.requestAnimationFrame??=()=>0;globalThis.cancelAnimationFrame??=()=>{};
  const {c,s,messages}=controller();
  Object.assign(s,{brush:normalizeBrush({size:4,spacingRatio:.05,texture:.6,flow:.7,pressureSize:true}),mirrors:[p=>p],matrix:[1,0,0,1,0,0]});
  c.strokePaths(s);
  for(let i=0;i<=4000;i++)c.sampleStroke.call(Object.assign(Object.create(c),{gesture:{kind:'stroke',session:s},point:()=>({x:i*8,y:20+Math.sin(i/50)*30})}),{clientX:0,clientY:0,pointerType:'mouse',timeStamp:i});
  assert.ok(s.queue.length>4000,'samples wait in the compact input queue');
  let most=0,guard=0;s.ended=true;c.flushStroke(s);
  while(messages.at(-1)?.kind==='dabs'&&guard++<10000){most=Math.max(most,s.pending.length);c.strokeMessage({kind:'tiles',stroke:1,seq:messages.at(-1).seq,tiles:[]});}
  const dabs=messages.filter(m=>m.kind==='dabs').flatMap(m=>m.dabs);
  assert.equal(messages.at(-1).kind,'end');assert.ok(dabs.length>65536,`${dabs.length} dabs painted`);
  assert.ok(messages.filter(m=>m.kind==='dabs').every(m=>m.dabs.length<=s.batch),'every batch is bounded');
  assert.ok(most<s.batch*8,'pending dabs stay near one batch');
});
