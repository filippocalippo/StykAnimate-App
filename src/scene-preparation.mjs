import {sceneBackgroundColor} from './pivot/background.mjs';

const imageItems = new WeakMap();
/** Drawing lists are immutable geometry resources, including nested clip
 * primitives. Reuse their image subset without flattening the whole scene on
 * every pointer frame just to discard its lines and polygons. */
export function frameImageDrawables(geometry) {
  const images = [];
  for (const group of geometry?.orderedObjects || []) {
    const items = group.drawables;
    let cached = imageItems.get(items);
    if (!cached) {cached = items.filter(item => item.type === 'image' && item.asset); imageItems.set(items, cached);}
    for (const item of cached) images.push(item);
  }
  return images;
}

export function backgroundImageAssets(report, frame) {
  if (frame && sceneBackgroundColor(report, frame) !== undefined) return [];
  const ids = frame ? new Set([Number(frame.background_id || 0), ...(frame.background_mix ? [Number(frame.background_id_b || 0)] : [])]) : null;
  return (report.backgrounds || []).filter(asset => (!ids || ids.has(Number(asset.background_id))) && ![2, 3, 4].includes(asset.kind) && asset.color === undefined);
}
