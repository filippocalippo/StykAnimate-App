import {messageTuple} from './localization-bindings.mjs';
import {t as interfaceText} from './localization.mjs';
/** Convert native skin joints that serve only as depth-tested triangle
 * vertices into a figure mesh (docs/SPATIAL-MESHES.md). Every remaining joint
 * keeps its ID; per-object pose channels of the removed vertices are dropped.
 * Figures that use a skin joint for anything else are left unchanged. */
import {spatialSkin} from './rig-spatial.mjs';
import {remapRigReferences} from './rig-constraints.mjs';

const POLY_KEYS=new Set(messageTuple(['polyfill_id','segment_ids','segment_ids_raw','color_rgb','color_alpha','alpha_raw','z_order','name',"_stykSurface"], {8: {key: "spatialMeshLegacy.styksurface", params: {}}}));
const SURFACE_KEYS=new Set(['basis','depth','depthTest','side']);
const polyAlpha=p=>p.alpha_raw===undefined?(p.color_alpha??1):1-p.alpha_raw/255;

/** The mesh a figure's skin surfaces would become, or the reason it cannot. */
function legacySpatialMesh(figure){
  if(figure._styk?.spatialMesh)return {reason:interfaceText("spatialMeshLegacy.theFigureAlreadyHasAMesh"), reasonKey: "spatialMeshLegacy.theFigureAlreadyHasAMesh"};
  if(figure._styk?.movieclip)return {reason:interfaceText("spatialMeshLegacy.movieclipsKeepTheirOwnMeshes"), reasonKey: "spatialMeshLegacy.movieclipsKeepTheirOwnMeshes"};
  const segments=figure.segments,candidates=new Map();
  segments.forEach((s,i)=>{if(spatialSkin(s)&&s.parent_id===0&&!(s.visible!==false&&Number(s.thickness??0)>0))candidates.set(s.segment_id,i);});
  if(!candidates.size)return {reason:interfaceText("spatialMeshLegacy.theFigureHasNoSkinJoints"), reasonKey: "spatialMeshLegacy.theFigureHasNoSkinJoints"};
  // Anything that refers to a skin joint (children, rig relations) keeps it a joint.
  const referenced=new Set(),recorder={get(id){referenced.add(id);}};
  for(const s of segments){referenced.add(s.parent_id);if(s._stykRig)remapRigReferences({_stykRig:s._stykRig},recorder);}
  const surfaces=[],basis=[],others=new Set();let z;
  for(const [index,p] of (figure.polyfills??[]).entries()){
    const ids=p.segment_ids??[],surface=p._stykSurface;
    if(!ids.some(id=>candidates.has(id))){for(const id of surface?.basis??[])others.add(id);continue;}
    const convertible=surface?.depthTest===true&&ids.length===3&&ids.every(id=>candidates.has(id))&&new Set(ids).size===3&&
      Array.isArray(surface.depth)&&surface.depth.length===3&&surface.depth.every((id,i)=>id===ids[i])&&(surface.side??'front')==='front'&&!surface.flipped&&
      Object.keys(p).every(k=>POLY_KEYS.has(k))&&Object.keys(surface).every(k=>SURFACE_KEYS.has(k))&&polyAlpha(p)===1&&Array.isArray(p.color_rgb)&&p.color_rgb.length===3;
    if(!convertible)return {reason:interfaceText("spatialMeshLegacy.fillUsesSkinJointsButIsNotAn", {value: p.polyfill_id??index+1}), reasonKey: "spatialMeshLegacy.fillUsesSkinJointsButIsNotAn", reasonParams: {value: p.polyfill_id??index+1}};
    if(!basis.length)basis.push(...surface.basis);
    else if(surface.basis.some((id,i)=>id!==basis[i]))return {reason:interfaceText("spatialMeshLegacy.meshFillsUseDifferentReferenceJoints"), reasonKey: "spatialMeshLegacy.meshFillsUseDifferentReferenceJoints"};
    const order=Number(p.z_order??0);
    if(z===undefined)z=order;else if(order!==z)return {reason:interfaceText("spatialMeshLegacy.meshFillsUseDifferentDepthOrders"), reasonKey: "spatialMeshLegacy.meshFillsUseDifferentDepthOrders"};
    surfaces.push(index);
  }
  if(!surfaces.length)return {reason:interfaceText("spatialMeshLegacy.noDepthTestedFillsUseTheSkinJoints"), reasonKey: "spatialMeshLegacy.noDepthTestedFillsUseTheSkinJoints"};
  if(basis.some(id=>candidates.has(id)))return {reason:interfaceText("spatialMeshLegacy.aMeshReferenceJointIsASkinJoint"), reasonKey: "spatialMeshLegacy.aMeshReferenceJointIsASkinJoint"};
  const polys=figure.polyfills,used=new Set(surfaces.flatMap(i=>polys[i].segment_ids));
  for(const id of used)if(referenced.has(id)||others.has(id))return {reason:interfaceText("spatialMeshLegacy.skinJointIsAlsoUsedByAnotherJoint", {id: id}), reasonKey: "spatialMeshLegacy.skinJointIsAlsoUsedByAnotherJoint", reasonParams: {id: id}};
  const order=[...used].sort((a,b)=>candidates.get(a)-candidates.get(b)),vertex=new Map(order.map((id,i)=>[id,i]));
  const positions=[],bones=[],weights=[],viewVertices=[],viewPoints=[];let views;
  for(const id of order){
    const spatial=segments[candidates.get(id)]._stykRig.spatial;
    positions.push(...spatial.point);
    for(let k=0;k<4;k++){bones.push(spatial.bindings[k]?.joint??0);weights.push(spatial.bindings[k]?.weight??0);}
    if(spatial.viewPoints){
      if(views!==undefined&&views!==spatial.viewPoints.length)return {reason:interfaceText("spatialMeshLegacy.meshVerticesMixFourAndEightViewPositions"), reasonKey: "spatialMeshLegacy.meshVerticesMixFourAndEightViewPositions"};
      views=spatial.viewPoints.length;viewVertices.push(vertex.get(id));for(const p of spatial.viewPoints)viewPoints.push(...p);
    }
  }
  const palette=new Map(),colors=[],indices=[],materials=[],groups=[];
  for(const [t,index] of surfaces.entries()){
    const p=polys[index],key=p.color_rgb.join(',');
    if(!palette.has(key)){palette.set(key,colors.length);colors.push(p.color_rgb.slice());}
    indices.push(...p.segment_ids.map(id=>vertex.get(id)));materials.push(palette.get(key));
    if(p.name!==undefined){const last=groups.at(-1);if(last?.name===String(p.name)&&last.start+last.count===t)last.count++;else groups.push({name:String(p.name),start:t,count:1});}
  }
  const mesh={positions,bones,weights,indices,colors,materials,basis,...(z?{z}:{}),
    ...(views?{views,viewVertices,viewPoints}:{}),...(groups.length?{groups}:{})};
  return {mesh,removedIds:new Set(order),removedPolys:new Set(surfaces)};
}

/** Convert every eligible figure of a plain keyframe document. Returns a new
 * document; the input is not modified. */
export function convertDocumentSpatialMeshes(document){
  const converted=[],skipped=[];
  if(document._styk?.layerSheet)return {document,converted,skipped:document.figure_types.map(f=>({figure_type_id:f.figure_type_id,reason:interfaceText("spatialMeshLegacy.layerSheetsAreNotConverted"), reasonKey: "spatialMeshLegacy.layerSheetsAreNotConverted"}))};
  let result=document;
  for(const figure of document.figure_types){
    const candidate=legacySpatialMesh(figure);
    if(!candidate.mesh){skipped.push({figure_type_id:figure.figure_type_id,reason:candidate.reason});continue;}
    const {mesh,removedIds,removedPolys}=candidate,typeId=figure.figure_type_id;
    const blocked=result.keyframes.some(frame=>frame.objects.some(o=>{
      const target=o.join&&frame.objects[o.join.target_object_slot];
      return (target?.figure_type_id===typeId&&removedIds.has(o.join.target_handle_id))||
        (o.figure_type_id===typeId&&Object.keys(o._stykIK??{}).some(id=>removedIds.has(Number(id))));
    }));
    if(blocked){skipped.push({figure_type_id:typeId,reason:interfaceText("spatialMeshLegacy.aJoinOrIkControlUsesASkin"), reasonKey: "spatialMeshLegacy.aJoinOrIkControlUsesASkin"});continue;}
    const keep=figure.segments.map(s=>!removedIds.has(s.segment_id)),filter=values=>Array.isArray(values)&&values.length===keep.length?values.filter((_,i)=>keep[i]):values;
    const segments=figure.segments.filter((_,i)=>keep[i]);
    const next={...figure,segments,segment_count:segments.length,polyfills:(figure.polyfills??[]).filter((_,i)=>!removedPolys.has(i)),
      _styk:{...figure._styk,spatialMesh:mesh}};
    result={...result,figure_types:result.figure_types.map(f=>f===figure?next:f),
      keyframes:result.keyframes.map(frame=>frame.objects.some(o=>o.figure_type_id===typeId)?{...frame,objects:frame.objects.map(o=>{
        if(o.figure_type_id!==typeId)return o;
        const copy={...o,angles:filter(o.angles)};
        for(const key of ['lengths','bends','runtime_segments'])if(o[key]!==undefined)copy[key]=filter(o[key]);
        return copy;
      })}:frame)};
    converted.push({figure_type_id:typeId,vertices:mesh.positions.length/3,triangles:mesh.indices.length/3,removedSegments:removedIds.size});
  }
  return {document:result,converted,skipped};
}
