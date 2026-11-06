import {localizedAttribute,localizedText} from './localization-bindings.mjs';
/** View-only layer projection. Never changes document order or visibility. */
export function organizeTimelineRows(rows, query = '', focusedIds = null) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = row => terms.every(term => row.name.toLocaleLowerCase().includes(term));
  const folderMatches = new Set();
  if (terms.length) for (const row of rows) if (row.kind === 'folder' && matches(row))
    for (const id of row.layerIds ?? []) folderMatches.add(id);
  const visible = new Set(rows.filter(row => row.kind === 'layer' &&
    (!focusedIds || focusedIds.has(row.id)) && (matches(row) || folderMatches.has(row.id))).map(row => row.id));
  return rows.filter(row => row.kind === 'layer' ? visible.has(row.id) : row.kind === 'folder' ?
    (row.layerIds ?? []).some(id => visible.has(id)) || !(row.layerIds?.length) && matches(row) || !terms.length && !focusedIds : true);
}

export const timelineOrganizationMethods = {
  setLayerFilter(query = '', focusedIds = this.focusedLayerIds, {lock = focusedIds === this.focusedLayerIds && Boolean(this.editor.getLayerFocus()?.lock)} = {}) {
    this._cancelGesture();
    // The rows start again from the top when the list shows something else, not when the same list is asked for again.
    const changed = query !== (this.layerQuery ?? '') || focusedIds !== this.focusedLayerIds;
    this.layerQuery = query;
    this.focusedLayerIds = focusedIds;
    this.layerSearch.value = query;
    this.editor.setLayerFocus(focusedIds, {lock});
    this.focusedLayerIds = this.editor.getLayerFocus()?.ids ?? null;
    this.anchor = this.hover = null;
    this._reindex();
    const visible = new Set(this.tracks.map(row => row.id));
    this.selectedLayers = new Set([...this.selectedLayers].filter(id => visible.has(id)));
    if (!visible.has(this.selectedTrackId)) this.selectedTrackId = this.tracks.find(row => row.kind === 'layer')?.id ?? 'camera';
    if (!this.selectedLayers.size) this.selectedLayers.add(this.selectedTrackId);
    if (changed) this.scroll.scrollTop = 0;
    this.update();
  },
  focusSelectedLayers({lock = false, ids} = {}) {
    const selected = new Set((ids ?? this.ids).filter(id => this.editor.getLayer(id)?.kind === 'layer'));
    if (!this.focusedLayerIds && !selected.size) { localizedText(this.live, "timelineOrganization.selectAFigureLayerToFocus", {}); return; }
    this.setLayerFilter(this.layerQuery, this.focusedLayerIds && !lock && ids === undefined ? null : selected.size ? selected : this.focusedLayerIds, {lock});
  },
  revealSelectedLayer() {
    if (this.layerView && !this.layerView.shown(this.selectedTrackId)) return;
    const folderId = this.editor?.getLayer(this.selectedTrackId)?.folderId;
    if (!this.focusedLayerIds && folderId && this.collapsedFolders?.delete(folderId)) this._reindex();
    // Selection on the canvas can belong to a layer outside this list. Focus
    // remains until Show all; a name search can still reveal its selection.
    if (!this.tracks.some(row => row.id === this.selectedTrackId) && !this.focusedLayerIds) {
      const id = this.selectedTrackId;this.setLayerFilter('', null);this.selectedTrackId = id;this.selectedLayers = new Set([id]);
    }
    timelineOrganizationMethods.revealRow.call(this, this.selectedTrackId);
  },
  /** Scrolls the rows just far enough to show row `id` between the pinned block (or the ruler) and the grid's foot. */
  revealRow(id) {
    const index = this.tracks.findIndex(row => row.id === id), layout = this.layout;
    if (index < 0 || !layout || layout.pinned && index < layout.system) return;
    // The scrolling rows show between the pinned block (or the ruler) and the grid's foot (timeline-rows.mjs).
    const top = layout.top(index), bottom = top + layout.size(index), offset = this._offsetY();
    const above = layout.contentTop - layout.header, view = this.height - layout.header;
    if (top < offset + above) this._scrollToY(top - above);
    else if (bottom > offset + view) this._scrollToY(bottom - view);
  },
  fitFrameRange(selection = false) {
    const start = selection ? this.start : 0;
    const end = selection ? this.end + 1 : this.editor.totalTicks;
    this.setZoom(Math.min(36, (this.width - 32) / Math.max(1, end - start)));
    this._scrollToX(Math.max(0, start * this.pxPerTick - 16));
  },
  _syncOrganization() {
    this.focusedLayerIds = this.editor.getLayerFocus()?.ids ?? null;
    const count = this.visibleLayerCount;
    const total = this.editor.report._styk.layers.order.length;
    const hidden=!this.layerQuery,focused=String(Boolean(this.focusedLayerIds));
    localizedAttribute(this.layerSearch,'title','timelineOrganization.visibleLayers',{visible:count,count:total});
    if(this.clearSearch.hidden!==hidden)this.clearSearch.hidden=hidden;
    if(this.focusLayersButton.getAttribute('aria-pressed')!==focused)this.focusLayersButton.setAttribute('aria-pressed',focused);
    localizedAttribute(this.focusLayersButton,'aria-label',this.focusedLayerIds?'timeline.showAllLayers':'timeline.focusLayers');
    const word=this.focusLayersButton.querySelector('.ui-label');if(word)localizedText(word,this.focusedLayerIds?'timelineOrganization.showAll':'timelineOrganization.focus');
    // The layer list's header: Show all while a focus is on (a layer's menu focuses it), New layer's kind
    // for the workspace (Draw makes drawing layers), and the find field in the title's place while it is used.
    const searching=Boolean(this.layerQuery)||document.activeElement===this.layerSearch;
    const focusHidden=!this.focusedLayerIds||searching;
    if(this.focusLayersButton.hidden!==focusHidden)this.focusLayersButton.hidden=focusHidden;
    if(this.newLayerButton)localizedAttribute(this.newLayerButton,'aria-label',this._drawWorkspace?.()?'timeline.newDrawingLayer':'timeline.newLayer');
    // An active filter says how much of the list it leaves, since the rows it hides give no other sign.
    if(this.filterButton){const filtered=Boolean(this.layerView?.active);if(this.filterButton.dataset.active!==String(filtered))this.filterButton.dataset.active=String(filtered);
      localizedAttribute(this.filterButton,'data-tooltip',filtered?'layerFilter.count':'layerFilter.title',filtered?{shown:count,total}:{});}
    if(this.searchField){if(this.searchField.hidden!==!searching)this.searchField.hidden=!searching;if(this.labelTitle.hidden!==searching)this.labelTitle.hidden=searching;}
    const emptyHidden=count>0||!this.layerQuery&&!this.focusedLayerIds&&Boolean(this.layerView?.active)&&this.tracks.length>0||!(this.layerQuery||this.focusedLayerIds||this.layerView?.active);
    if(this.emptyLayers.hidden!==emptyHidden)this.emptyLayers.hidden=emptyHidden;
  },
};
