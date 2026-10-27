import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,MIN_TILE,MAX_TILE,tileKey,assertTileCoordinates} from './drawing-tiles.mjs';
import {inverseMatrix} from './drawing-transform.mjs';

const PREFIX='data:image/png;base64,';
const PIXEL_CLIPBOARD_MAX_TILES=32768;
const PIXEL_CLIPBOARD_MAX_CHARACTERS=128*1024*1024;
const MAX_TILE_CHARACTERS=PREFIX.length+4*Math.ceil(65536/3);
const invalid=()=>{throw messageError(new Error(''), "errors.drawingClipboard.invalidDrawingPixelClipboard", {});};

/** Plain records and small PNG strings use the existing bounded clipboard wire
 * protocol. Version two preserves source coordinates and the full affine pose;
 * no dense image or second resampling is needed to copy a transformed lasso. */
export function validatePixelClipboard(data){
  if(!data||![1,2,4].includes(data.pixelsPerUnit))invalid();
  if(!data.world||![data.world.x,data.world.y].every(Number.isFinite))throw messageError(new Error(''), "errors.drawingClipboard.invalidDrawingPixelOrigin", {});
  if(data.matrix)inverseMatrix(data.matrix);
  if(data.version===2){
    if(!data.matrix||!Array.isArray(data.tiles)||data.tiles.length>PIXEL_CLIPBOARD_MAX_TILES)invalid();
    const b=data.bounds;
    if(b===null){if(data.tiles.length)invalid();}
    else if(!b||![b.x,b.y,b.width,b.height,b.x+b.width,b.y+b.height].every(Number.isSafeInteger)||b.width<1||b.height<1||b.x<MIN_TILE*TILE||b.y<MIN_TILE*TILE||b.x+b.width>(MAX_TILE+1)*TILE||b.y+b.height>(MAX_TILE+1)*TILE||!data.tiles.length)invalid();
    let characters=0;const seen=new Set();
    for(const tile of data.tiles){
      if(!tile)invalid();assertTileCoordinates(tile.tx,tile.ty);const key=tileKey(tile.tx,tile.ty);if(seen.has(key))invalid();seen.add(key);
      if(typeof tile.png!=='string'||!tile.png.startsWith(PREFIX)||tile.png.length>MAX_TILE_CHARACTERS)invalid();
      characters+=tile.png.length;if(characters>PIXEL_CLIPBOARD_MAX_CHARACTERS)invalid();
      if(tile.tx*TILE>=b.x+b.width||(tile.tx+1)*TILE<=b.x||tile.ty*TILE>=b.y+b.height||(tile.ty+1)*TILE<=b.y)invalid();
    }
    return {pixelBytes:data.tiles.length*TILE_BYTES,encodedBytes:characters*2};
  }
  if(data.version!==undefined&&data.version!==1)invalid();
  if(![data.width,data.height].every(n=>Number.isInteger(n)&&n>0&&n<=8192)||data.width*data.height>16*1024*1024||typeof data.dataUrl!=='string'||!data.dataUrl.startsWith(PREFIX)||data.dataUrl.length>96*1024*1024)invalid();
  return {pixelBytes:data.width*data.height*4,encodedBytes:data.dataUrl.length*2};
}
