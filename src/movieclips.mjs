import {messageError} from './localized-error.mjs';
import {validateDrawingSets} from './movieclip-drawings.mjs';
import {validateMovieclipMeshes} from './movieclip-mesh.mjs';
/** Movieclip assets are immutable figure definitions. Scene poses contain only
 * a small playback descriptor; sampled scenes and geometry never enter history. */
const MOVIECLIP_VERSION = 1;
export const isMovieclip = figure => Boolean(figure?._styk?.movieclip);
export const movieclipAsset = figure => figure?._styk?.movieclip;
export function movieclipAssetFigures(figure){
  const figures=[],documents=new Set(),queue=[figure];
  for(let i=0;i<queue.length;i++){
    const f=queue[i];figures.push(f);const document=movieclipAsset(f)?.document;
    if(document&&!documents.has(document)){documents.add(document);queue.push(...document.figure_types);}
  }
  return figures;
}
export function playbackSettings(object, defaults = {}) {
  return {start: 0, end: null, offset: 0, speed: 1, mode: 'loop', ...defaults, ...object?._stykMovieclip};
}
export function validatePlayback(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw messageError(new Error(''), "errors.movieclips.invalidMovieclipPlayback", {});
  const value = playbackSettings({_stykMovieclip: settings});
  if(value.clock!==undefined&&value.clock!=='presence')throw messageError(new Error(''), "errors.movieclips.invalidMovieclipClock", {});
  if(value.clock==='presence'&&(value.restarts?.length||value.start!==0||value.end!==null))throw messageError(new Error(''), "errors.movieclips.presenceMovieclipsUseFrameMembershipInsteadOfPlacement", {});
  if (!['loop','once','hold','single'].includes(value.mode)) throw messageError(new Error(''), "errors.movieclips.invalidMovieclipPlaybackMode", {});
  if (!Number.isInteger(value.start) || value.start < 0 || value.start > 10000000 ||
      value.end !== null && (!Number.isInteger(value.end) || value.end <= value.start || value.end > 10000001))
    throw messageError(new Error(''), "errors.movieclips.movieclipPlacementMustHaveAValidStartAnd", {});
  if (!Number.isFinite(value.offset) || value.offset < 0 || value.offset > 10000000 ||
      !Number.isFinite(value.speed) || value.speed <= 0 || value.speed > 100)
    throw messageError(new Error(''), "errors.movieclips.movieclipOffsetOrSpeedIsOutsideTheSupported", {});
  if (value.restarts !== undefined && (!Array.isArray(value.restarts) || value.restarts.length > 100000 || value.restarts.some((key,i) =>
    !Number.isInteger(key.tick) || key.tick < 0 || key.tick > 10000000 || !Number.isFinite(key.offset) || key.offset < 0 || key.offset > 10000000 || i > 0 && key.tick <= value.restarts[i-1].tick)))
    throw messageError(new Error(''), "errors.movieclips.invalidMovieclipRestartKeys", {});
  return value;
}
function movieclipSourceTime(asset, settings, tick, fps) {
  const keys=settings.restarts??[];let low=0,high=keys.length;
  while(low<high){const mid=(low+high)>>>1;if(keys[mid].tick<=tick)low=mid+1;else high=mid;}
  const phase=low?keys[low-1]:{tick:settings.start,offset:settings.offset};
  return settings.mode==='single'?phase.offset:phase.offset+(tick-phase.tick)*settings.speed*asset.document.fps/fps;
}
export function movieclipTime(asset, settings, tick, fps) {
  if (tick < settings.start || settings.end !== null && tick >= settings.end) return null;
  const duration = asset.duration;
  const raw = movieclipSourceTime(asset, settings, tick, fps);
  if (settings.mode === 'loop') return ((raw % duration) + duration) % duration;
  if (settings.mode === 'once' && raw >= duration) return null;
  return Math.max(0, Math.min(duration - 1, raw));
}
export function movieclipFigure(id, name, document, {duration, sourceStart = 0, pivot = {x: 0, y: 0}} = {}) {
  return {figure_type_id: id, name, segment_count: 1,
    segments: [{segment_id: 1, parent_id: 0, length: 40, angle_rad: 0, thickness: 0,
      bend_rad: 0, primitive_code: 0, aux_code: 0, flags: 0, segment_type: 'line',
      segment_kind: 'line', color_rgb: [0,0,0], transparency: 0, visible: false, z_order: 1}],
    polyfills: [], image_assets: [], text_assets: [],
    _styk: {movieclip: {version: MOVIECLIP_VERSION, document, duration, sourceStart, pivot}}};
}
/** Reject graph cycles and oversized nesting before recursive scene validation. */
export function validateMovieclipGraph(report) {
  const visiting = new Set(), visited = new Set(); let assets = 0;
  function visit(document, depth) {
    if(!document || typeof document!=='object' || !Array.isArray(document.figure_types))throw messageError(new Error(''), "errors.movieclips.invalidMovieclipDocument", {});
    if (visiting.has(document) || depth > 8) throw messageError(new Error(''), "errors.movieclips.movieclipsContainACycleOrExceedEightNested", {});
    if (visited.has(document)) return;
    visiting.add(document);
    if (document._styk?.movieclipSource?.document) visit(document._styk.movieclipSource.document, depth + 1);
    for (const figure of document.figure_types ?? []) {
      const asset = movieclipAsset(figure); if (!asset) continue;
      if (++assets > 4096) throw messageError(new Error(''), "errors.movieclips.movieclipAssetLimitExceeded", {});
      if (asset.version !== MOVIECLIP_VERSION || !asset.document || !Number.isInteger(asset.duration) || asset.duration < 1 || asset.duration > 10000000 ||
          !Number.isInteger(asset.sourceStart) || asset.sourceStart < 0 || !Number.isFinite(asset.pivot?.x) || !Number.isFinite(asset.pivot?.y))
        throw messageError(new Error(''), "errors.movieclips.invalidMovieclipAsset", {});
      if (figure.segments?.length !== 1) throw messageError(new Error(''), "errors.movieclips.movieclipContainersRequireOneTransformHandle", {});
      validateDrawingSets(asset);
      validateMovieclipMeshes(asset);
      visit(asset.document, depth + 1);
    }
    visiting.delete(document); visited.add(document);
  }
  visit(report, 0);
}
