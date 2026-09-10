import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtworkRegistry} from '../src/render-artwork.mjs';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';

function pair(){
  const e=new Editor({demo:false});e.addFigure();const g=e.geometry.objects.get(0);
  const translate=p=>({x:p.x+32,y:p.y-16});
  const obj={...g.obj,unique_id:999,object_slot:1,root_x:g.obj.root_x+32,root_y:g.obj.root_y-16,record_offset:987654};
  const moved={...g,obj,root:translate(g.root)};
  moved.drawables=g.drawables.map(item=>({...item,obj,slot:1,start:item.start&&translate(item.start),end:item.end&&translate(item.end),points:item.points?.map(translate)}));
  return{e,g,moved};
}
test('exact translated artwork shares content identity without sharing document objects',()=>{
  const {g,moved}=pair(),cache=new ArtworkRegistry();
  assert.notEqual(g.obj,moved.obj);assert.equal(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
  assert.equal(cache.stats.hits,1);
});
test('subpixel geometry differences are not quantized away',()=>{
  const {g,moved}=pair(),cache=new ArtworkRegistry();
  const first=cache.get(g,g.drawables);moved.drawables[0].points[0]={...moved.drawables[0].points[0],x:moved.drawables[0].points[0].x+1e-9};
  assert.notEqual(first,cache.get(moved,moved.drawables));
});

test('runtime cache payloads do not duplicate the exact evaluated artwork signature',()=>{
  const {g,moved}=pair(),cache=new ArtworkRegistry();
  g.obj.runtime_segments=[{length:1}];moved.obj.runtime_segments=[{length:999,cacheOnly:true}];
  assert.equal(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
  moved.drawables=moved.drawables.map((item,i)=>i?item:{...item,length:item.length+1});
  assert.notEqual(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
});
test('instance styles, tint, image flags and unknown future properties distinguish artwork',()=>{
  for(const change of [o=>o.image_text_flags=1,o=>o.futureRenderFlag=123]){
    const {g,moved}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);change(moved.obj);
    assert.notEqual(first,cache.get(moved,moved.drawables));
  }
  const {g,moved}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);
  moved.drawables[0]={...moved.drawables[0],rgb:[1,2,3]};
  assert.notEqual(first,cache.get(moved,moved.drawables));
});
test('definition snapshots detect in-place edits and history reconstruction',()=>{
  const {e,g}=pair(),cache=new ArtworkRegistry(),first=cache.get(g,g.drawables);
  g.fig.segments[0].thickness+=2;cache.begin();
  const next=buildGeometry(e.report,e.frame).objects.get(0);
  assert.notEqual(first,cache.get(next,next.drawables));
});
test('registry entries and coordinate bytes remain bounded',()=>{
  const {g}=pair(),cache=new ArtworkRegistry({maxEntries:2,maxBytes:1024*1024});
  for(let i=0;i<10;i++){const next={...g,obj:{...g.obj,futureRenderFlag:i}};cache.get(next,next.drawables);}
  assert.equal(cache.lru.size,2);assert.ok(cache.bytes<=cache.maxBytes);assert.equal(cache.stats.evictions,8);
});

test('non-finite and non-numeric attributes cannot alias absent or finite values',()=>{
  for(const [a,b] of [[undefined,NaN],[null,Infinity],[1,'1']]){
    const {g,moved}=pair(),cache=new ArtworkRegistry();
    g.drawables[0]={...g.drawables[0],opacity:a};moved.drawables[0]={...moved.drawables[0],opacity:b};
    assert.notEqual(cache.get(g,g.drawables),cache.get(moved,moved.drawables));
  }
});

test('cross-packet content identity survives registry eviction and keeps subpixel differences',async()=>{
  const {g}=pair(),cache=new ArtworkRegistry({maxEntries:1});
  const first=cache.get(g,g.drawables),key=await cache.contentKey(first);
  cache.get({...g,obj:{...g.obj,futureRenderFlag:1}},g.drawables);assert.equal(cache.stats.evictions,1);
  const rebuilt={...g},next=cache.get(rebuilt,rebuilt.drawables);
  assert.notEqual(next.id,first.id);assert.equal(await cache.contentKey(next),key);
  cache.clear();const afterClear={...g};assert.equal(await cache.contentKey(cache.get(afterClear,afterClear.drawables)),key);
  const changed={...g,drawables:g.drawables.map((item,i)=>i?item:{...item,thickness:item.thickness+1e-9})};
  assert.notEqual(await cache.contentKey(cache.get(changed,changed.drawables)),key);
});
