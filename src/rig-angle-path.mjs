import {messageError} from './localized-error.mjs';
/** Cyclic, angle-driven native joint positions. Curves are document data;
 * evaluation is stateless, so dragging, seeking and export use the same pose. */
const TAU=Math.PI*2;
export function sameAnglePath(a,b){
  if(!a||!b)return a===b;
  return ['driver','pitch','origin','restAngle','pitchRestAngle','figureRestAngle','source'].every(k=>a[k]===b[k])&&
    (!a.keys&&!b.keys||a.keys?.length===b.keys?.length&&a.keys.every((p,i)=>p.length===b.keys[i].length&&p.every((v,j)=>v===b.keys[i][j])));
}
export function validateAnglePath(path,reference,dependencies){
  if(!path||typeof path!=='object'||Array.isArray(path))throw messageError(new Error(''), "errors.rigAnglePath.invalidAnglePath", {});
  if(path.source!==undefined){
    if(Object.keys(path).some(k=>k!=='source'))throw messageError(new Error(''), "errors.rigAnglePath.aDepthGuideOnlyReferencesItsAnglePath", {});
    reference(path.source,'Angle-path depth source');dependencies.add(path.source);return;
  }
  if(Object.keys(path).some(k=>!['driver','pitch','origin','restAngle','pitchRestAngle','figureRestAngle','keys'].includes(k)))throw messageError(new Error(''), "errors.rigAnglePath.invalidAnglePathField", {});
  reference(path.driver,'Angle-path driver');reference(path.origin,'Angle-path origin',true);dependencies.add(path.driver);dependencies.add(path.origin);
  if(path.pitch!==undefined){reference(path.pitch,'Angle-path pitch');dependencies.add(path.pitch);}
  for(const k of ['restAngle','pitchRestAngle','figureRestAngle'])if(!Number.isFinite(path[k])||Math.abs(path[k])>1e6)throw messageError(new Error(''), "errors.rigAnglePath.setFiniteAnglePathReferenceAngles", {});
  if(!Array.isArray(path.keys)||path.keys.length<2||path.keys.length>64)throw messageError(new Error(''), "errors.rigAnglePath.anAnglePathNeeds264OrderedSamples", {});
  let prior=-Infinity;
  for(const key of path.keys){
    if(!Array.isArray(key)||key.length!==4||key.some(n=>!Number.isFinite(n)||Math.abs(n)>1e6)||key[0]<0||key[0]>=TAU||key[0]<=prior)throw messageError(new Error(''), "errors.rigAnglePath.anglePathSamplesRequireIncreasingAnglesFrom0", {});
    prior=key[0];
  }
}
