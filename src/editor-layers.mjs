import {messageError} from './localized-error.mjs';
import {ensureLayerState, validateLayerState, layerIdForUid, FIXED_LAYER_IDS} from './layers.mjs';

const cancelled = options => {
  if (options?.signal?.aborted) throw messageError(new DOMException('', 'AbortError'), "errors.editorLayerAsync.layerMigrationWasCancelled", {});
};

/** The layer list the interface reads, with the layer index the engine owner keeps current (`engine-owner.mjs`). Every change of a layer
 * is a command of the engine session. */
export const editorLayerMethods = {
  _initializeLayers() {
    const state = ensureLayerState(this.report); validateLayerState(state);
    this._layerUidCounts = new Map(); this._layerSeenUids = new Set(); this._layerGroups = new Map(state.order.map(id => [id, new Set()]));
    for (const frame of [...this.report.keyframes, ...Object.values(this.report._styk.frameSources ?? {})]) for (const object of frame.objects) {
      const uid = object.unique_id; this._layerUidCounts.set(uid, (this._layerUidCounts.get(uid) ?? 0) + 1); this._layerSeenUids.add(uid);
    }
    for (const uid of this._layerUidCounts.keys()) this._layerGroups.get(layerIdForUid(this.report, uid)).add(uid);
    this._layerRevision = (this._layerRevision ?? 0) + 1; this._layerDescriptors = null; this._layerUidArrays = new Map();
  },
  getLayers() {
    if (this._layerDescriptors) return this._layerDescriptors;
    const state = ensureLayerState(this.report);
    const fixed = FIXED_LAYER_IDS.map(id => ({id, kind: id, name: id === 'scene' ? 'Scene' : 'Camera',
      permanent: true, visible: state.fixed?.[id]?.visible !== false, savedLocked: state.fixed?.[id]?.locked === true, focusLocked: this.isLayerFocusLocked(id), locked: state.fixed?.[id]?.locked === true || this.isLayerFocusLocked(id), figureUids: []}));
    return this._layerDescriptors = [...fixed, ...state.order.map(id => ({id, kind: 'layer', ...state.byId[id], savedLocked: state.byId[id].locked, focusLocked: this.isLayerFocusLocked(id), locked: state.byId[id].locked || this.isLayerFocusLocked(id), permanent: false, figureUids: this.getLayerFigureUids(id)}))];
  },
  getLayer(id) { return this.getLayers().find(layer => layer.id === id) ?? null; },
  getLayerFolders() { return Object.entries(this.report._styk.layers.folders?.byId ?? {}).map(([id, folder]) => ({id, kind: 'folder', ...folder})); },
  layerForUid(uid) { return layerIdForUid(this.report, uid); },
  getLayerFigureUids(id) {
    let values = this._layerUidArrays.get(id);
    if (!values) { values = [...(this._layerGroups.get(id) ?? [])]; this._layerUidArrays.set(id, values); }
    return values;
  },
  setActiveLayer(id) {
    if (!this.getLayer(id)) throw messageError(new Error(''), "errors.editorLayers.chooseAnExistingLayer", {});
    const state = ensureLayerState(this.report); if (state.activeId === id) return false;
    state.activeId = id; this._emit('selection', {layerSelection: true, activeLayerId: id, layerRevision: this.layerRevision}); return true;
  },
  /** Moving figures to another layer and deleting a layer keep every figure's poses: the engine plans the change from the poses of the
   * whole animation and publishes it in one step (`assignFiguresToLayer`, `deleteLayer`, commands of the engine session). These are the
   * awaitable forms the interface calls; a signal already aborted cancels them. */
  async assignFiguresToLayerAsync(uids, id, options = {}) { cancelled(options); return this.assignFiguresToLayer(uids, id); },
  async deleteLayerAsync(id, options = {}) { cancelled(options); return this.deleteLayer(id, {targetLayerId: options.targetLayerId}); },
};
