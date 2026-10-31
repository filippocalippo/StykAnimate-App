import {messageError} from './localized-error.mjs';
/** Perspective is a final projection of the existing spatial pose. IK targets
 * remain in scene coordinates, before projection, in every saved document. */
const cameraDefaults = Object.freeze({strength: 0, distance: 600});
const shapeDefaults = Object.freeze({width: 1, taper: 0});
export const spatialCamera = object => ({...cameraDefaults, centerX:object?.root_x??0, centerY:object?.root_y??0, ...object?._stykSpatial?.camera});
export const spatialShape = (object, id) => ({...shapeDefaults, ...object?._stykSpatial?.shape?.[id]});
function projectedDrawing(objects,object,figures){
  const parent=objects[object.join?.target_object_slot],figure=id=>figures?.find(f=>f.figure_type_id===id);
  const asset=figure(object.figure_type_id)?._styk?.movieclip;
  return Boolean((asset?.drawingRotation||asset?.spatialMeshes)&&figure(parent?.figure_type_id)?.segments.some(s=>s.segment_id===object.join.target_handle_id&&s._stykRig?.spatial?.origin));
}
export const spatialPerspectiveAvailable = (objects, object, figures) => !object?.join && !objects.some(o=>o.join?.target_object_slot===object?.object_slot&&!projectedDrawing(objects,o,figures));
export function validateSpatialJoins(frame,figures){
  for(const o of frame.objects)if(o.join&&(o._stykSpatial?.camera?.strength||frame.objects[o.join.target_object_slot]?._stykSpatial?.camera?.strength&&!projectedDrawing(frame.objects,o,figures)))throw messageError(new Error(''), "errors.spatialProjection.perspectiveRequiresASingleSpatialFigureOrA", {});
}
const NEAR = .05;

export function validateSpatialPose(object, figure) {
  const state=object._stykSpatial;if(state===undefined)return;
  const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
  const number=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
  if(!record(state)||Object.keys(state).some(k=>!['camera','shape'].includes(k)))throw messageError(new Error(''), "errors.spatialProjection.invalidSpatialPoseSettings", {});
  if(state.camera!==undefined){const c=state.camera;if(!record(c)||Object.keys(c).some(k=>!['strength','distance','centerX','centerY'].includes(k))||!number(c.strength,0,1)||!number(c.distance,10,100000)||['centerX','centerY'].some(k=>c[k]!==undefined&&!number(c[k],-1e7,1e7)))throw messageError(new Error(''), "errors.spatialProjection.perspectiveNeedsStrength01AndDistance10", {});}
  if(state.shape!==undefined){
    if(!record(state.shape)||Object.keys(state.shape).length>figure.segments.length)throw messageError(new Error(''), "errors.spatialProjection.invalidSpatialProportions", {});
    const bones=new Set(figure.segments.filter(s=>s._stykRig?.spatial?.origin).map(s=>s.segment_id));
    for(const[id,s]of Object.entries(state.shape))if(String(Number(id))!==id||!bones.has(Number(id))||!record(s)||Object.keys(s).some(k=>!['width','taper'].includes(k))||!number(s.width,.1,5)||!number(s.taper,-.9,3))throw messageError(new Error(''), "errors.spatialProjection.spatialProportionsNeedAnExistingBoneWidth0", {});
  }
}
