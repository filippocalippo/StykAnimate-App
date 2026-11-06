import {messageError} from './localized-error.mjs';

/** Named drawing substitutions select existing single frames. No interpolation
 * or new playback channel is introduced. */
export function validateDrawingSets(asset){
 const rotation=asset.drawingRotation;
 if(rotation!==undefined&&(!rotation||Object.keys(rotation).some(k=>!['steps','tiltThreshold'].includes(k))||!Number.isInteger(rotation.steps)||rotation.steps<2||rotation.steps>32||!Number.isFinite(rotation.tiltThreshold)||rotation.tiltThreshold<=0||rotation.tiltThreshold>=Math.PI/2||!asset.drawingSets))throw messageError(new Error(''), "errors.movieclipDrawings.rotatingDrawingsNeed232DirectionsAndA", {});
 const sets=asset.drawingSets;if(sets===undefined)return;
 const name=s=>typeof s==='string'&&s.trim().length>0&&s.length<=120;
 if(!Array.isArray(sets)||!sets.length||sets.length>128)throw messageError(new Error(''), "errors.movieclipDrawings.drawingSetsNeed1128Groups", {});
 for(const set of sets){if(!set||!name(set.name)||!Array.isArray(set.views)||!set.views.length||set.views.length>256)throw messageError(new Error(''), "errors.movieclipDrawings.aDrawingSetNeedsANameAnd1", {});
  if(rotation&&set.views.length!==rotation.steps*3)throw messageError(new Error(''), "errors.movieclipDrawings.rotatingDrawingsNeedLevelUpAndDownViews", {});
  for(const v of set.views)if(!v||!name(v.name)||!Number.isInteger(v.frame)||v.frame<0||v.frame>=asset.duration)throw messageError(new Error(''), "errors.movieclipDrawings.drawingViewsMustSelectExistingClipFrames", {});}
}
export function drawingSelection(asset,object){
 const frame=object._stykMovieclip?.offset??0,sets=asset.drawingSets;
 let group=sets.findIndex(s=>s.views.some(v=>v.frame===frame));if(group<0)group=0;
 return{group,view:Math.max(0,sets[group].views.findIndex(v=>v.frame===frame))};
}
