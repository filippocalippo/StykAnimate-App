// The app's bounds callback, using its existing renderer owner and fixture resources.
import {objectBounds} from '../../src/renderer-geometry.mjs';
import {markAppBounds} from '../../src/engine/engine-edit-bounds.mjs';
export function appBounds(resources = {}) {
  const cache = new WeakMap();
  return geometry => {
    let bounds = cache.get(geometry);
    if (!bounds) {
      const rect = objectBounds([...geometry.segments.map(segment => ({...segment, type: segment.seg.segment_type || 'line'})),
        ...geometry.polys, ...(geometry.meshDrawables ?? [])], resources);
      bounds = {minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height};
      cache.set(geometry, bounds);
    }
    return bounds;
  };
}
/** The plain marker is the app's callback as the app has it, which the engine measures itself;
 * with `resources` it is a variant the engine does not know (its measurements are recorded). */
export const isAppMarker = value => value?.['@boundsCallback'] === 'app' && value.resources === undefined;
export function recordedBounds(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, '@boundsCallback')) return null;
  if (value['@boundsCallback'] === 'app') {
    const given = value.resources ?? {};
    const callback = appBounds({...given, ...(given.imageSize ? {image: () => ({naturalWidth: given.imageSize[0], naturalHeight: given.imageSize[1]})} : {}),
      ...(given.drawingBounds ? {drawing: () => ({store: {bounds: given.drawingBounds}})} : {})});
    return isAppMarker(value) ? markAppBounds(callback) : callback;
  }
  if (value['@boundsCallback'] === 'constant') return () => value.value;
  throw new Error('Unknown bounds callback in editing scenario');
}
