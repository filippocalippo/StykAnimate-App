import {messageError} from './localized-error.mjs';
import {TILE,MIN_TILE,MAX_TILE,TileStore,tileKey} from './drawing-tiles.mjs';

export function lassoBounds(points){
  if(!Array.isArray(points)||points.length>8192||points.some(p=>!p||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=MIN_TILE*TILE&&n<=(MAX_TILE+1)*TILE)))throw messageError(new Error(''), "errors.drawingLasso.invalidLassoCoordinates", {});
  if(points.length<3)return null;
  const x=Math.floor(Math.min(...points.map(p=>p.x))),y=Math.floor(Math.min(...points.map(p=>p.y)));
  const width=Math.ceil(Math.max(...points.map(p=>p.x)))-x,height=Math.ceil(Math.max(...points.map(p=>p.y)))-y;
  return width&&height?{x,y,width,height}:null;
}

/** Match the even-odd scan conversion at the center of the hit pixel. The
 * polygon also describes selected empty space without allocating its pixels. */
export function lassoContains(points,x,y){
  x=Math.floor(x)+.5;y=Math.floor(y)+.5;let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[j],b=points[i];
    if((a.y>y)!==(b.y>y)&&x<a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y))inside=!inside;
  }
  return inside;
}


/** The selected pixels and the cel without them, from the engine's capture (`select`): the remainder shares every tile
 * the selection did not touch with the cel. */
export function selectionStores(base,tiles){
  const source=new TileStore(),remainder=base.fork();
  for(const t of tiles){
    const key=tileKey(t.tx,t.ty);
    if(t.full)source.tiles.set(key,base.get(t.tx,t.ty));
    else source.tiles.set(key,{tx:t.tx,ty:t.ty,pixels:t.pixels instanceof Uint8ClampedArray?t.pixels:new Uint8ClampedArray(t.pixels),alphaBounds:t.alphaBounds,frozen:true});
    if(t.remaining)remainder.tiles.set(key,{tx:t.tx,ty:t.ty,pixels:t.remaining instanceof Uint8ClampedArray?t.remaining:new Uint8ClampedArray(t.remaining),alphaBounds:t.remainingBounds,frozen:true});else remainder.tiles.delete(key);
  }
  return {source,remainder};
}
