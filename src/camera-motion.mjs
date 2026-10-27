import {messageError} from './localized-error.mjs';
import {motionParameterMessages} from './camera-motion-localization.mjs';
/** Saved camera motion: what a clip stores and what a clip may store. The engine samples it (`styk_eval::camera`, `styk_eval::follow`):
 * follow clips move the camera itself (travel, which drives parallax), the other presets add an impulse to the finished shot. */
const CAMERA_MOTION_LIMIT = 256;
const FOLLOW_TARGET_LIMIT = 16;
const FOLLOW_FRAME_LIMIT = 100000;
const FOLLOW_KEYS = Object.freeze(['strength', 'followX', 'followY', 'offsetX', 'offsetY', 'lag', 'deadZone', 'lookAhead', 'zoomFit', 'padding', 'maxZoom', 'fadeIn', 'fadeOut']);
function validateFollowTargets(targets) {
  if (!Array.isArray(targets) || !targets.length || targets.length > FOLLOW_TARGET_LIMIT) throw messageError(new Error(''), "errors.cameraFollow.follow1Figures", {FOLLOW_TARGET_LIMIT: FOLLOW_TARGET_LIMIT});
  const uids = new Set();
  for (const target of targets) {
    if (!target || !Number.isInteger(target.uid) || target.uid < 0 || uids.has(target.uid) || typeof target.weight !== 'number' || !(target.weight >= 0 && target.weight <= 1))
      throw messageError(new Error(''), "errors.cameraFollow.eachFollowedFigureNeedsAUniqueFigureAnd", {});
    uids.add(target.uid);
  }
}
export const CAMERA_MOTION_TYPES = Object.freeze({follow:'Follow',shake:'Shake',handheld:'Handheld',wobble:'Wobble',impact:'Impact punch',pulse:'Zoom pulse'});
const KEYS = Object.freeze(['strength', 'moveX', 'moveY', 'roll', 'zoom', 'frequency', 'roughness', 'direction', 'recovery', 'phase', 'fadeIn', 'fadeOut', 'seed']);
export const MOTION_PARAMETERS = Object.freeze({
  strength:['Strength',0,2,.01,'%'],moveX:['Move X',0,2000,.5,'px'],moveY:['Move Y',0,2000,.5,'px'],
  roll:['Roll',0,90,.1,'°'],zoom:['Zoom',-0.8,4,.01,'%'],frequency:['Speed',.05,60,.05,'Hz'],
  roughness:['Roughness',0,1,.01,'%'],direction:['Direction',-180,180,1,'°'],recovery:['Recovery',.1,20,.1,''],
  phase:['Phase',-360,360,1,'°'],fadeIn:['Fade in',0,100000,1,'frames'],fadeOut:['Fade out',0,100000,1,'frames'],seed:['Seed',0,2147483647,1,''],
  followX:['Horizontal',0,1,.01,'%'],followY:['Vertical',0,1,.01,'%'],offsetX:['Frame X',-4000,4000,1,'px'],offsetY:['Frame Y',-4000,4000,1,'px'],
  lag:['Smoothness',0,240,1,'frames'],deadZone:['Dead zone',0,.9,.01,'%'],lookAhead:['Look ahead',0,120,1,'frames'],
  zoomFit:['Auto zoom',0,1,.01,'%'],padding:['Margin',0,.45,.01,'%'],maxZoom:['Zoom limit',1,20,.1,'×'],
});
const WHOLE=new Set(['seed','fadeIn','fadeOut','lookAhead','lag']);
/** The parameters a clip of this type stores, in display order. */
export const motionParameterKeys=type=>[...(type==='follow'?FOLLOW_KEYS:KEYS)];
export const isWholeMotionParameter=key=>WHOLE.has(key);
export function validateCameraMotion(state) {
  if(state===undefined)return;
  if(!state||state.version!==1||!Array.isArray(state.clips)||state.clips.length>CAMERA_MOTION_LIMIT)throw messageError(new Error(''), "errors.cameraMotion.invalidCameraMotionTableMaximum256Clips", {});
  const ids=new Set();
  for(const clip of state.clips){
    if(!clip||typeof clip.id!=='string'||!/^[\w-]{1,80}$/.test(clip.id)||ids.has(clip.id)||!Object.hasOwn(CAMERA_MOTION_TYPES,clip.type)||typeof clip.enabled!=='boolean'||!Number.isInteger(clip.start)||clip.start<0||!Number.isInteger(clip.duration)||clip.duration<1||clip.start+clip.duration>10000000)throw messageError(new Error(''), "errors.cameraMotion.invalidCameraMotionClip", {});
    ids.add(clip.id);
    if(clip.mutedRanges!==undefined&&(!Array.isArray(clip.mutedRanges)||clip.mutedRanges.length>1024||clip.mutedRanges.some(r=>!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end<=r.start)))throw messageError(new Error(''), "errors.cameraMotion.invalidBakedCameraRange", {});
    const keys=motionParameterKeys(clip.type);
    if(clip.type==='follow'){validateFollowTargets(clip.targets);if(clip.duration>FOLLOW_FRAME_LIMIT)throw messageError(new Error(''), "errors.cameraMotion.aFollowClipCanLastUpToFrames", {value: FOLLOW_FRAME_LIMIT.toLocaleString('en-US')});}
    else if(clip.targets!==undefined)throw messageError(new Error(''), "errors.cameraMotion.onlyFollowClipsHaveFollowedFigures", {});
    if(!clip.params||Object.keys(clip.params).some(key=>!keys.includes(key)))throw messageError(new Error(''), "errors.cameraMotion.invalidCameraMotionParameters", {});
    for(const key of keys){
      const [label,min,max]=MOTION_PARAMETERS[key],value=clip.params[key];
      if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||['seed','fadeIn','fadeOut','lookAhead'].includes(key)&&!Number.isInteger(value))throw messageError(new Error(''), "errors.cameraMotion.mustBeBetweenAnd", {label:{messageKey:motionParameterMessages[key],diagnosticValue:label},min,max});
    }
  }
}
