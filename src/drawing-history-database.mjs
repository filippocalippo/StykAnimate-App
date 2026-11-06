import {messageError} from './localized-error.mjs';
import {HISTORY_CHUNK_BYTES} from './drawing-history-codec.mjs';

const DB_NAME='stykanimate-drawing-history-v1';
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error??messageError(new Error(''), "errors.drawingHistoryDatabase.drawingHistoryTransactionAborted", {}));tx.onerror=()=>{};});
const range=(session,id)=>id===undefined?IDBKeyRange.bound([session],[session,[]]):IDBKeyRange.bound([session,id],[session,id,[]]);
const digest=async bytes=>new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
const same=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
const lockName=id=>'stykanimate-drawing-history:'+id;

/** Temporary, session-owned disk backing. A manifest becomes readable only
 * after all chunks commit. Web Locks protect other live editors from cleanup. */
export class DrawingHistoryDatabase {
  /** `codec` encodes and decodes undo chunks: the drawing raster engine's (`historyCodec` in engine-drawing.mjs). */
  constructor({name=DB_NAME,maxBytes=512*1024*1024,session=crypto.randomUUID(),externalLease=false,codec}={}){this.name=name;this.maxBytes=maxBytes;this.session=session;this.externalLease=externalLease;this.codec=codec;this.bytes=0;this.writes=new Map();}
  open(){
    if(this.opening)return this.opening;if(this.db)return Promise.resolve();
    return this.opening=this.initialize().catch(async error=>{
      this.db?.close();this.db=null;this.releaseLock?.();await this.lock?.catch(()=>{});this.lock=null;this.releaseLock=null;throw error;
    }).finally(()=>{this.opening=null;});
  }
  async initialize(){
    const opening=indexedDB.open(this.name,1);
    opening.onupgradeneeded=()=>{for(const store of ['sessions','records','chunks'])opening.result.createObjectStore(store);};
    const db=this.db=await request(opening);db.onversionchange=()=>{db.close();this.db=null;};
    if(navigator.locks){
      if(!this.externalLease&&!this.lock){
        let acquired,failed;const ready=new Promise((resolve,reject)=>{acquired=resolve;failed=reject;});
        this.lock=navigator.locks.request(lockName(this.session),()=>new Promise(resolve=>{this.releaseLock=resolve;acquired();}));this.lock.catch(failed);await ready;
      }
      const tx=db.transaction('sessions','readonly'),ids=await request(tx.objectStore('sessions').getAllKeys());
      for(const id of ids)if(id!==this.session)await navigator.locks.request(lockName(id),{ifAvailable:true},lock=>lock?this.removeSession(id):undefined);
    }
    // Without Web Locks, only explicit disposal deletes a session. Never guess
    // that an idle or suspended editor is dead from the age of its cache.
    const tx=db.transaction('sessions','readwrite'),done=complete(tx);tx.objectStore('sessions').put({created:Date.now()},this.session);await done;
    const read=db.transaction('records','readonly'),store=read.objectStore('records'),[records,keys]=await Promise.all([request(store.getAll(range(this.session))),request(store.getAllKeys(range(this.session)))]);
    // Chunk and partial-manifest writes share a transaction. A worker restart
    // can reclaim interrupted writes without scanning or decoding pixel blobs.
    const partial=keys.filter((_,i)=>!records[i].complete);
    if(partial.length){const tx=db.transaction(['records','chunks'],'readwrite'),done=complete(tx);for(const key of partial){tx.objectStore('records').delete(key);tx.objectStore('chunks').delete(range(this.session,key[1]));}await done;}
    this.bytes=records.reduce((n,r)=>n+(r.complete?r.storedBytes:0),0);this.writes.clear();
  }
  async removeSession(session){
    const tx=this.db.transaction(['sessions','records','chunks'],'readwrite'),done=complete(tx);
    tx.objectStore('sessions').delete(session);for(const store of ['records','chunks'])tx.objectStore(store).delete(range(session));await done;
  }
  async begin(id){
    await this.open();if(this.writes.has(id))throw messageError(new Error(''), "errors.drawingHistoryDatabase.drawingHistoryWriteAlreadyStarted", {});
    const state={parts:0,rawBytes:0,storedBytes:0,tiles:0,complete:false},tx=this.db.transaction('records','readwrite'),done=complete(tx);
    tx.objectStore('records').add(state,[this.session,id]);await done;this.writes.set(id,state);
  }
  async append(id,tiles){
    const state=this.writes.get(id);if(!state)throw messageError(new Error(''), "errors.drawingHistoryDatabase.drawingHistoryWriteIsUnavailable", {});
    const raw=this.codec.encode(tiles),checksum=await digest(raw);
    const packed=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const compressed=packed.length<raw.length,bytes=compressed?packed:raw;
    if(this.bytes+bytes.length>this.maxBytes)throw messageError(new DOMException('', 'QuotaExceededError'), "errors.drawingHistoryDatabase.drawingUndoDiskCacheIsFull", {});
    const next={...state,parts:state.parts+1,tiles:state.tiles+tiles.length,rawBytes:state.rawBytes+raw.length,storedBytes:state.storedBytes+bytes.length};
    const tx=this.db.transaction(['chunks','records'],'readwrite'),done=complete(tx);
    tx.objectStore('chunks').put({bytes,compressed,rawBytes:raw.length,checksum},[this.session,id,state.parts]);tx.objectStore('records').put(next,[this.session,id]);await done;
    Object.assign(state,next);this.bytes+=bytes.length;
  }
  async finish(id){
    const state=this.writes.get(id);if(!state?.parts)throw messageError(new Error(''), "errors.drawingHistoryDatabase.drawingHistoryWriteIsIncomplete", {});
    const tx=this.db.transaction('records','readwrite'),done=complete(tx);tx.objectStore('records').put({...state,complete:true},[this.session,id]);await done;this.writes.delete(id);return {...state};
  }
  async info(id){
    await this.open();const tx=this.db.transaction('records','readonly'),record=await request(tx.objectStore('records').get([this.session,id]));
    if(!record?.complete)throw messageError(new Error(''), "errors.drawingHistoryDatabase.drawingUndoDataIsUnavailableTheDocumentAnd", {});return record;
  }
  async read(id,part){
    await this.open();
    const tx=this.db.transaction('chunks','readonly'),entry=await request(tx.objectStore('chunks').get([this.session,id,part]));
    if(!entry||!Number.isInteger(entry.rawBytes)||entry.rawBytes<12||entry.rawBytes>HISTORY_CHUNK_BYTES)throw messageError(new Error(''), "errors.drawingHistoryDatabase.drawingUndoDataIsUnavailableOrDamaged", {});
    let bytes=entry.bytes;
    if(entry.compressed){
      const reader=new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();bytes=new Uint8Array(entry.rawBytes);let offset=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;if(offset+value.length>bytes.length)throw messageError(new Error(''), "errors.drawingHistoryDatabase.drawingUndoDataExpandsBeyondItsBounds", {});bytes.set(value,offset);offset+=value.length;}if(offset!==bytes.length)throw messageError(new Error(''), "errors.drawingHistoryCodec.drawingUndoDataIsTruncated", {});}finally{await reader.cancel();}
    }
    if(bytes.length!==entry.rawBytes||!same(await digest(bytes),entry.checksum))throw messageError(new Error(''), "errors.drawingHistoryDatabase.drawingUndoDataChecksumMismatch", {});
    return this.codec.decode(bytes);
  }
  async remove(id){
    await this.open();
    const tx=this.db.transaction(['records','chunks'],'readwrite'),done=complete(tx),records=tx.objectStore('records'),stored=records.get([this.session,id]);
    let released=this.writes.get(id)?.storedBytes??0;stored.onsuccess=()=>{released=stored.result?.storedBytes??released;};
    records.delete([this.session,id]);tx.objectStore('chunks').delete(range(this.session,id));await done;this.writes.delete(id);this.bytes=Math.max(0,this.bytes-released);
  }
  async close(){
    try{if(this.db)await this.removeSession(this.session);}finally{this.db?.close();this.db=null;this.releaseLock?.();await this.lock;this.lock=null;this.releaseLock=null;}
  }
}
