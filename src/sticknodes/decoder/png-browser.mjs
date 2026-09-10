/** Lossless portable PNG encoding, avoiding canvas alpha premultiplication. */
import {crc32} from './archive.mjs';
function pngJoin(parts){const out=new Uint8Array(parts.reduce((s,b)=>s+b.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;}
function pngChunk(type,data){const typeBytes=new TextEncoder().encode(type),out=new Uint8Array(data.length+12),view=new DataView(out.buffer);view.setUint32(0,data.length);out.set(typeBytes,4);out.set(data,8);view.setUint32(out.length-4,crc32(out.subarray(4,-4)));return out;}
export async function encodePNGPortable({width,height,channels},pixels){
 if(!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||![3,4].includes(channels)||pixels.length!==width*height*channels)throw new RangeError('Invalid RGB/RGBA image dimensions.');
 if(typeof CompressionStream==='undefined')throw new Error('This browser requires CompressionStream to export lossless PNGs.');
 const stride=width*channels,scan=new Uint8Array((stride+1)*height);for(let y=0;y<height;y++)scan.set(pixels.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);
 const compressed=new Uint8Array(await new Response(new Blob([scan]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
 const header=new Uint8Array(13),view=new DataView(header.buffer);view.setUint32(0,width);view.setUint32(4,height);header[8]=8;header[9]=channels===4?6:2;
 return pngJoin([new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',compressed),pngChunk('IEND',new Uint8Array())]);
}
