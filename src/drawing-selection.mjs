import {TILE,TileStore,tileKey} from './drawing-tiles.mjs';
import {tileAlignedRect} from './drawing-pixels.mjs';
import {transformBounds,transformTileCoverage} from './drawing-transform.mjs';
import {paintDrawingTiles} from './drawing-raster.mjs';

export function selectionMatrix(s){const a=s.angle*Math.PI/180,c=Math.cos(a)*s.scale,n=Math.sin(a)*s.scale;const fx=s.fx??1,fy=s.fy??1;return[c*fx,n*fx,-n*fy,c*fy,s.cx+s.dx-c*fx*s.cx+n*fy*s.cy,s.cy+s.dy-n*fx*s.cx-c*fy*s.cy];}
export const selectionBounds=transformBounds;
export function selectionTiles(store,source,m,filter,{remove=false,maxBytes}={}){
  const destination=remove?new Map():transformTileCoverage(source,m,filter,maxBytes);
  return [...store].filter(t=>source.has(t.tx,t.ty)||destination.has(tileKey(t.tx,t.ty)));
}
const canvas=(w,h)=>typeof OffscreenCanvas==='function'?new OffscreenCanvas(w,h):Object.assign(document.createElement('canvas'),{width:w,height:h});


/** Preview surfaces share untouched cel tiles and use the existing bounded
 * raster cache/worker. Only one additional viewport canvas is composited. */
export function selectionPresenter(s,owner){
  const remainder=owner.transient(s.remainder),selected=owner.transient(s.source),p=owner.transient(new TileStore());
  // Three images must coexist. If the compositor consumed the entire scratch
  // budget, child previews would evict it and each other indefinitely.
  const sideLimit=Math.min(4096,Math.floor(Math.sqrt(owner.scratchBudget/12)/TILE)*TILE);
  for(const entry of [remainder,selected]){const scratch=entry.scratch;entry.scratch=(rect,options={})=>scratch(rect,{...options,maxSide:Math.min(options.maxSide??4096,sideLimit)});}
  const union=(a,b)=>{if(!a||!b)return a??b;const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return {x,y,width:Math.max(a.x+a.width,b.x+b.width)-x,height:Math.max(a.y+a.height,b.y+b.height)-y};};
  // The composite has no tiles of its own: its extent is the remainder plus
  // the transformed selection. The renderer sizes drawings by tileBounds, so
  // it needs the tile-aligned extent too, or the whole cel draws nothing
  // while a selection floats.
  Object.defineProperty(p.store,'bounds',{get(){return union(s.remainder.bounds,s.source.bounds?selectionBounds(s.source.bounds,selectionMatrix(s)):null);}});
  Object.defineProperty(p.store,'tileBounds',{get(){
    const moved=s.source.tileBounds?selectionBounds(s.source.tileBounds,selectionMatrix(s)):null;
    return union(s.remainder.tileBounds,moved?tileAlignedRect(moved.x,moved.y,moved.width,moved.height):null);
  }});
  p.dispose=()=>{for(const entry of [p,selected,remainder])owner.releaseTransient(entry);};
  p.scratch=(rect,{level=0,maxSide=4096,clamp=false}={})=>{
    const f=2**level,x=Math.floor(rect.x/f/TILE)*TILE,y=Math.floor(rect.y/f/TILE)*TILE,w=Math.ceil((rect.x+rect.width)/f/TILE)*TILE-x,h=Math.ceil((rect.y+rect.height)/f/TILE)*TILE-y;
    const side=Math.min(maxSide,sideLimit);if(side<1||((w>side||h>side)&&!clamp))return null;
    const width=Math.max(1,Math.min(side,w)),height=Math.max(1,Math.min(side,h)),key=`selection:${level}:${x},${y},${width},${height}`;
    let scratch=p._scratches?.get('selection');
    if(!scratch||scratch.canvas.width!==width||scratch.canvas.height!==height){
      if(scratch){scratch.canvas.width=scratch.canvas.height=1;p._scratches=null;}
      if(!owner.scratchReserved(p,width*height*4))return null;
      scratch={canvas:canvas(width,height),used:performance.now()};p._scratches=new Map([['selection',scratch]]);
    }
    if(scratch.key!==key||scratch.drawn!==p.stamp||scratch.baseStamp!==remainder.stamp||scratch.sourceStamp!==selected.stamp){
      const ctx=scratch.canvas.getContext('2d');ctx.resetTransform();ctx.clearRect(0,0,width,height);ctx.setTransform(1/f,0,0,1/f,-x,-y);
      // Pin this scratch while child presenters reserve their own caches.
      scratch.pinned=true;
      try{paintDrawingTiles(ctx,remainder);ctx.transform(...selectionMatrix(s));paintDrawingTiles(ctx,selected,{filter:s.filter});}
      finally{scratch.pinned=false;}
      scratch.key=key;scratch.drawn=p.stamp;scratch.baseStamp=remainder.stamp;scratch.sourceStamp=selected.stamp;
    }
    return {canvas:scratch.canvas,x,y,width,height,scale:f,level,stamp:p.stamp,anchorKey:key,dirty:null};
  };
  return p;
}
