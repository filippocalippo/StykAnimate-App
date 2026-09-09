/** Persistent user layers. Native object slots and join references never change. */
export const FIXED_LAYER_IDS = Object.freeze(['scene', 'camera']);
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const isUserLayerId = id => typeof id === 'string' && /^layer-[1-9]\d*$/.test(id);
export function createLayerState() {
  return {version: 1, nextId: 2, order: ['layer-1'], byId: {'layer-1': {name: 'Layer 1', visible: true, locked: false}},
    assignments: {}, defaultLayerId: 'layer-1', activeId: 'layer-1',
    fixed: {scene: {visible: true, locked: false}, camera: {visible: true, locked: false}}};
}
export function validateLayerState(state) {
  const iterator = validateLayerStateSteps(state);
  for (;;) {const step=iterator.next(); if (step.done) return step.value;}
}
export function* validateLayerStateSteps(state) {
  if (!record(state) || state.version !== 1 || !Array.isArray(state.order) || !state.order.length || state.order.length > 10000 ||
    !record(state.byId) || !record(state.assignments) || !Number.isSafeInteger(state.nextId) || state.nextId < 1)
    throw new Error('Invalid StykAnimate layer metadata.');
  const ids = new Set(); let largest = 0, work = 0;
  for (const id of state.order) {
    if (!isUserLayerId(id) || ids.has(id) || !owns(state.byId, id)) throw new Error('Layer IDs and order must be unique.');
    ids.add(id); largest = Math.max(largest, Number(id.slice(6)));
    const layer = state.byId[id];
    if (!record(layer) || typeof layer.name !== 'string' || !layer.name.trim() || layer.name.length > 160 ||
      typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean') throw new Error('Invalid layer properties.');
    if (++work % 256 === 0) yield {phase:'layers', checked:work};
  }
  if (Object.keys(state.byId).length !== ids.size || state.nextId <= largest || !ids.has(state.defaultLayerId) ||
    (state.activeId !== undefined && !ids.has(state.activeId) && !FIXED_LAYER_IDS.includes(state.activeId))) throw new Error('Layer metadata references a missing layer.');
  for (const uid in state.assignments) if (owns(state.assignments,uid)) {
    if (!/^(0|[1-9]\d*)$/.test(uid) || Number(uid) > 0xffffffff || !ids.has(state.assignments[uid])) throw new Error('Invalid figure-to-layer assignment.');
    if (++work % 256 === 0) yield {phase:'layers', checked:work};
  }
  if (state.fixed !== undefined) {
    if (!record(state.fixed) || Object.keys(state.fixed).some(id => !FIXED_LAYER_IDS.includes(id))) throw new Error('Invalid permanent tracks.');
    for (const id of FIXED_LAYER_IDS) if (state.fixed[id] &&
      (typeof state.fixed[id].visible !== 'boolean' || typeof state.fixed[id].locked !== 'boolean')) throw new Error('Invalid permanent track properties.');
  }
  return state;
}
export function ensureLayerState(report) {
  if (!report._styk) report._styk = {};
  if (!record(report._styk)) throw new Error('Invalid StykAnimate metadata.');
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
export function layerLocked(report, uid) { const state = report._styk?.layers; return state?.byId[layerIdForUid(report, uid)]?.locked === true; }

/** Back-to-front grouping preserves the source order within each user layer. */
export function applyLayerOrder(report, frame) {
  const state = report._styk?.layers; if (!state || state.order.length < 2) return frame;
  const order = frame.object_draw_order ?? frame.objects.map((_, slot) => slot), groups = new Map(state.order.map(id => [id, []]));
  for (const slot of order) {
    const object = frame.objects[slot]; if (!object) throw new Error('Invalid native figure order.');
    const id = layerIdForUid(report, object.unique_id), group = groups.get(id);
    if (!group) throw new Error('Figure references a missing user layer.');
    group.push(slot);
  }
  const next = []; for (const id of state.order) for (const slot of groups.get(id)) next.push(slot);
  if (next.every((slot, index) => slot === order[index])) return frame;
  return {...frame, object_draw_order: next, object_draw_order_unique_ids: next.map(slot => frame.objects[slot].unique_id)};
}
