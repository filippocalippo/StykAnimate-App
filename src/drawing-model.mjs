import {messageError} from './localized-error.mjs';
import {createImageFigure} from './media-authoring.mjs';

const DRAWING_TILE = 64;
export const DRAWING_MAX_PIXELS = 16 * 1024 * 1024;
/** The largest region a fill or the magic wand samples from the visible artwork ("sample all layers"). */
export const FILL_SOURCE_MAX_PIXELS = 64 * 1024 * 1024;
export const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
export const drawingMetadata = figure => figure?._styk?.drawing;
export const isDrawingLayer = layer => layer?.drawing?.version === 1;
function drawingId() { return `cel-${globalThis.crypto.randomUUID()}`; }
/** v2 drawing cel: an ordinary image figure whose raster lives in the sparse
 * tile blob on image_assets[0].styk_tiles. The carrier PNG on data_url stays
 * 1×1 transparent; every consumer reads tiles through a presenter. */
export function createDrawingFigure({pixelsPerUnit=1,figureTypeId=1,celId=drawingId()}={}) {
  if (![1,2,4].includes(pixelsPerUnit)) throw messageError(new Error(''), "errors.drawingModel.choose12Or4DrawingResolution", {});
  const figure=createImageFigure({width:256,height:1,dataUrl:EMPTY_PNG,figureTypeId,name:'Drawing'});
  const a=figure.image_assets[0];
  Object.assign(a,{width:1,height:1,display_width:1,display_height:1,anchor_start:{x:0,y:0},anchor_end:{x:256,y:0},anchor_length:256,anchor_angle_rad:0,drawing_anchor:{x:0,y:0}});
  figure.segments[0].length=256;
  figure._styk.drawing={version:2,celId,pixelsPerUnit,revision:0,bounds:null};
  return figure;
}
/** v1 → v2 figure with identical anchors and segment geometry, so the same
 * object poses pixel space identically. Legacy surface pixel p sat at sprite
 * point p - anchor_start - crop; tiles keep those pixel coordinates, so the
 * migrated drawing_anchor is anchor_start + crop (scaled when the pixel space
 * itself was rescaled). The caller supplies the pixel-space bounds and the new
 * cel identity the entry is retargeted to. */
export function migrateDrawingFigure(figure,typeId,{celId=drawingId(),bounds=null,anchorScale=1}={}) {
  const old=drawingMetadata(figure);if(!old||old.version!==1)throw messageError(new Error(''), "errors.drawingModel.onlyV1DrawingsMigrate", {});
  const copy=structuredClone(figure),a=copy.image_assets[0];
  copy.figure_type_id=typeId;delete a.styk_tiles;
  const anchor={x:((a.anchor_start?.x??0)+old.crop.x)*anchorScale,y:((a.anchor_start?.y??0)+old.crop.y)*anchorScale};
  // v2 keeps anchor_start fixed at drawing_anchor so sprite-space and
  // pixel-space matrices coincide; anchor_end preserves length and direction.
  const end={x:anchor.x+(a.anchor_end?.x??0)-(a.anchor_start?.x??0),y:anchor.y+(a.anchor_end?.y??0)-(a.anchor_start?.y??0)};
  Object.assign(a,{data_url:EMPTY_PNG,width:1,height:1,display_width:1,display_height:1,anchor_start:{...anchor},anchor_end:end,drawing_anchor:anchor});
  copy._styk.drawing={version:2,celId,pixelsPerUnit:old.pixelsPerUnit,revision:0,bounds:bounds?{...bounds}:null};
  return copy;
}
/** Pixel-space artwork bounds for either drawing version, or null when empty. */
export function drawingPixelBounds(figure) {
  const d=drawingMetadata(figure);if(!d)return null;
  if(d.version===1)return{x:0,y:0,width:d.width,height:d.height};
  return d.bounds?{...d.bounds}:null;
}

/** Sprite pixel → world affine, matching Pivot's image compositor exactly. The
 * optional anchor selects the sprite-space origin; v2 carriers fix
 * anchor_start at drawing_anchor so both matrices coincide. */
export function drawingMatrix(item,anchor) {
  const a=item.asset,reverse=Boolean(item.seg.extra_u8_a??item.seg.extra?.[1]),mirror=Boolean(item.seg.extra_u8_b??item.seg.extra?.[2])!==Boolean(item.obj.image_text_flags);
  anchor??=a.anchor_start;
  const start=reverse?item.end:item.start,angle=(mirror?item.angle+a.anchor_angle_rad-Math.PI:item.angle-a.anchor_angle_rad)+(reverse?Math.PI:0);
  const scale=Math.hypot(item.end.x-item.start.x,item.end.y-item.start.y)/a.anchor_length;
  const c=Math.cos(angle)*scale,s=Math.sin(angle)*scale,m=mirror?-1:1;
  return [c*m,s*m,-s,c,start.x-c*m*anchor.x+s*anchor.y,start.y-s*m*anchor.x-c*anchor.y];
}
/** Tile-pixel → world affine: the coordinate space strokes and stores use. */
export function drawingPixelMatrix(item) {return drawingMatrix(item,item.asset.drawing_anchor??item.asset.anchor_start);}
export function transformPoint(matrix,p) {const [a,b,c,d,e,f]=matrix;return {x:a*p.x+c*p.y+e,y:b*p.x+d*p.y+f};}
export function inversePoint(matrix,p) {const [a,b,c,d,e,f]=matrix,det=a*d-b*c;if(Math.abs(det)<1e-12)throw messageError(new Error(''), "errors.drawingModel.setANonzeroDrawingScaleBeforePainting", {});return {x:(d*(p.x-e)-c*(p.y-f))/det,y:(a*(p.y-f)-b*(p.x-e))/det};}
