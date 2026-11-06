import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,tileKey,tileTransparent,assertTileCoordinates} from './drawing-tiles.mjs';

export const TRANSFORM_BYTES=384*1024*1024;
const limit=()=>{throw messageError(new Error(''), "errors.drawingTransform.theTransformExceedsTheDrawingWorkingMemoryLimit", {});};
export const tileIntersects=(t,r)=>t.tx*TILE<r.x+r.width&&(t.tx+1)*TILE>r.x&&t.ty*TILE<r.y+r.height&&(t.ty+1)*TILE>r.y;

export function transformBounds(r,m){
  const xs=[],ys=[];
  for(const x of [r.x,r.x+r.width])for(const y of [r.y,r.y+r.height]){xs.push(m[0]*x+m[2]*y+m[4]);ys.push(m[1]*x+m[3]*y+m[5]);}
  const x=Math.floor(Math.min(...xs)),y=Math.floor(Math.min(...ys));
  return {x,y,width:Math.ceil(Math.max(...xs))-x,height:Math.ceil(Math.max(...ys))-y};
}
export function inverseMatrix(m){
  if(!Array.isArray(m)||m.length!==6||!m.every(Number.isFinite))throw messageError(new Error(''), "errors.drawingTransform.invalidDrawingTransform", {});
  const [a,b,c,d,x,y]=m,det=a*d-b*c;
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)throw messageError(new Error(''), "errors.drawingTransform.theDrawingTransformIsSingular", {});
  return [d/det,-b/det,-c/det,a/det,(c*y-d*x)/det,(b*x-a*y)/det];
}
export function multiplyMatrix(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}

function filterLevel(matrix,filter){
  inverseMatrix(matrix);
  if(!['smooth','nearest'].includes(filter))throw messageError(new Error(''), "errors.drawingTransform.invalidDrawingTransformFilter", {});
  const [a,b,c,d]=matrix,det=a*d-b*c,q=a*a+b*b+c*c+d*d;
  const largest=Math.sqrt((q+Math.sqrt(Math.max(0,q*q-4*det*det)))/2),smallest=Math.abs(det)/largest;
  return filter==='nearest'?0:Math.max(0,Math.min(8,Math.floor(Math.log2(1/smallest)+1e-9)));
}
function supportBounds(b,matrix,filter,level){
  const f=2**level,halo=filter==='nearest'?0:f/2,x=Math.floor(b.x/f)*f,y=Math.floor(b.y/f)*f;
  const right=Math.ceil((b.x+b.width)/f)*f,bottom=Math.ceil((b.y+b.height)/f)*f;
  return transformBounds({x:x-halo,y:y-halo,width:right-x+2*halo,height:bottom-y+2*halo},matrix);
}
/** Include the filter footprint when collecting existing destination tiles.
 * Otherwise edge pixels could replace a neighboring tile that was not seeded. */
export function transformSupportBounds(bounds,matrix,filter='smooth'){return supportBounds(bounds,matrix,filter,filterLevel(matrix,filter));}

/** Plan only occupied source tiles. Neither coordinate distance nor the full
 * image's bounding rectangle can cause an allocation. Preflight all output
 * and mip tiles before rasterizing or touching a destination. */
function planTransform(source,matrix,filter,maxBytes,baseBytes,tileCost){
  if(!Number.isFinite(maxBytes)||maxBytes<0)throw messageError(new Error(''), "errors.drawingTransform.invalidDrawingTransformOptions", {});
  const level=filterLevel(matrix,filter);
  const coverage=Array.from({length:level},()=>new Set());let mipBytes=0;
  for(const t of source)for(let k=1;k<=level;k++){
    const keys=coverage[k-1],key=tileKey(Math.floor(t.tx/2**k),Math.floor(t.ty/2**k));
    if(!keys.has(key)){keys.add(key);mipBytes+=TILE_BYTES+96;if(baseBytes+mipBytes>maxBytes)limit();}
  }
  const candidates=new Map(),maxTiles=Math.floor((maxBytes-baseBytes-mipBytes)/(tileCost+96));
  if(maxTiles<0)limit();
  for(const tile of source){
    if(tileTransparent(tile))continue;
    const b=tile.alphaBounds,rect=supportBounds({...b,x:tile.tx*TILE+b.x,y:tile.ty*TILE+b.y},matrix,filter,level);
    const x0=Math.floor(rect.x/TILE),y0=Math.floor(rect.y/TILE),x1=Math.floor((rect.x+rect.width-1)/TILE),y1=Math.floor((rect.y+rect.height-1)/TILE);
    assertTileCoordinates(x0,y0);assertTileCoordinates(x1,y1);
    if((x1-x0+1)*(y1-y0+1)>maxTiles)limit();
    for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++){
      const key=tileKey(tx,ty);if(!candidates.has(key)){if(candidates.size>=maxTiles)limit();candidates.set(key,{tx,ty});}
    }
  }
  return {level,candidates};
}

/** Existing destination tiles must be seeded from the same sparse support
 * used by the transform, including filtering across tile boundaries. */
export function transformTileCoverage(source,matrix,filter='smooth',maxBytes=TRANSFORM_BYTES){
  return planTransform(source,matrix,filter,maxBytes,source.bytes,TILE_BYTES).candidates;
}

/** A serialized tile index can seed destination pixels without decoding PNGs
 * on the UI thread. Full tile support conservatively includes transparent edges. */
export function indexedTileCoverage(tiles,matrix,filter='smooth',maxBytes=TRANSFORM_BYTES){
  const source={bytes:tiles.length*TILE_BYTES,*[Symbol.iterator](){for(const {tx,ty} of tiles)yield{tx,ty,alphaBounds:{x:0,y:0,width:TILE,height:TILE}};}};
  return transformTileCoverage(source,matrix,filter,maxBytes);
}
