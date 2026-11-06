import {messageError} from './localized-error.mjs';
/** A bounded affine attachment in the existing rig graph. Anchors are evaluated
 * by the normal dependency plan; no solver, per-frame cache or pose state. */
export function sameWeightedJoint(a,b) {
  return a===b||Boolean(a&&b&&a.origin===b.origin&&a.anchors?.length===b.anchors?.length&&
    a.anchors.every((v,i)=>v.joint===b.anchors[i].joint&&v.weight===b.anchors[i].weight)&&sameWeightedJoint(a.depth,b.depth));
}
export function validateWeightedJoint(value,reference,dependencies,depth=false) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['origin','anchors',...(!depth?['depth']:[])].includes(k))||
    !Array.isArray(value.anchors)||value.anchors.length<1||value.anchors.length>16)throw messageError(new Error(''), "errors.rigWeighted.aWeightedJointRequires116Anchors", {});
  reference(value.origin,'Weighted origin',true);dependencies.add(value.origin);
  const seen=new Set();
  for(const anchor of value.anchors){
    if(!anchor||typeof anchor!=='object'||Array.isArray(anchor)||Object.keys(anchor).some(k=>!['joint','weight'].includes(k)))throw messageError(new Error(''), "errors.rigWeighted.invalidWeightedAnchor", {});
    reference(anchor.joint,'Weighted anchor',true);dependencies.add(anchor.joint);
    if(seen.has(anchor.joint)||anchor.joint===value.origin)throw messageError(new Error(''), "errors.rigWeighted.chooseDistinctWeightedAnchorsOutsideTheOrigin", {});
    seen.add(anchor.joint);
    if(!Number.isFinite(anchor.weight)||Math.abs(anchor.weight)>100)throw messageError(new Error(''), "errors.rigWeighted.anchorWeightMustBeBetween100And100", {});
  }
  if(value.depth!==undefined)validateWeightedJoint(value.depth,reference,dependencies,true);
}
export function remapWeightedJoint(value,remap) {
  return {origin:remap.get(value.origin)??value.origin,anchors:value.anchors.map(a=>({...a,joint:remap.get(a.joint)??a.joint})),
    ...(value.depth?{depth:remapWeightedJoint(value.depth,remap)}:{})};
}
