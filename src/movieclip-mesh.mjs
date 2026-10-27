import {messageError} from './localized-error.mjs';
/** What a movieclip stores of its indexed spatial meshes (one per clip frame; the engine poses and draws them). */
export function validateMovieclipMeshes(asset) {
  const meshes=asset.spatialMeshes;if(meshes===undefined)return;
  if(asset.drawingRotation||!Array.isArray(meshes)||meshes.length!==asset.duration||meshes.length>128)
    throw messageError(new Error(''), "errors.movieclipMesh.spatialFormsNeedOneMeshPerClipFrame", {});
  let total=0;
  for(const m of meshes){
    if(!m||!Array.isArray(m.positions)||m.positions.length<9||m.positions.length%3||m.positions.length>300000||m.positions.some(x=>!Number.isFinite(x)||Math.abs(x)>1e6)||
      !Array.isArray(m.indices)||!m.indices.length||m.indices.length%3||m.indices.length>600000||m.indices.some(i=>!Number.isInteger(i)||i<0||i>=m.positions.length/3)||
      !Array.isArray(m.colors)||!m.colors.length||m.colors.length>256||m.colors.some(c=>!Array.isArray(c)||c.length!==3||c.some(v=>!Number.isInteger(v)||v<0||v>255))||
      !Array.isArray(m.materials)||m.materials.length!==m.indices.length/3||m.materials.some(i=>!Number.isInteger(i)||i<0||i>=m.colors.length))
      throw messageError(new Error(''), "errors.movieclipMesh.invalidIndexedSpatialMesh", {});
    const views=m.viewPositions;
    if(views!==undefined&&(!Array.isArray(views)||![4,8].includes(views.length)||views.some(v=>!Array.isArray(v)||v.length!==m.positions.length||v.some(x=>!Number.isFinite(x)||Math.abs(x)>1e6))))
      throw messageError(new Error(''), "errors.movieclipMesh.viewCorrectedMeshesNeedFourOrEightComplete", {});
    if(m.viewTurns!==undefined&&(!views||!Array.isArray(m.viewTurns)||m.viewTurns.length!==views.length||m.viewTurns.some(t=>!Number.isFinite(t)||Math.abs(t)>Math.PI)||
      !Array.isArray(m.viewPivot)||m.viewPivot.length!==3||m.viewPivot.some(x=>!Number.isFinite(x)||Math.abs(x)>1e6)))
      throw messageError(new Error(''), "errors.movieclipMesh.viewTurnsNeedOneAnglePerViewSet", {});
    if(m.viewTurnWeights!==undefined&&(!m.viewTurns||!Array.isArray(m.viewTurnWeights)||m.viewTurnWeights.length!==m.positions.length/3||m.viewTurnWeights.some(w=>!Number.isFinite(w)||w<0||w>1)))
      throw messageError(new Error(''), "errors.movieclipMesh.viewTurnWeightsNeedOneValueFrom0", {});
    total+=m.positions.length*(1+(views?.length??0))+m.indices.length;if(total>6000000)throw messageError(new Error(''), "errors.movieclipMesh.spatialMeshAssetExceedsItsGeometryBudget", {});
  }
}
