import {synchronizeAnimationOrigin,preserveAnimationOrigin} from './animation-origin.mjs';
const fields=['root_x','root_y','scale','len_flag','bend_flag'];
const vectors=['angles','lengths','bends'];
function sameGhosts(a,b){
  if(a===b)return true;
  const keys=Object.keys(a??{});return keys.length===Object.keys(b??{}).length&&keys.every(key=>
    b?.[key]&&['angle_rad','bend_rad','length'].every(field=>a[key][field]===b[key][field]));
}
function samePose(a,b){
  if(!a||fields.some(field=>a[field]!==b[field]))return false;
  if(!sameGhosts(a._stykAnimationOrigin?.ghosts,b._stykAnimationOrigin?.ghosts))return false;
  return vectors.every(field=>a[field]===b[field]||a[field]?.length===b[field]?.length&&a[field]?.every((value,index)=>value===b[field][index]));
}
export function originGeometryChanged(before,after){
  if(before.segments.length!==after.segments.length)return true;
  return before.segments.some((segment,index)=>['segment_id','parent_id','length','angle_rad','bend_rad'].some(field=>segment[field]!==after.segments[index][field]));
}
export const editorOriginMutationMethods={
  _synchronizeAnimationOrigins(frame,before=[],{force=false,includeNew=false,report=this.report}={}){
    const figures=new Map(report.figure_types.filter(figure=>figure._styk?.animationOrigin).map(figure=>[figure.figure_type_id,figure]));
    if(!figures.size)return;
    const previous=new Map(before.map(object=>[object.unique_id,object]));
    for(const object of frame.objects){
      const figure=figures.get(object.figure_type_id);if(!figure||!object._stykAnimationOrigin)continue;
      const old=previous.get(object.unique_id);
      if(before.length&&!old&&!includeNew)continue;
      if(force&&old?._stykAnimationOrigin)preserveAnimationOrigin(figure,object,old._stykAnimationOrigin);
      else if(old&&samePose(old,object)){
        // Pointer return and style-only updates preserve the exact original
        // metadata rather than introducing another floating-point round trip.
        if(old._stykAnimationOrigin&&['x','y','offsetX','offsetY'].some(key=>old._stykAnimationOrigin[key]!==object._stykAnimationOrigin[key]))
          object._stykAnimationOrigin={...old._stykAnimationOrigin};
      }else synchronizeAnimationOrigin(figure,object);
    }
  },
};
