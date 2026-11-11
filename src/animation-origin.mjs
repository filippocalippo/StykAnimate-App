import {messageError} from './localized-error.mjs';
/** Set Origin changes construction topology while authored transforms retain
 * their original pivot and the native tween retains its original joint basis. */
import {originSupportPose, originSupportOffset, initializeOriginSupport} from './animation-origin-support.mjs';
const layouts = new WeakMap();
function animationOriginLayout(figure) {
  const origin = figure?._styk?.animationOrigin;
  if (!origin || origin.support) return null;
  let cached = layouts.get(figure);
  if (cached?.segments === figure.segments && cached.count === figure.segments.length && cached.origin === origin) return cached;
  const segments = figure.segments, ids = new Map(segments.map((segment,index) => [segment.segment_id,index])), adjacency = new Map();
  const add = (a,b,index) => {const list=adjacency.get(a)??[];list.push({handle:b,index});adjacency.set(a,list);};
  segments.forEach((segment,index) => {add(segment.parent_id,segment.segment_id,index);add(segment.segment_id,segment.parent_id,index);});
  const queue=[{handle:origin.handleId,parent:-1}],seen=new Set([origin.handleId]),ready=[],parents=new Int32Array(segments.length).fill(-1),reversed=new Uint8Array(segments.length),endpoints=new Map();
  for(let q=0;q<queue.length;q++)for(const edge of adjacency.get(queue[q].handle)??[]){
    if(seen.has(edge.handle))continue;
    seen.add(edge.handle);ready.push(edge.index);parents[edge.index]=queue[q].parent;
    reversed[edge.index]=Number(segments[edge.index].parent_id!==queue[q].handle);
    endpoints.set(edge.handle,edge.index);
    queue.push({handle:edge.handle,parent:edge.index});
  }
  const path=[];let handle=origin.handleId;
  while(handle!==0){const index=ids.get(handle);if(index===undefined||path.length>=segments.length)throw messageError(new Error(''), "errors.animationOrigin.theAnimationPivotNoLongerBelongsToIts", {});path.push(index);handle=segments[index].parent_id;}
  cached={origin,segments,count:segments.length,ids,ready,parents,reversed,endpoints,path:path.reverse()};layouts.set(figure,cached);return cached;
}
/** Retimed attachments retain the original physical vertex's tangent, even
 * when that endpoint has become the construction root or a reversed edge. */
function animationOriginBend(figure,object,index,reversed=false){
  const value=Number(object?.bend_flag?object.bends[index]:figure.segments[index].bend_rad??0);return reversed?-value:value;
}
function animationOriginAngle(figure,object,index,reversed=false){
  const value=Number(object?.angles?.[index]??figure.segments[index].angle_rad??0);
  return value+(reversed?animationOriginBend(figure,object,index)+Math.PI:0);
}
export function animationRotation(figure,object){
  const origin=figure?._styk?.animationOrigin;
  if(!origin)return Number(object.angles?.[0]??0)-Number(figure?.segments[0]?.angle_rad??0);
  if(origin.support)return originSupportPose(figure,object,origin.support.rotation).angle_rad-origin.support.bones[origin.support.rotation].angle_rad;
  const index=animationOriginLayout(figure).ids.get(origin.rotationHandleId);
  return animationOriginAngle(figure,object,index,origin.reversed)-animationOriginAngle(figure,null,index,origin.reversed);
}
/** Analytic root-to-pivot vector; no segment meshes, recursion, or scene scan. */
function animationOriginPathOffset(figure,object){
  if(figure?._styk?.animationOrigin?.support)return originSupportOffset(figure,object);
  const layout=animationOriginLayout(figure);let x=0,y=0;
  for(const index of layout?.path??[]){
    const segment=figure.segments[index],angle=animationOriginAngle(figure,object,index),bend=animationOriginBend(figure,object,index);
    const length=Number(object.len_flag?object.lengths[index]:segment.length??0)*Number(object.scale??1);
    if(Math.abs(bend)<1e-7){x+=length*Math.cos(angle);y+=length*Math.sin(angle);}
    else{const radius=length/bend;x+=radius*(Math.sin(angle+bend)-Math.sin(angle));y+=radius*(Math.cos(angle)-Math.cos(angle+bend));}
  }
  return{x,y};
}
function animationOriginOffset(figure,object){
  const point=animationOriginPathOffset(figure,object),origin=object._stykAnimationOrigin;
  if(origin&&(origin.offsetX||origin.offsetY)){
    const angle=animationRotation(figure,object),scale=Number(object.scale??1),x=origin.offsetX??0,y=origin.offsetY??0;
    point.x+=scale*(x*Math.cos(angle)-y*Math.sin(angle));point.y+=scale*(x*Math.sin(angle)+y*Math.cos(angle));
  }
  return point;
}
/** Call after an intentional physical pose edit, never during re-rooting. */
export function synchronizeAnimationOrigin(figure,object,{initialize=false}={}){
  if(!figure?._styk?.animationOrigin||!object||(!initialize&&!object._stykAnimationOrigin))return object;
  if(initialize&&!object._stykAnimationOrigin?.ghosts)initializeOriginSupport(figure,object);
  const offset=animationOriginOffset(figure,object);
  object._stykAnimationOrigin={...object._stykAnimationOrigin,x:Number(object.root_x)+offset.x,y:Number(object.root_y)+offset.y};return object;
}
