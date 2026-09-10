/** Set Origin changes construction topology while authored transforms retain
 * their original pivot and the native tween retains its original joint basis. */
import {originSupportLayout, originSupportPose, originSupportOffset, initializeOriginSupport} from './animation-origin-support.mjs';
const layouts = new WeakMap();
export function invalidateAnimationOriginLayout(figure){layouts.delete(figure);}
export function hasAnimationOrigins(report) {
  return report.figure_types?.some(figure => figure._styk?.animationOrigin) ?? false;
}
export function animationOriginLayout(figure) {
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
  while(handle!==0){const index=ids.get(handle);if(index===undefined||path.length>=segments.length)throw new Error('The animation pivot no longer belongs to its rig.');path.push(index);handle=segments[index].parent_id;}
  cached={origin,segments,count:segments.length,ids,ready,parents,reversed,endpoints,path:path.reverse()};layouts.set(figure,cached);return cached;
}
/** Retimed attachments retain the original physical vertex's tangent, even
 * when that endpoint has become the construction root or a reversed edge. */
export function animationOriginHandleOrientation(figure,object,handle){
  const support=originSupportLayout(figure);
  if(support){const node=support.support.vertices[handle];if(node===undefined)return null;
    const index=node<0?support.support.rotation:node,pose=originSupportPose(figure,object,index,support);
    return pose.angle_rad+(node<0?0:pose.bend_rad);}
  const layout=animationOriginLayout(figure);if(!layout)return undefined;
  if(handle===layout.origin.handleId){const index=layout.ids.get(layout.origin.rotationHandleId);return animationOriginAngle(figure,object,index,layout.origin.reversed);}
  const index=layout.endpoints.get(handle);if(index===undefined)return null;
  const reverse=Boolean(layout.reversed[index]);return animationOriginAngle(figure,object,index,reverse)+animationOriginBend(figure,object,index,reverse);
}
export function animationOriginBend(figure,object,index,reversed=false){
  const value=Number(object?.bend_flag?object.bends[index]:figure.segments[index].bend_rad??0);return reversed?-value:value;
}
export function animationOriginAngle(figure,object,index,reversed=false){
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
export function animationOriginOffset(figure,object){
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
/** A construction edit may move the vertex that used to define the animation
 * pivot. Retain that animation anchor as a small local offset instead of
 * rewriting its independent position/rotation/scale keys. */
export function preserveAnimationOrigin(figure,object,previous){
  if(!figure?._styk?.animationOrigin||!previous)return object;
  const point=animationOriginPathOffset(figure,object),angle=animationRotation(figure,object),scale=Number(object.scale??1);
  const x=previous.x-Number(object.root_x)-point.x,y=previous.y-Number(object.root_y)-point.y;
  const offsetX=scale?(x*Math.cos(angle)+y*Math.sin(angle))/scale:previous.offsetX??0;
  const offsetY=scale?(-x*Math.sin(angle)+y*Math.cos(angle))/scale:previous.offsetY??0;
  const origin={...previous,offsetX,offsetY};
  if(object._stykAnimationOrigin?.ghosts)origin.ghosts=object._stykAnimationOrigin.ghosts;else delete origin.ghosts;
  object._stykAnimationOrigin=origin;return object;
}
/** Call after reflecting live and hidden angles, with the pre-reflection
 * property rotation. XY is synchronized separately from the physical root. */
export function reflectAnimationOriginOffset(figure,object,axis,previousRotation){
  const origin=object._stykAnimationOrigin;if(!figure?._styk?.animationOrigin||!origin||(!origin.offsetX&&!origin.offsetY))return object;
  const x=origin.offsetX??0,y=origin.offsetY??0,c=Math.cos(previousRotation),s=Math.sin(previousRotation);
  const worldX=(axis==='vertical'?1:-1)*(x*c-y*s),worldY=(axis==='vertical'?-1:1)*(x*s+y*c);
  const rotation=animationRotation(figure,object),cos=Math.cos(rotation),sin=Math.sin(rotation);
  object._stykAnimationOrigin={...origin,offsetX:worldX*cos+worldY*sin,offsetY:-worldX*sin+worldY*cos};return object;
}
/** Correct native tween roots after interpolating the original pivot XY. */
export function correctAnimationOrigins(report,frame){
  if(!frame||!hasAnimationOrigins(report))return frame;
  const types=new Map(report.figure_types.map(figure=>[figure.figure_type_id,figure]));let objects;
  frame.objects.forEach((object,slot)=>{
    const figure=types.get(object.figure_type_id),origin=object._stykAnimationOrigin;
    if(!figure?._styk?.animationOrigin||!origin||object.join)return;
    const offset=animationOriginOffset(figure,object),x=origin.x-offset.x,y=origin.y-offset.y;
    if(Math.abs(x-object.root_x)<1e-10&&Math.abs(y-object.root_y)<1e-10)return;
    objects??=[...frame.objects];objects[slot]={...object,root_x:x,root_y:y,runtime_segments:undefined};
  });
  return objects?{...frame,objects}:frame;
}
