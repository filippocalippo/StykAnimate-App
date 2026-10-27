import {messageError} from './localized-error.mjs';
export const continuations = frame => frame?._styk?.movieclipContinuations ?? [];

export function validateContinuations(frame, types) {
  const values=frame?._styk?.movieclipContinuations;
  if(values===undefined)return;
  if(!Array.isArray(values)||values.length>65535)throw messageError(new Error(''), "errors.movieclipPresence.invalidMovieclipContinuationData", {});
  const seen=new Set();
  for(const value of values){
    if(!value||!Number.isInteger(value.uid)||value.uid<0||value.uid>0x7ffffffe||seen.has(value.uid)||!types.has(value.typeId)||value.playback?.clock!=='presence')throw messageError(new Error(''), "errors.movieclipPresence.invalidMovieclipContinuation", {});
    seen.add(value.uid);
  }
}
