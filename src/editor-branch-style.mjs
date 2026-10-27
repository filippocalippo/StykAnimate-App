/** The targets of a uniform scalar edit across one selected branch. Native definitions remain shared unless an authored/captured
 * style already owns an affected value. The edit itself (begin, preview, commit, cancel) is the session's animation edit of several
 * targets (`native-property-edit.mjs`, docs/BRANCH-STYLE.md). */
import {animationChannels} from './animation-channels.mjs';
import {polygonIdentity, resolveInstanceFigure} from './animation-style.mjs';
import {segmentBranchIndices} from './pivot/structure.mjs';

const properties={segment_opacity:'opacity',segment_gradient_opacity:'gradientOpacity',thickness:'thickness'};
/** The selected segments (several picked ones, else the selected one, with the branch under it when `whole`). */
function builderSelectionIndices(editor,whole=false) {
  const ids=editor.selectedSegmentIds,segment=editor.figure?.segments[editor.selectedJoint];
  return ids?.size>1?editor.figure.segments.flatMap((segment,index)=>ids.has(segment.segment_id)?[index]:[])
    :whole?(segment?segmentBranchIndices(editor.figure.segments,segment.segment_id):[]):[editor.selectedJoint];
}
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
  for(const index of builderSelectionIndices(editor,true)){
    const segment=resolved.segments[index];if(property==='gradientOpacity'&&!segment.secondary)continue;
    const handleId=Number(segment.segment_id),captured=object._stykStyle?.segments?.[handleId]?.[property];
    authored ||= overridden.has(handleId)||Number.isFinite(captured);
    const target={kind:'segment',uid:object.unique_id,handleId,...(editor.propertyChannels||scoped.has(handleId)?{figureTypeId:figure.figure_type_id}:{})};
    entries.push({target,index});
  }
  if(editor.propertyChannels && property==='opacity' && editor.selectedSegmentIds?.size <= 1) {
    const handles=new Set(entries.map(entry=>entry.target.handleId));handles.add(figure.segments[editor.selectedJoint]?.parent_id);
    figure.polyfills?.forEach((polygon,index)=>{
      if(!polygon.segment_ids?.every(id=>handles.has(id)))return;
      const target={kind:'polygon',uid:object.unique_id,polygonId:polygonIdentity(polygon,index),figureTypeId:figure.figure_type_id};
      entries.push({target,index});
    });
  }
  return entries.length?{property,entries,authored,uid:object.unique_id}:null;
}
