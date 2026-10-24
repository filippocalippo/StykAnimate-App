import {activeVfx,vfxStack,vfxPadding} from './vfx.mjs';
import {drawableVfxPadding,hasDrawableVfx} from './vfx-drawable.mjs';
import {filterVfxCanvas,vfxSurfaceDimension,vfxSourcePadding,releaseVfxWorkerSource,prepareVfxWorkerSource,vfxWorkerPixelsOwned} from './vfx-gpu.mjs';
import {fitsVfxSurface,vfxSurfaceTiles,vfxSurfaceError,VFX_MAX_PIXELS} from './vfx-surface.mjs';
import {sceneVfxPlan} from './vfx-scene.mjs';
import {VfxCPU} from './vfx-cpu.mjs';
const surfaces=new WeakMap();
const sceneSurfaces=new WeakMap();
const sceneInputs=new WeakMap();
/** Capability bounds beyond the GPU executor surface:
 *  a painted 2D source canvas (8192 px / 64 MP) and one assembled software
 *  buffer (128 MP). The software executor has no texture limit; these bounds
 *  exist only to keep single allocations sane. */
export const VFX_SOURCE_DIMENSION=8192,VFX_SOURCE_PIXELS=64*1024*1024,VFX_CPU_PIXELS=128*1024*1024;
const fitsSourceBound=(w,h)=>Number.isSafeInteger(w)&&Number.isSafeInteger(h)&&w>0&&h>0&&Math.max(w,h)<=VFX_SOURCE_DIMENSION&&w*h<=VFX_SOURCE_PIXELS;
function* splitRect(rect,size){for(let y=rect.y;y<rect.y+rect.height;y+=size)for(let x=rect.x;x<rect.x+rect.width;x+=size)yield{x,y,width:Math.min(size,rect.x+rect.width-x),height:Math.min(size,rect.y+rect.height-y)};}
let cpu;
const cpuExecutor=()=>cpu??=new VfxCPU();
const premultiply=pixels=>{for(let i=0;i<pixels.length;i+=4){const a=pixels[i+3];if(a<255){pixels[i]=Math.round(pixels[i]*a/255);pixels[i+1]=Math.round(pixels[i+1]*a/255);pixels[i+2]=Math.round(pixels[i+2]*a/255);}}return pixels;};
const unpremultiply=pixels=>{const owned=vfxWorkerPixelsOwned(),out=owned?pixels:new Uint8ClampedArray(pixels.length);for(let i=0;i<pixels.length;i+=4){const a=pixels[i+3];out[i+3]=a;if(a){out[i]=Math.min(255,Math.round(pixels[i]*255/a));out[i+1]=Math.min(255,Math.round(pixels[i+1]*255/a));out[i+2]=Math.min(255,Math.round(pixels[i+2]*255/a));}else if(owned)out[i]=out[i+1]=out[i+2]=0;}return out;};
const prepareSource=()=>{if(vfxWorkerPixelsOwned()){cpu?.releaseInput();prepareVfxWorkerSource();}};
const softwarePixels=(data,width,height,stack,options)=>cpuExecutor().runPixels(data,width,height,stack,vfxWorkerPixelsOwned()?{...options,ownedPixels:true}:options);
const blitInto=(dest,dw,src,sw,dx,dy)=>{const h=src.length/(sw*4);for(let y=0;y<h;y++)dest.set(src.subarray(y*sw*4,(y+1)*sw*4),((dy+y)*dw+dx)*4);};
/** getImageData + premultiply + software pass over a painted canvas region. */
function cpuRegion(source,sx,sy,region,stack,options){
 prepareSource();
 const data=source.getContext('2d',{willReadFrequently:true}).getImageData(region.x-sx,region.y-sy,region.width,region.height).data;
 return softwarePixels(premultiply(data),region.width,region.height,stack,options);
}
let resultCanvas;
/** Software results are premultiplied buffers; wrap them in a canvas so the
 * destination can composite with ordinary source-over drawImage. */
function filteredCanvas(filtered){
 if(!filtered?.pixels)return filtered;
 resultCanvas??=new OffscreenCanvas(1,1);
 if(resultCanvas.width!==filtered.width)resultCanvas.width=filtered.width;if(resultCanvas.height!==filtered.height)resultCanvas.height=filtered.height;
 resultCanvas.getContext('2d').putImageData(new ImageData(unpremultiply(filtered.pixels),filtered.width,filtered.height),0,0);
 return resultCanvas;
}
/** Copy a filtered result's source rectangle (sx,sy,w,h) to (dx,dy). A region
 * result lies inside a larger executor canvas. */
function drawFiltered(context,filtered,sx,sy,w,h,dx,dy){
 if(filtered?.canvas&&filtered.x!==undefined)context.drawImage(filtered.canvas,filtered.x+sx,filtered.y+sy,w,h,dx,dy,w,h);
 else context.drawImage(filteredCanvas(filtered),sx,sy,w,h,dx,dy,w,h);
}
/** Filtered software results shared across output tiles. Tiled export
 * repaints the same owner effects for every tile; when the halo-bounded source
 * is tile-invariant its filtered pixels are identical, so each unique source
 * is filtered once and composited per tile. The key chain is context → stack
 * object → geometry+content signature, so a repeated signature can only come
 * from the same painted content. Entries own their canvas (the executor
 * reuses its buffers). Preview owners explicitly configure their hardware
 * allowance and share it with their isolation children. Unconfigured export
 * contexts preserve the existing large tiled-export allowance. One aggregate
 * LRU uses the largest active allowance, never the sum of context allowances. */
const filteredCache=new WeakMap(),cacheLRU=new Map(),cacheOwners=new Set(),EXPORT_FILTER_CACHE_BYTES=1280*1024*1024,FILTER_CACHE_ENTRIES=2048;
let cacheBytes=0;
function softwareScope(context){
 let scope=filteredCache.get(context);
 if(!scope){scope={byStack:new WeakMap(),entries:new Set(),owner:{maxBytes:EXPORT_FILTER_CACHE_BYTES,bytes:0,entries:new Set()}};filteredCache.set(context,scope);}
 return scope;
}
function cacheTarget(incoming){let target=incoming?.maxBytes??0;for(const owner of cacheOwners)target=Math.max(target,owner.maxBytes);return target;}
function cacheRelease(entry){
 entry.map.delete(entry.sig);entry.scope.entries.delete(entry);cacheLRU.delete(entry);cacheBytes-=entry.bytes;
 const owner=entry.scope.owner;owner.entries.delete(entry);owner.bytes-=entry.bytes;if(!owner.entries.size)cacheOwners.delete(owner);
 entry.canvas.width=entry.canvas.height=1;
}
function trimSoftwareCache(owner){
 if(owner)while(owner.entries.size&&owner.bytes>owner.maxBytes)cacheRelease(owner.entries.values().next().value);
 while(cacheLRU.size&&(cacheBytes>cacheTarget()||cacheLRU.size>FILTER_CACHE_ENTRIES))cacheRelease(cacheLRU.keys().next().value);
}
/** Configure one pixel lifetime, or attach a child context to its parent's
 * existing allowance. Group/outline/effect scratch shares the quota instead
 * of acquiring another quota for every nested Canvas context. */
export function configureVfxSoftwareResources(context,{maxBytes,owner:parent}={}){
 const scope=softwareScope(context);let changed=false;
 if(parent&&parent!==context){
  const owner=softwareScope(parent).owner;
  if(scope.owner!==owner){for(const entry of [...scope.entries])cacheRelease(entry);scope.owner=owner;changed=true;}scope.parent=true;
 }
 if(maxBytes!==undefined){if(!Number.isFinite(maxBytes)||maxBytes<0)throw new RangeError('Software filter retention must be a finite nonnegative byte allowance.');scope.owner.maxBytes=maxBytes;trimSoftwareCache(scope.owner);}
 else if(changed)trimSoftwareCache();
}
export function vfxSoftwareResourceStats(context){
 const owner=context?filteredCache.get(context)?.owner:null;
 return owner?{bytes:owner.bytes,entries:owner.entries.size,maxBytes:owner.maxBytes}:{bytes:cacheBytes,entries:cacheLRU.size,maxBytes:cacheTarget()};
}
function cacheGet(context,stackObj,sig){
 const entry=filteredCache.get(context)?.byStack.get(stackObj)?.get(sig);
 if(entry){cacheLRU.delete(entry);cacheLRU.set(entry,entry);const entries=entry.scope.owner.entries;entries.delete(entry);entries.add(entry);}
 return entry;
}
function cacheAdmit(context,bytes){
 const owner=softwareScope(context).owner;
 if(bytes>owner.maxBytes)return false;
 while(owner.entries.size&&owner.bytes+bytes>owner.maxBytes)cacheRelease(owner.entries.values().next().value);
 while(cacheLRU.size&&(cacheBytes+bytes>cacheTarget(owner)||cacheLRU.size>=FILTER_CACHE_ENTRIES))cacheRelease(cacheLRU.keys().next().value);
 return true;
}
function cacheStore(context,stackObj,sig,canvas,bytes){
 if(!cacheAdmit(context,bytes))return null;
 const scope=softwareScope(context),byStack=scope.byStack;
 let map=byStack.get(stackObj);if(!map){map=new Map();byStack.set(stackObj,map);}
 const old=map.get(sig);
 if(old)cacheRelease(old);
 const entry={canvas,bytes,map,sig,scope};map.set(sig,entry);scope.entries.add(entry);cacheLRU.set(entry,entry);cacheBytes+=bytes;
 scope.owner.entries.add(entry);scope.owner.bytes+=bytes;cacheOwners.add(scope.owner);
 return entry;
}
/** Release software-only working owners after a worker capture. The ordinary
 * preview/export filter selection and cache reuse stay unchanged until an
 * owning worker explicitly ends this lifetime. */
export function releaseVfxSoftwareResources(){
 for(const entry of [...cacheLRU.keys()])cacheRelease(entry);
 cpu?.destroy();cpu=undefined;
 for(const canvas of [resultCanvas,tileCanvas])if(canvas)canvas.width=canvas.height=1;
 resultCanvas=tileCanvas=undefined;
}
/** Paint a world-space source rect into premultiplied pixels, striping past
 * the single-canvas bound. */
function paintSourceRect(paintAt,src){
 prepareSource();
 let data;
 if(fitsSourceBound(src.width,src.height)){
  const canvas=new OffscreenCanvas(src.width,src.height),ctx=canvas.getContext('2d');
  try{ctx.setTransform(1,0,0,1,0,0);paintAt(ctx,src.x,src.y);data=premultiply(ctx.getImageData(0,0,src.width,src.height).data);}
  finally{releaseVfxWorkerSource(ctx);}
 }else{
  data=new Uint8ClampedArray(src.width*src.height*4);
  for(const strip of splitRect(src,VFX_SOURCE_DIMENSION)){
   const canvas=new OffscreenCanvas(strip.width,strip.height),ctx=canvas.getContext('2d');
   try{ctx.setTransform(1,0,0,1,0,0);paintAt(ctx,strip.x,strip.y);const img=ctx.getImageData(0,0,strip.width,strip.height);premultiply(img.data);blitInto(data,src.width,img.data,strip.width,strip.x-src.x,strip.y-src.y);}
   finally{releaseVfxWorkerSource(ctx);}
  }
 }
 return data;
}
/** Preview raster budgets must include nested effect halos, not only artwork.
 * Called on cache misses; the document and requested export scale are untouched. */
export function vfxRasterScale(items,bounds,requested,limit){
 let padding=0,filtered=false;
 for(const item of items)if(hasDrawableVfx(item)){filtered=true;padding=Math.max(padding,drawableVfxPadding(item));}
 if(!filtered)return requested;
 const deviceLimit=limit??(typeof OffscreenCanvas==='undefined'?4096:vfxSurfaceDimension()||4096);
 const edge=Math.min(4096,deviceLimit)-128; // rounding/antialias guards through nested scopes
 return Math.min(requested,edge/(bounds.width+2*padding),edge/(bounds.height+2*padding));
}
/** Pure native source/domain calculation, shared by painting and bounded
 * worker admission. Passing padding does not change the executor or density. */
export function vfxSourcePlan({width:canvasWidth,height:canvasHeight,matrix,stack,bounds,domainBounds=bounds,scale=1,padding}){
 const pixelScale=Math.hypot(matrix.a,matrix.b)*Math.abs(scale),pad=padding??vfxSourcePadding(stack,pixelScale)+2;
 const corners=bounds?[[bounds.x,bounds.y],[bounds.x+bounds.width,bounds.y],[bounds.x,bounds.y+bounds.height],[bounds.x+bounds.width,bounds.y+bounds.height]].map(([x,y])=>({x:matrix.a*x+matrix.c*y+matrix.e,y:matrix.b*x+matrix.d*y+matrix.f})): [{x:0,y:0},{x:canvasWidth,y:canvasHeight}];
 const x=Math.max(-pad,Math.floor(Math.min(...corners.map(p=>p.x)))-pad),y=Math.max(-pad,Math.floor(Math.min(...corners.map(p=>p.y)))-pad),right=Math.min(canvasWidth+pad,Math.ceil(Math.max(...corners.map(p=>p.x)))+pad),bottom=Math.min(canvasHeight+pad,Math.ceil(Math.max(...corners.map(p=>p.y)))+pad),width=Math.max(1,right-x),height=Math.max(1,bottom-y);
 if(right<=-pad||bottom<=-pad||x>=canvasWidth+pad||y>=canvasHeight+pad)return null;
 // Anchor spatial filters to the full owner bounds, never the viewport/tile crop.
 const domain=domainBounds?[[domainBounds.x,domainBounds.y],[domainBounds.x+domainBounds.width,domainBounds.y],[domainBounds.x,domainBounds.y+domainBounds.height],[domainBounds.x+domainBounds.width,domainBounds.y+domainBounds.height]].map(([x,y])=>({x:matrix.a*x+matrix.c*y+matrix.e,y:matrix.b*x+matrix.d*y+matrix.f})):corners; const anchorX=Math.min(...domain.map(p=>p.x)),anchorY=Math.min(...domain.map(p=>p.y));
 const outputSize={width:Math.max(1,Math.max(...domain.map(p=>p.x))-anchorX),height:Math.max(1,Math.max(...domain.map(p=>p.y))-anchorY)};
 return {rect:{x,y,width,height},pixelScale,pad,corners,anchorX,anchorY,outputSize};
}
/** The native software route expands only the required output through its
 * sampling halo. Keep the exact region shared with admission as well. */
export function vfxSoftwareSourcePlan({rect,pad,corners},{width:canvasWidth,height:canvasHeight,outputRect}={}){
 const wx=Math.floor(Math.min(...corners.map(p=>p.x)))-pad,wy=Math.floor(Math.min(...corners.map(p=>p.y)))-pad;
 const world={x:wx,y:wy,width:Math.max(1,Math.ceil(Math.max(...corners.map(p=>p.x)))+pad-wx),height:Math.max(1,Math.ceil(Math.max(...corners.map(p=>p.y)))+pad-wy)};
 const cl=Math.max(0,rect.x),ct=Math.max(0,rect.y),cr=Math.min(canvasWidth,rect.x+rect.width),cb=Math.min(canvasHeight,rect.y+rect.height);
 if(cr<=cl||cb<=ct)return null;
 const rout={x:Math.min(cl,Math.max(world.x,outputRect?outputRect.x:cl)),y:Math.min(ct,Math.max(world.y,outputRect?outputRect.y:ct)),width:0,height:0};
 rout.width=Math.max(cr,Math.min(world.x+world.width,outputRect?outputRect.x+outputRect.width:cr))-rout.x;
 rout.height=Math.max(cb,Math.min(world.y+world.height,outputRect?outputRect.y+outputRect.height:cb))-rout.y;
 const rin={x:Math.max(world.x,rout.x-pad),y:Math.max(world.y,rout.y-pad),width:0,height:0};
 rin.width=Math.min(world.x+world.width,rout.x+rout.width+pad)-rin.x;
 rin.height=Math.min(world.y+world.height,rout.y+rout.height+pad)-rin.y;
 {const rx=Math.floor(rin.x),ry=Math.floor(rin.y);rin.width=Math.ceil(rin.x+rin.width)-rx;rin.height=Math.ceil(rin.y+rin.height)-ry;rin.x=rx;rin.y=ry;}
 return {world,rout,rin,cl,ct,cr,cb};
}
export function withVfx(context,stack,paint,{bounds,domainBounds=bounds,scale=1,cacheHint,outputRect}={}){
 const stackObj=stack;
 stack=activeVfx(stack);if(!stack.length){paint(context);return;}
 const matrix=context.getTransform(),plan=vfxSourcePlan({width:context.canvas.width,height:context.canvas.height,matrix,stack,bounds,domainBounds,scale});
 if(!plan)return;
 const {rect,pixelScale,pad,corners,anchorX,anchorY,outputSize}=plan,{x,y,width,height}=rect;
 const paintAt=(ctx,tx,ty)=>{configureVfxSoftwareResources(ctx,{owner:context});ctx.setTransform(matrix.a,matrix.b,matrix.c,matrix.d,matrix.e-tx,matrix.f-ty);paint(ctx);};
 const render=tile=>{
  prepareSource();
  let surface=surfaces.get(context);if(!surface){surface=new OffscreenCanvas(tile.width,tile.height);surfaces.set(context,surface);}if(surface.width!==tile.width)surface.width=tile.width;if(surface.height!==tile.height)surface.height=tile.height;
  const ctx=surface.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,tile.width,tile.height);paintAt(ctx,tile.x,tile.y);
  const filtered=filterVfxCanvas(surface,stack,{scale:pixelScale,origin:{x:tile.x-anchorX,y:tile.y-anchorY},outputSize,region:true});
  context.save();try{context.setTransform(1,0,0,1,0,0);const out=tile.output;
   if(out)drawFiltered(context,filtered,out.x-tile.x,out.y-tile.y,out.width,out.height,out.x,out.y);
   else drawFiltered(context,filtered,0,0,tile.width,tile.height,tile.x,tile.y);
  }finally{context.restore();}
 };
 const limit=vfxSurfaceDimension();
 if(fitsVfxSurface(width,height,limit)){render(rect);return;}
 let tiled=false;
 if(limit>0)try{for(const tile of vfxSurfaceTiles(rect,context.canvas,pad,limit))render(tile);tiled=true;}catch(error){if(vfxWorkerPixelsOwned())throw error;tiled=false;}
 if(tiled)return;
 // Software path. The drawn pixels sit inside world ∩ output, and every tap
 // they need sits inside rin = (world ∩ output)±pad ∩ world — a region that
 // is tile-invariant, so it is filtered once and composited per tile.
 const software=vfxSoftwareSourcePlan(plan,{width:context.canvas.width,height:context.canvas.height,outputRect});
 if(!software)return;
 const {world,rout,rin,cl,ct,cr,cb}=software;
 if(cacheHint!==undefined&&typeof stackObj==='object'&&stackObj!==null&&rin.width>0&&rin.height>0&&rin.width*rin.height<=VFX_CPU_PIXELS){
  // Fingerprints are only needed by this oversized software cache. Ordinary
  // painting and GPU filtering must not serialize a dense pose on each redraw.
  const content=typeof cacheHint==='function'?cacheHint():cacheHint;
  const sig=`${rin.x-anchorX},${rin.y-anchorY},${rin.width},${rin.height}|${pixelScale}|${outputSize.width},${outputSize.height}|${content}`;
  let entry=cacheGet(context,stackObj,sig),transient=false;
  if(!entry){
   const retained=cacheAdmit(context,rin.width*rin.height*4);
   const data=paintSourceRect(paintAt,rin);
   const filtered=softwarePixels(data,rin.width,rin.height,stack,{scale:pixelScale,origin:{x:rin.x-anchorX,y:rin.y-anchorY},outputSize});
   const canvas=new OffscreenCanvas(rin.width,rin.height);
   canvas.getContext('2d').putImageData(new ImageData(unpremultiply(filtered.pixels),rin.width,rin.height),0,0);
   entry=retained?cacheStore(context,stackObj,sig,canvas,rin.width*rin.height*4):null;transient=!entry;entry??={canvas};
  }
  try{
   const x0=Math.max(cl,rin.x),y0=Math.max(ct,rin.y),x1=Math.min(cr,rin.x+rin.width),y1=Math.min(cb,rin.y+rin.height),w=x1-x0,h=y1-y0;
   if(w>0&&h>0){context.save();try{context.setTransform(1,0,0,1,0,0);context.drawImage(entry.canvas,x0-rin.x,y0-rin.y,w,h,x0,y0,w,h);}finally{context.restore();}}
  }finally{if(transient)entry.canvas.width=entry.canvas.height=1;}
  return;
 }
 // Oversized filtered region: software tiles keep full detail. Cores cover
 // rect ∩ canvas; each source is the core's halo clipped to rect.
 const core=Math.max(1,Math.min(1024,Math.floor(Math.sqrt(VFX_CPU_PIXELS))-2*pad));
 for(const out of splitRect({x:cl,y:ct,width:cr-cl,height:cb-ct},core)){
  const sx=Math.max(rect.x,out.x-pad),sy=Math.max(rect.y,out.y-pad),ex=Math.min(rect.x+rect.width,out.x+out.width+pad),ey=Math.min(rect.y+rect.height,out.y+out.height+pad);
  const src={x:sx,y:sy,width:ex-sx,height:ey-sy};
  if(src.width*src.height>VFX_CPU_PIXELS)throw vfxSurfaceError();
  const data=paintSourceRect(paintAt,src);
  const filtered=softwarePixels(data,src.width,src.height,stack,{scale:pixelScale,origin:{x:src.x-anchorX,y:src.y-anchorY},outputSize});
  context.save();try{context.setTransform(1,0,0,1,0,0);context.drawImage(filteredCanvas(filtered),out.x-src.x,out.y-src.y,out.width,out.height,out.x,out.y,out.width,out.height);}finally{context.restore();}
 }
}
export function applySceneVfx(context,frame,{scale=1,origin={x:0,y:0},outputSize,clip,padding}={}){
 const stack=activeVfx(vfxStack(frame));if(!stack.length)return false;
 const pad=Math.ceil(padding??vfxPadding(stack,scale,Math.max(outputSize?.width??context.canvas.width,outputSize?.height??context.canvas.height)));
 const cw=context.canvas.width,ch=context.canvas.height,os=outputSize??{width:cw,height:ch},limit=vfxSurfaceDimension();
 const emit=(filtered,cover,target)=>{ // draw the canvas ∩ cover ∩ target region
  const x0=Math.max(0,cover.x,target.x),y0=Math.max(0,cover.y,target.y),x1=Math.min(cw,cover.x+cover.width,target.x+target.width),y1=Math.min(ch,cover.y+cover.height,target.y+target.height),w=x1-x0,h=y1-y0;if(w<=0||h<=0)return;
  context.save();context.setTransform(1,0,0,1,0,0);if(clip){context.beginPath();context.rect(clip.x,clip.y,clip.width,clip.height);context.clip();}context.clearRect(x0,y0,w,h);context.drawImage(filteredCanvas(filtered),x0-cover.x,y0-cover.y,w,h,x0,y0,w,h);context.restore();
 };
 const width=cw+2*pad,height=ch+2*pad;
 if(fitsVfxSurface(width,height,limit)){
  let source=context.canvas;
  if(pad||clip){source=sceneSurfaces.get(context);if(!source){source=new OffscreenCanvas(width,height);sceneSurfaces.set(context,source);}if(source.width!==width)source.width=width;if(source.height!==height)source.height=height;const c=source.getContext('2d');c.clearRect(0,0,width,height);c.save();if(clip){c.beginPath();c.rect(clip.x+pad,clip.y+pad,clip.width,clip.height);c.clip();}c.drawImage(context.canvas,pad,pad);c.restore();}
  const output=filterVfxCanvas(source,stack,{scale,origin:{x:origin.x-pad,y:origin.y-pad},outputSize:os});
  context.save();context.setTransform(1,0,0,1,0,0);if(clip){context.beginPath();context.rect(clip.x,clip.y,clip.width,clip.height);context.clip();}context.clearRect(0,0,cw,ch);context.drawImage(filteredCanvas(output),-pad,-pad);context.restore();return true;
 }
 // Tiled/software fallback: each core's source is its halo clipped to the
 // canvas — sampling outside the canvas yields transparency either way.
 const whole={x:0,y:0,width:cw,height:ch},edge=Math.min(limit||0,Math.floor(Math.sqrt(VFX_MAX_PIXELS)))-2*pad;
 if(edge<1){ // the halo outgrew every GPU tile: software passes over bounded cores
  const cpuCore=Math.max(1,Math.floor(Math.sqrt(VFX_CPU_PIXELS))-2*pad);
  if(2*pad+1>Math.floor(Math.sqrt(VFX_CPU_PIXELS)))throw vfxSurfaceError();
  for(const c of splitRect(whole,cpuCore)){
   const rx=Math.max(0,c.x-pad),ry=Math.max(0,c.y-pad),region={x:rx,y:ry,width:Math.min(cw,c.x+c.width+pad)-rx,height:Math.min(ch,c.y+c.height+pad)-ry};
   emit(cpuRegion(context.canvas,0,0,region,stack,{scale,origin:{x:origin.x+region.x,y:origin.y+region.y},outputSize:os}),region,c);
  }
  return true;
 }
 for(const c of splitRect(whole,edge)){
  const rx=Math.max(0,c.x-pad),ry=Math.max(0,c.y-pad),region={x:rx,y:ry,width:Math.min(cw,c.x+c.width+pad)-rx,height:Math.min(ch,c.y+c.height+pad)-ry};
  let filtered;
  if(fitsVfxSurface(region.width,region.height,limit)){
   const tile=tileSurface(region.width,region.height),ctx=tile.getContext('2d');ctx.clearRect(0,0,region.width,region.height);ctx.save();if(clip){ctx.beginPath();ctx.rect(clip.x-region.x,clip.y-region.y,clip.width,clip.height);ctx.clip();}ctx.drawImage(context.canvas,region.x,region.y,region.width,region.height,0,0,region.width,region.height);ctx.restore();
   try{filtered=filterVfxCanvas(tile,stack,{scale,origin:{x:origin.x+region.x,y:origin.y+region.y},outputSize:os});}catch(error){if(vfxWorkerPixelsOwned())throw error;filtered=cpuRegion(context.canvas,0,0,region,stack,{scale,origin:{x:origin.x+region.x,y:origin.y+region.y},outputSize:os});}
  }else filtered=cpuRegion(context.canvas,0,0,region,stack,{scale,origin:{x:origin.x+region.x,y:origin.y+region.y},outputSize:os});
  emit(filtered,region,c);
 }
 return true;
}
let tileCanvas;
function tileSurface(w,h){tileCanvas??=new OffscreenCanvas(1,1);if(tileCanvas.width!==w)tileCanvas.width=w;if(tileCanvas.height!==h)tileCanvas.height=h;return tileCanvas;}
/** Render into real neighboring scene pixels before filtering. Unlike
 * applySceneVfx, this must be called before painting, not after camera clipping.
 * Never throws on surface size: the paint surface tiles into parts when a
 * single canvas cannot hold the padded source. */
export function prepareSceneVfx(context,frame,viewport,scale=1){
 const plan=sceneVfxPlan(frame,context.canvas.width,context.canvas.height,viewport,scale);
 const stack=activeVfx(vfxStack(frame));
 const core={x:viewport?.x??0,y:viewport?.y??0,width:context.canvas.width,height:context.canvas.height};
 if(!stack.length)return {...plan,context,parts:[{context,origin:{x:core.x,y:core.y},done(){}}],finish(){}};
 const pad=plan.pad,src={x:core.x-pad,y:core.y-pad,width:core.width+2*pad,height:core.height+2*pad},os=plan.outputSize,limit=vfxSurfaceDimension();
 const composite=(filtered,cover,target=core)=>{ // draw the target ∩ cover ∩ core region
  const x0=Math.max(cover.x,target.x,core.x),y0=Math.max(cover.y,target.y,core.y),x1=Math.min(cover.x+cover.width,target.x+target.width,core.x+core.width),y1=Math.min(cover.y+cover.height,target.y+target.height,core.y+core.height),w=x1-x0,h=y1-y0;if(w<=0||h<=0)return;
  context.save();try{context.setTransform(1,0,0,1,0,0);context.clearRect(x0-core.x,y0-core.y,w,h);context.drawImage(filteredCanvas(filtered),x0-cover.x,y0-cover.y,w,h,x0-core.x,y0-core.y,w,h);}finally{context.restore();}
 };
 // One painted source canvas: the common case at every output size.
 if(fitsSourceBound(src.width,src.height)){
  let source=sceneInputs.get(context);
  if(!source){source=new OffscreenCanvas(1,1);sceneInputs.set(context,source);}
  if(source.width!==src.width)source.width=src.width;if(source.height!==src.height)source.height=src.height;
  const ctx=source.getContext('2d');configureVfxSoftwareResources(ctx,{owner:context});const parts=[{context:ctx,origin:{x:src.x,y:src.y},done(){
   if(fitsVfxSurface(src.width,src.height,limit)){composite(filterVfxCanvas(source,stack,{scale,origin:{x:src.x,y:src.y},outputSize:os}),src);return;}
   const edge=Math.min(limit,Math.floor(Math.sqrt(VFX_MAX_PIXELS)))-2*pad;
   if(edge>=1){ // split the core so each GPU tile's halo fits the executor
    for(const c of splitRect(core,edge)){
     const region={x:c.x-pad,y:c.y-pad,width:c.width+2*pad,height:c.height+2*pad},tile=tileSurface(region.width,region.height);
     tile.getContext('2d').drawImage(source,region.x-src.x,region.y-src.y,region.width,region.height,0,0,region.width,region.height);
     try{composite(filterVfxCanvas(tile,stack,{scale,origin:{x:region.x,y:region.y},outputSize:os}),region,c);}
     catch(error){if(vfxWorkerPixelsOwned())throw error;composite(cpuRegion(source,src.x,src.y,region,stack,{scale,origin:{x:region.x,y:region.y},outputSize:os}),region,c);}
    }
    return;
   }
   composite(cpuRegion(source,src.x,src.y,src,stack,{scale,origin:{x:src.x,y:src.y},outputSize:os}),src);
  }}];
  return {...plan,context:parts[0].context,parts,finish(){}};
 }
 // Source exceeds a single canvas: the caller repaints one strip per part and
 // finish() assembles them for a single software pass.
 if(src.width*src.height>VFX_CPU_PIXELS)throw vfxSurfaceError();
 const parts=[...splitRect(src,VFX_SOURCE_DIMENSION)].map(strip=>{
  const canvas=new OffscreenCanvas(strip.width,strip.height);
  const child=canvas.getContext('2d');configureVfxSoftwareResources(child,{owner:context});return {context:child,origin:{x:strip.x,y:strip.y},canvas,rect:strip,done(){}};
 });
 return {...plan,context:parts[0].context,parts,finish(){
  prepareSource();
  const data=new Uint8ClampedArray(src.width*src.height*4);
  for(const part of parts){
   const img=part.canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,part.canvas.width,part.canvas.height);
   premultiply(img.data);blitInto(data,src.width,img.data,part.canvas.width,part.rect.x-src.x,part.rect.y-src.y);
   part.canvas.width=part.canvas.height=1;
  }
  composite(softwarePixels(data,src.width,src.height,stack,{scale,origin:{x:src.x,y:src.y},outputSize:os}),src);
 }};
}
export function releaseVfxSurface(context,{retainSoftwareFilters=false}={}){
 if(!retainSoftwareFilters){const scope=filteredCache.get(context);if(scope)for(const entry of [...(scope.parent?scope.entries:scope.owner.entries)])cacheRelease(entry);}
 const input=sceneInputs.get(context);if(input){releaseVfxSurface(input.getContext('2d'),{retainSoftwareFilters});input.width=input.height=1;sceneInputs.delete(context);}
 const scene=sceneSurfaces.get(context);if(scene){scene.width=scene.height=1;sceneSurfaces.delete(context);}
 const surface=surfaces.get(context);if(surface){releaseVfxSurface(surface.getContext('2d'),{retainSoftwareFilters});surface.width=surface.height=1;surfaces.delete(context);}
 if(!retainSoftwareFilters)trimSoftwareCache();
}
