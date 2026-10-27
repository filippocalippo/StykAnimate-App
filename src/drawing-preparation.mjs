import {messageError} from './localized-error.mjs';
import {TILE,TILE_BYTES,assertTileCoordinates} from './drawing-tiles.mjs';

const DRAWING_PREPARATION_BYTES=1024*1024;
const BATCH_TILES=DRAWING_PREPARATION_BYTES/TILE_BYTES;
const aborted=()=>messageError(new DOMException('', 'AbortError'), "errors.drawingPreparation.drawingPreparationCancelledOrSuperseded", {});

export function* drawingPixelCommands(root,direction='after'){
  if(!root)return;if(root.kind==='drawing-pixels')yield root;
  for(const child of direction==='before'?[...(root.commands??[])].reverse():root.commands??[])yield* drawingPixelCommands(child,direction);
}
export function validateDrawingChanges(tiles){
  for(const tile of tiles){
    assertTileCoordinates(tile.tx,tile.ty);
    for(const side of [tile.before,tile.after])if(side!=null&&(!(side instanceof Uint8ClampedArray||side instanceof Uint8Array)||side.byteLength!==4&&side.byteLength!==TILE_BYTES))throw messageError(new Error(''), "errors.drawingHistoryCodec.invalidDrawingHistoryTile", {});
  }
}
export function needsDrawingPreparation(root,direction){
  let bytes=0;for(const command of drawingPixelCommands(root,direction))for(const tile of command.tiles??[])if(tile[direction]!=null){bytes+=TILE_BYTES;if(bytes>DRAWING_PREPARATION_BYTES)return true;}return false;
}

/** Owns detached replacements until a synchronous editor transaction adopts
 * them. History buffers stay untouched; preparation never changes a live cel. */
class DrawingPreparation {
  constructor(owner,root,direction){
    this.owner=owner;this.generation=owner.generation;this.direction=direction;this.plans=[];this.entries=new Map();this.bytes=0;this.index=0;
    for(const command of drawingPixelCommands(root,direction)){
      validateDrawingChanges(command.tiles);
      const bytes=command.tiles.reduce((n,t)=>n+(t[direction]==null?0:TILE_BYTES),0);
      this.plans.push({celId:command.celId,changes:command.tiles,tiles:[],bytes});this.bytes+=bytes;
      const entry=owner.entries.get(command.celId);
      if(entry&&!this.entries.has(entry))this.entries.set(entry,{store:entry.store,revision:entry.revision,storeRevision:entry.store?.revision});
    }
  }
  check(){if(this.released||this.owner.disposed||this.owner.generation!==this.generation)throw aborted();}
  checkSources(){
    this.check();for(const [entry,snapshot] of this.entries)if(entry.disposed||entry.revision!==snapshot.revision||snapshot.store&&(entry.store!==snapshot.store||entry.store.revision!==snapshot.storeRevision))throw aborted();
  }
  validate(root,direction){
    this.checkSources();const commands=[...drawingPixelCommands(root,direction)];
    if(direction!==this.direction||this.index||commands.length!==this.plans.length||commands.some((c,i)=>c.tiles!==this.plans[i].changes||c.celId!==this.plans[i].celId||c.tiles.length!==this.plans[i].tiles.length))throw messageError(new Error(''), "errors.drawingPreparation.preparedPixelsDoNotMatchThisDrawingTransaction", {});
  }
  plan(changes,direction,celId){
    this.check();const plan=this.plans[this.index];
    if(direction!==this.direction||plan?.changes!==changes||plan.celId!==celId)throw messageError(new Error(''), "errors.drawingPreparation.preparedPixelsDoNotMatchThisDrawingCommand", {});
    return plan;
  }
  consume(plan){this.index++;this.bytes-=plan.bytes;plan.tiles=null;this.owner.hold(this,this.bytes);}
  release(){
    if(this.released)return;this.released=true;
    if(this.pinned)for(const entry of this.entries.keys())entry.preparing--;
    this.plans=[];this.entries.clear();this.bytes=0;this.owner.hold(this,0);
  }
}

/** The 1 MiB input/output batches keep expansion, cloning and alpha scanning
 * in the pixel worker. The complete result is reserved before any allocation. */
export function prepareDrawingChanges(owner,root,direction,{signal,checkCurrent=()=>{}}={}){
  if(!needsDrawingPreparation(root,direction))return null;
  const prepared=new DrawingPreparation(owner,root,direction);
  const check=()=>{prepared.checkSources();if(signal?.aborted)throw aborted();checkCurrent();};
  return (async()=>{
    try{
      check();for(const entry of prepared.entries.keys())entry.preparing=(entry.preparing??0)+1;prepared.pinned=true;
      owner.hold(prepared,prepared.bytes+DRAWING_PREPARATION_BYTES);
      for(const plan of prepared.plans){
        for(let start=0;start<plan.changes.length;start+=BATCH_TILES){
          check();const input=plan.changes.slice(start,start+BATCH_TILES);
          const tiles=input.map(t=>({tx:t.tx,ty:t.ty,pixels:t[direction]?.slice().buffer??null}));
          const result=await owner.worker.request('prepare-tiles',{tiles},{signal,transfer:tiles.flatMap(t=>t.pixels?[t.pixels]:[])});
          check();if(result.tiles?.length!==input.length)throw messageError(new Error(''), "errors.drawingPreparation.incompletePreparedDrawingTiles", {});
          for(let i=0;i<input.length;i++){
            const t=result.tiles[i],b=t.alphaBounds;
            if(t.tx!==input[i].tx||t.ty!==input[i].ty||t.pixels!=null&&(!(t.pixels instanceof ArrayBuffer)||t.pixels.byteLength!==TILE_BYTES)||t.pixels!=null&&(!b||![b.x,b.y,b.width,b.height].every(Number.isInteger)||b.x<0||b.y<0||b.width<1||b.height<1||b.x+b.width>TILE||b.y+b.height>TILE))throw messageError(new Error(''), "errors.drawingPreparation.invalidPreparedDrawingTile", {});
            plan.tiles.push({tx:t.tx,ty:t.ty,pixels:t.pixels==null?null:new Uint8ClampedArray(t.pixels),alphaBounds:b});
          }
        }
        plan.bytes=plan.tiles.reduce((n,t)=>n+(t.pixels?.byteLength??0),0);
      }
      prepared.bytes=prepared.plans.reduce((n,p)=>n+p.bytes,0);owner.hold(prepared,prepared.bytes);
      prepared.validate(root,direction);return prepared;
    }catch(error){prepared.release();throw error;}
  })();
}
