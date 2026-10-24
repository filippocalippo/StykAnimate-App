/** Tile-level helpers of the drawing workspace: applying undo records, selection masks (lasso, rectangle,
 * ellipse, wand) and the work a filter would do. The pixel operations themselves run in the drawing
 * raster engine (docs/engine/drawing.md). */
import {messageError} from './localized-error.mjs';
import {DRAWING_MAX_PIXELS} from './drawing-model.mjs';
import {TILE,TILE_BYTES} from './drawing-tiles.mjs';
import {lassoContains} from './drawing-lasso.mjs';
export function applyTileChanges(store,changes,direction) {
  for(const change of changes){const value=change[direction];if(value==null)store.delete(change.tx,change.ty);else store.set(change.tx,change.ty,value);}
}
export const pixelChangeBytes=tiles=>tiles.reduce((n,t)=>n+(t.before?.byteLength??0)+(t.after?.byteLength??0)+64,256);
/** Bounding rect of every tile intersected by a pixel-space rect. */
export function tileAlignedRect(x,y,width,height){
  const x0=Math.floor(x/TILE)*TILE,y0=Math.floor(y/TILE)*TILE;
  return{x:x0,y:y0,width:Math.ceil((x+width)/TILE)*TILE-x0,height:Math.ceil((y+height)/TILE)*TILE-y0};
}
/** A lasso mask allocated only around the polygon bounding box. */
export function maskValue(m,x,y){if(!m||x<m.x||y<m.y||x>=m.x+m.width||y>=m.y+m.height)return 0;return m.points?Number(lassoContains(m.points,x,y)):m.mask[(y-m.y)*m.width+x-m.x]/(m.max??1);}
export function lassoMask(points) {
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
  const x0=Math.floor(Math.min(...xs)),y0=Math.floor(Math.min(...ys)),width=Math.ceil(Math.max(...xs))-x0,height=Math.ceil(Math.max(...ys))-y0;
  if(width*height>DRAWING_MAX_PIXELS)return {x:x0,y:y0,width,height,points};
  const mask=new Uint8Array(Math.max(0,width)*Math.max(0,height));
  if(points.length<3||width<1||height<1)return{x:x0,y:y0,width:Math.max(0,width),height:Math.max(0,height),mask};
  for(let y=0;y<height;y++){const crosses=[],wy=y0+y+.5;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a.y>wy)!==(b.y>wy))crosses.push(a.x+(wy-a.y)*(b.x-a.x)/(b.y-a.y));}crosses.sort((a,b)=>a-b);for(let i=0;i+1<crosses.length;i+=2)for(let x=Math.max(0,Math.ceil(crosses[i]-.5-x0));x<Math.min(width,Math.ceil(crosses[i+1]-.5-x0));x++)mask[y*width+x]=1;}
  return{x:x0,y:y0,width,height,mask};
}

/** Selection masks are {x,y,width,height,mask:Uint8Array} in cel pixel space,
 * one byte per pixel (0 or 1). */
export const rectPoints=(a,b)=>{const x0=Math.min(a.x,b.x),y0=Math.min(a.y,b.y),x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y);return [{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];};
export const ellipsePoints=(a,b,n=96)=>{const cx=(a.x+b.x)/2,cy=(a.y+b.y)/2,rx=Math.abs(b.x-a.x)/2,ry=Math.abs(b.y-a.y)/2;return Array.from({length:n},(_,i)=>({x:cx+Math.cos(i/n*Math.PI*2)*rx,y:cy+Math.sin(i/n*Math.PI*2)*ry}));};
/** Rectangle mask covering `rect` entirely. */
export function rectMask(rect){if(rect.width*rect.height>DRAWING_MAX_PIXELS)return {...rect,points:rectPoints({x:rect.x,y:rect.y},{x:rect.x+rect.width,y:rect.y+rect.height})};return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,mask:new Uint8Array(rect.width*rect.height).fill(1)};}
/** Combine two masks: replace, add (union), subtract (a minus b) or intersect.
 * The result is cropped to its occupied bounding box, or null when empty. */
export function combineMasks(a,b,mode='replace'){
  if(mode==='replace'||!a)return mode==='subtract'||mode==='intersect'?null:cropMask(b);
  if(!b)return mode==='intersect'?null:cropMask(a);
  const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),width=Math.max(a.x+a.width,b.x+b.width)-x,height=Math.max(a.y+a.height,b.y+b.height)-y;
  if(width*height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingPixels.combinedSelectionExceedsThe16MegapixelMaskLimit", {});
  const out=new Uint8Array(width*height),at=maskValue;
  for(let py=0;py<height;py++)for(let px=0;px<width;px++){const u=at(a,px+x,py+y),v=at(b,px+x,py+y);out[py*width+px]=mode==='add'?(u|v):mode==='subtract'?(u&&!v?1:0):(u&v);}
  return cropMask({x,y,width,height,mask:out});
}
/** Invert a mask within `bounds` (the canvas region selections can reach). */
export function invertMask(m,bounds){
  if(bounds.width*bounds.height>DRAWING_MAX_PIXELS)throw messageError(new Error(''), "errors.drawingPixels.invertedSelectionExceedsThe16MegapixelMaskLimit", {});
  const out=new Uint8Array(bounds.width*bounds.height).fill(1);
  if(m)for(let py=0;py<m.height;py++)for(let px=0;px<m.width;px++){if(!maskValue(m,px+m.x,py+m.y))continue;const x=px+m.x-bounds.x,y=py+m.y-bounds.y;if(x>=0&&y>=0&&x<bounds.width&&y<bounds.height)out[y*bounds.width+x]=0;}
  return cropMask({...bounds,mask:out});
}
function cropMask(m){
  if(!m)return null;if(m.points)return m;let x0=m.width,y0=m.height,x1=-1,y1=-1;
  for(let py=0;py<m.height;py++){const row=py*m.width;for(let px=0;px<m.width;px++)if(m.mask[row+px]){if(px<x0)x0=px;if(px>x1)x1=px;if(py<y0)y0=py;y1=py;}}
  if(x1<0)return null;if(x0===0&&y0===0&&x1===m.width-1&&y1===m.height-1)return m;
  const width=x1-x0+1,height=y1-y0+1,mask=new Uint8Array(width*height);
  for(let py=0;py<height;py++)mask.set(m.mask.subarray((py+y0)*m.width+x0,(py+y0)*m.width+x0+width),py*width);
  return {x:m.x+x0,y:m.y+y0,width,height,mask};
}
/** Boundary segments between selected and unselected pixels as flat
 * [x0,y0,x1,y1,…] runs in pixel space, merged along rows and columns, or null
 * when the outline exceeds `limit` segments (callers draw the bounds instead). */
export function maskEdges(m,limit=250000){
  if(!m)return null;const {width:w,height:h}=m,at=(px,py)=>px>=0&&py>=0&&px<w&&py<h?m.mask[py*w+px]:0,out=[];
  for(let py=0;py<=h;py++){let start=-1;for(let px=0;px<=w;px++){const edge=px<w&&at(px,py)!==at(px,py-1);if(edge&&start<0)start=px;else if(!edge&&start>=0){out.push(m.x+start,m.y+py,m.x+px,m.y+py);start=-1;if(out.length>limit*4)return null;}}}
  for(let px=0;px<=w;px++){let start=-1;for(let py=0;py<=h;py++){const edge=py<h&&at(px,py)!==at(px-1,py);if(edge&&start<0)start=py;else if(!edge&&start>=0){out.push(m.x+px,m.y+start,m.x+px,m.y+py);start=-1;if(out.length>limit*4)return null;}}}
  return out;
}
/** Paint `color` [r,g,b,a] over every selected pixel (source-over). */
function assertFilterBounds(bounds){
  if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height,bounds.x+bounds.width,bounds.y+bounds.height].every(Number.isSafeInteger)||bounds.width<1||bounds.height<1)throw messageError(new Error(''), "errors.drawingPixels.invalidFilterBounds", {});
}
/** Point filters visit only existing tile intersections. Their pixel limit
 * follows occupied work, so distant paint does not allocate its empty bounds. */
export function pointFilterWork(store,bounds){
  assertFilterBounds(bounds);let pixels=0,bytes=0;
  for(const tile of store){
    const x=tile.tx*TILE,y=tile.ty*TILE,width=Math.min(x+TILE,bounds.x+bounds.width)-Math.max(x,bounds.x),height=Math.min(y+TILE,bounds.y+bounds.height)-Math.max(y,bounds.y);
    if(width>0&&height>0){pixels+=width*height;bytes+=TILE_BYTES;}
  }
  return {pixels,bytes};
}
/** Drawing filters over `bounds`, weighted by an optional selection mask:
 * blur (three box passes ≈ Gaussian, premultiplied so transparent pixels
 * never darken edges), hue/saturation/lightness, brightness/contrast and
 * invert. Pixels outside the mask keep their exact bytes. */
