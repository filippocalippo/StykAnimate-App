import {validationLabel} from "./validation-labels.mjs";
import {messageError} from './localized-error.mjs';
import {editorSpatialMethods} from './editor-spatial.mjs';
import {timeline} from './pivot/read-view.mjs';
import {validateScene, syncDerived} from './pivot/model.mjs';
import {resolveJoinSelection} from './pivot/structure.mjs';
import {createDemo, emptyDocument, defaultFigure} from './demo.mjs';
import {createStartupDocument} from './startup-document.mjs';
import {editorSelectionMethods} from './editor-selection.mjs';
import {editorLayerMethods} from './editor-layers.mjs';
import {editorLayerFocusMethods} from './editor-layer-focus.mjs';
import {validateLayerState} from './layers.mjs';
import {editorAnimationMethods} from './editor-animation.mjs';
import {validateAnimationDocument, animationEndTick} from './animation-channels.mjs';
import {editorFrameMethods, validateFrameIdentities} from './editor-frames.mjs';
import {invalidateFrameIndex} from './frame-ids.mjs';
import {editorVfxMethods} from './editor-vfx.mjs';
import {editorHandleCommandMethods} from './editor-handle-commands.mjs';
import {prepareLoad, prepareLoadNow} from './engine/engine-open.mjs';
import {editorMovieclipMethods} from './editor-movieclips.mjs';
import {editorLayerSheetMethods} from './editor-layer-sheet.mjs';
import {validateLayerSheet} from './layer-sheet.mjs';
import {editorDrawingMethods} from './editor-drawing.mjs';
import {DrawingResources,drawingResourcesFor} from './drawing-resources.mjs';
import {editorSessionMethods} from './editor-sessions.mjs';

const clone = value => structuredClone(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, label) => { if (!Number.isFinite(value)) throw messageError(new Error(''), "errors.editorCamera.mustBeFinite", {label: validationLabel(label)}); return value; };
function initialLoadState(report,{initialFrameIndex=0,initialTick}={}){
  let frameIndex=initialFrameIndex==='last'?report.keyframes.length-1:clamp(Math.trunc(finite(initialFrameIndex,'Initial frame')),0,report.keyframes.length-1);
  if(initialTick!==undefined)finite(initialTick,'Initial tick');
  const rows=timeline(report),last=rows.at(-1),total=last?last.start+last.count:0;
  const tick=initialTick===undefined?rows[frameIndex]?.start??0:clamp(initialTick,0,Math.max(0,total-1));
  if(initialTick!==undefined){let low=0,high=rows.length-1;while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=tick)low=mid;else high=mid-1;}frameIndex=low;}
  return {frameIndex,tick,timeline:rows,animation:report._styk?.animation};
}
const event = detail => {
  if (typeof CustomEvent !== 'undefined') return new CustomEvent('change', {detail});
  const result = new Event('change'); Object.defineProperty(result, 'detail', {value: detail}); return result;
};

/**
 * The interface's view of the open document: its records as the engine session last published them (the engine owner patches
 * them copy-on-write, engine-owner.mjs), and what the interface moves itself: the selection, the playhead, the active layer
 * and the layer focus. Every edit is a call the session runs (SESSION_COMMANDS, docs/engine/editing.md): the editor holds no
 * body of one, only the views, the document's load and the history stacks the owner mirrors.
 */
export class Editor extends EventTarget {
  constructor({demo = true, historyLimit = 80, historyBytes = 48 * 1024 * 1024, propertyChannels = false, layerTimeline = false} = {}) {
    super(); this.historyLimit = historyLimit; this.historyBytes = historyBytes; this.propertyChannels = propertyChannels;
    this.layerTimeline=layerTimeline;
    this._undo = []; this._redo = []; this._nextUid = 1;
    this._revision = 0; this._savedRevision = 0; this._revisionSerial = 0;
    this.load(demo ? createDemo() : emptyDocument());
  }
  get frame() { return this._authoredPoseEdit?.frame ?? this.report.keyframes[this.frameIndex]; }
  get selectionFrame() { return this._authoredPoseEdit?.frame ?? this.evaluatedFrame; }
  get selectedUid() {
    if (!this.selectedUids?.has(this._selectedUid)) this._selectedUid = [...(this.selectedUids ?? [])].at(-1) ?? null;
    return this._selectedUid;
  }
  get selectedPolygonIndex() {
    const selection = this._polygonSelection;
    if (!selection || selection.uid !== this.selectedUid || this.selectedJoint >= 0 || selection.typeId !== this.figure?.figure_type_id) return -1;
    const polygons = this.figure.polyfills ?? [];
    return selection.id === undefined ? (polygons[selection.index] ? selection.index : -1) : polygons.findIndex(polygon => polygon.polyfill_id === selection.id);
  }
  get selectedSegmentIds() {
    const id = this.figure?.segments[this.selectedJoint]?.segment_id;
    if (id === undefined) return new Set();
    const selection = this._segmentSelection;
    return selection?.uid === this.selectedUid && selection.active === id ? selection.ids : new Set([id]);
  }
  get branchSelected() { return Boolean(this._branchSelection && this._branchSelection.uid === this.selectedUid && this._branchSelection.joint === this.selectedJoint && this.selectedJoint >= 0); }
  set selectedUid(uid) { this._polygonSelection = null; this._segmentSelection = null; this._branchSelection = null; this._selectedUid = uid ?? null; this.selectedUids = new Set(uid === null || uid === undefined ? [] : [uid]); }
  // With nothing selected there is nothing to look up: the frame on show is not built for it (the library reads this on every tick of playback).
  get selectedObjects() { return this.selectedUids?.size ? this.selectionFrame?.objects.filter(o => this.selectedUids.has(o.unique_id)) ?? [] : []; }
  get object() { return this.selectionFrame?.objects.find(o => o.unique_id === this.selectedUid) ?? this.selectedObjects.at(-1) ?? null; }
  get figure() { const typeId = this.object?.figure_type_id; return this.report.figure_types.find(f => f.figure_type_id === typeId) ?? null; }
  get selectedSlot() { return this.selectionFrame?.objects.findIndex(o => o.unique_id === this.selectedUid) ?? -1; }
  get timeline() {
    const animation = this.report._styk?.animation;
    const animationEnd = animation === this._timelineAnimation && this._timelineEndTick !== undefined ? this._timelineEndTick : animationEndTick({_styk:{animation}});
    if (this._timeline && this._timelineEndTick === animationEnd) { this._timelineAnimation = animation; return this._timeline; }
    this._timelineAnimation = animation; this._timelineEndTick = animationEnd;
    return this._timeline = this._shown.timeline();
  }
  get totalTicks() { const last = this.timeline.at(-1); return last ? last.start + last.count : 0; }
  get evaluatedFrame() {
    if(this._sheetPropertyPreview)return this._sheetPropertyPreview;
    if (this._authoredPoseEdit) return this._authoredPoseEdit.frame;
    return this._evaluated ??= this._shown.frame();
  }
  /** The document's frame at the playhead, under any gesture the engine holds: the frame a draft is composed on. */
  _documentFrame() { return this._evaluated ??= this._shown.documentFrame(); }
  get geometry() { return this._geometry ??= this._shown.geometry(this.evaluatedFrame); }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  get undoLabel() { return this._undo.at(-1)?.label ?? ''; }
  get redoLabel() { return this._redo.at(-1)?.label ?? ''; }
  get dirty() { return this._revision !== this._savedRevision || Boolean(this._drag?.changed || this._animationEdit?.changed) || Boolean(this._movieclipScopes?.some(scope=>scope.parent._revision!==scope.parent._savedRevision)); }
  set dirty(value) {
    if (value) { if (!this.dirty) this._revision = ++this._revisionSerial; this._emit('edit', {label: 'Project metadata'}); }
    else { this._savedRevision = this._revision; this._emit('saved'); }
  }
  get dragging() { return Boolean(this._drag); }
  get drawingResources() { return drawingResourcesFor(this.report) ?? new DrawingResources(this.report, {onPublished: figure => this._drawingPublished(figure)}); }
  get revision() { return this._revision; }
  get definitionRevision() { return this._definitionRevision ?? 0; }
  get layers() { return this.getLayers(); }
  get layerRevision() { return this._layerRevision ?? 0; }
  get activeLayerId() { return this.report?._styk?.layers?.activeId ?? this.report?._styk?.layers?.defaultLayerId ?? 'layer-1'; }
  set activeLayerId(id) { this.setActiveLayer(id); }

  _emit(kind, detail = {}) {
    if(kind==='document')this.clearLayerFocus({notify:false});
    else if(detail.layers||detail.structural||kind==='history')this.reconcileLayerFocus();
    if(kind==='seek')this._followSheetSelection();
    if(kind==='selection'&&!detail.sheetSelection)this._sheetSelection=null;
    if (kind === 'document' || detail.definition || (detail.structural && !detail.layerSheet)) this._definitionRevision = this.definitionRevision + 1;
    if (this._layerEventPending && ['edit', 'history', 'document'].includes(kind)) {
      detail = {layers: true, layerRevision: this.layerRevision, ...detail}; this._layerEventPending = false;
    }
    this.dispatchEvent(event({kind, frameIndex: this.frameIndex, tick: this.tick,
      structural: false, timing: false, ...detail}));
  }
  _invalidate({timing = false} = {}) {
    this._geometry = null; this._evaluated = null;
    if (timing) this._timeline = null;
  }
  _selectionState() { return {frameIndex: this.frameIndex, tick: this.tick, uid: this.selectedUid, uids: [...this.selectedUids], joint: this.selectedJoint, activeLayerId: this.activeLayerId, sheetSelection:this._sheetSelection?{...this._sheetSelection}:null, ...(this.selectedPolygonIndex >= 0 ? {polygonSelection:{...this._polygonSelection}} : {}), ...(this._segmentSelection && this.selectedSegmentIds.size > 1 ? {segmentIds:[...this.selectedSegmentIds]} : {}), ...(this.branchSelected ? {branch: {...this._branchSelection}} : {})}; }
  _restoreSelection(state) {
    const frameIndex = clamp(state.frameIndex, 0, this.report.keyframes.length - 1), tick = clamp(state.tick, 0, Math.max(0, this.totalTicks - 1));
    // The frame on show is cached for the playhead: moving the playhead must not read the old one.
    if (frameIndex !== this.frameIndex || tick !== this.tick) { this.frameIndex = frameIndex; this.tick = tick; this._invalidate(); }
    const existing = new Set((this.selectionFrame?.objects ?? []).filter(o=>!this.isFigureFocusLocked(o.unique_id)).map(o => o.unique_id));
    this.selectedUid = existing.has(state.uid) ? state.uid : null;
    this.selectedUids = new Set((state.uids ?? [state.uid]).filter(uid => existing.has(uid)));
    if (!this.selectedUids.has(this.selectedUid)) this._selectedUid = [...this.selectedUids].at(-1) ?? null;
    this.selectedJoint = this.selectedUid === null ? -1 : state.joint;
    this._branchSelection = state.branch ? {...state.branch} : null;
    this._polygonSelection = state.polygonSelection ? {...state.polygonSelection} : null;
    const active = this.figure?.segments[this.selectedJoint]?.segment_id;
    const valid = new Set(this.figure?.segments.map(segment => segment.segment_id) ?? []);
    const ids = new Set((state.segmentIds ?? []).filter(id => valid.has(id)));
    this._segmentSelection = ids.size > 1 && ids.has(active) ? {uid:this.selectedUid,active,ids} : null;
    const layers = this.report._styk?.layers;
    if (layers) layers.activeId = this.getLayer(state.activeLayerId) ? state.activeLayerId : layers.defaultLayerId;
    this._sheetSelection=state.sheetSelection&&!this.isLayerFocusLocked(state.sheetSelection.id)?{...state.sheetSelection}:null;
  }
  /** The history entry the next undo (or redo) applies, as far as its pixels go: what `DrawingHistory` loads and the drawing store prepares first. */
  historyPixels(direction) {return (direction==='undo'?this._undo:this._redo).at(-1);}
  markSaved() { this._savedRevision = this._revision; this._emit('saved'); }

  newDocument(options) {
    return this.load(createStartupDocument(),'Untitled animation',options);
  }
  load(document, name, options = {}) {
    this._loadRequestId = (this._loadRequestId ?? 0) + 1;
    return this._publishLoadedReport(prepareLoadNow(document, {layerTimeline: this.layerTimeline}), name, options);
  }
  async loadAsync(document, name, options = {}) {
    const report = document?.document ?? document?.report ?? document;
    if (report === this.report) throw messageError(new Error(''), "errors.editor.asynchronousImportRequiresASeparateIncomingDocument", {});
    const request = this._loadRequestId = (this._loadRequestId ?? 0) + 1;
    if(name!==undefined&&name!==null&&typeof name!=='string')throw messageError(new Error(''), "errors.editor.theDocumentNameMustBeText", {});
    const token = this._documentToken, revision = this.revision, drag = this._drag, animationEdit = this._animationEdit;
    const checkCurrent = () => {
      if(options.signal?.aborted)throw messageError(new DOMException('', 'AbortError'), "errors.editorLoad.importCancelled", {});
      if (request !== this._loadRequestId || token !== this._documentToken || revision !== this.revision ||
          drag !== this._drag || animationEdit !== this._animationEdit || this._drag?.changed || this._animationEdit?.changed)
        throw messageError(new DOMException('', 'AbortError'), "errors.editor.theDocumentChangedWhileImporting", {});
    };
    const prepared = await prepareLoad(document,{...options,layerTimeline:this.layerTimeline,checkCurrent});
    checkCurrent();
    return this._publishLoadedReport(prepared, name, options);
  }
  _publishLoadedReport(prepared, name, {initialFrameIndex=0, initialTick, preserveDrawingResources=false, onDetach} = {}) {
    const {report} = prepared;
    if (name !== undefined && name !== null && typeof name !== 'string') throw messageError(new Error(''), "errors.editor.theDocumentNameMustBeText", {});
    const initial=initialLoadState(report,{initialFrameIndex,initialTick}),index=initial.frameIndex;
    const started = performance.now();
    // The open document stays open beside the loaded one (editor-sessions.mjs): its owner receives it whole.
    if(onDetach)this.handOverDocument(onDetach);
    if(!preserveDrawingResources){drawingResourcesFor(this.report)?.dispose();for(const scope of this._movieclipScopes??[])drawingResourcesFor(scope.parent.report)?.dispose();}
    this._vfxClipEdit=null;this._selectedVfxClip=null;this._selectedVfxKey=null;
    this._movieclipScopes=[];
    this._sheetSelection=null;this._sheetPropertyPreview=null;
    // The engine opened the document: its layer sheet is in it, and the session that edits it is started from the opening.
    this._opening?.dispose();this._opening=prepared.opening??null;
    this.report = report; this.name = name?.replace(/\.(piv|stk|styk)$/i, '') || report._styk?.name || 'Untitled animation';
    this._documentToken = {};
    this.frameIndex = index; this.tick = 0; this.selectedUid = report.keyframes[index].objects[0]?.unique_id ?? null; this.selectedJoint = -1;
    this._undo = []; this._redo = []; this._drag = null;
    this._animationEdit = null; this._authoredPoseEdit = null;
    this._revision = this._savedRevision = ++this._revisionSerial;
    this._nextUid = prepared.nextUid; this._nextFrameIdentity = prepared.nextFrameIdentity;
    this._layerUidCounts = prepared.layerUidCounts; this._layerSeenUids = prepared.layerSeenUids; this._layerGroups = prepared.layerGroups;
    this._layerRevision = (this._layerRevision ?? 0) + 1; this._layerDescriptors = null; this._layerUidArrays = new Map();
    this._invalidate({timing: true}); invalidateFrameIndex(report);
    this.tick=initial.tick;this._timeline=initial.timeline;this._timelineAnimation=initial.animation;this._timelineEndTick=animationEndTick({_styk:{animation:initial.animation}});
    const published = performance.now();
    this._emit('document', {structural: true, timing: true, prepared: true});
    this.lastLoadTimings = {...prepared.timings, publishMs:published-started, listenersMs:performance.now()-published, commitMs:performance.now()-started};
    return this;
  }
  select(uid, joint = -1, {toggle = false, add = false} = {}) {
    if(uid!=null&&this.isFigureFocusLocked(uid)&&this.selectionFrame.objects.some(object=>object.unique_id===uid))return this.object;
    if (this.branchSelected && uid === this.selectedUid && joint === this.selectedJoint && !toggle && !add) return this.object;
    this._polygonSelection = null;
    this._segmentSelection = null;
    this._branchSelection = null;
    if (joint && typeof joint === 'object') return this.select(uid, -1, joint);
    const valid = this.selectionFrame.objects.some(o => o.unique_id === uid);
    if(valid&&this.report._styk?.layerSheet)this.report._styk.layers.activeId=this.layerForUid(uid);
    if (!valid) this.selectedUid = null;
    else if (toggle || add) {
      if (toggle && this.selectedUids.has(uid)) this.selectedUids.delete(uid); else this.selectedUids.add(uid);
      this._selectedUid = this.selectedUids.has(uid) ? uid : [...this.selectedUids].at(-1) ?? null;
    } else this.selectedUid = uid;
    this.selectedJoint = this.selectedUids.size === 1 ? joint : -1;
    this._emit('selection'); return this.object;
  }
  selectMany(uids) {
    this._branchSelection = null;
    const existing = new Set(this.selectionFrame.objects.filter(o=>!this.isFigureFocusLocked(o.unique_id)).map(o => o.unique_id));
    this.selectedUids = new Set([...uids].filter(uid => existing.has(uid)));
    this._selectedUid = [...this.selectedUids].at(-1) ?? null; this.selectedJoint = -1;
    this._emit('selection'); return this.selectedObjects;
  }
  selectFrame(index) {
    if (this._drag) this.commitDrag();
    const next = clamp(Math.trunc(finite(index, 'Frame index')), 0, this.report.keyframes.length - 1);
    this.frameIndex = next;
    this.tick = this.timeline[this.frameIndex]?.start ?? 0;
    this.selectedJoint = -1; this._invalidate(); this._emit('seek'); return this.frame;
  }
  seek(tick, {evaluate = true, allowBeyondEnd = false} = {}) {
    this.commitVfxClipEdit();
    if (this._drag) this.commitDrag();
    const nextTick = clamp(finite(tick, 'Timeline tick'), 0, allowBeyondEnd ? 10000000 : Math.max(0, this.totalTicks - 1));
    let low = 0, high = this.timeline.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.timeline[mid].start <= nextTick) low = mid; else high = mid - 1; }
    this.tick = nextTick; this.frameIndex = low; this._invalidate(); this._emit('seek'); return evaluate ? this.evaluatedFrame : this.frame;
  }


  /** Translation uses complete connected components; posing uses selected subtrees. */
  resolveTranslationSelection(uids = this.selectedUids, {frame = this.selectionFrame} = {}) {
    return resolveJoinSelection(frame, uids, true);
  }
  _selectIds(uids) { this._branchSelection = null; this.selectedUids = new Set([...uids].filter(uid=>!this.isFigureFocusLocked(uid))); this._selectedUid = [...this.selectedUids].at(-1) ?? null; this.selectedJoint = -1; }
  _frameIndices(indices) {
    const result = [...new Set(indices ?? [this.frameIndex])].sort((a, b) => a - b);
    if (result.some(i => !Number.isInteger(i) || i < 0 || i >= this.report.keyframes.length)) throw messageError(new Error(''), "errors.editor.selectExistingKeyframes", {});
    return result;
  }
  serialize() {
    const document = clone(this.report); document._styk = {...document._styk, format: 'StykAnimate', format_version: 1, name: this.name};
    for (const frame of document.keyframes) for (const object of frame.objects) delete object.runtime_segments;
    syncDerived(document); validateScene(document); validateLayerState(document._styk.layers); validateAnimationDocument(document); validateFrameIdentities(document); validateLayerSheet(document); return document;
  }
}

Object.assign(Editor.prototype, editorSpatialMethods);
Object.assign(Editor.prototype, editorSelectionMethods);
Object.assign(Editor.prototype, editorLayerMethods);
Object.defineProperties(Editor.prototype, Object.getOwnPropertyDescriptors(editorLayerFocusMethods));
Object.defineProperties(Editor.prototype, Object.getOwnPropertyDescriptors(editorAnimationMethods));
Object.assign(Editor.prototype, editorFrameMethods);
Object.assign(Editor.prototype, editorMovieclipMethods);
Object.assign(Editor.prototype, editorLayerSheetMethods);
Object.assign(Editor.prototype, editorDrawingMethods);
Object.assign(Editor.prototype, editorVfxMethods);
Object.assign(Editor.prototype, editorHandleCommandMethods);
Object.assign(Editor.prototype, editorSessionMethods);
export {createDemo, emptyDocument, defaultFigure};
