/** Floats in one GPU shape record: six aligned vec4s. */
const SHAPE_FLOATS = 24;

/** Immutable per-pose vector packets. Weak geometry lookup avoids retaining
 * scene graphs; the bounded LRU owns only arrays and small cache records. */
export class PlaybackVectorCache {
  constructor({maxBytes=32*1024*1024,maxEntries=4096}={}) {
    Object.assign(this,{maxBytes,maxEntries});this.clear();
  }
  clear(){this.byGeometry=new WeakMap();this.lru=new Set();this.bytes=0;this.hits=0;}
  get(geometry,transformIndex,compile) {
    let entry=this.byGeometry.get(geometry),data=entry?.data;
    if(data){
      this.hits++;this.lru.delete(entry);
      if(entry.transformIndex!==transformIndex){
        data=data.slice();for(let i=21;i<data.length;i+=SHAPE_FLOATS)data[i]=transformIndex;
        entry.data=data;entry.transformIndex=transformIndex;
      }
    } else {
      data=compile();
      if(data.byteLength>this.maxBytes||this.maxEntries<1)return data;
      while(this.lru.size&&(this.bytes+data.byteLength>this.maxBytes||this.lru.size>=this.maxEntries)){
        const old=this.lru.values().next().value;this.lru.delete(old);this.bytes-=old.data.byteLength;old.data=null;
      }
      entry={data,transformIndex};this.byGeometry.set(geometry,entry);this.bytes+=data.byteLength;
    }
    this.lru.add(entry);return data;
  }
}
