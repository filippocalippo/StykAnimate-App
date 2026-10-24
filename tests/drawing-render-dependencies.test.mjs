import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrawingFigure} from '../src/drawing-model.mjs';
import {drawingRasterInputs,publishedDrawingRasterInputs,drawingRasterKey,changedDrawingRaster,sameDrawingRaster} from '../src/drawing-render-dependencies.mjs';

test('camera drawing dependencies detect publication and resource lifetime changes without geometry changes',()=>{
  const fig=createDrawingFigure(),items=[{fig}],owner={surfaceVersion:1};
  let entry={id:'fixture',stamp:1,store:null,owner};
  const resources={drawing:()=>entry},snapshot=()=>drawingRasterInputs(items,resources);
  const cold=snapshot();assert.equal(sameDrawingRaster(cold,snapshot()),true);
  entry.store={};assert.equal(changedDrawingRaster(cold),true);
  const decoded=snapshot();entry.stamp++;assert.equal(changedDrawingRaster(decoded),true);
  const ready=snapshot();assert.equal(sameDrawingRaster(ready,snapshot()),true);
  assert.equal(drawingRasterKey(ready),'fixture:2:1');
  entry.store={};assert.equal(sameDrawingRaster(ready,snapshot()),false);
  const replaced=snapshot();entry.owner={surfaceVersion:1};assert.equal(sameDrawingRaster(replaced,snapshot()),false);
  const transferred=snapshot();entry={...entry};assert.equal(sameDrawingRaster(transferred,snapshot()),false);
  const retained=snapshot();entry.disposed=true;assert.equal(sameDrawingRaster(retained,snapshot()),false);
  entry=null;assert.equal(sameDrawingRaster(null,snapshot()),true);
  entry={id:'fixture',stamp:2,store:{},owner};assert.equal(sameDrawingRaster(null,snapshot()),false);
});

function publishedFixture(){
  const fig=createDrawingFigure({celId:'cel-published'}),items=[{fig}];
  let entry={id:'cel-published',stamp:7,pixelStamp:3,revision:4,store:{},
    owner:{surfaceVersion:11},published:{revision:4,url:'data:published-tiles'}};
  const resources={drawing:()=>entry};
  return {get entry(){return entry;},set entry(value){entry=value;},
    snapshot:options=>drawingRasterInputs(items,resources,options)};
}

test('published drawing snapshots ignore derived previews while broad snapshots retain their existing invalidation',()=>{
  const fixture=publishedFixture(),broad=fixture.snapshot(),native=fixture.snapshot({published:true});
  const broadKey=drawingRasterKey(broad),nativeKey=drawingRasterKey(native);
  fixture.entry.stamp++;
  assert.equal(changedDrawingRaster(broad),true);
  assert.equal(changedDrawingRaster(native),false);
  assert.equal(sameDrawingRaster(native,fixture.snapshot({published:true})),true);
  assert.equal(drawingRasterKey(native),nativeKey);
  assert.equal(drawingRasterKey(fixture.snapshot({published:true})),nativeKey);
  assert.equal(drawingRasterKey(broad),broadKey);
  fixture.entry.owner.surfaceVersion++;
  assert.equal(drawingRasterKey(broad),'cel-published:7:12');
  assert.equal(changedDrawingRaster(native),false);
  assert.equal(sameDrawingRaster(native,fixture.snapshot({published:true})),true);
  assert.equal(drawingRasterKey(fixture.snapshot({published:true})),nativeKey);
});

test('published drawing snapshots invalidate each authoritative pixel or resource change',()=>{
  const changes={
    pixelStamp:entry=>entry.pixelStamp++,
    revision:entry=>entry.revision++,
    publishedRevision:entry=>entry.published.revision++,
    publishedUrl:entry=>entry.published.url='data:replacement-tiles',
    removedPublication:entry=>entry.published=null,
    store:entry=>entry.store={},
    owner:entry=>entry.owner={surfaceVersion:11},
    disposal:entry=>entry.disposed=true
  };
  for(const [name,change] of Object.entries(changes)){
    const fixture=publishedFixture(),snapshot=fixture.snapshot({published:true});
    change(fixture.entry);
    assert.equal(changedDrawingRaster(snapshot),true,name);
    assert.equal(sameDrawingRaster(snapshot,fixture.snapshot({published:true})),false,name);
  }
  const fixture=publishedFixture(),snapshot=fixture.snapshot({published:true});
  fixture.entry={...fixture.entry};
  assert.equal(sameDrawingRaster(snapshot,fixture.snapshot({published:true})),false,'presenter identity');
});

test('publication conversion preserves the captured authority even if the live entry already changed',()=>{
  const fixture=publishedFixture(),broad=fixture.snapshot();
  fixture.entry.stamp++;
  const native=publishedDrawingRasterInputs(broad);
  assert.notEqual(native,broad);
  assert.notEqual(native[0],broad[0]);
  assert.equal(native[0].stamp,7);
  assert.equal(native[0].entry,fixture.entry);
  assert.equal(native[0].store,broad[0].store);
  assert.equal(native[0].owner,broad[0].owner);
  assert.equal(native[0].published,true);
  assert.equal(changedDrawingRaster(native),false);
  assert.equal(sameDrawingRaster(native,fixture.snapshot({published:true})),true);
  assert.equal(broad[0].published,false);
  fixture.entry.published={revision:5,url:'data:newer-publication'};
  fixture.entry.pixelStamp++;
  const obsolete=publishedDrawingRasterInputs(broad);
  assert.equal(obsolete[0].pixelStamp,3);
  assert.equal(obsolete[0].revision,4);
  assert.equal(obsolete[0].publishedRevision,4);
  assert.equal(obsolete[0].publishedUrl,'data:published-tiles');
  assert.equal(changedDrawingRaster(obsolete),true);
  assert.equal(publishedDrawingRasterInputs(null),null);
  assert.equal(publishedDrawingRasterInputs(undefined),undefined);
});

test('drawing dependency equality distinguishes authority mode and keeps legacy broad semantics',()=>{
  const fixture=publishedFixture(),broad=fixture.snapshot(),native=fixture.snapshot({published:true});
  assert.equal(sameDrawingRaster(broad,native),false);
  assert.equal(sameDrawingRaster(native,broad),false);
  fixture.entry.pixelStamp++;
  fixture.entry.revision++;
  fixture.entry.published={revision:5,url:'data:newer-publication'};
  assert.equal(changedDrawingRaster(broad),false);
  assert.equal(sameDrawingRaster(broad,fixture.snapshot()),true);
  assert.equal(changedDrawingRaster(native),true);
  assert.equal(sameDrawingRaster(null,[]),true);
  assert.equal(drawingRasterKey(null),'');
});

test('published dependency keys use captured revisions and leave large URL identity to the validity guard',()=>{
  const fixture=publishedFixture();
  fixture.entry.published.url='data:tiles;base64,'+'A'.repeat(1_000_000);
  const snapshot=fixture.snapshot({published:true}),key=drawingRasterKey(snapshot);
  assert.equal(key,'cel-published:published:3:4:4');
  assert.equal(key.includes(fixture.entry.published.url),false);
  fixture.entry.published.url='data:replacement-tiles';
  assert.equal(changedDrawingRaster(snapshot),true);
  assert.equal(drawingRasterKey(snapshot),key);
  const replaced=fixture.snapshot({published:true});
  assert.equal(sameDrawingRaster(snapshot,replaced),false);
  fixture.entry.pixelStamp++;
  assert.notEqual(drawingRasterKey(fixture.snapshot({published:true})),drawingRasterKey(replaced));
  assert.equal(drawingRasterKey(replaced),key);
});

test('published dependency snapshots normalize an absent pixel stamp without inventing revisions',()=>{
  const fixture=publishedFixture();
  delete fixture.entry.pixelStamp;
  delete fixture.entry.revision;
  delete fixture.entry.published;
  const snapshot=fixture.snapshot({published:true});
  assert.equal(snapshot[0].pixelStamp,0);
  assert.equal(snapshot[0].revision,undefined);
  assert.equal(snapshot[0].publishedRevision,undefined);
  assert.equal(snapshot[0].publishedUrl,null);
  fixture.entry.pixelStamp=0;
  assert.equal(changedDrawingRaster(snapshot),false);
  fixture.entry.revision=0;
  assert.equal(changedDrawingRaster(snapshot),true);
});
