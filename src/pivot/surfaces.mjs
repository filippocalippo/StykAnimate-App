import {messageError} from '../localized-error.mjs';
/** Optional single-sided native fills. A local reference triangle preserves winding under reflection, rotation, joining and ID
 * remapping. Ordinary polygons remain double-sided. Optional depth guides offset native painter order without storing any
 * per-pose surface state. What a document stores of a surface is checked here; the engine decides which faces show
 * and in what order (`styk_eval::geometry`). */
export function validateSurface(poly, ids) {
  const s=poly._stykSurface;if(s===undefined)return;
  if(!s||!Array.isArray(s.basis)||s.basis.length!==3||new Set(s.basis).size!==3||s.basis.some(id=>!Number.isInteger(id)||!ids.has(id)))throw messageError(new Error(''), "errors.surfaces.faceVisibilityNeedsThreeDistinctExistingReferenceJoints", {});
  if(s.side!==undefined&&!['front','back'].includes(s.side))throw messageError(new Error(''), "errors.surfaces.chooseFrontBackOrBothForFaceVisibility", {});
  if(s.flipped!==undefined&&typeof s.flipped!=='boolean')throw messageError(new Error(''), "errors.surfaces.faceFacingMustBeABoolean", {});
  if(s.depth!==undefined&&(!Array.isArray(s.depth)||!s.depth.length||s.depth.length>1024||s.depth.some(id=>!Number.isInteger(id)||!ids.has(id))))throw messageError(new Error(''), "errors.surfaces.faceDepthNeedsExistingReferenceJointsUpTo", {});
  if(s.depthTest!==undefined&&(typeof s.depthTest!=='boolean'||s.depthTest&&(s.depth?.length!==3||poly.segment_ids?.length!==3)))throw messageError(new Error(''), "errors.surfaces.depthTestingNeedsATriangleWithOneDepth", {});
}
