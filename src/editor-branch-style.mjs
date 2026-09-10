import {keyEasing} from './keyframe-easing.mjs';
/** A uniform scalar edit across one selected branch. Native definitions remain
 * shared unless an authored/captured style already owns an affected value. */
import {animationChannels,animationChannelId,validateAnimationValue,composeAnimationChannels} from './animation-channels.mjs';
import {buildGeometry} from './pivot/geometry.mjs';
import {animationStyleValue, polygonIdentity, resolveInstanceFigure} from './animation-style.mjs';
import {branchSegmentIndices} from './editor-builder-branch.mjs';

const properties={segment_opacity:'opacity',segment_gradient_opacity:'gradientOpacity',thickness:'thickness'};
export function branchOpacityPlan(editor,key) {
  const property=properties[key],figure=editor.figure,object=editor.object;
  if(!property||!figure||!object||(property==='thickness'&&!editor.propertyChannels))return null;
  const scoped=new Set(),overridden=new Set();
  for(const channel of animationChannels(editor.report)){
    const target=channel.target;
    if(target.kind!=='segment'||target.uid!==object.unique_id||channel.property!==property)continue;
    if(target.figureTypeId!==undefined)scoped.add(target.handleId);
    if(target.figureTypeId===undefined||target.figureTypeId===figure.figure_type_id)overridden.add(target.handleId);
  }
  let authored=Boolean(editor.propertyChannels);
  const entries=[], resolved=resolveInstanceFigure(figure,object);
  for(const index of branchSegmentIndices(figure,editor.selectedJoint)){
    const segment=resolved.segments[index];if(property==='gradientOpacity'&&!segment.secondary)continue;
    const handleId=Number(segment.segment_id),captured=object._stykStyle?.segments?.[handleId]?.[property];
    authored ||= overridden.has(handleId)||Number.isFinite(captured);
    const target={kind:'segment',uid:object.unique_id,handleId,...(editor.propertyChannels||scoped.has(handleId)?{figureTypeId:figure.figure_type_id}:{})};
    entries.push({target,index,initialValue:animationStyleValue(figure,object,target,property)});
  }
  if(editor.propertyChannels && property==='opacity') {
    const handles=new Set(entries.map(entry=>entry.target.handleId));handles.add(figure.segments[editor.selectedJoint]?.parent_id);
    figure.polyfills?.forEach((polygon,index)=>{
      if(!polygon.segment_ids?.every(id=>handles.has(id)))return;
      const target={kind:'polygon',uid:object.unique_id,polygonId:polygonIdentity(polygon,index),figureTypeId:figure.figure_type_id};
      entries.push({target,index,initialValue:animationStyleValue(figure,object,target,'opacity')});
    });
  }
  return entries.length?{property,entries,authored,uid:object.unique_id}:null;
}

function publish(editor,edit,animation,live,label) {
  if(editor.report._styk?.layerSheet){
    editor._sheetPropertyPreview=live&&edit.changed?composeAnimationChannels({...editor.report,_styk:{...editor.report._styk,animation}},edit.frame,edit.tick,{resolveGeometry:buildGeometry}):null;
    editor._invalidate();editor._emit('edit',{label,live,changedUids:[edit.uid]});return;
  }
  editor.report._styk ??= {};
  if(animation)editor.report._styk.animation=animation;else delete editor.report._styk.animation;
  editor._invalidate({timing:true});
  editor._emit('edit',{label,live,animation:true,changedUids:[edit.uid],changedChannels:edit.channelIds});
}
function current(editor) {
  const edit=editor._animationEdit;
  if(!edit?.branchStyle)throw new Error('Begin a branch opacity edit first.');
  if(editor.report!==edit.report||editor.tick!==edit.tick){cancelBranchStyleAnimation(editor);throw new Error('The branch edit target changed.');}
  return edit;
}
export function beginBranchStyleAnimation(editor,plan) {
  if(!plan?.entries?.length)throw new Error('Choose a branch with editable opacity.');
  if(editor._animationEdit)editor.commitAnimationEdit();
  if(editor.dragging)editor.commitDrag();
  const before=editor.report._styk?.animation??null;
  const after={...before,version:1,nextKeyId:before?.nextKeyId??1,channels:[...animationChannels(editor.report)]};
  const indices=new Map(after.channels.map((channel,index)=>[channel.id,index])),entries=[],keys=[],channelIds=[];
  for(const source of plan.entries){
    const target={...source.target},property=plan.property,id=animationChannelId(target,property),index=indices.get(id),original=index===undefined?null:after.channels[index];
    const baseline=original ?? (editor.propertyChannels ? editor.nativePropertyChannel(target,property) : null);
    const channel=baseline?{...baseline,target:{...baseline.target},keys:baseline.keys.map(key=>({...key}))}:{id,target,property,keys:[]};
    if(index===undefined){indices.set(id,after.channels.length);after.channels.push(channel);}else after.channels[index]=channel;
    let key=channel.keys.find(key=>key.tick===editor.tick&&!key.hidden);
    if(!key){
      const ids=new Set(channel.keys.map(key=>key.id));let keyId;
      do{if(!Number.isSafeInteger(after.nextKeyId)||after.nextKeyId<1)throw new Error('Animation key identity capacity exceeded.');keyId=`key-${after.nextKeyId++}`;}while(ids.has(keyId));
      key={id:keyId,tick:editor.tick,value:source.initialValue,interpolation:'linear'};channel.keys.push(key);channel.keys.sort((a,b)=>a.tick-b.tick);
    }
    delete key.passthrough;
    entries.push({target,property,tick:editor.tick,value:source.initialValue,exactTarget:true,...keyEasing(key)});keys.push(key);channelIds.push(id);
  }
  return editor._animationEdit={branchStyle:true,report:editor.report,frame:editor.evaluatedFrame,uid:plan.uid,tick:editor.tick,before,after,selection:editor._selectionState(),entries,keys,channelIds,initialValues:plan.entries.map(entry=>entry.initialValue),changed:false};
}
export function previewBranchStyleAnimation(editor,value) {
  const edit=current(editor);
  value=validateAnimationValue(edit.entries[0].target,edit.entries[0].property,value);
  for(let i=0;i<edit.keys.length;i++){edit.keys[i].value=value;edit.entries[i].value=value;}
  edit.changed=edit.initialValues.some(initial=>initial!==value);
  publish(editor,edit,edit.changed?edit.after:edit.before,true,'Preview branch opacity');return value;
}
export function cancelBranchStyleAnimation(editor) {
  const edit=editor._animationEdit;if(!edit?.branchStyle)return false;
  editor._animationEdit=null;
  if(editor.report===edit.report)publish(editor,edit,edit.before,false,'Cancel branch opacity');
  return true;
}
export function commitBranchStyleAnimation(editor) {
  const edit=editor._animationEdit;if(!edit?.branchStyle)return false;
  editor._animationEdit=null;
  if(editor.report!==edit.report)return false;
  editor._sheetPropertyPreview=null;
  editor.report._styk ??= {};
  if(edit.before)editor.report._styk.animation=edit.before;else delete editor.report._styk.animation;
  editor._invalidate({timing:true});
  if(!edit.changed){editor._emit('edit',{animation:true,label:'Cancel unchanged branch opacity'});return false;}
  editor.addAnimationKeys(edit.entries);return true;
}

/** Numeric secondary opacity preserves each existing endpoint RGB. It does not
 * invent gradients on plain segments (unlike the native combined color chooser). */
export function branchGradientOpacityBinding(editor,plan) {
  const indices=plan.entries.map(entry=>entry.index);
  return {paths:indices.map(index=>['segments',index,'secondary','a']),mutate(figure,{gradientOpacity}){
    const value=validateAnimationValue(plan.entries[0].target,'gradientOpacity',gradientOpacity);
    for(const index of indices)figure.segments[index].secondary.a=Math.round((1-value)*255);
  }};
}
