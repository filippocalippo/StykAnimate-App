import {messageError} from './localized-error.mjs';
import {nativeTimeline, timeline} from './pivot/read-view.mjs';
import {sheetKeyAt,validateLayerSheet,MAX_SHEET_TICKS} from './layer-sheet.mjs';
import {layerIdForUid} from './layers.mjs';

const fixed=id=>id==='scene'||id==='camera';
const checkedTick=tick=>{if(!Number.isInteger(tick)||tick<0||tick>=MAX_SHEET_TICKS)throw messageError(new Error(''), "errors.editorLayerSheet.chooseAValidWholeFrame", {});return tick;};
/** A document without a layer sheet gets one from its keyframes and authored animation. */
export function initializeLayerSheet(report){
  if(report._styk.layerSheet)return validateLayerSheet(report);
  const rows=timeline(report),native=nativeTimeline(report),duration=Math.max(1,(rows.at(-1)?.start??0)+(rows.at(-1)?.count??1));
  const legacyAnimation=report._styk.animation,tracks={},state={version:1,duration,nextId:1,tracks,...(legacyAnimation?{legacyAnimation}:{})},nativeKeys=new Map(native.map((row,index)=>[row.start,report.keyframes[index]]));
  for(const id of ['scene','camera',...report._styk.layers.order]){
    const times=new Set(native.filter(r=>r.count>0).map(r=>r.start));times.add(0);
    for(const channel of legacyAnimation?.channels??[]){const target=channel.target;
      if(target.kind===id||target.kind==='layer'&&target.id===id||target.uid!==undefined&&layerIdForUid(report,target.uid)===id)
        for(const key of channel.keys)if(!key.hidden&&key.tick<duration)times.add(key.tick);
    }
    tracks[id]={end:duration,keys:[...times].sort((a,b)=>a-b).map(tick=>({id:`cell-${state.nextId++}`,tick,sourceTick:tick,...(nativeKeys.get(tick)?._styk?.easing??{interpolation:report.version<5?'constant':report.auto_easing?'auto':'linear'}),...(!fixed(id)&&!legacyAnimation&&!report._styk.movieclipSource?{empty:!nativeKeys.get(tick)?.objects.some(o=>layerIdForUid(report,o.unique_id)===id)}:{})}))};
  }
  report._styk.layerSheet=state;delete report._styk.animation;delete report._styk.simpleFrameDraft;return validateLayerSheet(report);
}

/** What the editor reads of the layer sheet and the selection it keeps beside it. Every edit of the sheet is a command of the engine session. */
export const editorLayerSheetMethods={
  sheetSpan(id=this.activeLayerId,tick=this.tick){const track=this.report._styk.layerSheet.tracks[id],{key,next}=sheetKeyAt(track,tick);return {start:key?.tick??tick,end:next?.tick??Math.max(tick+1,track?.end??0)};},
  sheetEditTimes(indices=[this.frameIndex]){
    const times=indices.sheetTicks??this._frameIndices(indices).map(index=>indices.length===1&&index===this.frameIndex?this.tick:this.timeline[index].start);
    return [...new Set(times.map(checkedTick))].sort((a,b)=>a-b);
  },
  selectSheetLayer(id,{contents=true}={}){
    if(!this.getLayer(id)||this.isLayerFocusLocked(id))return false;this.setActiveLayer(id);this._sheetSelection={id,contents};
    if(contents)this._followSheetSelection();this._emit('selection',{sheetSelection:true});return true;
  },
  /** Keep the current figure selection across seeks (Simple frame navigation). */
  keepSelectionOnSeek(){if(this._sheetSelection?.contents)this._sheetSelection={...this._sheetSelection,contents:false};},
  _followSheetSelection(){
    const selection=this._sheetSelection;if(!selection?.contents||!this.report._styk.layerSheet)return;
    if(this.isLayerFocusLocked(selection.id)){this._sheetSelection=null;return;}
    const objects=this.evaluatedFrame.objects.filter(o=>this.layerForUid(o.unique_id)===selection.id);
    if(objects.length!==this.selectedUids.size||objects.some(o=>!this.selectedUids.has(o.unique_id)))this.selectedUids=new Set(objects.map(o=>o.unique_id));
    this._selectedUid=objects.find(o=>!o.join)?.unique_id??objects[0]?.unique_id??null;this.selectedJoint=-1;this._branchSelection=null;
  },
  layerFrameKeys(id=this.activeLayerId){return this.report._styk.layerSheet?.tracks[id]?.keys??[];},
};
