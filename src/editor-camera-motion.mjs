import {messageError} from './localized-error.mjs';
import {editorDraws} from './editor-draws.mjs';
import {prepareCameraBake} from './camera-motion-bake-client.mjs';
import {createCameraMotion,validateCameraMotion} from './camera-motion.mjs';
import {FOLLOW_FRAME_LIMIT} from './camera-follow.mjs';
import {validateParallax} from './layer-parallax.mjs';

const empty=Object.freeze({version:1,clips:Object.freeze([])});
function muteRange(clip,start,end){
  if(!clip.enabled||end<=clip.start||start>=clip.start+clip.duration)return clip;
  const ranges=[];
  for(const range of [...(clip.mutedRanges??[]),{start:Math.max(start,clip.start),end:Math.min(end,clip.start+clip.duration)}].sort((a,b)=>a.start-b.start)){
    const last=ranges.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else ranges.push({...range});
  }
  return {...clip,enabled:!(ranges.length===1&&ranges[0].start<=clip.start&&ranges[0].end>=clip.start+clip.duration),mutedRanges:ranges};
}
const shiftedRanges=(clip,start,duration=clip.duration)=>clip.mutedRanges?{mutedRanges:clip.mutedRanges.map(r=>({start:r.start+start-clip.start,end:Math.min(start+duration,r.end+start-clip.start)})).filter(r=>r.end>r.start)}:{};
function unlocked(editor){if(editor.getLayer('camera')?.locked)throw messageError(new Error(''), "errors.editorCameraMotion.unlockCameraBeforeEditingMotion", {});}
function publish(editor,next,label){
  unlocked(editor);validateCameraMotion(next);
  if(editor._drag)editor.commitDrag();if(editor._animationEdit)editor.commitAnimationEdit();
  const before=editor.report._styk.cameraMotion??null;if(JSON.stringify(before)===JSON.stringify(next))return false;
  const beforeSelection=editor._selectionState();editor.report._styk.cameraMotion=next;
  const end=Math.max(1,...next.clips.map(c=>c.start+c.duration)),sheet=editor.report._styk.layerSheet;
  let layerSheetPatch;
  if(sheet&&end>sheet.duration){const tracks={...sheet.tracks};for(const [id,track] of Object.entries(tracks))if(track.end===sheet.duration)tracks[id]={...track,end};
    const after={...sheet,duration:end,tracks};layerSheetPatch={before:sheet,after};editor.report._styk.layerSheet=after;}
  editor._invalidate({timing:true,retainGeometry:true});
  editor._record({kind:'camera-motion',label,before,after:next,beforeSelection,afterSelection:editor._selectionState(),timing:true,retainGeometry:true,layerSheetPatch,precomputedBytes:JSON.stringify([before,next]).length*2+(layerSheetPatch?Object.keys(sheet.tracks).length*160:0)+256});
  editor._emit('edit',{label,camera:true,cameraMotion:true,frameIndices:[],timing:true});return true;
}
export const editorCameraMotionMethods={
  getCameraMotions(){return this.report._styk.cameraMotion?.clips??empty.clips;},
  copyCameraMotion(id){const clip=this.getCameraMotions().find(c=>c.id===id);if(!clip)return false;this._cameraMotionClipboard=structuredClone(clip);return true;},
  pasteCameraMotion(start=Math.floor(this.tick)){const clip=this._cameraMotionClipboard;if(!clip)throw messageError(new Error(''), "errors.editorCameraMotion.copyACameraMotionClipFirst", {});const next={...clip,id:`motion-${editorDraws.uuid()}`,start,...shiftedRanges(clip,start)};publish(this,{version:1,clips:[...this.getCameraMotions(),next]},'Paste camera motion');this._selectedCameraMotion=next.id;return next.id;},
  /** Follow defaults to the selected figures from the playhead to the end of the animation. */
  addCameraMotion(type,{start=Math.floor(this.tick),duration,targets}={}){
    if(type==='follow'){
      targets??=[...this.selectedUids].map(uid=>({uid,weight:1}));
      if(!targets.length)throw messageError(new Error(''), "errors.editorCameraMotion.selectTheFiguresTheCameraShouldFollow", {});
      duration??=Math.min(FOLLOW_FRAME_LIMIT,Math.max(24,this.totalTicks-start));
    }
    duration??=type==='impact'?12:24;
    const id=`motion-${editorDraws.uuid()}`,clip=createCameraMotion(type,id,start,duration,{targets});
    publish(this,{version:1,clips:[...this.getCameraMotions(),clip]},'Add camera motion');return id;
  },
  setCameraMotion(id,patch){
    if(Object.keys(patch).some(k=>!['start','duration','enabled','params','targets'].includes(k)))throw messageError(new Error(''), "errors.editorCameraMotion.unsupportedCameraMotionProperty", {});
    const clips=this.getCameraMotions(),old=clips.find(c=>c.id===id);if(!old)throw messageError(new Error(''), "errors.editorCameraMotion.selectACameraMotionClip", {});
    return publish(this,{version:1,clips:clips.map(c=>c!==old?c:{...c,...patch,...shiftedRanges(c,patch.start??c.start,patch.duration??c.duration),params:{...c.params,...patch.params}})},'Edit camera motion');
  },
  deleteCameraMotion(id){return publish(this,{version:1,clips:this.getCameraMotions().filter(c=>c.id!==id)},'Delete camera motion');},
  duplicateCameraMotion(id,start){const source=this.getCameraMotions().find(c=>c.id===id);if(!source)throw messageError(new Error(''), "errors.editorCameraMotion.selectACameraMotionClip", {});start??=source.start+source.duration;const next={...source,id:`motion-${editorDraws.uuid()}`,start,...shiftedRanges(source,start)};publish(this,{version:1,clips:[...this.getCameraMotions(),next]},'Duplicate camera motion');return next.id;},
  randomizeCameraMotion(id){return this.setCameraMotion(id,{params:{seed:editorDraws.seed()&0x7fffffff}});},
  setLayerParallax(id,patch){
    const layer=this.getLayer(id);if(layer?.kind!=='layer')throw messageError(new Error(''), "errors.editorCameraMotion.selectAFigureLayerForParallax", {});if(layer.locked)throw messageError(new Error(''), "errors.editorCameraMotion.unlockBeforeEditingParallax", {name: layer.name});
    if(Object.keys(patch).some(k=>!['enabled','linked','x','y','reference'].includes(k)))throw messageError(new Error(''), "errors.editorCameraMotion.unsupportedParallaxProperty", {});
    const c=this.evaluatedFrame.camera??{},p={enabled:false,linked:true,x:1,y:1,reference:{x:c.x??0,y:c.y??0},...layer.parallax,...patch};
    if(p.linked){if(patch.y!==undefined&&patch.x===undefined)p.x=p.y;else p.y=p.x;}validateParallax(p);
    return this._layerEdit('Edit layer parallax',[[['byId',id,'parallax'],p]]);
  },
  async bakeCameraMotion({start=0,end=this.totalTicks,signal}={}){
    unlocked(this);if(!this.getCameraMotions().some(c=>c.enabled))return false;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>this.totalTicks||end-start>100000)throw messageError(new Error(''), "errors.editorCameraMotion.bakeAValidRangeOfAtMost100", {});
    const revision=this.revision,token=this._documentToken;
    const controller=new AbortController(),cancel=event=>{if(['edit','history','document','preview'].includes(event.detail?.kind))controller.abort();};
    this.addEventListener('change',cancel);let frames;
    try{frames=await prepareCameraBake(this.report,{start,end,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});}
    finally{this.removeEventListener('change',cancel);}
    if(this.revision!==revision||this._documentToken!==token||this._drag||this._animationEdit)throw messageError(new Error(''), "errors.editorCameraMotion.theAnimationChangedWhileBakingTryAgain", {});
    return this.movieclipBatch('Bake camera motion',()=>{
      this._sheetBakeCameraFrames(frames);
      const clips=this.getCameraMotions().map(c=>muteRange(c,start,end));
      publish(this,{version:1,clips},'Disable baked camera motion');return true;
    });

  },
};
