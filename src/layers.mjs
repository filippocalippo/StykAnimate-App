import {messageError} from './localized-error.mjs';
import {validateParallax} from './layer-parallax.mjs';
import {validateLayerFolders} from './layer-folders.mjs';
import {figureFocusLocked} from './editor-layer-focus.mjs';
/** Persistent user layers. Native object slots and join references never change. */
export const FIXED_LAYER_IDS = Object.freeze(['scene', 'camera']);
export const LAYER_COLORS = Object.freeze({blue:'#3399ee',violet:'#9966dd',rose:'#df6690',orange:'#d99035',green:'#43a878',teal:'#36a8b5'});
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const isUserLayerId = id => typeof id === 'string' && /^layer-[1-9]\d*$/.test(id);
export function createLayerState() {
  return {version: 1, nextId: 2, order: ['layer-1'], byId: {'layer-1': {name: 'Layer 1', visible: true, locked: false}},
    assignments: {}, defaultLayerId: 'layer-1', activeId: 'layer-1',
    fixed: {scene: {visible: true, locked: false}, camera: {visible: true, locked: false}}};
}
export function validateLayerState(state) {
  const iterator = validateLayerStateSteps(state);
  for (;;) {const step=iterator.next(); if (step.done) return step.value;}
}
function* validateLayerStateSteps(state) {
  if (!record(state) || state.version !== 1 || !Array.isArray(state.order) || !state.order.length || state.order.length > 10000 ||
    !record(state.byId) || !record(state.assignments) || !Number.isSafeInteger(state.nextId) || state.nextId < 1)
    throw messageError(new Error(''), "errors.layers.invalidStykanimateLayerMetadata", {});
  const ids = new Set(); let largest = 0, work = 0;
  for (const id of state.order) {
    if (!isUserLayerId(id) || ids.has(id) || !owns(state.byId, id)) throw messageError(new Error(''), "errors.layers.layerIdsAndOrderMustBeUnique", {});
    ids.add(id); largest = Math.max(largest, Number(id.slice(6)));
    const layer = state.byId[id];
    if (!record(layer) || typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 160 ||
      typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean') throw messageError(new Error(''), "errors.layers.invalidLayerProperties", {});
    validateParallax(layer.parallax);
    if (layer.drawing !== undefined && (!record(layer.drawing) || layer.drawing.version !== 1)) throw messageError(new Error(''), "errors.layers.invalidDrawingLayerMetadata", {});
    if (layer.color !== undefined && !Object.hasOwn(LAYER_COLORS, layer.color)) throw messageError(new Error(''), "errors.layers.invalidLayerColor", {});
    if (++work % 256 === 0) yield {phase:'layers', checked:work};
  }
  if (Object.keys(state.byId).length !== ids.size || state.nextId <= largest || !ids.has(state.defaultLayerId) ||
    (state.activeId !== undefined && !ids.has(state.activeId) && !FIXED_LAYER_IDS.includes(state.activeId))) throw messageError(new Error(''), "errors.layers.layerMetadataReferencesAMissingLayer", {});
  for (const uid in state.assignments) if (owns(state.assignments,uid)) {
    if (!/^(0|[1-9]\d*)$/.test(uid) || Number(uid) > 0xffffffff || !ids.has(state.assignments[uid])) throw messageError(new Error(''), "errors.layers.invalidFigureToLayerAssignment", {});
    if (++work % 256 === 0) yield {phase:'layers', checked:work};
  }
  if (state.fixed !== undefined) {
    if (!record(state.fixed) || Object.keys(state.fixed).some(id => !FIXED_LAYER_IDS.includes(id))) throw messageError(new Error(''), "errors.layers.invalidPermanentTracks", {});
    for (const id of FIXED_LAYER_IDS) if (state.fixed[id] &&
      (typeof state.fixed[id].visible !== 'boolean' || typeof state.fixed[id].locked !== 'boolean')) throw messageError(new Error(''), "errors.layers.invalidPermanentTrackProperties", {});
  }
  validateLayerFolders(state);
  return state;
}
export function ensureLayerState(report) {
  if (!report._styk) report._styk = {};
  if (!record(report._styk)) throw messageError(new Error(''), "errors.layers.invalidStykanimateMetadata", {});
  const state = report._styk.layers ??= createLayerState();
  if (record(state) && (state.fixed === undefined || record(state.fixed))) {
    state.fixed ??= {};
    for (const id of FIXED_LAYER_IDS) state.fixed[id] ??= {visible: true, locked: false};
  }
  return state;
}
export function layerIdForUid(report, uid) {
  const state = report._styk?.layers;
  return state ? (owns(state.assignments, String(uid)) ? state.assignments[String(uid)] : state.defaultLayerId) : 'layer-1';
}
export function layerVisible(report, uid) { const state = report._styk?.layers; return state?.byId[layerIdForUid(report, uid)]?.visible !== false; }
export function layerLocked(report, uid) { const state = report._styk?.layers; return state?.byId[layerIdForUid(report, uid)]?.locked === true || figureFocusLocked(report, uid); }

/** Back-to-front grouping preserves the source order within each user layer. */
export function applyLayerOrder(report, frame) {
  const state = report._styk?.layers;
  const hasDepth = frame.objects.some(object => object._stykZIndex);
  if ((!state || state.order.length < 2) && !hasDepth) return frame;
  const layerOrder = state?.order ?? ['layer-1'];
  const order = frame.object_draw_order ?? frame.objects.map((_, slot) => slot), groups = new Map(layerOrder.map(id => [id, []]));
  for (const slot of order) {
    const object = frame.objects[slot]; if (!object) throw messageError(new Error(''), "errors.layers.invalidNativeFigureOrder", {});
    const id = layerIdForUid(report, object.unique_id), group = groups.get(id);
    if (!group) throw messageError(new Error(''), "errors.layers.figureReferencesAMissingUserLayer", {});
    group.push(slot);
  }
  const next = [];
  for (const id of layerOrder) {
    const group = groups.get(id);
    // Stable ties retain the native pose order; never reorder object slots or joins.
    if (hasDepth) group.sort((a, b) => (frame.objects[a]._stykZIndex ?? 0) - (frame.objects[b]._stykZIndex ?? 0));
    for (const slot of group) next.push(slot);
  }
  if (next.every((slot, index) => slot === order[index])) return frame;
  return {...frame, object_draw_order: next, object_draw_order_unique_ids: next.map(slot => frame.objects[slot].unique_id)};
}
