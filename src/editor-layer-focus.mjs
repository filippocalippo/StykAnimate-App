import {messageError} from './localized-error.mjs';

// Focus belongs to the editing session. Report copies, workers, exports and
// serialized projects do not inherit these temporary locks.
const focusByReport = new WeakMap();

export function layerFocusLocked(report, id) {
  const focus = focusByReport.get(report);
  return Boolean(focus?.lock && !focus.ids.has(id));
}

export function figureFocusLocked(report, uid) {
  const layers = report._styk?.layers;
  const id = Object.hasOwn(layers?.assignments ?? {}, String(uid)) ? layers.assignments[String(uid)] : layers?.defaultLayerId ?? 'layer-1';
  return layerFocusLocked(report, id);
}

/** The layer table a focus was last checked against: the session replaces it with every change of a layer, so the same table means the
 * focused layers are all still there. */
const layerTable = report => report._styk?.layers?.byId;

function changed(editor, {notify = true} = {}) {
  editor._layerDescriptors = null;
  editor._layerFocusRevision = (editor._layerFocusRevision ?? 0) + 1; // the focus's own count: `layerRevision` is the engine session's alone
  const focus = focusByReport.get(editor.report);
  if (focus) focus.layers = layerTable(editor.report);
  if (notify) editor._emit('layer-focus', {layers: true, layerFocus: true, layerFocusRevision: editor.layerFocusRevision});
}

export const editorLayerFocusMethods = {
  getLayerFocus() {
    this.reconcileLayerFocus();
    return focusByReport.get(this.report) ?? null;
  },

  // Creation publishers call this before follow-up selection/edit guards and
  // their layer-change event. The focus remains session state, including when
  // Draw or a movieclip command creates its own layer without the timeline UI.
  _includeCreatedLayersInFocus(ids) {
    const focus = focusByReport.get(this.report);
    if (!focus) return false;
    let included = false;
    for (const id of ids) if (Object.hasOwn(this.report._styk.layers.byId, id) && !focus.ids.has(id)) {
      focus.ids.add(id); included = true;
    }
    return included;
  },

  setLayerFocus(ids, {lock = false} = {}) {
    if (ids == null) return this.clearLayerFocus();
    const next = new Set(ids);
    if (!next.size || [...next].some(id => !Object.hasOwn(this.report._styk.layers.byId, id)))
      throw messageError(new Error(''), 'timelineOrganization.chooseLayersToFocus', {});
    if (typeof lock !== 'boolean') throw messageError(new Error(''), 'timelineOrganization.invalidFocusLock', {});
    const previous = this.getLayerFocus();
    if (previous?.lock === lock && next.size === previous.ids.size && [...next].every(id => previous.ids.has(id))) return false;
    if (this.dragging) this.commitDrag();
    focusByReport.set(this.report, {ids: next, lock, layers: layerTable(this.report)});
    this._layerFocusReport = this.report;
    if (lock) {
      const selected = [...this.selectedUids].filter(uid => !figureFocusLocked(this.report, uid));
      if (selected.length !== this.selectedUids.size) {
        const preferred = this.selectedUid;
        this._selectIds(selected);
        if (this.selectedUids.has(preferred)) this._selectedUid = preferred;
        this._segmentSelection = this._polygonSelection = null;
      }
      if (layerFocusLocked(this.report, this._sheetSelection?.id)) this._sheetSelection = null;
    }
    changed(this);
    return true;
  },

  clearLayerFocus({notify = true} = {}) {
    const previous = this._layerFocusReport;
    const existed = Boolean(previous && focusByReport.has(previous));
    if (previous) focusByReport.delete(previous);
    focusByReport.delete(this.report);
    this._layerFocusReport = null;
    if (existed) changed(this, {notify});
    return existed;
  },

  // Called before publishing document/layer changes. Removing the last focused
  // layer releases the focus, rather than leaving the whole document locked.
  reconcileLayerFocus() {
    if (this._layerFocusReport && this._layerFocusReport !== this.report) return this.clearLayerFocus({notify: false});
    const focus = focusByReport.get(this.report);
    if (!focus) return false;
    const layers = layerTable(this.report);
    if (focus.layers === layers) return false;
    let removed = false;
    for (const id of focus.ids) if (!Object.hasOwn(layers, id)) { focus.ids.delete(id); removed = true; }
    if (!removed) { focus.layers = layers; return false; }
    if (!focus.ids.size) return this.clearLayerFocus({notify: false});
    changed(this, {notify: false});
    return true;
  },

  isLayerFocusLocked(id) { this.reconcileLayerFocus(); return layerFocusLocked(this.report, id); },
  isFigureFocusLocked(uid) { this.reconcileLayerFocus(); return figureFocusLocked(this.report, uid); },

  /** What the engine session holds from edits while Focus and lock is on: the focused layers, which it leaves free (everything else,
   * Scene and Camera too, is locked as if saved). Null without the lock: a focus that only filters the view changes no edit. The
   * owner sends it with every call (`view()`); the focus never changes the document. */
  layerFocusLock() {
    const focus = this.getLayerFocus();
    return focus?.lock ? [...focus.ids] : null;
  },

  /** Focus changes count here, never in `layerRevision`, which the engine session counts and writes alone: one number then never
   * stands for two states. */
  get layerFocusRevision() { return this._layerFocusRevision ?? 0; },
  /** What a cache of the layers' look keys on: the layers the session counts and the focus the editor keeps. */
  get layerViewKey() { return `${this.layerRevision}.${this.layerFocusRevision}`; },
};
