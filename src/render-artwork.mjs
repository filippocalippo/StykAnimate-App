/** Content identity for reusable object-local artwork. Native world geometry is
 * untouched. Coordinates must match exactly after subtracting each root; no
 * quantization or fast-hash-only equality can merge distinct poses or styles. */
const ignoredObjectKeys=new Set(['unique_id','object_slot','root_x','root_y','join','record_offset','record_end']);
const numericFields=['index','version','angle','bend','length','z','thickness','alpha','opacity'];
const knownFields=new Set(['obj','fig','slot','start','end','points','seg','poly','asset','type','rgb','static',...numericFields]);
const types=['line','circle','image','text','poly'];
const hash=values=>{let n=2166136261;for(let i=0;i<values.length;i++)n=Math.imul(n^values[i],16777619);return n>>>0;};
const textHash=value=>{let n=2166136261;for(let i=0;i<value.length;i++)n=Math.imul(n^value.charCodeAt(i),16777619);return n>>>0;};
const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
let registrySerial=0;
const encoder=new TextEncoder();
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');

export class ArtworkRegistry {
  constructor({maxBytes=64*1024*1024,maxEntries=512}={}){
    this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.namespace=++registrySerial;this.artworkSerial=0;this.clear();
  }
  clear(){this.buckets=new Map();this.lru=new Map();this.definitions=new Map();this.byGeometry=new WeakMap();this.figureCache=new WeakMap();this.bytes=0;this.definitionBytes=0;this.serial=0;this.stats={hits:0,misses:0,evictions:0};}
  // Definitions may be edited in place. Re-snapshot each one once per prepare,
  // rather than trusting its JS identity across document revisions.
  begin(){this.figureCache=new WeakMap();}
  /** Stable cross-packet identity survives eviction of the large comparison
   * records. Local lookup still compares full content after its fast hash.
   * SHA-256 addresses the complete, unquantized signature, not the fast hash. */
  contentKey(artwork){
    if(!artwork.data||!artwork.definition.text||!globalThis.crypto?.subtle)return Promise.resolve(`local:${this.namespace}:${artwork.id}`);
    return artwork.contentKeyPromise??=(async()=>{
      const definition=artwork.definition;
      const definitionKey=await (definition.contentDigest??=digest(encoder.encode(definition.text)));
      const header=encoder.encode(JSON.stringify(['styk-artwork-v1',definitionKey,artwork.metadata,artwork.data.byteLength]));
      const bytes=new Uint8Array(4+header.byteLength+artwork.data.byteLength);
      new DataView(bytes.buffer).setUint32(0,header.byteLength,true);bytes.set(header,4);
      bytes.set(new Uint8Array(artwork.data.buffer,artwork.data.byteOffset,artwork.data.byteLength),4+header.byteLength);
      return `sha256:${await digest(bytes)}`;
    })();
  }
  definition(figure){
    let value=this.figureCache.get(figure);if(value)return value;
    const text=JSON.stringify(figure);
    if(text.length*2>this.maxBytes/4){value={id:++this.serial,unshared:true};this.figureCache.set(figure,value);return value;}
    value=this.definitions.get(text);
    if(!value){
      if(this.definitionBytes+text.length*2>this.maxBytes/4){this.clear();}
      value={id:++this.serial,text};this.definitions.set(text,value);this.definitionBytes+=text.length*2;
    }
    this.figureCache.set(figure,value);return value;
  }
  get(g,items){
    const definition=this.definition(g.fig),previous=this.byGeometry.get(g);
    if(previous?.items===items&&previous.artwork.definition===definition)return previous.artwork;
    if(definition.unshared){const artwork={definition,id:++this.artworkSerial};this.byGeometry.set(g,{items,artwork});return artwork;}
    const coordinates=[],extra=[];
    const point=p=>{coordinates.push(p.x-g.root.x,p.y-g.root.y);};
    for(let i=0;i<items.length;i++){
      const item=items[i],{start,end,points,seg,poly,asset}=item,type=types.indexOf(item.type);
      coordinates.push(type,Number(Boolean(start)),Number(Boolean(end)),points?.length??-1,Number(Boolean(item.static)));
      for(const field of numericFields){
        const value=item[field];coordinates.push(value===undefined?NaN:value===null?Infinity:value);
        // Preserve distinctions that Float64 conversion would otherwise erase.
        if(value!==undefined&&value!==null&&(typeof value!=='number'||!Number.isFinite(value)))extra.push([i,field,typeof value,String(value)]);
      }
      const rgb=item.rgb;coordinates.push(rgb?.length??-1);if(rgb)for(const n of rgb)coordinates.push(n);
      if(start)point(start);if(end)point(end);if(points)for(const p of points)point(p);
      // Most records reference the definition directly. Styled/generated
      // records and future drawing attributes remain part of exact identity.
      if(type<0)extra.push([i,'type',item.type]);
      if(seg&&seg!==g.fig.segments?.[item.index])extra.push([i,'seg',seg]);
      if(poly&&poly!==g.fig.polyfills?.[item.index])extra.push([i,'poly',poly]);
      if(asset)extra.push([i,'asset',asset]);
      for(const key of Object.keys(item))if(!knownFields.has(key))extra.push([i,key,item[key]]);
    }
    const object=Object.fromEntries(Object.entries(g.obj).filter(([key])=>!ignoredObjectKeys.has(key)));
    const metadata=JSON.stringify([object,extra]);
    const data=new Float64Array(coordinates),words=new Uint32Array(data.buffer);
    const key=`${definition.id}:${textHash(metadata)}:${hash(words)}:${data.length}`;
    const bucket=this.buckets.get(key)||[];
    let artwork=bucket.find(entry=>entry.definition===definition&&entry.metadata===metadata&&equal(entry.data,data));
    if(artwork){this.stats.hits++;this.lru.delete(artwork);this.lru.set(artwork,true);}
    else{
      this.stats.misses++;
      artwork={definition,metadata,data,key,id:++this.artworkSerial,bytes:data.byteLength+metadata.length*2};
      if(artwork.bytes<=this.maxBytes){
        bucket.push(artwork);this.buckets.set(key,bucket);this.lru.set(artwork,true);this.bytes+=artwork.bytes;
        while(this.bytes>this.maxBytes||this.lru.size>this.maxEntries){
          const oldest=this.lru.keys().next().value;this.lru.delete(oldest);this.bytes-=oldest.bytes;this.stats.evictions++;
          const entries=this.buckets.get(oldest.key);entries.splice(entries.indexOf(oldest),1);if(!entries.length)this.buckets.delete(oldest.key);
        }
      }
      else artwork={definition,id:artwork.id};
    }
    this.byGeometry.set(g,{items,artwork});return artwork;
  }
}
