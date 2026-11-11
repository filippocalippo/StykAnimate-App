import {restoreMessageError, messageError} from './localized-error.mjs';

import {historyChunks,historyPixelBytes} from './drawing-history-codec.mjs';
import {drawingPixelCommands as pixelCommands} from './drawing-preparation.mjs';

const aborted=()=>messageError(new DOMException('', 'AbortError'), "errors.drawingHistory.drawingHistoryOperationCancelled", {});
const yieldToInput=()=>new Promise(resolve=>setTimeout(resolve,0));

/** The lease lives in the editor thread so a worker crash cannot make another
 * window's cleanup mistake this editor's cold history for an abandoned cache. */
export class DrawingHistoryDisk {
  constructor(){this.session=crypto.randomUUID();this.next=0;this.queue=Promise.resolve();this.pending=new Map();}
  async lease(){
    if(this.ready)return this.ready;
    this.ready=new Promise((resolve,reject)=>{
      if(!globalThis.navigator?.locks){resolve();return;}
      this.lock=navigator.locks.request('stykanimate-drawing-history:'+this.session,()=>new Promise(done=>{this.releaseLock=done;resolve();}));this.lock.catch(reject);
    });return this.ready;
  }
  request(kind,data={}){
    if(this.closed&&kind!=='close')return Promise.reject(aborted());
    const run=this.queue.catch(()=>{}).then(async()=>{
      if(this.closed&&kind!=='close')throw aborted();await this.lease();
      if(!this.worker){
        const worker=this.worker=new Worker(new URL('./drawing-history-worker.mjs',import.meta.url),{type:'module',name:'StykAnimate drawing undo disk'});
        worker.onmessage=({data})=>{const entry=this.pending.get(data.id);if(!entry)return;this.pending.delete(data.id);clearTimeout(entry.timer);data.error?entry.reject(Object.assign(restoreMessageError(new Error(data.error.message), data.error),{name:data.error.name})):entry.resolve(data);};
        worker.onerror=event=>{event.preventDefault();this.fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.drawingHistory.theDrawingUndoWorkerStoppedRetryUndo")));};
        worker.onmessageerror=()=>this.fail(messageError(new Error(''), "errors.drawingHistory.drawingUndoDataCouldNotBeTransferred", {}));
      }
      return new Promise((resolve,reject)=>{
        const id=++this.next,timer=setTimeout(()=>this.fail(messageError(new Error(''), "errors.drawingHistory.drawingUndoDiskAccessTimedOutRetryThe", {})),30000);
        this.pending.set(id,{resolve,reject,timer});
        try{this.worker.postMessage({id,kind,session:this.session,...data});}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
      });
    });this.queue=run;return run;
  }
  fail(error){this.worker?.terminate();this.worker=null;for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}this.pending.clear();}
  close(){
    if(this.closing)return this.closing;this.closed=true;
    return this.closing=(async()=>{try{if(this.ready)await this.request('close');}finally{this.fail(aborted());this.releaseLock?.();await this.lock;}})();
  }
}

/** Exact pixel histories have a small RAM tier and immutable disk records.
 * `command.bytes` counts metadata while pending/ready pixel bytes belong to
 * this tier. Failed writes restore their full chronological history weight. */
export class DrawingHistory {
  constructor({disk=new DrawingHistoryDisk(),hotBytes=16*1024*1024,minRecordBytes=64*1024,reserve=()=>{},hold=()=>{},onWarning=()=>{},enabled=true}={}){
    Object.assign(this,{disk,hotBytes,minRecordBytes,reserve,hold,onWarning,records:new Map(),commands:new WeakMap(),payloads:new WeakMap(),queue:[],replays:new Map(),residentBytes:0,diskBytes:0,next:0,clock:0,enabled});
  }
  track(root,onSizeChange=()=>{}){
    if(this.disposed)return;
    for(const command of pixelCommands(root)){
      if(this.commands.has(command)||!command.tiles)continue;
      const bytes=historyPixelBytes(command.tiles),archive=this.enabled&&bytes>=this.minRecordBytes;
      const record={id:++this.next,command,root,bytes,count:command.tiles.length,state:archive?'queued':'memory',used:++this.clock,pins:0,onSizeChange};
      this.records.set(record.id,record);this.commands.set(command,record);this.payloads.set(command.tiles,record);this.residentBytes+=bytes;
      if(archive){root.bytes-=bytes;this.queue.push(record);}
    }
    if(!this.pumping&&this.queue.length){this.pumping=Promise.resolve().then(()=>this.pump()).finally(()=>{this.pumping=null;});}
  }
  /** The identity the record of the next tracked command gets: what the session's history entry refers to. */
  nextId(){return this.next+1;}
  /** What `command` weighs in the history once tracked: its metadata when its record goes to the disk, its pixels too otherwise. */
  weight(command){const bytes=historyPixelBytes(command.tiles);return command.bytes-(this.enabled&&bytes>=this.minRecordBytes?bytes:0);}
  /** The command of record `id`, while the history holds it. */
  commandOf(id){const record=this.records.get(id);return record&&!record.disposed?record.command:undefined;}
  owns(tiles){const record=this.payloads.get(tiles);return Boolean(record&&!record.disposed&&record.command.tiles===tiles);}
  needsLoad(root){return Boolean(root&&[...pixelCommands(root)].some(command=>this.commands.has(command)&&!command.tiles));}
  beginScratch(){if(!this.scratchUsers)this.hold(4*1024*1024);this.scratchUsers=(this.scratchUsers??0)+1;}
  endScratch(){this.scratchUsers=Math.max(0,(this.scratchUsers??0)-1);if(!this.scratchUsers)this.hold(0);}
  async pump(){
    while(this.queue.length&&!this.disposed){
      const record=this.queue.shift();if(record.disposed)continue;
      record.writing=true;
      let scratch=false;try{
        if(!this.enabled)throw messageError(new Error(''), "errors.drawingHistory.theDrawingUndoDiskCacheIsUnavailable", {});
        this.beginScratch();scratch=true;await this.disk.request('begin',{record:record.id});record.state='writing';
        for(const tiles of historyChunks(record.command.tiles)){
          if(this.disposed||record.disposed)throw aborted();
          await this.disk.request('append',{record:record.id,tiles});await yieldToInput();
        }
        const {result}=await this.disk.request('finish',{record:record.id});
        if(this.disposed||record.disposed)throw aborted();
        record.state='ready';record.diskBytes=result.storedBytes;this.diskBytes+=record.diskBytes;this.trim();
      }catch(error){
        if(!this.disposed)this.disk.request('remove',{record:record.id}).catch(()=>{});
        if(!record.disposed&&!this.disposed){
          record.state='memory';record.root.bytes+=record.bytes;record.onSizeChange(record.bytes);
          if(this.enabled){this.enabled=false;this.onWarning(messageError(new Error(''), 'errors.drawingHistory.diskUnavailable', {detail:error.message}));}
        }
      }finally{record.writing=false;this.releaseRetired(record);if(scratch)this.endScratch();}
    }
  }
  trim(target=this.hotBytes){
    for(const record of [...this.records.values()].sort((a,b)=>a.used-b.used)){
      if(this.residentBytes<=target)break;
      if(record.state!=='ready'||record.pins||!record.command.tiles)continue;
      record.command.tiles=null;this.residentBytes-=record.bytes;
    }
  }
  /** Pin a whole compound command before loading any of its children. A failed
   * read exposes no partial command; the editor applies only after all pass. */
  prepare(root,{signal}={}){
    const records=[...pixelCommands(root)].map(c=>this.commands.get(c)).filter(r=>r&&!r.disposed);
    for(const record of records){record.pins++;record.used=++this.clock;}
    // The undo or redo replays `root` until release(root); see replaying().
    if(records.length)this.replays.set(root,(this.replays.get(root)??0)+1);
    const cold=records.filter(r=>!r.command.tiles);if(!cold.length)return null;
    return (async()=>{
      for(const record of cold){
        if(signal?.aborted||this.disposed||record.disposed)throw aborted();
        const reader={signal};(record.readers??=new Set()).add(reader);
        try{record.loading??=this.load(record).finally(()=>{record.loading=null;this.releaseRetired(record);});await record.loading;if(signal?.aborted)throw aborted();}
        finally{record.readers.delete(reader);}
      }
    })();
  }
  async load(record){
    this.beginScratch();let installed=false,reserved=false;
    const check=()=>{if(this.disposed||record.disposed||[...record.readers].every(r=>r.signal?.aborted))throw aborted();};
    try{
      this.reserve(record.bytes);this.residentBytes+=record.bytes;reserved=true;
      const {result}=await this.disk.request('info',{record:record.id});
      if(result.tiles!==record.count||!Number.isInteger(result.parts)||result.parts<1||result.parts>record.count)throw messageError(new Error(''), "errors.drawingHistory.drawingUndoRecordIsDamaged", {});
      const tiles=[];let bytes=0;
      for(let part=0;part<result.parts;part++){
        check();const chunk=await this.disk.request('read',{record:record.id,part});bytes+=historyPixelBytes(chunk.tiles);
        if(tiles.length+chunk.tiles.length>record.count||bytes>record.bytes)throw messageError(new Error(''), "errors.drawingHistory.drawingUndoRecordIsDamaged", {});tiles.push(...chunk.tiles);await yieldToInput();
      }
      check();if(tiles.length!==record.count||bytes!==record.bytes)throw messageError(new Error(''), "errors.drawingHistory.drawingUndoRecordIsDamaged", {});
      record.command.tiles=tiles;this.payloads.set(tiles,record);installed=true;
    }finally{if(reserved&&!installed)this.residentBytes=Math.max(0,this.residentBytes-record.bytes);this.endScratch();}
  }
  releaseRetired(record){if(record.retiredBytes&&!record.writing&&!record.loading&&!record.pins){this.residentBytes=Math.max(0,this.residentBytes-record.retiredBytes);delete record.retiredBytes;}}
  release(root){
    for(const command of pixelCommands(root)){const record=this.commands.get(command);if(record){record.pins=Math.max(0,record.pins-1);this.releaseRetired(record);}}this.trim();
    const replays=this.replays.get(root);if(replays>1)this.replays.set(root,replays-1);else if(replays){this.replays.delete(root);if(!this.replays.size)this.replayed?.();}
  }
  /** While an undo or redo of pixel commands is between prepare() and release() (loading
   * its records, preparing its tiles, applying them), a promise that settles once none is;
   * otherwise null. Publication waits on it: the replay is about to replace the revision
   * being published. */
  replaying(){
    if(!this.replays.size||this.disposed)return null;
    return this.replayWait??=new Promise(resolve=>{this.replayed=()=>{this.replayWait=this.replayed=null;resolve();};});
  }
  /** Keeps the records of the commands in `roots` and of the records named by `ids`; every other one goes. */
  retain(roots,ids=[]){
    const keep=new Set(roots.flatMap(root=>[...pixelCommands(root)]));
    for(const id of ids){const record=this.records.get(id);if(record)keep.add(record.command);}
    for(const record of [...this.records.values()])if(!keep.has(record.command))this.drop(record);
  }
  drop(record){
    record.disposed=true;
    // A writer or prepared replay can still hold these arrays after history
    // eviction. Account for them until every outstanding use releases them.
    if(record.command.tiles){if(record.writing||record.pins)record.retiredBytes=record.bytes;else this.residentBytes-=record.bytes;}
    record.command.tiles=null;this.records.delete(record.id);this.diskBytes-=record.diskBytes??0;
    if(record.diskBytes||record.writing)this.disk.request('remove',{record:record.id}).catch(()=>{});
  }
  /** A session entry named record `id` but the commit failed before the record was made: the identity is not handed out again. */
  skip(id){this.next=Math.max(this.next,id);}
  get stats(){return {residentBytes:this.residentBytes,diskBytes:this.diskBytes,records:this.records.size,pending:this.queue.length+(this.pumping?1:0),enabled:this.enabled};}
  dispose(){
    if(this.closing)return this.closing;
    this.disposed=true;this.queue=[];for(const record of this.records.values())record.disposed=true;
    this.records.clear();this.replays.clear();this.replayed?.();this.residentBytes=0;this.hold(0);return this.closing=this.disk.close();
  }
}
