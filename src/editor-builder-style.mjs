import {messageError} from './localized-error.mjs';
/** Figure-internal order and polygon opacity. History stores small native fields,
 * never embedded assets or animation poses. Valid native ordering is a combined
 * sequence; tied authored records retain the renderer's deterministic ordering. */
import {resolveInstanceFigure, polygonIdentity} from './animation-style.mjs';

const animatedOrder = editor => Boolean(editor.propertyChannels || editor.report._styk?.layerSheet);
const orderFigure = editor => animatedOrder(editor) ? resolveInstanceFigure(editor.figure,editor.object) : editor.figure;

const orderValue = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw messageError(new Error(''), "errors.animationProperties.drawOrderMustBeAFiniteNativeNumber", {});
  return value;
};
export function builderDrawables(figure) {
  return [
    ...(figure.polyfills ?? []).map((item, index) => ({kind:'polygon', index, item, z:orderValue(item.z_order ?? 0)})),
    ...figure.segments.map((item, index) => ({kind:'segment', index, item, z:orderValue(item.z_order ?? index + 1)})),
  ].sort((a,b) => a.z-b.z);
}
function resolveTarget(figure, target, selectedJoint) {
  const kind = target?.kind ?? 'segment', index = target?.index ?? selectedJoint;
  const item = (kind === 'segment' ? figure.segments : kind === 'polygon' ? figure.polyfills : null)?.[index];
  if (!Number.isInteger(index) || !item) throw messageError(new Error(''), "errors.editorBuilderStyle.selectAnExistingSegmentOrPolygon", {});
  return {kind,index,item,z:orderValue(item.z_order ?? (kind==='segment'?index+1:0))};
}
/** Shift selects descendant segments and polygons whose every connection belongs
 * to that branch. The selected segment's pivot is part of the branch boundary. */
export function builderStyleTargets(figure, target, {branch=false, selectedJoint=-1}={}) {
  const selected=resolveTarget(figure,target,selectedJoint);
  if (!branch || selected.kind==='polygon') return [selected];
  const children=new Map();
  for(const segment of figure.segments){const list=children.get(segment.parent_id)??[];list.push(segment.segment_id);children.set(segment.parent_id,list);}
  const ids=new Set([selected.item.segment_id]), queue=[selected.item.segment_id];
  for(let i=0;i<queue.length;i++)for(const id of children.get(queue[i])??[])if(!ids.has(id)){ids.add(id);queue.push(id);}
  const polygonIds=new Set([...ids,selected.item.parent_id]);
  return builderDrawables(figure).filter(entry=>entry.kind==='segment'?ids.has(entry.item.segment_id):
    entry.item.segment_ids?.every(id=>polygonIds.has(id))&&entry.item.segment_ids.some(id=>ids.has(id)));
}
const sameEntry = (a,b) => a.kind===b.kind&&a.index===b.index;
const entryKey = entry => `${entry.kind}:${entry.index}`;
/** Native combined-array order: a numeric move visits raised members backwards and lowered members forwards, never crossing another
 * selected member. Stored ties are stable before the first actual reordering. */
export function reorderBuilderDrawables(entries,selected,delta){
  const keys=new Set(selected.map(entryKey)),original=[...entries];
  if(!delta)return original;
  const moving=[],other=[];
  original.forEach((entry,index)=>{if(keys.has(entryKey(entry)))moving.push({entry,index});else other.push(entry);});
  if(delta>0)moving.reverse();
  const result=new Array(original.length);let boundary=delta>0?original.length-1:0;
  for(const {entry,index} of moving){
    const target=delta>0?Math.min(index+delta,boundary):Math.max(index+delta,boundary);
    result[target]=entry;boundary=target+(delta>0?-1:1);
  }
  let cursor=0;for(let i=0;i<result.length;i++)if(!result[i])result[i]=other[cursor++];
  return result;
}
export function builderStyleProperty(editor,key,{branch=false}={}) {
  let target, property;
  if(key==='segment_z_order'){target={kind:'segment',index:editor.selectedJoint};property='z_order';}
  else {
    const match=/^polygon_(\d+)_(z_order|opacity)$/.exec(key);
    if(!match)return null;
    target={kind:'polygon',index:Number(match[1])};property=match[2];
  }
  if(!editor.figure)return null;
  const figure=property==='z_order'?orderFigure(editor):editor.figure;
  let selected;try{selected=resolveTarget(figure,target,editor.selectedJoint);}catch{return null;}
  const entries=builderDrawables(figure),targets=property==='z_order'?builderStyleTargets(figure,target,{branch}):[selected];
  return {targets,entries,animated:property==='z_order'&&animatedOrder(editor),
    value:property==='z_order'?entries.findIndex(entry=>sameEntry(entry,selected))+1:(selected.item.alpha_raw!==undefined?1-selected.item.alpha_raw/255:selected.item.color_alpha??1)*100,
    label:property==='z_order'?`${branch&&selected.kind==='segment'?'Branch':selected.kind==='segment'?'Segment':'Polygon'} draw order`:'Polygon opacity'};
}
/** The animation target of each drawable of `binding.entries` (the figure on show, in draw order): the targets one draw-order edit begins on. */
export function builderOrderTargets(editor,binding) {
  const uid=editor.object.unique_id,figureTypeId=editor.figure.figure_type_id;
  return binding.entries.map(entry=>({kind:entry.kind,uid,figureTypeId,...(entry.kind==='segment'?{handleId:entry.item.segment_id}:{polygonId:polygonIdentity(entry.item,entry.index)})}));
}
/** The position of each of `binding.entries` once the selected members move to position `value`. A move that changes nothing keeps the
 * drawables' own values. Combined draw order changes assign a different held value to each drawable. */
export function builderOrderValues(binding,value) {
  orderValue(value);
  if(!Number.isInteger(value)||value<1||value>binding.entries.length)throw messageError(new Error(''), "errors.editorBuilderStyle.drawOrderMustBeAWholePositionFrom", {length: binding.entries.length});
  const original=binding.entries,next=reorderBuilderDrawables(original,binding.targets,value-binding.value);
  const unchanged=original.every((entry,index)=>sameEntry(entry,next[index]));
  const positions=new Map(next.map((entry,index)=>[entryKey(entry),index+1]));
  return original.map(entry=>unchanged?entry.z:positions.get(entryKey(entry)));
}
