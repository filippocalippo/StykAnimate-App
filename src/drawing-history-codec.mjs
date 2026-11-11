/** Undo chunks are encoded by the drawing raster engine (engine-drawing.mjs `historyCodec`); this is how a record's tiles split into chunks. */

export const HISTORY_CHUNK_BYTES=1024*1024;
const HEADER=12,RECORD=16;
const size=side=>side?.byteLength??0;
export const historyPixelBytes=tiles=>tiles.reduce((n,t)=>n+size(t.before)+size(t.after),0);

export function* historyChunks(tiles){
  let chunk=[],bytes=HEADER;
  for(const tile of tiles){const length=RECORD+size(tile.before)+size(tile.after);if(bytes+length>HISTORY_CHUNK_BYTES&&chunk.length){yield chunk;chunk=[];bytes=HEADER;}chunk.push(tile);bytes+=length;}
  if(chunk.length)yield chunk;
}
