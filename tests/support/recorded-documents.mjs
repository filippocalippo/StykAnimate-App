import {VFX_REGISTRY} from '../../src/vfx-registry.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `actual` (a document) as the recording `recorded` would hold it. Effects gained parameters after the recordings were
 * made (generated effects, 2026-11; docs/engine/vfx.md), so a parameter an effect of the recording lacks is left out
 * where ours holds its default, as the engine's replay (`styk_edit::replay::as_recorded`) and `vfx::parity` compare
 * them. Anything else is kept, so it still differs.
 */
export const asRecorded = (actual, recorded) => {
  if (Array.isArray(actual) && Array.isArray(recorded)) return actual.map((item, i) => i < recorded.length ? asRecorded(item, recorded[i]) : item);
  if (!isObject(actual) || !isObject(recorded)) return actual;
  const specs = typeof actual.type === 'string' && Object.hasOwn(VFX_REGISTRY, actual.type) ? VFX_REGISTRY[actual.type].params : null;
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => {
    if (!Object.hasOwn(recorded, key)) return [key, value];
    if (key === 'params' && specs && isObject(value) && isObject(recorded.params)) {
      return [key, Object.fromEntries(Object.entries(value).filter(([name, item]) => Object.hasOwn(recorded.params, name) || !Object.hasOwn(specs, name) || specs[name].default !== item))];
    }
    return [key, asRecorded(value, recorded[key])];
  }));
};
