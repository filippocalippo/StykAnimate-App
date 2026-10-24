import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBrush,pressureMap,LINEAR_PRESSURE,BRUSH_KEYS,BRUSH_DEFAULTS} from '../src/drawing-brush.mjs';
import {TileStore} from '../src/drawing-tiles.mjs';
import {DrawingStroke} from './support/sketch-stroke.mjs';

test('the pen pressure curve maps pressure monotonically and the identity curve is free',()=>{
  assert.equal(pressureMap(LINEAR_PRESSURE),null);
  const soft=pressureMap([.1,.5,.4,.95]),firm=pressureMap([.6,.05,.9,.5]);
  assert.ok(Math.abs(soft(0))<1e-6&&Math.abs(soft(1)-1)<1e-6);
  assert.ok(soft(.3)>.3&&firm(.3)<.3,'soft lifts light pressure, firm lowers it');
  for(let p=0;p<1;p+=.05)assert.ok(soft(p+.05)>=soft(p)-1e-6);
});

test('brush settings normalize new keys and smudge keeps a round untapered tip',()=>{
  assert.deepEqual(Object.keys(BRUSH_DEFAULTS),BRUSH_KEYS);
  const b=normalizeBrush({tip:'nope',grain:'nope',stabilizerMode:'nope',pressureCurve:[2,-1,'x',0],taperIn:-5});
  assert.equal(b.tip,'round');assert.equal(b.grain,'noise');assert.equal(b.stabilizerMode,'average');assert.deepEqual(b.pressureCurve,LINEAR_PRESSURE);assert.equal(b.taperIn,0);
  const smudge=normalizeBrush({blend:'smudge',tip:'chalk',taperOut:40,texture:.5});
  assert.equal(smudge.tip,'round');assert.equal(smudge.taperOut,0);assert.equal(smudge.texture,0);
  assert.deepEqual(normalizeBrush(b),b,'normalization is idempotent');
});

test('a stroke painted by the engine in this thread leaves its ink and paints over what the store held',()=>{
  const store=new TileStore();
  const stroke=new DrawingStroke(store,{size:12,color:[200,30,40],pressureSize:false,seed:3});
  for(let i=0;i<=40;i++)stroke.sample({x:20+i*3,y:40+Math.sin(i/6)*10,pressure:1,time:i*8});
  stroke.finish();
  assert.ok(store.size>0&&store.bounds&&store.bounds.width>100,'the stroke is in the store');
  const [r,g,b,a]=store.pixel(80,40+Math.round(Math.sin(60/18)*10));
  assert.deepEqual([r,g,b],[200,30,40]);assert.equal(a,255);
  // An eraser stroke over opaque pixels removes them.
  const backdrop=new TileStore();backdrop.set(0,0,new Uint8ClampedArray([40,90,160,255]));
  const erase=new DrawingStroke(backdrop,{size:16,erase:true,pressureSize:false,seed:1});
  for(let i=0;i<=20;i++)erase.sample({x:10+i*2,y:30,pressure:1,time:i*8});
  erase.finish();
  assert.equal(backdrop.pixel(30,30)[3],0,'erased where the tip passed');assert.equal(backdrop.pixel(5,5)[3],255,'untouched elsewhere');
});
