/** Packet metadata is private; bitmap storage may be shared across frames.
 * Identity uses SHA-256 of complete unquantized worker artwork, crop and
 * resolution; the registry's fast local hash alone never grants equality. */
export const bitmapKey=(packet,entry)=>entry.artworkKey===undefined?entry.bitmap:`${packet.cacheEpoch ?? packet.revision}:${entry.artworkKey}`;
export const bitmapBytes=entry=>entry.bitmap?entry.bitmap.width*entry.bitmap.height*4:0;
export function closePacketBitmaps(packet){
  for(const bitmap of new Set((packet?.compatibility||[]).map(e=>e.bitmap).filter(Boolean)))bitmap.close();
}
export function packetFootprint(packet){
  let base=packet.byteLength;
  const resources=new Map();
  for(const entry of packet.compatibility||[])if(entry.bitmap&&entry.artworkKey!==undefined){
    const bytes=bitmapBytes(entry);base-=bytes;resources.set(bitmapKey(packet,entry),bytes);
  }
  return {base,resources:[...resources]};
}
export class PlaybackBitmapPool {
  constructor(){this.resources=new Map();this.packets=new WeakMap();this.bytes=0;}
  incrementalBytes(packet){
    let bytes=packet.byteLength;
    for(const entry of packet.compatibility||[])if(entry.bitmap&&this.resources.has(bitmapKey(packet,entry)))bytes-=bitmapBytes(entry);
    return bytes;
  }
  acquire(packet){
    if(this.packets.has(packet))throw new Error('Playback packet already owns bitmap references.');
    const sizes=new Map();
    for(const entry of packet.compatibility||[])if(entry.bitmap){
      const key=bitmapKey(packet,entry),bytes=bitmapBytes(entry),existing=this.resources.get(key);
      const dimensions=`${entry.bitmap.width}:${entry.bitmap.height}`;
      if(!Number.isFinite(bytes)||bytes<=0||(existing&&existing.dimensions!==dimensions)||(sizes.has(key)&&sizes.get(key)!==dimensions))throw new Error('Shared playback artwork has inconsistent dimensions.');
      sizes.set(key,dimensions);
    }
    let base=packet.byteLength;
    const retained=new Set();
    for(const entry of packet.compatibility||[])if(entry.bitmap){
      const key=bitmapKey(packet,entry),bytes=bitmapBytes(entry);base-=bytes;
      let resource=this.resources.get(key);
      if(resource){
        if(resource.bitmap!==entry.bitmap)entry.bitmap.close();
        entry.bitmap=resource.bitmap;
      }else{
        resource={key,bitmap:entry.bitmap,dimensions:`${entry.bitmap.width}:${entry.bitmap.height}`,bytes,refs:0};this.resources.set(key,resource);this.bytes+=bytes;
      }
      if(!retained.has(resource)){resource.refs++;retained.add(resource);}
    }
    this.packets.set(packet,{base,retained});this.bytes+=base;
  }
  release(packet){
    const owned=this.packets.get(packet);if(!owned)return;
    this.packets.delete(packet);this.bytes-=owned.base;
    for(const resource of owned.retained)if(!--resource.refs){
      resource.bitmap.close();this.resources.delete(resource.key);this.bytes-=resource.bytes;
    }
  }
}
