import {messageError} from './localized-error.mjs';
import {createImageFigure} from './media-authoring.mjs';
import {TILE_BLOB_PREFIX,TILE_BLOB_MAX_CHARACTERS} from './drawing-tile-codec.mjs';
import {MIN_TILE,MAX_TILE,TILE} from './drawing-tiles.mjs';

export const DRAWING_TILE = 64;
export const DRAWING_MAX_PIXELS = 16 * 1024 * 1024;
/** The largest region a fill or the magic wand samples from the visible artwork ("sample all layers"). */
export const FILL_SOURCE_MAX_PIXELS = 64 * 1024 * 1024;
export const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
export const drawingMetadata = figure => figure?._styk?.drawing;
export const isDrawingLayer = layer => layer?.drawing?.version === 1;
export function drawingId() { return `cel-${globalThis.crypto.randomUUID()}`; }
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
export function copyDrawingFigure(figure,typeId,celId=drawingId()) {
  const result=structuredClone(figure);
  result.figure_type_id=typeId;result._styk.drawing={...result._styk.drawing,celId};
  return result;
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
// Sparse bounds describe coordinates, not an allocation. Two distant marks
// must round-trip without allocating the empty rectangle between them.
const integerRect=r=>r&&[r.x,r.y,r.width,r.height].every(Number.isSafeInteger)&&r.width>0&&r.height>0&&
  r.x>=MIN_TILE*TILE&&r.y>=MIN_TILE*TILE&&r.x+r.width<=(MAX_TILE+1)*TILE&&r.y+r.height<=(MAX_TILE+1)*TILE;
export function validateDrawingFigure(figure) {
  const d=drawingMetadata(figure);if(d===undefined)return;
  const point=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
  const identity=typeof d?.celId!=='string'||!/^cel-[a-zA-Z0-9-]{1,100}$/.test(d.celId)||![1,2,4].includes(d.pixelsPerUnit)||!Number.isSafeInteger(d.revision)||d.revision<0;
  if(d.version===1){
    if(identity||![d.width,d.height].every(n=>Number.isInteger(n)&&n>0&&n<=8192)||d.width*d.height>DRAWING_MAX_PIXELS||
      !point(d.origin)||!point(d.crop)||
      ![d.crop.x,d.crop.y,d.crop.width,d.crop.height].every(Number.isInteger)||d.crop.x<0||d.crop.y<0||d.crop.width<1||d.crop.height<1||
      d.crop.x+d.crop.width>d.width||d.crop.y+d.crop.height>d.height||typeof d.empty!=='boolean')
      throw messageError(new Error(''), "errors.drawingModel.invalidDrawingMetadataOrPaintDimensions", {});
  } else if(d.version===2){
    if(identity||!(d.bounds===null||integerRect(d.bounds)))throw messageError(new Error(''), "errors.drawingModel.invalidDrawingMetadata", {});
  } else throw messageError(new Error(''), "errors.drawingModel.invalidDrawingMetadataOrPaintDimensions", {});
  const a=figure.image_assets?.[0];
  if(figure.segments?.length!==1||figure.segments[0].segment_type!=='image'||figure.image_assets.length!==1||!a?.data_url?.startsWith('data:image/png;base64,')||
    (d.version===1&&!((a.width===d.crop.width&&a.height===d.crop.height)||(d.empty&&a.width===1&&a.height===1)))||
    (d.version===2&&!(a.width===1&&a.height===1&&a.display_width===1&&a.display_height===1)))
    throw messageError(new Error(''), "errors.drawingModel.aDrawingNeedsOneEmbeddedPngSpriteMatching", {});
  if(a.data_url.length>96*1024*1024)throw messageError(new Error(''), "errors.drawingModel.drawingPngExceedsTheAssetLimit", {});
  if(d.version===2&&a.styk_tiles!==undefined&&(typeof a.styk_tiles!=='string'||!a.styk_tiles.startsWith(TILE_BLOB_PREFIX)||a.styk_tiles.length>TILE_BLOB_PREFIX.length+TILE_BLOB_MAX_CHARACTERS))throw messageError(new Error(''), "errors.drawingModel.invalidDrawingTileBlob", {});
  let header;try{header=Uint8Array.from(atob(a.data_url.slice(22,66)),c=>c.charCodeAt(0));}catch{throw messageError(new Error(''), "errors.drawingModel.invalidDrawingPngHeader", {});}
  if(header.length<24||![137,80,78,71,13,10,26,10].every((v,i)=>header[i]===v))throw messageError(new Error(''), "errors.drawingModel.invalidDrawingPngHeader", {});
  const view=new DataView(header.buffer);if(view.getUint32(16)!==a.width||view.getUint32(20)!==a.height)throw messageError(new Error(''), "errors.drawingModel.drawingPngDimensionsDoNotMatchItsMetadata", {});
}
export function validateDrawings(report) {
  const ids=new Set();for(const figure of report.figure_types??[]) {
    validateDrawingFigure(figure);const d=drawingMetadata(figure);if(!d)continue;
    if(ids.has(d.celId))throw messageError(new Error(''), "errors.drawingModel.drawingCelIdentitiesMustBeUnique", {});ids.add(d.celId);
  }
  const layers=report._styk?.layers,sheet=report._styk?.layerSheet;if(!layers||!sheet)return;
  const figures=new Map((report.figure_types??[]).map(f=>[f.figure_type_id,f])),frames=new Map((report.keyframes??[]).map(f=>[f._styk?.frameId,f]));
  for(const [id,layer] of Object.entries(layers.byId??{}))if(layer.drawing){
    for(const key of sheet.tracks[id]?.keys??[]){if(!key.value?.frameId)continue;const frame=report._styk.frameSources?.[key.value.frameId]??frames.get(key.value.frameId);if(!frame)continue;
      const objects=frame.objects.filter(o=>layers.assignments?.[o.unique_id]===id);
      if(objects.length>1||objects.some(o=>!drawingMetadata(figures.get(o.figure_type_id))))throw messageError(new Error(''), "errors.drawingModel.drawingLayersMustContainOneDrawingCelPer", {});
    }
  }
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
