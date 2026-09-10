import {movieclipAsset, playbackSettings} from './movieclips.mjs';
import {layerVisible} from './layers.mjs';

const caches = new WeakMap();
const MAX_FRAMES = 48, MAX_POINTS = 250000;
// One budget for every asset in this renderer, including nested assets.
const retained=new Map();let retainedPoints=0;
function touch(cache){retained.delete(cache);retained.set(cache,true);}
function evict(cache){const first=cache.frames.entries().next().value;if(!first)return;cache.frames.delete(first[0]);cache.points-=first[1].points;retainedPoints-=first[1].points;if(!cache.frames.size)retained.delete(cache);}
export function movieclipCacheStats(figure) {
  const cache = caches.get(movieclipAsset(figure));
  return cache ? {hits:cache.hits, misses:cache.misses, frames:cache.frames.size, points:cache.points} : {hits:0,misses:0,frames:0,points:0};
}
function sample(asset, local, api) {
  let cache = caches.get(asset);
  if (!cache) {cache = {frames:new Map(), rows:api.timeline(asset.document), points:0,hits:0,misses:0}; caches.set(asset, cache);}
  const prior = cache.frames.get(local);
  if (prior) {cache.hits++; cache.frames.delete(local); cache.frames.set(local,prior);touch(cache);return prior.geometry;}
  const tick = asset.sourceStart + local, rows = cache.rows;
  let low=0,high=rows.length-1;
  while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=tick)low=mid;else high=mid-1;}
  const row=rows[low], frame=api.evaluatedFrame(asset.document,low,row.count?(tick-row.start)/row.count:0,tick);
  const geometry=api.buildGeometry(asset.document,frame);
  const points=geometry.drawables.reduce((n,s)=>n+(s.points?.length??1),0);
  cache.misses++;
  if(points<=MAX_POINTS){
    while(cache.frames.size&&(cache.frames.size>=MAX_FRAMES||cache.points+points>MAX_POINTS)){
      evict(cache);
    }
    while(retained.size&&(retainedPoints+points>MAX_POINTS||retained.size>=64&&!retained.has(cache)))evict(retained.keys().next().value);
    cache.frames.set(local,{geometry,points});cache.points+=points;retainedPoints+=points;touch(cache);
  }
  return geometry;
}
/** One selectable container, with independently styled child render groups.
 * Cached local geometry is shared by all instances of an immutable asset. */
export function buildMovieclipGeometry(fig,obj,root,slot,api) {
  const asset=movieclipAsset(fig), scale=Number(obj.scale??1), angle=Number(obj.angles?.[0]??0),
    a=Math.cos(angle)*scale,b=Math.sin(angle)*scale,flip=obj.image_text_flags?-1:1;
  const point=p=>({x:root.x+a*(p.x-asset.pivot.x)-b*(p.y-asset.pivot.y)*flip,y:root.y+b*(p.x-asset.pivot.x)+a*(p.y-asset.pivot.y)*flip});
  const end={x:root.x+40*Math.cos(angle)*scale,y:root.y+40*Math.sin(angle)*scale};
  const joints=new Map([[0,root],[1,end]]),
    handle={seg:fig.segments[0],obj,fig,slot,index:0,start:root,end,points:[root,end],angle,length:40*scale,bend:0,thickness:0,opacity:1,alpha:1,rgb:[0,0,0]};
  const geometry={obj,fig,root,slot,joints,segments:[handle],polys:[],drawables:[]};
  const local=obj._movieclipSample??(obj._movieclipSample===null?null:playbackSettings(obj).offset);
  if(local===null)return geometry;
  const source=sample(asset,local,api), owner={opacity:1-Number(obj.field28??0)/255};
  const objects=new Map();
  for(const item of source.drawables){
    if(!layerVisible(asset.document,item.obj.unique_id))continue;
    let child=objects.get(item.obj);
    if(!child){child={...item.obj,unique_id:obj.unique_id,object_slot:slot,scale:(item.obj.scale??1)*scale,image_text_flags:Number(Boolean(item.obj.image_text_flags)!==Boolean(obj.image_text_flags))};objects.set(item.obj,child);}
    geometry.drawables.push({...item,obj:child,slot,
      _movieclipOwner:owner,_movieclipPart:item.slot,
      ...(item._movieclipOwner?{_movieclipInner:{owner:item._movieclipOwner,part:item._movieclipPart,inner:item._movieclipInner}}:{}),
      points:item.points?.map(point),start:item.start&&point(item.start),end:item.end&&point(item.end),
      angle:item.angle===undefined?undefined:item.angle*flip+angle,bend:(item.bend??0)*flip,
      length:item.length===undefined?undefined:item.length*scale,
      thickness:item.thickness===undefined?undefined:item.thickness*Math.abs(scale)});
  }
  return geometry;
}
