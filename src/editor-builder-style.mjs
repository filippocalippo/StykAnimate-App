/** Figure-internal order and polygon opacity. History stores small native fields,
 * never embedded assets or animation poses. Valid native ordering is a combined
 * sequence; tied authored records retain the renderer's deterministic ordering. */

const clone = value => value === undefined ? undefined : structuredClone(value);
const orderValue = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new Error('Draw order must be a finite native number.');
  return value;
};
export function builderDrawables(figure) {
  return [
    ...(figure.polyfills ?? []).map((item, index) => ({kind:'polygon', index, item, z:orderValue(item.z_order ?? 0)})),
    ...figure.segments.map((item, index) => ({kind:'segment', index, item, z:orderValue(item.z_order ?? index + 1)})),
  ].sort((a,b) => a.z-b.z);
}
/** Used inside an existing topology transaction before appending a new drawable. */
export function normalizeBuilderOrder(figure) {
  const entries=builderDrawables(figure);
  entries.forEach((entry,index)=>{entry.item.z_order=index+1;entry.item.z_order_runtime_raw=index;});
  delete figure.segment_z_raw;delete figure.poly_z_raw;
  return entries.length;
}
function resolveTarget(figure, target, selectedJoint) {
  const kind = target?.kind ?? 'segment', index = target?.index ?? selectedJoint;
  const item = (kind === 'segment' ? figure.segments : kind === 'polygon' ? figure.polyfills : null)?.[index];
  if (!Number.isInteger(index) || !item) throw new Error('Select an existing segment or polygon.');
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
const itemPath = entry => [entry.kind==='segment'?'segments':'polyfills',entry.index];
const sameEntry = (a,b) => a.kind===b.kind&&a.index===b.index;
const entryKey = entry => `${entry.kind}:${entry.index}`;
const orderPaths = entries => [...entries.flatMap(entry=>[['z_order'],['z_order_runtime_raw']].map(tail=>[...itemPath(entry),...tail])),['segment_z_raw'],['poly_z_raw']];
/** Native combined-array order: top/bottom partition; one-step and numeric moves
 * visit raised members backwards/lowered members forwards, never crossing another
 * selected member. Stored ties are stable before the first actual reordering. */
export function reorderBuilderDrawables(entries,selected,{direction,delta}={}){
  const keys=new Set(selected.map(entryKey)),original=[...entries];
  if(direction==='front'||direction==='back'){
    const own=original.filter(e=>keys.has(entryKey(e))),other=original.filter(e=>!keys.has(entryKey(e)));
    return direction==='front'?[...other,...own]:[...own,...other];
  }
  delta=direction==='up'?1:direction==='down'?-1:delta;
  if(!Number.isInteger(delta))throw new Error('Choose a whole draw-order position.');
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
function publishOrder(figure,original,next){
  if(original.every((entry,index)=>sameEntry(entry,next[index])))return false;
  next.forEach((entry,index)=>{entry.item.z_order=index+1;entry.item.z_order_runtime_raw=index;});
  delete figure.segment_z_raw;delete figure.poly_z_raw;return true;
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
  let selected;try{selected=resolveTarget(editor.figure,target,editor.selectedJoint);}catch{return null;}
  const entries=builderDrawables(editor.figure),targets=property==='z_order'?builderStyleTargets(editor.figure,target,{branch}):[selected];
  const paths=property==='z_order'?orderPaths(entries):[[...itemPath(selected),'alpha_raw'],[...itemPath(selected),'color_alpha']];
  return {target,property,targets,entries,paths,initial:capture(editor.figure,paths),
    value:property==='z_order'?entries.findIndex(entry=>sameEntry(entry,selected))+1:(selected.item.alpha_raw!==undefined?1-selected.item.alpha_raw/255:selected.item.color_alpha??1)*100,
    label:property==='z_order'?`${branch&&selected.kind==='segment'?'Branch':selected.kind==='segment'?'Segment':'Polygon'} draw order`:'Polygon opacity'};
}
export function previewBuilderStyleProperty(figure,binding,value) {
  orderValue(value);
  if(binding.property==='opacity'){
    if(value<0||value>100)throw new Error('Polygon opacity must be from 0 to 100%.');
    const polygon=figure.polyfills[binding.target.index];
    polygon.alpha_raw=Math.round((1-value/100)*255);polygon.color_alpha=1-polygon.alpha_raw/255;
  }else{
    if(!Number.isInteger(value)||value<1||value>binding.entries.length)throw new Error(`Draw order must be a whole position from 1 to ${binding.entries.length}.`);
    const delta=value-binding.value;
    // Each preview starts at the captured sequence, never a cumulative drag.
    apply(figure,binding.initial);
    publishOrder(figure,binding.entries,reorderBuilderDrawables(binding.entries,binding.targets,{delta}));
  }
}
function capture(figure,paths){return {entries:paths.map(path=>{let parent=figure;for(const key of path.slice(0,-1))parent=parent?.[key];
  const exists=Boolean(parent&&Object.hasOwn(parent,path.at(-1)));return {path,exists,value:exists?clone(parent[path.at(-1)]):undefined};}),removeEmptyParents:[]};}
function apply(figure,patch){for(const {path,exists,value}of patch.entries){let parent=figure;for(const key of path.slice(0,-1))parent=parent[key];if(exists)parent[path.at(-1)]=clone(value);else delete parent[path.at(-1)];}}
function command(editor,label,paths,mutate){
  if(editor.dragging)editor.commitDrag();
  const figure=editor.figure;if(!figure)return false;
  const index=editor.report.figure_types.indexOf(figure),selection=editor._selectionState(),before=capture(figure,paths);
  try{mutate();}catch(error){apply(figure,before);throw error;}
  const after=capture(figure,paths);
  if(JSON.stringify(before.entries)===JSON.stringify(after.entries))return false;
  editor._record({kind:'native-properties',scope:'figure',index,label,before,after,beforeSelection:selection,
    afterSelection:editor._selectionState(),definition:true,structural:false,timing:false});
  editor._invalidate();editor._emit('edit',{label,definition:true});return true;
}
export const editorBuilderStyleMethods={
  moveBuilderOrder(target,direction,{branch=false}={}){
    if(!['front','back','up','down'].includes(direction))throw new Error('Choose a valid draw-order direction.');
    const entries=builderDrawables(this.figure),selected=builderStyleTargets(this.figure,target,{branch,selectedJoint:this.selectedJoint});
    const next=reorderBuilderDrawables(entries,selected,{direction});
    return command(this,`${direction==='front'||direction==='up'?'Raise':'Lower'} ${branch?'branch':target?.kind??'segment'}`,
      orderPaths(entries),()=>publishOrder(this.figure,entries,next));
  },
  setBuilderOrder(target,value,{branch=false}={}){
    const selected=resolveTarget(this.figure,target,this.selectedJoint);
    const key=selected.kind==='segment'?'segment_z_order':`polygon_${selected.index}_z_order`;
    // Resolve arbitrary segment targets without changing the editor's selection.
    const facade=Object.create(this);Object.defineProperty(facade,'selectedJoint',{value:selected.index});
    const binding=builderStyleProperty(facade,key,{branch});orderValue(value);
    return command(this,binding.label,binding.paths,()=>previewBuilderStyleProperty(this.figure,binding,value));
  },
  setPolygonOpacity(index,opacity){
    if(typeof opacity!=='number'||!Number.isFinite(opacity)||opacity<0||opacity>1)throw new Error('Polygon opacity must be from 0 to 1.');
    if (this.propertyChannels) return this.updatePolygon(index,{opacity});
    const binding=builderStyleProperty(this,`polygon_${index}_opacity`);if(!binding)throw new Error('Select an existing polygon.');
    return command(this,binding.label,binding.paths,()=>previewBuilderStyleProperty(this.figure,binding,opacity*100));
  },
};
