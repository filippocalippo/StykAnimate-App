import {messageError} from './localized-error.mjs';
/** Figure-level indexed skinned meshes. Vertices, triangles and colours are
 * immutable definition data bound to the figure's own spatial bones. They never
 * become joints, fills or per-frame pose channels: the engine poses them into
 * typed arrays consumed by one depth-tested draw. See docs/SPATIAL-MESHES.md. */
import {spatialBone} from './rig-spatial.mjs';

const MESH_LIMITS=Object.freeze({vertices:200000,triangles:400000,colors:1024,groups:1024});
const KEYS=new Set(['positions','bones','weights','indices','colors','materials','basis','z','views','viewVertices','viewPoints','groups']);
const spatialMeshOf=figure=>figure?._styk?.spatialMesh;

export function validateSpatialMesh(figure){
  const m=spatialMeshOf(figure);if(m===undefined)return;
  const fail=(key,params)=>{throw messageError(new Error(''),key,params);};
  if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!KEYS.has(k)))fail("errors.spatialMesh.invalid3dMesh", {});
  const {positions,bones,weights,indices,colors,materials,basis}=m;
  if(!Array.isArray(positions)||positions.length<9||positions.length%3)fail("errors.spatialMesh.a3dMeshNeedsXyzPositionsForAt", {});
  const count=positions.length/3;
  if(count>MESH_LIMITS.vertices)fail("errors.spatialMesh.a3dMeshCanHaveUpToVertices", {vertices: MESH_LIMITS.vertices});
  for(const v of positions)if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e6)fail("errors.spatialMesh.failure3dMeshPositionsMustBeFinite", {});
  if(!Array.isArray(bones)||bones.length!==count*4||!Array.isArray(weights)||weights.length!==count*4)fail("errors.spatialMesh.each3dMeshVertexNeedsFourBoneAnd", {});
  const ids=new Map(figure.segments.map((s,i)=>[s.segment_id,i])),checked=new Set();
  for(let v=0;v<count;v++){
    let sum=0;
    for(let k=0;k<4;k++){
      const bone=bones[v*4+k],weight=weights[v*4+k];
      if(!Number.isInteger(bone)||bone<0||bone>65535||typeof weight!=='number'||!Number.isFinite(weight)||weight<0||weight>1)fail("errors.spatialMesh.failure3dMeshBindingsNeedBoneIdsAndWeights", {});
      if((bone===0)!==(weight===0)||(k===0&&bone===0))fail("errors.spatialMesh.bindEvery3dMeshVertexToAtLeast", {});
      if(!bone)continue;
      for(let j=0;j<k;j++)if(bones[v*4+j]===bone)fail("errors.spatialMesh.a3dMeshVertexCannotBindOneBone", {});
      if(!checked.has(bone)){if(!spatialBone(figure.segments[ids.get(bone)]))fail("errors.spatialMesh.failure3dMeshVerticesMustBindArticulatedSpatialJoints", {});checked.add(bone);}
      sum+=weight;
    }
    if(Math.abs(sum-1)>1e-6)fail("errors.spatialMesh.failure3dMeshVertexWeightsMustAddUpTo", {});
  }
  if(!Array.isArray(indices)||!indices.length||indices.length%3)fail("errors.spatialMesh.a3dMeshNeedsTriangleIndices", {});
  const triangles=indices.length/3;
  if(triangles>MESH_LIMITS.triangles)fail("errors.spatialMesh.a3dMeshCanHaveUpToTriangles", {triangles: MESH_LIMITS.triangles});
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i],b=indices[i+1],c=indices[i+2];
    for(const n of [a,b,c])if(!Number.isInteger(n)||n<0||n>=count)fail("errors.spatialMesh.failure3dMeshTrianglesMustReferenceExistingVertices", {});
    if(a===b||b===c||a===c)fail("errors.spatialMesh.failure3dMeshTrianglesNeedThreeDifferentVertices", {});
  }
  if(!Array.isArray(colors)||!colors.length||colors.length>MESH_LIMITS.colors||colors.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isInteger(v)||v<0||v>255)))
    fail("errors.spatialMesh.a3dMeshNeeds1RgbColours", {colors: MESH_LIMITS.colors});
  if(!Array.isArray(materials)||materials.length!==triangles||materials.some(i=>!Number.isInteger(i)||i<0||i>=colors.length))fail("errors.spatialMesh.each3dMeshTriangleNeedsAColour", {});
  if(!Array.isArray(basis)||basis.length!==3||basis.some(id=>!Number.isInteger(id)||(id!==0&&!ids.has(id)))||basis[1]===0||basis[2]===0||basis[1]===basis[2])
    fail("errors.spatialMesh.a3dMeshNeedsItsOriginXAnd", {});
  if(m.z!==undefined&&(typeof m.z!=='number'||!Number.isFinite(m.z)||Math.abs(m.z)>1e6))fail("errors.spatialMesh.failure3dMeshDepthOrderMustBeFinite", {});
  if(m.views!==undefined||m.viewVertices!==undefined||m.viewPoints!==undefined){
    const {views,viewVertices,viewPoints}=m;
    if(![4,8].includes(views)||!Array.isArray(viewVertices)||!viewVertices.length||!Array.isArray(viewPoints)||viewPoints.length!==viewVertices.length*views*3)
      fail("errors.spatialMesh.viewCorrectedMeshVerticesNeedFourOrEight", {});
    let previous=-1;
    for(const v of viewVertices){
      if(!Number.isInteger(v)||v<=previous||v>=count)fail("errors.spatialMesh.viewCorrectedVerticesMustBeListedOnceIn", {});
      if(weights[v*4]!==1)fail("errors.spatialMesh.viewCorrectedMeshVerticesMustFollowOneBone", {});
      previous=v;
    }
    for(const n of viewPoints)if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e6)fail("errors.spatialMesh.failure3dMeshViewPositionsMustBeFinite", {});
  }
  if(m.groups!==undefined){
    if(!Array.isArray(m.groups)||m.groups.length>MESH_LIMITS.groups)fail("errors.spatialMesh.invalid3dMeshParts", {});
    let end=0;
    for(const g of m.groups){
      if(!g||typeof g!=='object'||Object.keys(g).some(k=>!['name','start','count'].includes(k))||typeof g.name!=='string'||g.name.length>256||
        !Number.isInteger(g.start)||!Number.isInteger(g.count)||g.count<1||g.start<end||g.start+g.count>triangles)fail("errors.spatialMesh.failure3dMeshPartsNeedNamesAndOrderedTriangle", {});
      end=g.start+g.count;
    }
  }
}
