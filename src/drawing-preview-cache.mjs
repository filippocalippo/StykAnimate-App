import {messageError} from './localized-error.mjs';
import {TILE,tileKey} from './drawing-tiles.mjs';

/** A bounded derived-image cache. Dense viewport rasterization belongs to a
 * dedicated worker, never the input thread. Old completed images remain
 * usable while a new revision is prepared. Completed snapshots can trail live
 * input; replies from discarded surfaces or cancelled jobs are disposed. */
export class DrawingPreviewCache {
  constructor(worker,{budgetBytes=64*1024*1024,onReady=()=>{},onError=()=>{},reserve=()=>true,hold=()=>{}}={}){
    Object.assign(this,{worker,budgetBytes,onReady,onError,reserve,hold,cache:new Map(),queue:new Map(),bytes:0});
  }
  scratch(entry,rect,{level=0,maxSide=4096,clamp=false}={}){
    const b=entry.store?.tileBounds,f=2**level;if(!b||!rect||rect.width<=0||rect.height<=0)return null;
    maxSide=Math.min(maxSide,4096,Math.floor(Math.sqrt(this.budgetBytes/4)/TILE)*TILE);if(maxSide<TILE)return null;
    let x=Math.max(Math.floor(b.x/f/TILE)*TILE,Math.floor(rect.x/f/TILE)*TILE-TILE),y=Math.max(Math.floor(b.y/f/TILE)*TILE,Math.floor(rect.y/f/TILE)*TILE-TILE);
    let right=Math.min(Math.ceil((b.x+b.width)/f/TILE)*TILE,Math.ceil((rect.x+rect.width)/f/TILE)*TILE+TILE),bottom=Math.min(Math.ceil((b.y+b.height)/f/TILE)*TILE,Math.ceil((rect.y+rect.height)/f/TILE)*TILE+TILE);
    if(right<=x||bottom<=y)return null;
    if(right-x>maxSide||bottom-y>maxSide){if(!clamp)return null;x=Math.max(x,Math.min(right-maxSide,Math.floor((rect.x+rect.width/2)/f-maxSide/2)));y=Math.max(y,Math.min(bottom-maxSide,Math.floor((rect.y+rect.height/2)/f-maxSide/2)));right=Math.min(right,x+maxSide);bottom=Math.min(bottom,y+maxSide);}
    const width=right-x,height=bottom-y,anchorKey=`worker:${level}:${x},${y},${width},${height}`,key=entry.id+'|'+anchorKey,version=entry.pixelStamp??0;
    let hit=this.cache.get(key);if(hit?.entry!==entry||hit?.store!==entry.store)hit=null;
    // Growing strokes and pans change the requested anchor. Keep displaying
    // the newest overlapping snapshot while that new cover is prepared.
    if(hit?.version!==version)for(const value of this.cache.values()){
      if(value.entry===entry&&value.store===entry.store&&value.level===level&&(!hit||value.version>hit.version)&&value.x<right&&value.x+value.width>x&&value.y<bottom&&value.y+value.height>y)hit=value;
    }
    const failed=entry.previewError?.store===entry.store&&entry.previewError.version===version;
    if(hit){this.cache.delete(hit.key);this.cache.set(hit.key,hit);}
    // Zooming across a mip level has nothing at the new level yet: show the
    // overlapping snapshot of the nearest level, scaled, rather than a blank
    // frame. The request below still prepares the right density.
    let stand=null;
    if(!hit)for(const value of this.cache.values()){
      if(value.entry!==entry||value.store!==entry.store)continue;const s=value.scale;
      if(value.x*s>=rect.x+rect.width||(value.x+value.width)*s<=rect.x||value.y*s>=rect.y+rect.height||(value.y+value.height)*s<=rect.y)continue;
      if(!stand||Math.abs(value.level-level)<Math.abs(stand.level-level)||value.level===stand.level&&value.version>stand.version)stand=value;
    }
    if(!failed&&(hit?.version!==version||hit?.anchorKey!==anchorKey)){
      // One request per cel per render: the renderer's higher-level retries
      // must not replace the desired sampling density with level eight.
      if(!this.queue.has(entry.id)&&this.active?.entry!==entry){
        if(this.queue.size>=3)this.queue.delete(this.queue.keys().next().value);
        this.queue.set(entry.id,{entry,store:entry.store,version,key,anchorKey,x,y,width,height,level,scale:f});this.pump();
      }
    }
    return hit?{...hit,dirty:null}:stand?{...stand,dirty:null}:null;
  }
  async pump(){
    if(this.active||this.disposed||!this.queue.size)return;
    const [id,job]=this.queue.entries().next().value;this.queue.delete(id);this.active=job;
    const current=()=>!this.disposed&&!job.cancelled&&!job.entry.disposed&&job.entry.store===job.store;
    let published=false;
    try{
      if(!current())return;
      job.version=job.entry.pixelStamp??0;
      const tiles=[],x=job.x*job.scale,y=job.y*job.scale,right=(job.x+job.width)*job.scale,bottom=(job.y+job.height)*job.scale;
      // The worker holds the tiles it was sent last only while it is the same worker: one that ended while idle (or was cancelled) starts empty.
      const cached=this.source?.entry===job.entry&&this.source?.storeRef.deref()===job.store&&(this.worker.active??true)&&this.source.instance===this.worker.instance?this.source:null,versions=new Map();
      let source=[];
      for(const tile of job.store){
        if(tile.tx*TILE>=right||(tile.tx+1)*TILE<=x||tile.ty*TILE>=bottom||(tile.ty+1)*TILE<=y)continue;
        const key=tileKey(tile.tx,tile.ty),version=tile.version??0;versions.set(key,version);
        if(cached?.versions.get(key)!==version)source.push(tile);
      }
      const copyBytes=source.length*TILE*TILE*4,workerBytes=Math.ceil(versions.size*TILE*TILE*4*1.34)+job.width*job.height*8;
      this.entry=job.entry;this.hold(this,Math.max(this.source?.bytes??0,workerBytes));
      // Reserve both the pinned snapshot and its transfer buffers before any
      // yielding copy. Mutations then copy on write, preserving one revision.
      this.hold(job,copyBytes*2);for(const tile of source)tile.frozen=true;
      for(const t of source){
        tiles.push({tx:t.tx,ty:t.ty,pixels:t.pixels.slice().buffer});
        if(tiles.length%128===0){await new Promise(resolve=>setTimeout(resolve,0));if(!current())return;}
      }
      if(!current())return;
      source=null;this.hold(job,copyBytes);
      const result=await this.worker.request('preview',{tiles,reset:!cached,keep:[...versions.keys()],rect:{x:job.x,y:job.y,width:job.width,height:job.height},level:job.level},{transfer:tiles.map(t=>t.pixels)});
      if(!current()){result.bitmap.close();return;}
      this.source={entry:job.entry,storeRef:new WeakRef(job.store),versions,bytes:workerBytes,instance:this.worker.instance};this.hold(this,workerBytes);this.lastTransferredTiles=tiles.length;
      this.remove(job.key);const bytes=job.width*job.height*4;
      if(!this.reserve(bytes)){result.bitmap.close();throw messageError(new Error(''), "errors.drawingPreviewCache.drawingPreviewMemoryIsFull", {});}
      for(const key of this.cache.keys()){if(this.bytes+bytes<=this.budgetBytes)break;this.remove(key);}
      this.cache.set(job.key,{canvas:result.bitmap,bytes,version:job.version,store:job.store,entry:job.entry,key:job.key,id,stamp:++job.entry.stamp,anchorKey:job.anchorKey,x:job.x,y:job.y,width:job.width,height:job.height,level:job.level,scale:job.scale});this.bytes+=bytes;
      published=true;this.onReady();
    }catch(error){this.worker.dispose();this.source=null;this.hold(this,0);if(current()&&error.name!=='AbortError'){job.entry.previewError={store:job.store,version:job.version};this.onError(error);}}
    finally{this.hold(job,0);if(!current()){this.worker.dispose();this.source=null;this.hold(this,0);}this.active=null;this.pump();if(!published&&!this.disposed&&!job.entry.disposed&&job.entry.store===job.store&&(job.cancelled||(job.entry.pixelStamp??0)!==job.version)){job.entry.stamp++;this.onReady();}}
  }
  remove(key){const value=this.cache.get(key);if(!value)return;value.canvas.close();this.bytes-=value.bytes;this.cache.delete(key);}
  drop(entry){for(const [key,job] of this.queue)if(job.entry===entry)this.queue.delete(key);for(const [key,value] of this.cache)if(value.entry===entry)this.remove(key);if(this.active?.entry===entry)this.active.cancelled=true;if(this.active?.entry===entry||this.source?.entry===entry){this.worker.dispose();this.source=null;this.hold(this,0);}}
  dispose(){this.disposed=true;this.queue.clear();this.worker.dispose();this.source=null;this.hold(this,0);for(const key of this.cache.keys())this.remove(key);}
}
