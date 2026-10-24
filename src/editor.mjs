import {validationLabel} from "./validation-labels.mjs";
import {messageError} from './localized-error.mjs';
import {editorSpatialMethods,spatialBone,spatialSkin} from './editor-spatial.mjs';
import {resolveInstanceFigure} from './animation-style.mjs';
import {remapSurface,surfaceHandles,protectSurfaceReferences} from './pivot/surfaces.mjs';
import {UserActionError} from './user-action-error.mjs';
import {editorRigConstraintMethods} from './editor-rig-constraints.mjs';
import {editorColorMethods, applyPaletteCommand} from './editor-colors.mjs';
import {editorVfxClipMethods} from './editor-vfx-clips.mjs';
import {invalidateVfxRenderFrame, figureVfxClips} from './vfx-clips.mjs';
import {editorCameraMotionMethods} from './editor-camera-motion.mjs';
import {authoredRigTarget,hasRigConstraints} from './rig-constraints.mjs';
import {editorTweenerMethods} from './editor-tweener.mjs';
import {buildGeometry, buildGeometryAsync, evaluatedFrame, timeline, shortest, isStatic, invalidateEvaluationCaches} from './pivot/geometry.mjs';
import {validateScene, validateObjectChanges, syncDerived} from './pivot/model.mjs';
import {normalizeFrame, frameOrder, setOrder, deleteObject, moveLayer as reorderLayer, rotationEdits, resolveJoinSelection} from './pivot/structure.mjs';
import {createDemo, emptyDocument, createObject, createFrame, defaultFigure} from './demo.mjs';
import {createStartupDocument} from './startup-document.mjs';
import {editorRangeMethods} from './editor-ranges.mjs';
import {applyFrameTiming,captureTimingGeometry,restoreTimingGeometry} from './frame-timing-history.mjs';
import {RetainedGeometryCache} from './playback-geometry-cache.mjs';
import {editorBuilderMethods, segmentBranchIndices} from './editor-builder.mjs';
import {editorCombineMethods} from './editor-combine.mjs';
import {editorDisconnectMethods, applyDisconnectFrames} from './editor-disconnect.mjs';
import {editorRigMethods} from './editor-rig.mjs';
import {editorSelectionMethods} from './editor-selection.mjs';
import {editorLayerMethods} from './editor-layers.mjs';
import {editorLayerFolderMethods} from './editor-layer-folders.mjs';
import {editorLayerFocusMethods} from './editor-layer-focus.mjs';
import {editorLayerAsyncMethods} from './editor-layer-async.mjs';
import {ensureLayerState, validateLayerState, layerLocked} from './layers.mjs';
import {editorAnimationMethods} from './editor-animation.mjs';
import {validateAnimationDocument, animationEndTick} from './animation-channels.mjs';
import {editorFrameMethods, validateFrameIdentities} from './editor-frames.mjs';
import {editorFrameClipboardMethods} from './editor-frame-clipboard.mjs';
import {invalidateFrameIndex} from './frame-ids.mjs';
import {editorAuthoredPoseMethods} from './editor-authored-pose.mjs';
import {applyNativePropertyCommand} from './native-property-edit.mjs';
import {editorCameraMethods} from './editor-camera.mjs';
import {editorHandleEditMethods} from './editor-handle-edit.mjs';
import {editorFigureTransformMethods} from './editor-figure-transform.mjs';
import {editorDuplicateDragMethods} from './editor-duplicate-drag.mjs';
import {editorRangeCommandMethods} from './editor-range-commands.mjs';
import {editorSceneMethods} from './editor-scene.mjs';
import {editorVfxMethods} from './editor-vfx.mjs';
import {remapVfxOwner} from './vfx.mjs';
import {editorHandleCommandMethods} from './editor-handle-commands.mjs';
import {editorInbetweenMethods} from './editor-inbetween.mjs';
import {editorFrameDraftMethods, validateSimpleFrameDraft, installFrameDraftPreflights} from './editor-frame-draft.mjs';
import {repairTopologyStyles, topologyAnimationPatch, reverseGradientEndpoints} from './editor-style-topology.mjs';
import {prepareEditorLoad} from './editor-load.mjs';
import {prepareLoad, prepareLoadNow} from './engine/engine-open.mjs';
import {editorInbetweenAsyncMethods} from './editor-inbetween-async.mjs';
import {editorOriginMutationMethods,originGeometryChanged} from './editor-origin-mutations.mjs';
import {invalidateAnimationOriginLayout,animationOriginOffset,animationRotation,reflectAnimationOriginOffset} from './animation-origin.mjs';
import {repairOriginSupport} from './editor-origin-support.mjs';
import {rotateOriginSupport,mirrorOriginSupport,resetOriginSupport} from './animation-origin-support.mjs';
import {applySparseClipboardFrames} from './editor-clipboard-sparse.mjs';
import {animationHistoryBytes} from './animation-history.mjs';
import {editorIKMethods} from './editor-ik.mjs';
import {editorMovieclipMethods, applyMovieclipCommand} from './editor-movieclips.mjs';
import {editorLayerSheetMethods, applyLayerSheetCommand} from './editor-layer-sheet.mjs';
import {validateLayerSheet} from './layer-sheet.mjs';
import {isMovieclip, invalidateMovieclipTypes,movieclipSourceFrames,snapshotFigureDefinition} from './movieclips.mjs';
import {hasPinnedIK, translateIKTargets, remapIKFollowers, ikChain} from './ik.mjs';
import {editorMotionPathMethods} from './editor-motion-path.mjs';
import {snapshotPoseObject} from './pose-snapshot.mjs';
import {cloneTopologySnapshot,topologyHistoryBytes} from './topology-history.mjs';
import {presencePlayback} from './movieclip-presence.mjs';
import {editorAudioMethods, applyAudioCommand} from './editor-audio.mjs';
import {editorDrawingMethods,applyDrawingCommand} from './editor-drawing.mjs';
import {DrawingResources,drawingResourcesFor} from './drawing-resources.mjs';
import {editorSessionMethods} from './editor-sessions.mjs';

const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rangeReportCopies = new WeakMap();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, label) => { if (!Number.isFinite(value)) throw messageError(new Error(''), "errors.editorCamera.mustBeFinite", {label: validationLabel(label)}); return value; };
function initialLoadState(report,{initialFrameIndex=0,initialTick}={},draftEnabled=false){
  let frameIndex=initialFrameIndex==='last'?report.keyframes.length-1:clamp(Math.trunc(finite(initialFrameIndex,'Initial frame')),0,report.keyframes.length-1);
  if(initialTick!==undefined)finite(initialTick,'Initial tick');
  const draft=draftEnabled?report._styk?.simpleFrameDraft:null;
  const draftIndex=draft?.mode==='add'&&draft.baseline?draft.index:-1,draftDuration=draftIndex>=0?draft.baseline.duration_raw:undefined;
  let source=draftIndex>=0&&draftDuration!==report.keyframes[draftIndex]?.duration_raw?
    {...report,keyframes:report.keyframes.map((frame,index)=>index===draftIndex?{...frame,duration_raw:draftDuration}:frame)}:report;
  if(draftIndex>=0&&Object.hasOwn(draft,'animationBaseline'))source={...source,_styk:{...source._styk,animation:draft.animationBaseline}};
  const rows=draft?.empty?[]:timeline(source),last=rows.at(-1),total=last?last.start+last.count:0;
  let tick=initialTick===undefined?rows[frameIndex]?.start??0:clamp(initialTick,0,Math.max(0,total-1));
  if(initialTick!==undefined){let low=0,high=rows.length-1;while(low<high){const mid=Math.ceil((low+high)/2);if(rows[mid].start<=tick)low=mid;else high=mid-1;}frameIndex=low;}
  // Simple restores this saved working frame during the document event. Prepare
  // the same target so that no earlier or incomplete scene can become visible.
  if(draft){frameIndex=draft.index;tick=rows[frameIndex]?.start??0;}
  return {frameIndex,tick,timeline:rows,draftIndex,draftDuration,draftAnimation:source._styk?.animation};
}
const event = detail => {
  if (typeof CustomEvent !== 'undefined') return new CustomEvent('change', {detail});
  const result = new Event('change'); Object.defineProperty(result, 'detail', {value: detail}); return result;
};

/**
 * Mutable native Pivot document + bounded command history. Pointer moves mutate
 * only active objects; a drag creates one history entry. Keyframe/timeline/geometry
 * caches are invalidated independently, avoiding whole-project work while posing.
 */
export class Editor extends EventTarget {
  constructor({demo = true, historyLimit = 80, historyBytes = 48 * 1024 * 1024, propertyChannels = false, layerTimeline = false} = {}) {
    super(); this.historyLimit = historyLimit; this.historyBytes = historyBytes; this.propertyChannels = propertyChannels;
    this.layerTimeline=layerTimeline;
    this._undo = []; this._redo = []; this._historySize = 0; this._nextUid = 1;
    this._revision = 0; this._savedRevision = 0; this._revisionSerial = 0;
    this.load(demo ? createDemo() : emptyDocument());
  }
  get frame() { return this._authoredPoseEdit?.frame ?? this.report.keyframes[this.frameIndex]; }
  get selectionFrame() { return this._authoredPoseEdit?.frame ?? (this.report._styk?.layerSheet || this.animationChannels.length ? this.evaluatedFrame : this.frame); }
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
  get selectedObjects() { return this.selectionFrame?.objects.filter(o => this.selectedUids?.has(o.unique_id)) ?? []; }
  get object() { return this.selectionFrame?.objects.find(o => o.unique_id === this.selectedUid) ?? this.selectedObjects.at(-1) ?? null; }
  get figure() { const typeId = this.object?.figure_type_id; return this.report.figure_types.find(f => f.figure_type_id === typeId) ?? null; }
  get selectedSlot() { return this.selectionFrame?.objects.findIndex(o => o.unique_id === this.selectedUid) ?? -1; }
  get timeline() {
    const draft = this._frameDraftEnabled ? this.report._styk?.simpleFrameDraft : null;
    if (draft?.empty) return this._emptyTimeline ??= [];
    const index = draft?.mode === 'add' && draft.baseline ? draft.index : -1;
    const duration = index >= 0 ? draft.baseline.duration_raw : undefined;
    const animation = index >= 0 && Object.hasOwn(draft, 'animationBaseline') ? draft.animationBaseline : this.report._styk?.animation;
    const animationEnd = animation === this._timelineDraftAnimation && this._timelineDraftEndTick !== undefined ? this._timelineDraftEndTick : animationEndTick({_styk:{animation}});
    if (this._timeline && this._timelineDraftIndex === index && this._timelineDraftDuration === duration && this._timelineDraftEndTick === animationEnd) {
      this._timelineDraftAnimation = animation; return this._timeline;
    }
    this._timelineDraftIndex = index; this._timelineDraftDuration = duration;
    this._timelineDraftAnimation = animation;
    this._timelineDraftEndTick = animationEnd;
    let report = index >= 0 && duration !== this.report.keyframes[index]?.duration_raw
      ? {...this.report, keyframes:this.report.keyframes.map((frame, i) => i === index ? {...frame, duration_raw:duration} : frame)} : this.report;
    if (animation !== report._styk?.animation) report = {...report, _styk: {...report._styk, animation}};
    return this._timeline = timeline(report);
  }
  get totalTicks() { const last = this.timeline.at(-1); return last ? last.start + last.count : 0; }
  get evaluatedFrame() {
    if(this._sheetPropertyPreview)return this._sheetPropertyPreview;
    if (this._authoredPoseEdit) return this._authoredPoseEdit.frame;
    const entry = this.timeline[this.frameIndex];
    const t = entry?.count > 1 ? (this.tick - entry.start) / entry.count : 0;
    return this._evaluated ??= evaluatedFrame(this.report, this.frameIndex, clamp(t, 0, 1), this.tick);
  }
  get geometry() {
    const retained=this._seekGeometry??=new RetainedGeometryCache();
    if(this._retainGeometryRevision){retained.retainRevision(this.revision);this._retainGeometryRevision=false;}
    if (!this._geometry) {
      this._geometry = this._incremental?buildGeometry(this.report, this.evaluatedFrame, this._incremental)
        :retained.get(this.report,this.evaluatedFrame,this.revision);
      this._incremental = null;
    }
    if(retained.geometry!==this._geometry)retained.adopt(this.report,this.evaluatedFrame,this.revision,this._geometry);
    return this._geometry;
  }
  get canUndo() { return this._undo.length > 0; }
  /** Prepare the exact current pose cooperatively; publishing stale geometry is
   * forbidden even if an input handler synchronously materializes it meanwhile. */
  async prepareGeometry(options={}) {
    if(this._geometry)return this.geometry;
    const report=this.report,revision=this.revision,tick=this.tick,frame=this.evaluatedFrame,incremental=this._incremental,evaluated=this._evaluated,authored=this._authoredPoseEdit;
    const checkCurrent=()=>!this._geometry&&this.report===report&&this.revision===revision&&this.tick===tick&&
      this._evaluated===evaluated&&this._authoredPoseEdit===authored&&this._incremental===incremental&&options.checkCurrent?.()!==false;
    const retained=this._seekGeometry??=new RetainedGeometryCache();
    if(this._retainGeometryRevision){retained.retainRevision(this.revision);this._retainGeometryRevision=false;}
    const settings={...options,checkCurrent};
    const geometry=incremental?await buildGeometryAsync(report,frame,incremental,settings):await retained.getAsync(report,frame,revision,settings);
    if(!checkCurrent())throw messageError(new DOMException('', 'AbortError'), "errors.editor.editableGeometryWasSuperseded", {});
    this._geometry=geometry;this._incremental=null;
    if(retained.geometry!==geometry)retained.adopt(report,frame,revision,geometry);
    return geometry;
  }
  get canRedo() { return this._redo.length > 0; }
  get undoLabel() { return this._undo.at(-1)?.label ?? ''; }
  get redoLabel() { return this._redo.at(-1)?.label ?? ''; }
  get dirty() { return this._revision !== this._savedRevision || Boolean(this._drag?.changed || this._animationEdit?.changed) || Boolean(this._movieclipScopes?.some(scope=>scope.parent._revision!==scope.parent._savedRevision)); }
  set dirty(value) {
    if (value) { if (!this.dirty) this._revision = ++this._revisionSerial; this._emit('edit', {label: 'Project metadata'}); }
    else { this._savedRevision = this._revision; this._emit('saved'); }
  }
  get dragging() { return Boolean(this._drag); }
  get historySize() { return this._historySize; }
  get drawingResources() { return drawingResourcesFor(this.report) ?? new DrawingResources(this.report, {onPublished: figure => this._drawingPublished(figure)}); }
  get revision() { return this._revision; }
  get definitionRevision() { return this._definitionRevision ?? 0; }
  get layers() { return this.getLayers(); }
  get layerRevision() { return this._layerRevision ?? 0; }
  get activeLayerId() { return this.report?._styk?.layers?.activeId ?? this.report?._styk?.layers?.defaultLayerId ?? 'layer-1'; }
  set activeLayerId(id) { this.setActiveLayer(id); }
  get hasFrameClipboard() { return Boolean(this._frameClipboard?.length); }
  get clipboardFrameCount() { return this._frameClipboard?.length ?? 0; }
  get hasFigureClipboard() { return Boolean(this._figureClipboard || this._selectionClipboard); }

  _emit(kind, detail = {}) {
    if(kind==='document')this.clearLayerFocus({notify:false});
    else if(detail.layers||detail.structural||kind==='history')this.reconcileLayerFocus();
    if(kind==='seek')this._followSheetSelection();
    if(kind==='selection'&&!detail.sheetSelection)this._sheetSelection=null;
    if(detail.structural&&kind!=='document'){this._loadedFigureNames=null;this._loadedTimelineTracks=null;}
    if (kind === 'document' || detail.definition || (detail.structural && !detail.layerSheet)) this._definitionRevision = this.definitionRevision + 1;
    if (this._layerEventPending && ['edit', 'history', 'document'].includes(kind)) {
      detail = {layers: true, layerRevision: this.layerRevision, ...detail}; this._layerEventPending = false;
    }
    this.dispatchEvent(event({kind, frameIndex: this.frameIndex, tick: this.tick,
      structural: false, timing: false, ...detail}));
  }
  _invalidate({timing = false, viewOnly = false, retainGeometry = false, retainPropertyMarkers = false} = {}) {
    // Authored gesture drafts mutate in place; their composed VFX view must
    // follow each pose change even while the clip records stay unchanged.
    if(!viewOnly)invalidateVfxRenderFrame(this._authoredPoseEdit?.frame);
    if(!viewOnly)this._retainGeometryRevision=retainGeometry;
    if (!viewOnly && retainPropertyMarkers && this._propertyChannelCache) {
      this._propertyChannelCache.frames.clear();this._propertyChannelCache.values.clear();this._propertyChannelCache.dependencies.clear();
      this._propertyChannelCache.indices=new WeakMap();this._propertyChannelCache.coordinates=new WeakMap();
    } else if (!viewOnly) this._propertyChannelCache = null;
    if (!viewOnly) {invalidateEvaluationCaches(this.report,{retainGeometry});if(!retainGeometry)this._seekGeometry?.clear();}
    const preview = this._authoredCommitPreview;
    this._geometry = preview?.geometry ?? null; this._evaluated = preview?.frame ?? null; this._incremental = preview?.incremental ?? null;
    if (timing) this._timeline = null;
  }
  /** Keep the last published scene across object edits, including edits queued
   * before the next render. Join descendants depend on their parent's pose. */
  _invalidateObjects(uids, retained = null, {translation = false, pose = false} = {}) {
    const previous = retained?.previous ?? this._geometry ?? this._incremental?.previous;
    const pending = retained?.dirtySlots ?? (this._geometry ? [] : this._incremental?.dirtySlots ?? []);
    const affected=this._ikPoseSlots(this.frame, resolveJoinSelection(this.frame, uids).affectedSlots);
    const dirtySlots = new Set([...pending, ...affected]), pendingSet=new Set(pending);
    const renderSources=new Map(this._geometry||retained?[]:this._incremental?.renderSources);
    const poseSlots=new Set(this._geometry||retained?[]:this._incremental?.poseSlots);
    for(const slot of affected){
      if(pose&&(!pendingSet.has(slot)||poseSlots.has(slot)))poseSlots.add(slot);else poseSlots.delete(slot);
      if(translation && previous && (this._geometry || !pendingSet.has(slot) || renderSources.has(slot))){
        const g=previous.objects.get(slot);if(g)renderSources.set(slot,g.renderSource||g);
      }else renderSources.delete(slot);
    }
    this._invalidate();
    if (previous) this._incremental = {previous, dirtySlots, renderSources, poseSlots};
  }
  /** Both locally computed and adopted live poses use the same rigid-move eligibility. */
  _invalidatePoseObjects(uids, {translation = false} = {}) {
    this._invalidateObjects(uids, null, {pose: true, translation: translation && !this.animationChannels.length && !this._drag?.before.some(o => o.runtime_segments || o._stykSpatial?.camera?.strength || hasPinnedIK(o))});
  }
  /** Definition edits invalidate every instance and joined dependent, retaining unrelated artwork. */
  _invalidateFigure(typeId, retained = null) {
    if (this.report._styk?.movieclipSource || this.report.figure_types.some(isMovieclip) || this.frame.objects.some(object => object._stykIK)) return this._invalidate();
    const prior = retained?.previous ?? this._geometry ?? this._incremental?.previous;
    if (prior && [...prior.objects].some(([slot,g]) => g && (g.obj._stykIK || g.obj.unique_id !== this.frame.objects[slot]?.unique_id))) return this._invalidate();
    const uids = this.frame.objects.filter(object => object.figure_type_id === typeId).map(object => object.unique_id);
    this._invalidateObjects(uids, retained);
  }
  _selectionState() { return {frameIndex: this.frameIndex, tick: this.tick, uid: this.selectedUid, uids: [...this.selectedUids], joint: this.selectedJoint, activeLayerId: this.activeLayerId, sheetSelection:this._sheetSelection?{...this._sheetSelection}:null, ...(this.selectedPolygonIndex >= 0 ? {polygonSelection:{...this._polygonSelection}} : {}), ...(this._segmentSelection && this.selectedSegmentIds.size > 1 ? {segmentIds:[...this.selectedSegmentIds]} : {}), ...(this.branchSelected ? {branch: {...this._branchSelection}} : {})}; }
  _restoreSelection(state) {
    const frameIndex = clamp(state.frameIndex, 0, this.report.keyframes.length - 1), tick = clamp(state.tick, 0, Math.max(0, this.totalTicks - 1));
    // The frame on show is cached for the playhead: moving the playhead must not read the old one.
    if (frameIndex !== this.frameIndex || tick !== this.tick) { this.frameIndex = frameIndex; this.tick = tick; this._invalidate({viewOnly: true}); }
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
  _record(command) {
    if (this._authoredPoseEdit?.transaction && (command.kind === 'import'||this.report._styk?.layerSheet&&command.kind==='project')) return;
    this._recordFrameDraft?.(command);
    if (this._authoredCommandLabel) command.label = this._authoredCommandLabel;
    if (this._pendingSourceLayerChanges?.length) {
      command.layerChanges = [...(command.layerChanges ?? []), ...this._pendingSourceLayerChanges]; this._pendingSourceLayerChanges = null; command.layers = true;
    }
    this._captureRemovedFrameSources(command);
    for (const change of command.frameSourceChanges ?? []) if (change.after?.exists && !change.before?.exists) this._generatedFrameSources.add(change.id);
    this._trackLayerCommand(command, 'after', {record: true});
    let collectSources = this._redo.length > 0;
    command.beforeRevision = this._revision; command.afterRevision = ++this._revisionSerial;
    this._revision = command.afterRevision;
    const sized = command.sourceBytes !== undefined && command.frameSourceChanges ? {...command, frameSourceChanges: command.frameSourceChanges.map(change => ({
      id: change.id, before: {exists: change.before.exists}, after: {exists: change.after.exists},
    }))} : command;
    command.bytes = (Number.isFinite(command.precomputedBytes) && command.precomputedBytes >= 0
      ? command.precomputedBytes : command.kind === 'animation' || command.draftAnimation
        ? animationHistoryBytes(sized) : command.kind === 'topology' ? topologyHistoryBytes(sized)
          : JSON.stringify(sized).length * 2 + (command.sourceBytes ?? 0)) + (this._pendingSourceBytes ?? 0);
    this._pendingSourceBytes = 0;
    if (this._movieclipBatch) {this._movieclipBatch.push(command); return;}
    drawingResourcesFor(this.report)?.history?.track(command,delta=>{
      if(this._undo.includes(command)||this._redo.includes(command)){this._historySize+=delta;this._trimHistory();}
    });
    this._historySize -= this._redo.reduce((bytes,entry)=>bytes+entry.bytes,0);
    this._historySize += command.bytes; this._undo.push(command); this._redo = [];
    this._trimHistory(collectSources);
  }
  _trimHistory(collectSources=false) {
    while (this._undo.length > this.historyLimit || (this._historySize > this.historyBytes && this._undo.length + this._redo.length > 1)) {
      // A failed background archive can restore RAM weight after commands
      // moved to redo. Retire the farthest future first once one undo remains.
      const retired=this._undo.length>1?this._undo:this._redo.length?this._redo:this._undo;
      this._historySize -= retired.shift().bytes;
      collectSources = true;
    }
    if (collectSources){this._pruneFrameSources();drawingResourcesFor(this.report)?.collectHistory([...this._undo,...this._redo]);}
  }
  _sourceFrame({index,sourceId,draft,sourceDepth=0}){
    let report=this.report;for(let depth=0;depth<sourceDepth;depth++)report=report._styk.movieclipSource.document;
    return draft?report._styk.simpleFrameDraft?.baseline:sourceId?report._styk.frameSources[sourceId]:report.keyframes[index];
  }
  _replaceObjects(index, objects, sourceId, draft = false,sourceDepth=0) {
    const frame = this._sourceFrame({index,sourceId,draft,sourceDepth});
    if (!frame && draft) return;
    const replacements = new Map(objects.map(o => [o.unique_id, snapshotPoseObject(o, {retainRuntime:true})]));
    for (let i = 0; i < frame.objects.length; i++) if (replacements.has(frame.objects[i].unique_id))
      frame.objects[i] = replacements.get(frame.objects[i].unique_id);
  }
  _applyCommand(command, direction, drawingPrepared) {
    if(applyDrawingCommand(this,command,direction,drawingPrepared))return;
    if(applyAudioCommand(this,command,direction))return;
    if(applyPaletteCommand(this,command,direction))return;
    if(applyLayerSheetCommand(this,command,direction))return;
    if (command.kind === 'movieclip-batch') {
      for (const child of direction === 'before' ? [...command.commands].reverse() : command.commands) this._applyCommand(child,direction,drawingPrepared);
      if(command.frameDraftJournal){this._prepareFrameDraftHistory(command,direction);this._applyFrameDraftHistory(command,direction);}
      if(command[`${direction}Selection`])this._restoreSelection(command[`${direction}Selection`]);
      this._revision=command[`${direction}Revision`];return;
    }
    if (applyMovieclipCommand(this,command,direction)) return;
    const timingGeometry=command.kind==='frame-timing'?captureTimingGeometry(this):null;
    const selection = command[`${direction}Selection`];
    const localObjects = command.kind === 'objects' && !command.structural && !command.timing &&
      !command.layerChanges && !command.layerAnimationPatch && !command.frameSourceChanges &&
      !this._frameDraftEnabled && !this.report._styk?.animation?.channels?.length;
    const retained = localObjects && command.index === this.frameIndex && selection?.frameIndex === this.frameIndex && selection.tick === this.tick
      ? {previous: this._geometry ?? this._incremental?.previous, dirtySlots: this._geometry ? [] : this._incremental?.dirtySlots ?? []} : null;
    this._prepareFrameDraftHistory?.(command, direction);
    const sparseClipboard = applySparseClipboardFrames(this, command, direction);
    // Animation commands publish immutable tables/channels; later edits copy the
    // touched channel. Replay must not copy every unrelated key in the project.
    const value = sparseClipboard ? undefined : ['animation','camera-motion','vfx-clips'].includes(command.kind) ? command[direction]
      : command.kind === 'topology' ? cloneTopologySnapshot(command[direction]) : clone(command[direction]);
    if (command.kind === 'frame') this.report.keyframes[command.index] = value;
    else if(command.kind==='frame-timing')applyFrameTiming(this,command,direction);
    else if (command.kind === 'objects') this._replaceObjects(command.index, value);
    else if (command.kind === 'native-properties') applyNativePropertyCommand(this, command, direction);
    else if (command.kind === 'camera') this._applyCameraSnapshot(value);
    else if(command.kind==='vfx-clips'){if(value==null)delete this.report._styk.vfxClips;else this.report._styk.vfxClips=value;}
    else if(command.kind==='camera-motion'){if(value==null)delete this.report._styk.cameraMotion;else this.report._styk.cameraMotion=value;}
    else if (command.kind === 'scene') this._applySceneSnapshot(value);
    else if (command.kind === 'figure-range') this._applyFigureRangeCommand(command, direction);
    else if (command.kind === 'disconnect') applyDisconnectFrames(this, command, direction);
    else if (command.kind === 'splice') {
      if (!sparseClipboard) {
        const previous = command[direction === 'before' ? 'after' : 'before'];
        this.report.keyframes.splice(command.index, previous.length, ...value);
      }
    } else if (command.kind === 'animation') {
      this.report._styk ??= {};
      if (value == null) delete this.report._styk.animation; else this.report._styk.animation = value;
    } else if (command.kind === 'fields') Object.assign(this.report, value);
    else if (command.kind === 'figure') this.report.figure_types[command.index] = value;
    else if (command.kind === 'import') {
      this.report.figure_types = value.figures;
      this.report.keyframes[command.index] = value.frame;
    } else if (command.kind === 'figure-splice') {
      const previous = command[direction === 'before' ? 'after' : 'before'];
      this.report.figure_types.splice(command.figureIndex, previous.figures.length, ...value.figures);
      this.report.keyframes[command.index] = value.frame;
    } else if (command.kind === 'topology') {
      if (command.appendCount !== undefined) value.figure.segments = [...this.report.figure_types[command.index].segments.slice(0, command.appendCount), ...value.figure.segments];
      if (command.segmentIndices) {
        const segments = this.report.figure_types[command.index].segments.slice();
        command.segmentIndices.forEach((index, offset) => {segments[index] = value.figure.segments[offset];});
        value.figure.segments = segments;
      }
      this.report.figure_types[command.index] = value.figure;
      for (const entry of value.frames) this._replaceObjects(entry.index, entry.objects, entry.sourceId, entry.draft,entry.sourceDepth);
      this._restoreMovieclipSourceAnimations(value);
    } else if (command.kind === 'project') {
      Object.assign(this.report, value.fields);
      if (value.frame) this.report.keyframes[command.index] = value.frame;
    } else if (command.kind === 'ranges') {
      const changes = direction === 'before' ? [...command.changes].sort((a, b) => a.index - b.index) : [...command.changes].sort((a, b) => b.index - a.index);
      let copies;
      if(command.reuseFrameCopies){copies=rangeReportCopies.get(command);if(!copies)rangeReportCopies.set(command,copies=new Map());}
      for (const change of changes) {
        const opposite=direction==='before'?'after':'before',key=`${change.index}:${direction}`;
        const inserted=copies?.get(key)??clone(change[direction]);
        const removed=this.report.keyframes.splice(change.index,change[opposite].length,...inserted);
        copies?.set(`${change.index}:${opposite}`,removed);
      }
    }
    this._applyFrameClipboardAssets?.(command, direction);
    if (command.figureDefinitionSplice) {
      const {index, figures} = command.figureDefinitionSplice;
      if (direction === 'before') this.report.figure_types.splice(index, figures.length);
      else this.report.figure_types.splice(index, 0, ...clone(figures));
    }
    this._trackLayerCommand(command, direction);
    this._applyFrameSourceChanges(command, direction);
    if (command.layerAnimationPatch) this._applyLayerAnimationPatch(command.layerAnimationPatch, direction);
    if (command.draftAnimation) {
      const animation = command.draftAnimation[direction];
      if (animation === null) delete this.report._styk.animation;
      else this.report._styk.animation = animation;
    }
    if (['frame', 'splice', 'ranges', 'import', 'figure-splice', 'project'].includes(command.kind)) invalidateFrameIndex(this.report);
    if (command.kind === 'layers') this._applyLayerChanges(command.changes, direction);
    else if (command.layerChanges) this._applyLayerChanges(command.layerChanges, direction);
    if(command.layerSheetPatch)this.report._styk.layerSheet=command.layerSheetPatch[direction];
    this._restoreFrameDraftOverlay?.(command, direction);
    invalidateMovieclipTypes(this.report);
    this._invalidate({timing: command.kind !== 'animation', retainGeometry: command.kind === 'animation' || command.retainGeometry});
    this._restoreSelection(command[`${direction}Selection`]);
    this._revision = command[`${direction}Revision`];
    this._applyFrameDraftHistory?.(command, direction);
    restoreTimingGeometry(this,timingGeometry);
    if (retained?.previous) this._invalidateObjects(value.map(o => o.unique_id), retained);
    this._emit('history', {label: command.label, structural: command.structural, timing: command.timing, timingOnly: command.timingOnly,
      definition: Boolean(command.definition || command.figureDefinitionSplice || ['figure','import','figure-splice','topology'].includes(command.kind)),
      animation: command.kind === 'animation' || Boolean(command.layerAnimationPatch),
      ...(command.kind==='camera-motion'?{cameraMotion:true,frameIndices:[]}:{}),
      ...(command.kind==='frame-timing'?{frameIndices:command.changes.map(change=>change.index)}:{}),
      ...(['objects','frame'].includes(command.kind)&&!command.structural&&!command.frameDraftStored?{frameIndices:[command.index]}:{}),
      ...(localObjects ? {frameIndices: [command.index], changedUids: value.map(o => o.unique_id)} : {})});
  }
  undo({signal}={}) {
    this.cancelVfxClipEdit();
    if (this._animationEdit) this.cancelAnimationEdit();
    if (this._drag) this.cancelDrag();
    const command = this._undo.at(-1); if (!command) return false;
    return this._drawingHistoryReplay(command,'before',signal);
  }
  redo({signal}={}) {
    this.cancelVfxClipEdit();
    if (this._animationEdit) this.cancelAnimationEdit();
    const command = this._redo.at(-1); if (!command) return false;
    return this._drawingHistoryReplay(command,'after',signal);
  }
  _drawingHistoryReplay(command,direction,signal) {
    const resources=drawingResourcesFor(this.report),history=resources?.history,report=this.report,revision=this.revision;
    const source=direction==='before'?this._undo:this._redo,destination=direction==='before'?this._redo:this._undo;
    const check=()=>{if(signal?.aborted||report!==this.report||revision!==this.revision||source.at(-1)!==command)throw messageError(new DOMException('', 'AbortError'), "errors.editor.historyChangedBeforeUndoRedoCompleted", {});};
    const replay=prepared=>{try{
      check();resources?.checkHistory(command,direction,prepared);this._applyCommand(command,direction,prepared);source.pop();destination.push(command);return true;
    }finally{prepared?.release();}};
    const prepare=()=>{check();const pending=resources?.prepareChanges(command,direction,{signal,checkCurrent:check});return pending?pending.then(replay):replay();};
    try{
      const pending=history?.prepare(command,{signal}),result=pending?pending.then(prepare):prepare();
      if(result?.then)return result.finally(()=>history?.release(command));
      history?.release(command);return result;
    }catch(error){history?.release(command);throw error;}
  }
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
    const token = this._documentToken, revision = this.revision, drag = this._drag, animationEdit = this._animationEdit,
      draftRevision=this.frameDraftRevision,draftEnabled=this._frameDraftEnabled;
    const checkCurrent = () => {
      if(options.signal?.aborted)throw messageError(new DOMException('', 'AbortError'), "errors.editorLoad.importCancelled", {});
      if (request !== this._loadRequestId || token !== this._documentToken || revision !== this.revision ||
          drag !== this._drag || animationEdit !== this._animationEdit || this._drag?.changed || this._animationEdit?.changed ||
          draftRevision!==this.frameDraftRevision || draftEnabled!==this._frameDraftEnabled)
        throw messageError(new DOMException('', 'AbortError'), "errors.editor.theDocumentChangedWhileImporting", {});
    };
    const prepared = await prepareLoad(document,{...options,layerTimeline:this.layerTimeline,checkCurrent});
    checkCurrent();
    return this._publishLoadedReport(prepared, name, options);
  }
  _publishLoadedReport(prepared, name, {initialFrameIndex=0, initialTick, preserveDrawingResources=false, onDetach} = {}) {
    const {report} = prepared;
    if (name !== undefined && name !== null && typeof name !== 'string') throw messageError(new Error(''), "errors.editor.theDocumentNameMustBeText", {});
    const initial=initialLoadState(report,{initialFrameIndex,initialTick},this._frameDraftEnabled),index=initial.frameIndex;
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
    this._undo = []; this._redo = []; this._historySize = 0; this._drag = null;
    this._animationEdit = null; this._nativeAnimationChannels = null; this._authoredPoseEdit = null; this._authoredCommitPreview = null;
    this._pendingSourceLayerChanges = null; this._authoredCommandLabel = null; this._pendingSourceBytes = 0;
    this._revision = this._savedRevision = ++this._revisionSerial;
    this._nextUid = prepared.nextUid; this._nextFrameIdentity = prepared.nextFrameIdentity;
    this._generatedFrameSources = new Set(); this._sourceTableWasPresent = report._styk.frameSources !== undefined;
    this._layerUidCounts = prepared.layerUidCounts; this._layerSeenUids = prepared.layerSeenUids; this._layerGroups = prepared.layerGroups;
    this._layerRevision = (this._layerRevision ?? 0) + 1; this._layerDescriptors = null; this._layerUidArrays = new Map();
    this._loadedFigureNames = prepared.figureNames; this._loadedTimelineTracks = prepared.tracks;
    this._invalidate({timing: true}); invalidateFrameIndex(report);
    this.tick=initial.tick;this._timeline=initial.timeline;this._timelineDraftIndex=initial.draftIndex;this._timelineDraftDuration=initial.draftDuration;this._timelineDraftAnimation=initial.draftAnimation;
    this._timelineDraftEndTick=animationEndTick({_styk:{animation:initial.draftAnimation}});
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
    this._beforeFrameDraftSeek?.(next);
    this.frameIndex = next;
    this.tick = this.timeline[this.frameIndex]?.start ?? 0;
    this.selectedJoint = -1; this._invalidate({viewOnly: true}); this._emit('seek'); return this.frame;
  }
  seek(tick, {evaluate = true, allowBeyondEnd = false} = {}) {
    this.commitVfxClipEdit();
    if (this._drag) this.commitDrag();
    const nextTick = clamp(finite(tick, 'Timeline tick'), 0, allowBeyondEnd ? 10000000 : Math.max(0, this.totalTicks - 1));
    let low = 0, high = this.timeline.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.timeline[mid].start <= nextTick) low = mid; else high = mid - 1; }
    this._beforeFrameDraftSeek?.(low);
    this.tick = nextTick; this.frameIndex = low; this._invalidate({viewOnly: true}); this._emit('seek'); return evaluate ? this.evaluatedFrame : this.frame;
  }

  /** Callback receives the editable frame, followed by the report. One frame is snapshotted. */
  transaction(label, mutateFn, {structural = false, timing = false} = {}) {
    if (this._drag) this.commitDrag();
    if (this.report._styk?.layerSheet || this.animationChannels.length || this.report._styk?.movieclipSource) return this._authoredTransaction(label, mutateFn, {structural, timing});
    const index = this.frameIndex, before = clone(this.frame), beforeSelection = this._selectionState();
    try { mutateFn(this.frame, this.report); this._synchronizeAnimationOrigins(this.frame,before.objects,{includeNew:true}); validateScene({...this.report, keyframes: [this.report.keyframes[index]]}); }
    catch (error) { this.report.keyframes[index] = before; this._restoreSelection(beforeSelection); this._invalidate(); throw error; }
    const after = clone(this.report.keyframes[index]); if (same(before, after)) return false;
    timing ||= before.duration_raw !== after.duration_raw;
    structural ||= before.objects.length !== after.objects.length || before.objects.some((o, i) => o.unique_id !== after.objects[i]?.unique_id);
    this._invalidate({timing}); this.tick = this.timeline[index]?.start ?? 0;
    this._record({kind: 'frame', label, index, before, after, beforeSelection,
      afterSelection: this._selectionState(), structural, timing});
    this._emit('edit', {label, structural, timing, ...(!structural ? {frameIndices: [this.frameIndex]} : {})}); return true;
  }

  /** Translation uses complete connected components; posing uses selected subtrees. */
  resolveTranslationSelection(uids = this.selectedUids, {frame = this.selectionFrame} = {}) {
    return resolveJoinSelection(frame, uids, true);
  }
  beginTranslationDrag(label = 'Move figures') { return this.beginDrag(label, {scope: 'translation'}); }
  /** Snapshots affected figures only, independent of animation length. */
  beginDrag(label = 'Pose figure', {scope = 'selection'} = {}) {
    if (this._drag) this.commitDrag();
    const authored = this._beginAuthoredPoseDrag(label, scope); if (authored !== null) return authored;
    if (!this.object) return false;
    this._selectedUid = this.object.unique_id;
    const start = this.timeline[this.frameIndex]?.start ?? 0;
    if (this.tick !== start) { this.tick = start; this._invalidate(); }
    // A property edit can arrive after a seek but before its next paint. Resolve
    // the retained baseline before mutating native objects, so scoped invalidation
    // does not lose every unchanged figure merely because no paint ran yet.
    if(!this._geometry&&!this._incremental&&this._seekGeometry?.geometry)this.geometry;
    const resolved = resolveJoinSelection(this.frame, this.selectedUids, scope === 'translation');
    this._drag = {label, scope, index: this.frameIndex, before: this._ikPoseSlots(this.frame, resolved.affectedSlots).map(i => clone(this.frame.objects[i])),
      beforeSelection: this._selectionState(), changed: false}; return true;
  }
  _expandTranslationDrag() {
    if (this._drag.scope === 'translation') return;
    const resolved = this.resolveTranslationSelection(), snapshots = new Map(this._drag.before.map(o => [o.unique_id, o]));
    this._ownAuthoredSlots(resolved.affectedSlots);
    this._drag.before = resolved.affectedSlots.map(slot => {
      const object = this.frame.objects[slot]; return snapshots.get(object.unique_id) ?? clone(object);
    });
    this._drag.scope = 'translation';
  }
  touch({translation = false} = {}) {
    if(this._drag)this._synchronizeAnimationOrigins(this.frame,this._drag.before);
    if (this._drag) this._drag.changed = true;
    else this._revision = ++this._revisionSerial;
    this._invalidatePoseObjects(this._drag?.before.map(o => o.unique_id) ?? [this.selectedUid], {translation});
    this._rememberIKBends();
    this._emit('edit', {live: Boolean(this._drag),
      changedUids: this._drag?.before.map(o => o.unique_id) ?? [this.selectedUid]});
  }
  commitDrag() {
    if (this._drag?.duplicate) return this.finishDuplicateDrag(true);
    if (this._drag?.motionPath) return this.commitMotionPathEdit();
    if (this._drag?.rig) return this.commitRigDrag();
    if (this._drag?.authored) return this.commitAuthoredPoseDrag();
    if (this._drag?.camera) return this.commitCameraDrag();
    const drag = this._drag; if (!drag) return false;
    this._synchronizeAnimationOrigins(this.report.keyframes[drag.index],drag.before);
    const ids = new Set(drag.before.map(o => o.unique_id));
    let after = this.report.keyframes[drag.index].objects.filter(o => ids.has(o.unique_id)).map(clone);
    if (same(drag.before, after)) { this._drag = null; return false; }
    try { validateObjectChanges(this.report, this.report.keyframes[drag.index], ids); }
    catch (error) { this.cancelDrag(); throw error; }
    // Native Pivot stores final attachment coordinates as well as join links.
    // Refresh only the captured group, reusing the preview's geometry cache.
    // Pristine imports and unrelated objects keep their exact source values.
    if (after.some(object => object.join)) {
      const geometry = this.geometry;
      for (const [slot, entry] of geometry.objects) {
        const object = this.frame.objects[slot];
        if (!object?.join || !ids.has(object.unique_id)) continue;
        const root = entry?.root;
        if (root) { object.root_x = root.x; object.root_y = root.y; }
      }
      this._synchronizeAnimationOrigins(this.frame,drag.before);
      after = this.report.keyframes[drag.index].objects.filter(o => ids.has(o.unique_id)).map(clone);
    }
    this._drag = null;
    this._record({kind: 'objects', label: drag.label, index: drag.index, before: drag.before, after,
      beforeSelection: drag.beforeSelection, afterSelection: this._selectionState(), structural: false, timing: false});
    this._emit('edit', {label: drag.label, changedUids: [...ids]}); return true;
  }
  cancelDrag() {
    if (this._drag?.duplicate) return this.finishDuplicateDrag(false);
    if (this._drag?.motionPath) return this.cancelMotionPathEdit();
    if (this._drag?.rig) return this.cancelRigDrag();
    if (this._drag?.authored) return this.cancelAuthoredPoseDrag();
    if (this._drag?.camera) return this.cancelCameraDrag();
    if (!this._drag) return false;
    const drag = this._drag; this._drag = null; this._replaceObjects(drag.index, drag.before);
    this._invalidateObjects(drag.before.map(o => o.unique_id)); this._emit('edit', {label: 'Cancel pose', changedUids: drag.before.map(o => o.unique_id)}); return true;
  }
  _objectEdit(label, mutate, {translation = false, posed = false} = {}) {
    if (!this.object) return false;
    const active = Boolean(this._drag); if (!active) this.beginDrag(label);
    try {
      // Edit the displayed constrained pose. Only captured objects are owned by
      // this gesture; untouched frames/figures retain their source and caches.
      if (posed && this._drag?.before.some(hasPinnedIK)) {
        const geometry = this.geometry;
        for (const before of this._drag.before) {
          // IK dependency capture includes locked ancestors needed to evaluate
          // an editable attachment. Their evaluated pose is not an authored edit.
          if (layerLocked(this.report, before.unique_id)) continue;
          const object = this.frame.objects.find(o => o.unique_id === before.unique_id);
          const posedGeometry = geometry.objects.get(object?.object_slot), solved = posedGeometry?.solvedAngles;
          this._bakeIKFollowers(object, posedGeometry);
          if (solved) object.angles = solved.slice();
        }
      }
      mutate(this.object); this.touch({translation}); if (!active) this.commitDrag();
    }
    catch (error) { this.cancelDrag(); throw error; }
    return true;
  }
  _identity() { if (this._nextUid > 0x7ffffffe) throw messageError(new Error(''), "errors.editorLayerSheet.objectIdentityCapacityReached", {}); return this._nextUid++; }
  addFigure(typeId = this.report.figure_types[0]?.figure_type_id) {
    const fig = this.report.figure_types.find(f => f.figure_type_id === typeId);
    if (!fig) throw messageError(new Error(''), "errors.editor.chooseAFigureFromTheLibrary", {});
    if(isMovieclip(fig)&&!this._insertingMovieclip)return this._insertMovieclip(()=>this.addFigure(typeId));
    this.applyFigureRange({kind:'add',typeId},{atPlayhead:true,label:'Add figure'});
    return this.object;
  }
  duplicateFigure() {
    if (this.selectedObjects.length > 1) return this.duplicateSelection().at(-1) ?? null;
    if (!this.object) return null;
    const copy = clone(this.object); copy.unique_id = this._identity();
    delete copy._stykMovieclipPart;
    if(isMovieclip(this.figure)&&this.report._styk?.layerSheet)copy._stykMovieclip=presencePlayback({mode:this.object._stykMovieclip?.mode??'loop',speed:this.object._stykMovieclip?.speed??1});
    this._newLayerHints ??= new Map(); this._newLayerHints.set(copy.unique_id, this.layerForUid(this.object.unique_id));
    const worldRoot = this.geometry.objects.get(this.selectedSlot)?.root;
    copy.root_x = (worldRoot?.x ?? copy.root_x) + 24; copy.root_y = (worldRoot?.y ?? copy.root_y) + 24;
    translateIKTargets(copy, 24, 24);
    copy.join = null;
    this.transaction('Duplicate figure', frame => {
      const ids = frameOrder(frame); frame.objects.push(copy); setOrder(frame, [...ids, copy.unique_id]);
      normalizeFrame(frame); this.selectedUid = copy.unique_id; this.selectedJoint = -1;
    }, {structural: true}); return this.object;
  }
  copyFigure() {
    if (this.selectedObjects.length > 1) return Boolean(this.copySelection());
    if (!this.object || !this.figure) return false;
    const object = snapshotPoseObject(this.object), root = object.join ? this.geometry.objects.get(this.selectedSlot)?.root : null;
    if (root) { object.root_x = root.x; object.root_y = root.y; }
    object.join = null; delete object.runtime_segments;
    this._selectionClipboard = null;
    this._figureClipboard = {object, figure: snapshotFigureDefinition(this.figure), movieclipSamples: isMovieclip(this.figure)&&Number.isFinite(this.object._movieclipSample)?{[object.unique_id]:this.object._movieclipSample}:{}, documentToken: this._documentToken, sourceVersion: this.report.version, offset: 24, pastes: 0};
    return true;
  }
  cutFigure() {
    if (this.selectedObjects.length > 1) return Boolean(this.cutSelection());
    if (!this.copyFigure()) return false;
    this._figureClipboard.offset = 0; return this.deleteFigure();
  }
  pasteFigure(options) {
    return this.pasteSelection(options).at(-1) ?? null;
  }
  deleteFigure() {
    return this.deleteSelection();
  }
  _selectIds(uids) { this._branchSelection = null; this.selectedUids = new Set([...uids].filter(uid=>!this.isFigureFocusLocked(uid))); this._selectedUid = [...this.selectedUids].at(-1) ?? null; this.selectedJoint = -1; }
  deleteSelection() {
    if (this.branchSelected) return this.deleteSegment();
    const selected = new Set(this.selectedObjects.map(o => o.unique_id)); if (!selected.size) return false;
    if(this.report._styk?.layerSheet&&this.selectedObjects.some(object=>isMovieclip(this.report.figure_types.find(figure=>figure.figure_type_id===object.figure_type_id))))return this.sheetDeleteFigures(selected);
    const geometry = this.geometry;
    return this.transaction('Delete figures', frame => {
      const order = frameOrder(frame).filter(uid => !selected.has(uid));
      for (const object of frame.objects) if (object.join) {
        object.join.target_unique_id = frame.objects[object.join.target_object_slot]?.unique_id;
        if (!selected.has(object.unique_id) && selected.has(object.join.target_unique_id)) {
          const root = geometry.objects.get(object.object_slot)?.root;
          if (root) { object.root_x = root.x; object.root_y = root.y; }
          object.join = null;
        }
      }
      frame.objects = frame.objects.filter(o => !selected.has(o.unique_id));
      const slots = new Map(frame.objects.map((o, i) => [o.unique_id, i]));
      frame.objects.forEach((o, i) => { o.object_slot = i; if (o.join) o.join.target_object_slot = slots.get(o.join.target_unique_id); });
      setOrder(frame, order); this._selectIds([]);
    }, {structural: true});
  }
  /** Translate connected roots once, including when a selected figure is a joined child. */
  moveSelection(dx, dy, {fromStart = false, detachExternal = false, movePins = false} = {}) {
    finite(dx, 'Translation X'); finite(dy, 'Translation Y');
    return this._objectEdit('Move figures', () => {
      if (!detachExternal) this._expandTranslationDrag();
      const snapshots = new Map(this._drag.before.map(o => [o.unique_id, o]));
      const affected = this.frame.objects.filter(o => snapshots.has(o.unique_id));
      const external = affected.filter(o => o.join && !snapshots.has(this.frame.objects[o.join.target_object_slot]?.unique_id));
      if (external.length) {
        const geometry = this.geometry;
        for (const object of external) {
          const root = geometry.objects.get(object.object_slot)?.root;
          if (root) {
            this._drag.detachedOrigins ??= new Map(); this._drag.detachedOrigins.set(object.unique_id, {...root});
            object.root_x = root.x; object.root_y = root.y;
          }
          object.join = null;
        }
      }
      for (const object of affected) {
        const baseline = fromStart ? snapshots.get(object.unique_id) : object;
        if (!object.join) {
          const detached = fromStart ? this._drag.detachedOrigins?.get(object.unique_id) : null;
          object.root_x = (detached?.x ?? baseline.root_x) + dx; object.root_y = (detached?.y ?? baseline.root_y) + dy;
          delete object.runtime_segments;
        }
        if (movePins || fromStart) {
          if (translateIKTargets(object, movePins ? dx : 0, movePins ? dy : 0, {source: baseline, pinnedOnly: true})) delete object.runtime_segments;
        }
      }
    }, {translation:true});
  }
  moveSelectionInFrames(dx, dy, indices = [this.frameIndex], {movePins = false} = {}) {
    finite(dx, 'Translation X'); finite(dy, 'Translation Y');
    if(this.report._styk?.layerSheet)return this.sheetMoveSelection(dx,dy,indices.sheetTicks??indices.map(index=>indices.length===1?this.tick:this.timeline[index].start),{movePins});
    if (!dx && !dy) return 0;
    const selectedFrames = this._frameIndices(indices), selectedIds = new Set(this.selectedUids);
    if (!selectedIds.size) return 0;
    if (this._drag) this.commitDrag();
    const changes = [];
    for (const index of selectedFrames) {
      const source = this.report.keyframes[index], selected = source.objects.filter(o => selectedIds.has(o.unique_id));
      if (!selected.length) continue;
      const resolved = this.resolveTranslationSelection(selectedIds, {frame: source});
      const rootIds = new Set(resolved.rootUids), affected = new Set(resolved.affectedUids);
      const before = clone(source), after = clone(source);
      for (const object of after.objects) {
        if (rootIds.has(object.unique_id)) {object.root_x += dx; object.root_y += dy; delete object.runtime_segments;}
        if (movePins && affected.has(object.unique_id) && translateIKTargets(object, dx, dy, {pinnedOnly: true})) delete object.runtime_segments;
      }
      this._synchronizeAnimationOrigins(after,before.objects);
      validateScene({...this.report, keyframes: [after]});
      changes.push({index, before: [before], after: [after]});
    }
    this._rangesEdit('Move figures across keyframes', changes, {retainSelection: true, structural: false, timing: false});
    return changes.length;
  }
  _transformSelection(label, transform, {center, selectedOnly = false} = {}) {
    return this._objectEdit(label, () => {
      const ids = selectedOnly ? this.selectedUids : new Set(this._drag.before.map(o => o.unique_id));
      const objects = this.frame.objects.filter(o => ids.has(o.unique_id));
      let pivot = center;
      if (!pivot) {
        const geometry = this.geometry;
        if (this.selectedObjects.length === 1) pivot = geometry.objects.get(this.selectedSlot)?.root;
        else {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const g of geometry.objects.values()) if (g && ids.has(g.obj.unique_id)) for (const p of g.joints.values()) {
            minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
          }
          pivot = {x: (minX + maxX) / 2, y: (minY + maxY) / 2};
        }
      }
      finite(pivot?.x, 'Transform center X'); finite(pivot?.y, 'Transform center Y');
      for (const object of objects) {
        transform(object, pivot, !object.join, this.report.figure_types.find(f => f.figure_type_id === object.figure_type_id));
        delete object.runtime_segments;
      }
    });
  }
  rotateSelection(radians, options = {}) {
    finite(radians, 'Rotation'); const c = Math.cos(radians), s = Math.sin(radians);
    return this._transformSelection('Rotate figures', (object, pivot, root, figure) => {
      if (root) { const x = object.root_x - pivot.x, y = object.root_y - pivot.y;
        object.root_x = pivot.x + x * c - y * s; object.root_y = pivot.y + x * s + y * c; }
      object.angles = object.angles.map(a => a + radians);
      rotateOriginSupport(figure, object, radians);
    }, options);
  }
  scaleSelection(factor, options = {}) {
    finite(factor, 'Scale'); if (factor < 0) throw messageError(new Error(''), "errors.editor.scaleCannotBeNegative", {});
    return this._transformSelection('Scale figures', (object, pivot, root) => {
      if (root) { object.root_x = pivot.x + (object.root_x - pivot.x) * factor; object.root_y = pivot.y + (object.root_y - pivot.y) * factor; }
      object.scale *= factor;
    }, options);
  }
  /** Native numeric scale control: selected instances only; attachments follow. */
  scaleSelected(factor, {center} = {}) {
    finite(factor, 'Scale'); if (factor < 0) throw messageError(new Error(''), "errors.editor.scaleCannotBeNegative", {});
    return this._transformSelection('Scale selected figures', (object, pivot, root) => {
      if (root) { object.root_x = pivot.x + (object.root_x - pivot.x) * factor; object.root_y = pivot.y + (object.root_y - pivot.y) * factor; }
      object.scale *= factor;
    }, {center, selectedOnly: true});
  }
  mirrorSelection(axis = 'horizontal', options = {}) {
    if (!['horizontal', 'vertical'].includes(axis)) throw messageError(new Error(''), "errors.editorBuilderTopology.chooseAHorizontalOrVerticalFlip", {});
    if (this.selectedJoint >= 0 && (this.selectedObjects.length === 1 || this.branchSelected))
      return this.applyFigureRange({kind: 'mirror', axis}, {...options, atPlayhead: true});
    return this._transformSelection('Flip figures', (object, pivot, root, figure) => {
      const previousRotation = object._stykAnimationOrigin ? animationRotation(figure, object) : 0;
      if (root) { if (axis === 'horizontal') object.root_x = 2 * pivot.x - object.root_x; else object.root_y = 2 * pivot.y - object.root_y; }
      object.angles = object.angles.map(a => axis === 'horizontal' ? Math.PI - a : -a);
      object.bends = object.bend_flag ? object.bends.map(b => -b) : figure.segments.map(s => -(s.bend_rad ?? 0));
      object.bend_flag = 1; object.image_text_flags = Number(!object.image_text_flags);
      mirrorOriginSupport(figure, object, axis);
      reflectAnimationOriginOffset(figure, object, axis, previousRotation);
    }, options);
  }
  moveSelectionLayer(direction) {
    if (!this.selectedObjects.length) return false;
    if (!Number.isInteger(direction)) throw messageError(new Error(''), "errors.editor.layerDirectionMustBeAWholeNumber", {});
    if (this.propertyChannels || this.animationChannels.length || this.selectionFrame.objects.some(object => object._stykZIndex !== undefined))
      return this.applyFigureRange({kind: 'order', direction}, {ticks: [this.tick]});
    return this.transaction('Reorder figures', frame => {
      const before = frameOrder(frame), selected = this.selectedUids, groups = new Map();
      for (const uid of before) { const id = this.layerForUid(uid), group = groups.get(id) ?? {order: [], cursor: 0}; group.order.push(uid); groups.set(id, group); }
      for (const {order} of groups.values()) for (let n = 0; n < Math.min(Math.abs(direction), order.length); n++) {
        if (direction > 0) for (let i = order.length - 2; i >= 0; i--) {
          if (selected.has(order[i]) && !selected.has(order[i + 1])) [order[i], order[i + 1]] = [order[i + 1], order[i]];
        } else for (let i = 1; i < order.length; i++) {
          if (selected.has(order[i]) && !selected.has(order[i - 1])) [order[i], order[i - 1]] = [order[i - 1], order[i]];
        }
      }
      setOrder(frame, before.map(uid => { const group = groups.get(this.layerForUid(uid)); return group.order[group.cursor++]; }));
    }, {structural: true});
  }
  copySelection({wholeFigures = false} = {}) {
    if (!wholeFigures && this._branchSelection?.uid === this.selectedUid && this._branchSelection?.joint === this.selectedJoint)
      return this.copyBranchSelection();
    const selected = this.selectedObjects; if (!selected.length) return 0;
    const geometry = selected.some(object=>object.join) ? this.geometry : null, ids = new Set(selected.map(o => o.unique_id));
    const figures = [...new Set(selected.map(o => o.figure_type_id))].map(id => snapshotFigureDefinition(this.report.figure_types.find(f => f.figure_type_id === id)));
    const objects = selected.map(object => {
      const out = snapshotPoseObject(object), root = geometry?.objects.get(object.object_slot)?.root;
      if (root) { out.root_x = root.x; out.root_y = root.y; }
      if (out.join) {
        const targetUid = this.selectionFrame.objects[out.join.target_object_slot]?.unique_id;
        if (ids.has(targetUid)) out.join.target_unique_id = targetUid; else out.join = null;
      }
      delete out.runtime_segments; return out;
    });
    this._selectionClipboard = {objects, figures, movieclipSamples: Object.fromEntries(selected.filter(object=>figures.some(figure=>figure.figure_type_id===object.figure_type_id&&isMovieclip(figure))&&Number.isFinite(object._movieclipSample)).map(object=>[object.unique_id,object._movieclipSample])), layers: new Map(selected.map(object => [object.unique_id, this.layerForUid(object.unique_id)])), order: frameOrder(this.selectionFrame).filter(id => ids.has(id)), vfxClips: figureVfxClips(this.report, ids), copyTick: Math.round(this.tick), documentToken: this._documentToken, sourceVersion: this.report.version, offset: 24, pastes: 0};
    this._figureClipboard = null; return objects.length;
  }
  cutSelection() {
    const count = this.copySelection(); if (!count) return 0;
    this._selectionClipboard.offset = 0; this.deleteSelection(); return count;
  }
  pasteSelection({newIdentities = false, pasteMode = 'default', pasteDepth = 'same', offset} = {}) {
    const clipboard = this._selectionClipboard ?? this._figureClipboard;
    if (!clipboard) return [];
    if (!Number.isInteger(this.tick) && (this.report._styk?.layerSheet || this.animationChannels.length || this.report._styk?.movieclipSource)) {
      this.tick = Math.round(this.tick); this._invalidate({viewOnly: true});
    }
    // One prepared insertion owns validation, IDs, assets and history. The
    // destination's unchanged figures and library never become paste snapshots.
    const result = this.applyFigureRange({kind: 'paste', offset, defaultOffset: clipboard.offset * (clipboard.pastes + 1), newIdentities, pasteMode, pasteDepth},
      {atPlayhead: true, label: this._selectionClipboard ? 'Paste figures' : 'Paste figure'});
    if (result.insertedUids.length && offset !== 0) clipboard.pastes++;
    return this.selectedObjects;
  }
  duplicateSelection({pasteMode = 'instance', offset, wholeFigures = false} = {}) {
    const groupClipboard = this._selectionClipboard, singleClipboard = this._figureClipboard;
    try { if (!this.copySelection({wholeFigures})) return []; return this.pasteSelection({newIdentities: true, pasteMode, offset}); }
    finally { this._selectionClipboard = groupClipboard; this._figureClipboard = singleClipboard; }
  }
  _frameSplice(label, index, remove, insert) {
    if (this._drag) this.commitDrag();
    const beforeSelection = this._selectionState(), before = this.report.keyframes.slice(index, index + remove).map(clone);
    insert = this._newInsertedFrames(insert);
    this.report.keyframes.splice(index, remove, ...insert);
    const command = {kind: 'splice', label, index, before, after: clone(insert), beforeSelection, structural: true, timing: true};
    this._captureRemovedFrameSources(command); this._invalidate({timing: true});
    invalidateFrameIndex(this.report);
    this.frameIndex = Math.min(index, this.report.keyframes.length - 1); this.tick = this.timeline[this.frameIndex]?.start ?? 0;
    this._selectIds(this.selectedObjects.map(o => o.unique_id));
    command.afterSelection = this._selectionState(); this._record(command);
    this._emit('edit', {label, structural: true, timing: true}); return this.frame;
  }
  addFrame({blank = false} = {}) {
    const frame = blank ? createFrame() : clone(this.frame);
    if (blank && this.frame._styk?.easing) frame._styk = {easing: clone(this.frame._styk.easing)};
    return this._frameSplice('Add keyframe', this.frameIndex + 1, 0, [frame]);
  }
  duplicateFrame() { return this._frameSplice('Duplicate keyframe', this.frameIndex + 1, 0, [clone(this.frame)]); }
  _frameIndices(indices) {
    const result = [...new Set(indices ?? [this.frameIndex])].sort((a, b) => a - b);
    if (result.some(i => !Number.isInteger(i) || i < 0 || i >= this.report.keyframes.length)) throw messageError(new Error(''), "errors.editor.selectExistingKeyframes", {});
    return result;
  }
  _rangesEdit(label, changes, {retainSelection = false, structural = true, timing = true, timingOnly = false, selectIndex, frameEasing = false, animationPlan} = {}) {
    if (!changes.length) return false;
    if (this._drag) this.commitDrag();
    const beforeSelection = this._selectionState();
    const previous = new Map(this.report.keyframes.map(frame => [frame._styk.frameId, frame])), applied = [];
    for (const change of [...changes].sort((a, b) => b.index - a.index)) {
      const inserted = clone(change.after); applied.push([change, inserted]);
      this.report.keyframes.splice(change.index, change.before.length, ...inserted);
    }
    this._reconcileFrameIds(previous);
    for (const [change, inserted] of applied) change.after = clone(inserted);
    const command = {kind: 'ranges', label, changes, beforeSelection, structural, timing, timingOnly};
    if (animationPlan) {
      command.draftAnimation = {before: animationPlan.before, after: animationPlan.after};
      command.hadFrameSourceTable = this.report._styk.frameSources !== undefined;
      command.frameSourceChanges = animationPlan.frameSourceChanges;
      this._applyFrameSourceChanges(command, 'after');
      if (animationPlan.after === null) delete this.report._styk.animation;
      else this.report._styk.animation = animationPlan.after;
      this._nextFrameIdentity = animationPlan.nextFrameIdentity;
    }
    if (frameEasing) command.frameEasing = true;
    this._captureRemovedFrameSources(command);
    this._invalidate({timing});
    if (retainSelection) this._restoreSelection(beforeSelection);
    else { this.frameIndex = Math.min(selectIndex ?? changes[0].index, this.report.keyframes.length - 1);
      this.tick = this.timeline[this.frameIndex]?.start ?? 0; this._selectIds(this.selectedObjects.map(o => o.unique_id)); }
    command.afterSelection = this._selectionState(); this._record(command);
    this._emit('edit', {label, structural, timing, timingOnly, ...(!structural ? {frameIndices: changes.flatMap(change => change.after.map((_, offset) => change.index + offset))} : {})}); return true;
  }
  cutFrames(indices = [this.frameIndex]) {
    const selected = this._frameIndices(indices); this.copyFrames(selected); return this.deleteFrames(selected, 'Cut keyframes');
  }
  deleteFrames(indices = [this.frameIndex], label = 'Delete keyframes') {
    const selected = this._frameIndices(indices); if (!selected.length) return 0;
    if (selected.length === this.report.keyframes.length) this._frameSplice(label, 0, selected.length, [createFrame()]);
    else this._rangesEdit(label, selected.map(index => ({index, before: [clone(this.report.keyframes[index])], after: []})));
    return selected.length;
  }
  reverseFrames(indices = [this.frameIndex]) {
    const selected = this._frameIndices(indices); if (selected.length < 2) return false;
    const frames = selected.map(index => clone(this.report.keyframes[index]));
    return this._rangesEdit('Reverse keyframes', selected.map((index, i) => ({index, before: [frames[i]], after: [frames[frames.length - i - 1]]})));
  }
  deleteFrame() {
    if (this.report.keyframes.length === 1) return this.transaction('Clear keyframe', frame => {
      frame.objects = []; frame.object_draw_order = []; frame.object_draw_order_unique_ids = []; this.selectedUid = null;
    }, {structural: true});
    return this._frameSplice('Delete keyframe', this.frameIndex, 1, []);
  }
  updateObject(patch) {
    if (this.selectedObjects.length > 1 && Object.keys(patch).every(k => ['color_override_raw', 'field28', 'image_text_flags', 'name', '_styk'].includes(k))) return this.updateSelection(patch);
    for (const field of ['root_x', 'root_y', 'scale']) if (field in patch) finite(patch[field], field);
    if (patch.scale < 0) throw messageError(new Error(''), "errors.editor.scaleCannotBeNegative", {});
    if ('field28' in patch && (!Number.isInteger(patch.field28) || patch.field28 < 0 || patch.field28 > 255)) throw messageError(new Error(''), "errors.editor.opacityMustBeAByte", {});
    if ('unique_id' in patch || 'figure_type_id' in patch || 'object_slot' in patch || 'join' in patch) throw messageError(new Error(''), "errors.editor.useStructuralOperationsToChangeFigureIdentityOr", {});
    return this._objectEdit('Edit figure', obj => { Object.assign(obj, clone(patch)); delete obj.runtime_segments; });
  }
  updateSelection(patch) {
    if (Object.keys(patch).some(k => !['color_override_raw', 'field28', 'image_text_flags', 'name', '_styk'].includes(k))) throw messageError(new Error(''), "errors.editor.useGroupTransformCommandsToChangeSelectionGeometry", {});
    return this._objectEdit('Edit selected figures', () => {
      for (const object of this.selectedObjects) { Object.assign(object, clone(patch)); delete object.runtime_segments; }
    });
  }
  updateSegment(patch) {
    const index = this.selectedJoint, fig = this.figure;
    if (!fig || index < 0 || index >= fig.segments.length) return false;
    if ('color_rgb' in patch && (!Array.isArray(patch.color_rgb) || patch.color_rgb.length !== 3 || patch.color_rgb.some(n => !Number.isInteger(n) || n < 0 || n > 255))) throw messageError(new Error(''), "errors.editor.colorMustContainThreeRgbBytes", {});
    if ('transparency' in patch && (!Number.isInteger(patch.transparency) || patch.transparency < 0 || patch.transparency > 255)) throw messageError(new Error(''), "errors.editor.transparencyMustBeAByte", {});
    if ('primitive_code' in patch && ![0, 1, 2, 3, 4, 5, 6].includes(patch.primitive_code)) throw messageError(new Error(''), "errors.editor.unknownSegmentPrimitive", {});
    const pose = {}, definition = {...patch};
    for (const field of ['angle_rad', 'length', 'bend_rad']) if (field in patch) { pose[field] = finite(patch[field], field); delete definition[field]; }
    if('length' in pose && (pose.length<0 || fig.segments[index]._stykRig?.connector && pose.length>1))throw messageError(new Error(''), "errors.editor.connectorPositionMustBe01SegmentLengths", {});
    if (Object.keys(pose).length) this._objectEdit('Edit joint', obj => {
      if ('angle_rad' in pose) this._rotateJoint(pose.angle_rad - obj.angles[index]);
      if ('length' in pose) { if (!obj.len_flag) obj.lengths = fig.segments.map(s => s.length); obj.len_flag = 1; obj.lengths[index] = pose.length; }
      if ('bend_rad' in pose) {
        const previous = obj.bend_flag ? obj.bends[index] : (fig.segments[index].bend_rad ?? 0);
        this._rotateJoint(pose.bend_rad - previous, false);
        if (!obj.bend_flag) obj.bends = fig.segments.map(s => s.bend_rad ?? 0);
        obj.bend_flag = 1; obj.bends[index] = pose.bend_rad;
      }
      delete obj.runtime_segments;
    }, {posed: true});
    if (!Object.keys(definition).length) return true;
    for (const field of ['segment_id', 'parent_id']) if (field in definition) throw messageError(new Error(''), "errors.editor.useTheFigureBuilderToChangeJointHierarchy", {});
    if ('thickness' in definition && finite(definition.thickness, 'Thickness') < 0) throw messageError(new Error(''), "errors.editor.thicknessCannotBeNegative", {});
    const figureIndex = this.report.figure_types.indexOf(fig), before = clone(fig), selection = this._selectionState();
    Object.assign(fig.segments[index], clone(definition));
    // Keep raw definition flags in step with UI edits without scanning the project.
    const s = fig.segments[index]; if ('is_static' in definition) s.aux_code = (s.aux_code ?? 0) & ~1 | Number(s.is_static);
    if ('primitive_code' in definition) {
      s.segment_kind = ['line', 'circle', 'image', 'circleFill', 'circleClear', 'text', 'squareLine'][s.primitive_code];
      s.segment_type = [1, 3, 4].includes(s.primitive_code) ? 'circle' : s.primitive_code === 2 ? 'image' : s.primitive_code === 5 ? 'text' : 'line';
    }
    s.flags = (s.primitive_code ?? 0) | ((s.aux_code ?? 0) << 8); s.visible = s.thickness > 0.01 || s.primitive_code > 0;
    this._record({kind: 'figure', label: 'Edit segment style', index: figureIndex, before, after: clone(fig),
      beforeSelection: selection, afterSelection: selection, structural: false, timing: false});
    this._invalidate(); this._emit('edit', {label: 'Edit segment style', definition: true}); return true;
  }
  _rotateJoint(delta, includeJoint = true, {isolate = false} = {}) {
    if(includeJoint&&this.figure?.segments[this.selectedJoint]?._stykRig?.angleLock)return;
    const slot = this.selectedSlot, joint = this.selectedJoint, key = `${slot}:${joint}${isolate ? ':isolated' : ''}`;
    let targets = this._drag?.rotationTargets?.get(key);
    if (!targets) {
      const report = this._authoredPoseEdit ? {...this.report, keyframes: [this.frame]} : this.report;
      targets = rotationEdits(report, this._authoredPoseEdit ? 0 : this.frameIndex, slot, joint, 0, true, {isolate}).map(change => {
        const tokens = change.path.split('/'); return [Number(tokens[4]), Number(tokens[6])];
      });
      if (this._drag) { this._drag.rotationTargets ??= new Map(); this._drag.rotationTargets.set(key, targets); }
    }
    this._applyJointRotation(targets, delta, includeJoint);
  }
  _applyJointRotation(targets, delta, includeJoint = true) {
    const slot = this.selectedSlot, joint = this.selectedJoint;
    this._rotateIKFollowers(targets, delta, includeJoint);
    const children = new Set();
    for (const [objectSlot, segment] of targets) if (includeJoint || objectSlot !== slot || segment !== joint) {
      this.frame.objects[objectSlot].angles[segment] += delta;
      if (objectSlot !== slot) children.add(objectSlot);
    }
    for (const childSlot of children) {
      const child = this.frame.objects[childSlot];
      rotateOriginSupport(this.report.figure_types.find(figure => figure.figure_type_id === child.figure_type_id), child, delta);
    }
  }
  rotateJoint(delta, options = {}) {
    finite(delta, 'Joint rotation'); if (!this.figure?.segments[this.selectedJoint]) return false;
    const spatial=this.getSpatialPose();
    if(spatial&&!options.isolate)return this.setSpatialPose({bend:spatial.bend+delta*(this.object.image_text_flags?-1:1)});
    return this._objectEdit('Rotate joint', () => this._rotateJoint(delta, true, options), {posed: true});
  }
  _poseSnapState() {
    const key = `${this.selectedUid}:${this.selectedJoint}`;
    this._drag.poseSnaps ??= new Map();
    let state = this._drag.poseSnaps.get(key);
    if (!state) {
      const object = this._drag.before.find(o => o.unique_id === this.selectedUid), segment = this.figure.segments[this.selectedJoint];
      const length = object.len_flag ? object.lengths[this.selectedJoint] : segment.length;
      const bend = object.bend_flag ? object.bends[this.selectedJoint] : (segment.bend_rad ?? 0);
      state = {length: segment.length, bend: segment.bend_rad ?? 0,
        lengthEnabled: Math.abs(length - segment.length) > Math.max(1, Math.abs(segment.length)) * 1e-7,
        bendEnabled: Math.abs(bend - (segment.bend_rad ?? 0)) > 1e-7};
      this._drag.poseSnaps.set(key, state);
    }
    return state;
  }
  poseJoint(x, y, {stretch = false, isolate = false, snap = true, snapTolerance = 6, alternate = false, depth = false, pixel = 0, anchor = null} = {}) {
    if(spatialSkin(this.figure?.segments[this.selectedJoint])||this.figure?.segments[this.selectedJoint]?._stykRig?.anglePath||this.figure?.segments[this.selectedJoint]?._stykRig?.weighted)return false;
    finite(x, 'Joint X'); finite(y, 'Joint Y');
    finite(snapTolerance, 'Snap tolerance'); if (snapTolerance < 0) throw messageError(new Error(''), "errors.editor.snapToleranceCannotBeNegative", {});
    if (!this.object || this.selectedJoint < 0) return false;
    if (this.figure?.segments[this.selectedJoint]?._stykRig?.connector) return this.slideConnector(x,y);
    // A stretch drag poses the node directly, like one without a controller.
    if (!stretch && this.object._stykIK?.[this.figure?.segments[this.selectedJoint]?.segment_id]?.enabled) {
      // Shift or the depth key pushes a spatial hand/foot target in depth;
      // releasing it resumes ordinary target dragging from the current pointer.
      if ((alternate || depth) && this.poseSpatialIKDepth(x, y, {pixel: pixel || 1})) { this._clearFlatSpatialIK(); return true; }
      this._clearSpatialIKDepth();
      const pointer = this._spatialIKPointer(x, y);
      return this.poseIKTarget(pointer.x, pointer.y, {flat: true});
    }
    const seg = this.figure?.segments[this.selectedJoint]; if (!seg || isStatic(seg)) return false;
    if(spatialBone(seg))return this.poseSpatialJoint(x,y,{stretch,depth,flip:alternate,pixel,anchor});
    const shape = this.geometry.objects.get(this.selectedSlot)?.segments[this.selectedJoint]; if (!shape) return false;
    if(seg._stykRig?.angleLock){
      if(!stretch||Math.abs(this.object.scale)<1e-8)return false;
      const chord=shape.bend/2,axis=shape.angle+chord;
      const along=Math.max(0,(x-shape.start.x)*Math.cos(axis)+(y-shape.start.y)*Math.sin(axis));
      const current=this.object.len_flag?this.object.lengths[this.selectedJoint]:seg.length;
      const chordLength=Math.hypot(shape.end.x-shape.start.x,shape.end.y-shape.start.y);
      if(current<1e-8||chordLength<1e-8)throw messageError(new UserActionError(''), "errors.editor.expandTheStretchDriverBeforePosingAFully", {});
      return this._objectEdit('Stretch locked joint',obj=>{
        if(!obj.len_flag)obj.lengths=this.figure.segments.map(s=>s.length);
        obj.len_flag=1;obj.lengths[this.selectedJoint]=along*current/chordLength;
      },{posed:true});
    }
    const pointer = {x, y}, pin = this.object._stykIK?.[seg.segment_id];
    const pinned = stretch && pin?.enabled && pin.pinned;
    const solvedLengths = pinned ? this.geometry.objects.get(this.selectedSlot).solvedLengths : null;
    const limb = pinned ? this._ikLimbPoints(seg.segment_id) : null;
    ({x,y}=authoredRigTarget(shape,x,y,stretch?undefined:{angle:this.object.angles[this.selectedJoint],
      length:(this.object.len_flag?this.object.lengths[this.selectedJoint]:seg.length)*Number(this.object.scale??1)}));
    const angle = Math.atan2(y - shape.start.y, x - shape.start.x) - shape.bend / 2;
    return this._objectEdit('Pose joint', obj => {
      const defaults = this._poseSnapState();
      this._rotateJoint(shortest(angle - (shape.rigSpace ? obj.angles[this.selectedJoint] : shape.angle)), true, {isolate});
      if (stretch && Math.abs(obj.scale) > 1e-8) {
        if (!obj.len_flag) obj.lengths = this.figure.segments.map(s => s.length);
        obj.len_flag = 1; const bend = shape.bend;
        const chord = Math.abs(bend) < 1e-7 ? 1 : Math.abs(2 * Math.sin(bend / 2) / bend);
        if (chord < 1e-8) throw messageError(new Error(''), "errors.editorMotionPath.reduceTheFullCircleBendBeforeStretchingThis", {});
        const reached = Math.hypot(x - shape.start.x, y - shape.start.y) / (Math.abs(obj.scale) * chord);
        let length = reached;
        if (snap && defaults.lengthEnabled && Math.abs(length - defaults.length) * Math.abs(obj.scale) * chord <= snapTolerance) length = defaults.length;
        // The rest of a limb displayed beyond its reach keeps the length shown.
        if (solvedLengths) for (const i of ikChain(this.figure, seg.segment_id, pin.chainLength)) obj.lengths[i] = solvedLengths[i];
        obj.lengths[this.selectedJoint] = length;
        if (pinned) {
          const ratio = reached > 1e-8 ? length / reached : 0;
          this._followStretchedIK(obj, seg.segment_id, limb,
            {x: shape.start.x + (pointer.x - shape.start.x) * ratio, y: shape.start.y + (pointer.y - shape.start.y) * ratio});
        }
      }
    }, {posed: true});
  }
  /** Bend keeps the start tangent fixed; optional stretching reaches the cursor. */
  bendJoint(x, y, {stretch = false, isolate = false, snap = true, snapTolerance = 6, pixel = 1} = {}) {
    finite(x, 'Joint X'); finite(y, 'Joint Y'); finite(snapTolerance, 'Snap tolerance');
    if (snapTolerance < 0) throw messageError(new Error(''), "errors.editor.snapToleranceCannotBeNegative", {});
    const segment = this.figure?.segments[this.selectedJoint];
    // Spatial bones have no curved bend; the secondary drag twists them instead.
    if (spatialBone(segment)) return this.twistSpatialJoint(x, y, {pixel});
    const rigBend = this._drag?.rig?.bend;
    if (!segment || (isStatic(segment) && !rigBend) || ![0, 6].includes(segment.primitive_code ?? (segment.flags ?? 0) & 255)) return false;
    const shape = this.geometry.objects.get(this.selectedSlot)?.segments[this.selectedJoint]; if (!shape) return false;
    if (shape.connector) return this._bendConnector(x, y, shape);
    const distance = Math.hypot(x - shape.start.x, y - shape.start.y);
    let bend = distance < 1e-8 ? shape.bend : 2 * shortest(Math.atan2(y - shape.start.y, x - shape.start.x) - shape.angle);
    return this._objectEdit('Bend joint', object => {
      const defaults = this._poseSnapState(), scale = Math.abs(object.scale);
      const chord = value => Math.abs(value) < 1e-7 ? 1 : Math.abs(2 * Math.sin(value / 2) / value);
      let length = object.len_flag ? object.lengths[this.selectedJoint] : segment.length;
      if (snap && defaults.bendEnabled) {
        const radius = stretch ? distance : length * scale * chord(defaults.bend), direction = shape.angle + defaults.bend / 2;
        if (Math.hypot(shape.start.x + radius * Math.cos(direction) - x, shape.start.y + radius * Math.sin(direction) - y) <= snapTolerance) bend = defaults.bend;
      }
      if (stretch && scale > 1e-8) {
        const factor = chord(bend); if (factor < 1e-8) throw messageError(new Error(''), "errors.editorMotionPath.reduceTheFullCircleBendBeforeStretchingThis", {});
        length = distance / (scale * factor);
        if (snap && defaults.lengthEnabled && Math.abs(length - defaults.length) * scale * factor <= snapTolerance) length = defaults.length;
        if (!object.len_flag) object.lengths = this.figure.segments.map(s => s.length);
        object.len_flag = 1; object.lengths[this.selectedJoint] = length;
      }
      if (rigBend) {
        // A reusable rig edit rotates this definition's descendants. Joined
        // figures retain their own poses, as with ordinary rig rotation.
        if (!isolate) for (const i of this._drag.rig.branch)
          if (i !== this.selectedJoint) object.angles[i] += bend - shape.bend;
      } else this._rotateJoint(bend - shape.bend, false, {isolate});
      if (!object.bend_flag) object.bends = this.figure.segments.map(s => s.bend_rad ?? 0);
      object.bend_flag = 1; object.bends[this.selectedJoint] = bend;
    }, {posed: true});
  }
  /** Anchors fix a connector's chord and its evaluated angle depends on its
   * bend, so the arc is fitted through the pointer instead of from the start
   * tangent. Attached parts follow the curve; the slide position is unchanged. */
  _bendConnector(x, y, shape) {
    const factor = Math.abs(shape.bend) < 1e-7 ? 1 : 2 * Math.sin(shape.bend / 2) / shape.bend;
    const chord = shape.angle + shape.bend / 2, span = shape.length * factor, a = shape.start;
    const b = {x: a.x + span * Math.cos(chord), y: a.y + span * Math.sin(chord)};
    const ux = a.x - x, uy = a.y - y, vx = b.x - x, vy = b.y - y;
    if (Math.hypot(ux, uy) < 1e-6 || Math.hypot(vx, vy) < 1e-6 || Math.abs(span) < 1e-6) return false;
    // The tangent-chord angle is the supplement of the inscribed angle APB.
    const inscribed = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
    const side = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    const bend = Math.max(-Math.PI * 1.99, Math.min(Math.PI * 1.99, 2 * (Math.PI - inscribed) * (side < 0 ? 1 : -1)));
    return this._objectEdit('Bend joint', object => {
      if (!object.bend_flag) object.bends = this.figure.segments.map(s => s.bend_rad ?? 0);
      object.bend_flag = 1; object.bends[this.selectedJoint] = bend;
    }, {posed: true});
  }
  mirrorFigure(axis = 'horizontal') {
    if (!['horizontal', 'vertical'].includes(axis)) throw messageError(new Error(''), "errors.editorBuilderTopology.chooseAHorizontalOrVerticalFlip", {});
    if (this.selectedJoint >= 0 && (this.selectedObjects.length === 1 || this.branchSelected))
      return this.mirrorSelection(axis);
    if (this.selectedObjects.length > 1) return this.mirrorSelection(axis);
    return this._objectEdit('Flip figure', () => {
      const ids = new Set(this._drag.before.map(o => o.unique_id));
      for (const obj of this.frame.objects) if (ids.has(obj.unique_id)) {
        const figure = this.report.figure_types.find(f => f.figure_type_id === obj.figure_type_id);
        const previousRotation = obj._stykAnimationOrigin ? animationRotation(figure, obj) : 0;
        obj.angles = obj.angles.map(a => axis === 'vertical' ? -a : Math.PI - a);
        if (!obj.bend_flag) obj.bends = figure.segments.map(s => -(s.bend_rad ?? 0)); else obj.bends = obj.bends.map(b => -b);
        obj.bend_flag = 1; obj.image_text_flags = Number(!obj.image_text_flags); delete obj.runtime_segments;
        mirrorOriginSupport(figure, obj, axis);
        reflectAnimationOriginOffset(figure, obj, axis, previousRotation);
      }
    });
  }
  rotateFigure(radians) {
    if (this.selectedObjects.length > 1) return this.rotateSelection(radians);
    finite(radians, 'Rotation');
    return this._objectEdit('Rotate figure', () => {
      const ids = new Set(this._drag.before.map(o => o.unique_id));
      for (const child of this.frame.objects) if (ids.has(child.unique_id)) {
        child.angles = child.angles.map(a => a + radians); delete child.runtime_segments;
        rotateOriginSupport(this.report.figure_types.find(figure => figure.figure_type_id === child.figure_type_id), child, radians);
      }
    });
  }
  centerFigure() {
    if (!this.object) return false;
    let center = this.geometry.objects.get(this.selectedSlot)?.root;
    if (this.selectedObjects.length > 1) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const g of this.geometry.objects.values()) if (g && this.selectedUids.has(g.obj.unique_id)) for (const point of g.joints.values()) {
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
      }
      center = {x: (minX + maxX) / 2, y: (minY + maxY) / 2};
    }
    return this.moveSelection(this.report.canvas_width / 2 - center.x, this.report.canvas_height / 2 - center.y);
  }
  resetPose() { return this._objectEdit('Reset pose', () => {
    for (const obj of this.selectedObjects) {
      const figure = this.report.figure_types.find(f => f.figure_type_id === obj.figure_type_id);
      obj.angles = figure.segments.map(s => s.angle_rad); obj.len_flag = obj.bend_flag = 0; obj.lengths = []; obj.bends = []; delete obj.runtime_segments;
      resetOriginSupport(figure, obj);
    }
  }); }
  moveLayer(direction) { return this.moveSelectionLayer(direction); }
  joinTo(targetUid, handleId = 0) {
    if (!this.object) return false;
    const frame = this.selectionFrame, targetSlot = frame.objects.findIndex(o => o.unique_id === targetUid), slot = this.selectedSlot;
    const target = frame.objects[targetSlot], figure = this.report.figure_types.find(f => f.figure_type_id === target?.figure_type_id);
    if (!target || targetSlot === slot || ![0, ...figure.segments.map(s => s.segment_id)].includes(handleId)) throw messageError(new Error(''), "errors.editor.chooseAnotherFigureAndAValidJoint", {});
    for (let current = targetSlot; frame.objects[current]?.join;) {
      current = frame.objects[current].join.target_object_slot;
      if (current === slot) throw messageError(new Error(''), "errors.editor.joiningTheseFiguresWouldCreateACycle", {});
    }
    return this.transaction('Join figures', () => {
      this.object.join = {target_object_slot: targetSlot, target_unique_id: targetUid, target_handle_id: handleId};
    }, {structural: true});
  }
  unjoinFigure() {
    if (!this.object?.join) return false;
    const root = this.geometry.objects.get(this.selectedSlot)?.root;
    return this.transaction('Unjoin figure', () => {
      if (root) { this.object.root_x = root.x; this.object.root_y = root.y; }
      this.object.join = null;
    }, {structural: true});
  }
  joinFigure(targetUid, handleId = 0) { return targetUid === null ? this.unjoinFigure() : this.joinTo(targetUid, handleId); }
  _allSourceFrames() {
    const baseline = this.report._styk.simpleFrameDraft?.baseline;
    return [...this.report.keyframes, ...Object.values(this.report._styk.frameSources ?? {}), ...(baseline ? [baseline] : []), ...[...movieclipSourceFrames(this.report)].map(entry=>entry.frame)];
  }
  _prepareDraftTopology(typeId) {
    const state = this.report._styk.simpleFrameDraft, baseline = state?.baseline;
    if (!baseline) return;
    const instances = baseline.objects.filter(object => object.figure_type_id === typeId).map(object => object.unique_id);
    if (!instances.length) return;
    const affected = new Set(this._ikPoseSlots(baseline, resolveJoinSelection(baseline, instances).affectedSlots).map(slot => baseline.objects[slot].unique_id));
    // The lazy journal shares untouched objects with the working frame. A
    // shared rig operation visits both frames, so detach its affected poses
    // before either visit can mutate those aliases twice.
    const copy = {...baseline, objects:baseline.objects.map(object => affected.has(object.unique_id) ? snapshotPoseObject(object, {retainRuntime:true}) : object)};
    state.baseline = copy;
    if (this._frameDraft?.baseline === baseline) this._frameDraft.baseline = copy;
  }
  _restoreDraftTopologyAnimation(before) {
    this._restoreMovieclipSourceAnimations(before);
    if (!Object.hasOwn(before, 'animationBaseline') || !this.report._styk.simpleFrameDraft) return;
    this.report._styk.simpleFrameDraft.animationBaseline = before.animationBaseline;
    if (this._frameDraft) this._frameDraft.animationBaseline = before.animationBaseline;
  }
  _topologySnapshot(typeId, reference = null, sparse = false) {
    const key = entry => entry.draft ? 'simple-draft' : `${entry.sourceDepth??0}:${entry.sourceId??entry.index}`;
    const references = reference ? new Map(reference.frames.map(entry => [key(entry),
      new Set(entry.objects.map(object => object.unique_id))])) : null;
    const draft = this.report._styk.simpleFrameDraft;
    const entries = [...this.report.keyframes.map((frame, index) => ({frame, index})),
      ...Object.entries(this.report._styk.frameSources ?? {}).map(([sourceId, frame]) => ({frame, index: -1, sourceId})),
      ...(draft?.baseline ? [{frame:draft.baseline, index:draft.index, draft:true}] : []),...movieclipSourceFrames(this.report)];
    const sourceFigure = this.report.figure_types.find(f => f.figure_type_id === typeId);
    const snapshot = {figure: sparse ? {...clone({...sourceFigure, segments: []}), segments: sourceFigure.segments.map((segment,index) => sparse instanceof Set && sparse.has(index) ? clone(segment) : segment)} : clone(sourceFigure),
      frames: entries.map(({frame, index, sourceId, draft,sourceDepth}) => {
        let identities = references?.get(key({index, sourceId, draft,sourceDepth}));
        if (references && !identities) return null;
        if (!references) {
          const instances = frame.objects.filter(object => object.figure_type_id === typeId).map(object => object.unique_id);
          if (!instances.length) return null;
          identities = new Set(this._ikPoseSlots(frame, resolveJoinSelection(frame, instances).affectedSlots).map(slot => frame.objects[slot].unique_id));
        }
        return {index, ...(sourceId ? {sourceId} : {}), ...(draft ? {draft:true} : {}), ...(sourceDepth?{sourceDepth}:{}),objects: frame.objects.filter(object => identities.has(object.unique_id)).map(object => snapshotPoseObject(object, {retainRuntime:true}))};
      }).filter(Boolean)};
    // The draft journal retains this immutable table separately. Do not clone
    // the entire channel table with the affected rig poses during history replay.
    if (Object.hasOwn(draft ?? {}, 'animationBaseline'))
      Object.defineProperty(snapshot, 'animationBaseline', {value: draft.animationBaseline});
    const sources=[];let source=this.report._styk.movieclipSource?.document;
    while(source){sources.push(source._styk?.animation??null);source=source._styk?.movieclipSource?.document;}
    if(sources.length)snapshot.movieclipSourceAnimations=sources;
    const sheetAnimations=[];let document=this.report,depth=0;
    while(document){
      if(document._styk?.layerSheet)sheetAnimations.push({depth,animation:document._styk.layerSheet.legacyAnimation??null});
      document=document._styk?.movieclipSource?.document;depth++;
    }
    if(sheetAnimations.length)snapshot.sheetAnimations=sheetAnimations;
    return snapshot;
  }
  _restoreMovieclipSourceAnimations(snapshot){
    for(const {depth,animation} of snapshot.sheetAnimations??[]){
      let document=this.report;for(let i=0;i<depth;i++)document=document._styk.movieclipSource.document;
      const sheet={...document._styk.layerSheet};
      if(animation===null)delete sheet.legacyAnimation;else sheet.legacyAnimation=animation;
      document._styk.layerSheet=sheet;
    }
    let source=this.report._styk.movieclipSource?.document;
    for(const animation of snapshot.movieclipSourceAnimations??[]){
      if(animation===null)delete source._styk.animation;else source._styk.animation=animation;
      source=source._styk?.movieclipSource?.document;
    }
  }
  /** Edits the selected figure's definition, or `definition` when given. */
  _topologyEdit(label, mutate, {definition, appendOnly = false, segmentIndices, retainedGeometry, segmentMap, reversedGradients, preserveAnimationOrigins=false, originReRoot, originSplit, originSplits, originFreezeHandles} = {}) {
    if (!(definition ?? this.figure)) return false;
    if(isMovieclip(definition ?? this.figure))throw messageError(new Error(''), "errors.editor.openTheMovieclipToEditItsFigures", {});
    if (this._drag) this.commitDrag();
    const figure = definition ?? this.figure, index = this.report.figure_types.indexOf(figure), typeId = figure.figure_type_id;
    appendOnly = appendOnly && !figure._styk?.animationOrigin;
    if (figure._styk?.animationOrigin) segmentIndices = undefined;
    const sparse = segmentIndices ? new Set(segmentIndices) : appendOnly;
    const before = this._topologySnapshot(typeId, null, sparse), beforeSelection = this._selectionState(), beforeAnimation = this.report._styk.animation;
    this._prepareDraftTopology(typeId);
    try { mutate(figure); invalidateAnimationOriginLayout(figure); repairOriginSupport(this, before, figure, {originReRoot, originSplit, originSplits, originFreezeHandles}); repairTopologyStyles(this, before, figure, segmentMap, reversedGradients);
      if(!preserveAnimationOrigins&&originGeometryChanged(before.figure,figure))for(const entry of before.frames){
        const frame=this._sourceFrame(entry);
        this._synchronizeAnimationOrigins(frame,entry.objects,{force:true});
      }
      validateScene({...this.report, keyframes: this._allSourceFrames()}); } catch (error) {
      this.report.figure_types[index] = before.figure;
      if (beforeAnimation === undefined) delete this.report._styk.animation; else this.report._styk.animation = beforeAnimation;
      this._restoreDraftTopologyAnimation(before);
      for (const entry of before.frames) this._replaceObjects(entry.index, entry.objects, entry.sourceId, entry.draft,entry.sourceDepth);
      this._restoreSelection(beforeSelection); this._invalidate(); throw error;
    }
    return this._finishTopologyEdit(label, {figure, index, typeId, before, beforeSelection, beforeAnimation,
      sparse, segmentIndices, appendOnly, retainedGeometry});
  }
  /** The same history/publication owner for computed and adopted topology edits. */
  _finishTopologyEdit(label, {figure, index, typeId, before, beforeSelection, beforeAnimation,
    sparse = false, segmentIndices, appendOnly = false, retainedGeometry}) {
    figure.segment_count = figure.segments.length;
    // Native compressed ordering arrays no longer describe an edited topology.
    delete figure.segment_z_raw; delete figure.poly_z_raw;
    const after = this._topologySnapshot(typeId, before, sparse);
    if (segmentIndices) {
      before.figure.segments = segmentIndices.map(index => before.figure.segments[index]);
      after.figure.segments = segmentIndices.map(index => after.figure.segments[index]);
    }
    let appendCount;
    if (appendOnly) {
      appendCount = before.figure.segments.length;
      before.figure.segments = [];
      after.figure.segments = clone(after.figure.segments.slice(appendCount));
    }
    const retained = retainedGeometry ?? {previous:this._geometry ?? this._incremental?.previous, dirtySlots:this._geometry ? [] : this._incremental?.dirtySlots ?? []};
    this._record({kind: 'topology', label, index, before, after, appendCount, segmentIndices,
      beforeSelection, afterSelection: this._selectionState(), structural: true, timing: false,
      layerAnimationPatch: topologyAnimationPatch(beforeAnimation, this.report._styk.animation)});
    if (sparse && beforeAnimation === this.report._styk.animation) this._invalidateFigure(typeId,retained);
    else this._invalidate({timing:beforeAnimation !== this.report._styk.animation});
    this._emit('edit', {label, structural: true, definition: true}); return true;
  }
  /** Replace a reusable definition while retaining every instance's pose and identity. */
  replaceFigureDefinition(figureTypeId, definition, {label = 'Edit figure definition'} = {}) {
    const index = this.report.figure_types.findIndex(f => f.figure_type_id === figureTypeId);
    if (index < 0) throw messageError(new Error(''), "errors.editor.theFigureDefinitionDoesNotExist", {});
    if (!definition || !Array.isArray(definition.segments) || !definition.segments.length) throw messageError(new Error(''), "errors.editor.aFigureNeedsAtLeastOneSegment", {});
    if (this._drag) this.commitDrag();
    const oldFigure = this.report.figure_types[index], replacement = {...clone(definition), figure_type_id: figureTypeId};
    replacement.segment_count = replacement.segments.length;
    const before = this._topologySnapshot(figureTypeId), beforeSelection = this._selectionState(), beforeAnimation = this.report._styk.animation;
    const oldIndices = new Map(oldFigure.segments.map((s, i) => [s.segment_id, i]));
    const handles = new Set([0, ...replacement.segments.map(s => s.segment_id)]);
    this._prepareDraftTopology(figureTypeId);
    try {
      for (const frame of this._allSourceFrames()) {
        const detached = frame.objects.filter(o => o.join && !handles.has(o.join.target_handle_id) && frame.objects[o.join.target_object_slot]?.figure_type_id === figureTypeId);
        if (detached.length) {
          const geometry = buildGeometry(this.report, frame);
          for (const obj of detached) { const root = geometry.objects.get(obj.object_slot)?.root;
            if (root) { obj.root_x = root.x; obj.root_y = root.y; } obj.join = null;
          }
        }
        for (const obj of frame.objects) if (obj.figure_type_id === figureTypeId) {
          const oldAngles = obj.angles;
          obj.angles = replacement.segments.map(s => {
            const i = oldIndices.get(s.segment_id);
            return i === undefined ? s.angle_rad : s.angle_rad + oldAngles[i] - oldFigure.segments[i].angle_rad;
          });
          if (obj.len_flag) {
            const lengths = obj.lengths;
            obj.lengths = replacement.segments.map(s => { const i = oldIndices.get(s.segment_id), base = oldFigure.segments[i]?.length;
              return i === undefined ? s.length : Math.abs(base) > 1e-9 ? s.length * lengths[i] / base : lengths[i]; });
          }
          if (obj.bend_flag) {
            const bends = obj.bends;
            obj.bends = replacement.segments.map(s => { const i = oldIndices.get(s.segment_id);
              return (s.bend_rad ?? 0) + (i === undefined ? 0 : bends[i] - (oldFigure.segments[i].bend_rad ?? 0)); });
          }
          delete obj.runtime_segments;
        }
      }
      this.report.figure_types[index] = replacement; repairOriginSupport(this, before, replacement); repairTopologyStyles(this, before, replacement);
      if(originGeometryChanged(oldFigure,replacement))for(const entry of before.frames){
        const frame=this._sourceFrame(entry);
        this._synchronizeAnimationOrigins(frame,entry.objects,{force:true});
      }
      validateScene({...this.report, keyframes: this._allSourceFrames()});
      if (this.object?.figure_type_id === figureTypeId) this.selectedJoint = Math.min(this.selectedJoint, replacement.segments.length - 1);
      this._record({kind: 'topology', label, index, before, after: this._topologySnapshot(figureTypeId, before), beforeSelection,
        afterSelection: this._selectionState(), structural: true, timing: false,
        layerAnimationPatch: topologyAnimationPatch(beforeAnimation, this.report._styk.animation)});
      this._invalidate({timing:beforeAnimation !== this.report._styk.animation}); this._emit('edit', {label, structural: true, definition: true}); return replacement;
    } catch (error) {
      this.report.figure_types[index] = before.figure;
      if (beforeAnimation === undefined) delete this.report._styk.animation; else this.report._styk.animation = beforeAnimation;
      this._restoreDraftTopologyAnimation(before);
      for (const entry of before.frames) this._replaceObjects(entry.index, entry.objects, entry.sourceId, entry.draft,entry.sourceDepth);
      this._restoreSelection(beforeSelection); this._invalidate(); throw error;
    }
  }
  /** Insert a movable midpoint while keeping the existing endpoint handle intact. */
  splitSegment(fraction = 0.5) {
    return this.splitBuilderSegments({branch: false, fraction});
  }
  /** Re-root a rig without moving its visible joints; external attachments detach. */
  setOrigin(handleId = this.figure?.segments[this.selectedJoint]?.segment_id) {
    if(this.figure?.segments.some(s=>s._stykRig))throw messageError(new Error(''), "errors.editor.setTheFigureOriginBeforeConfiguringRigRelationships", {});
    const figure = this.figure; if (!figure || handleId === 0) return false;
    if (!Number.isInteger(handleId) || !figure.segments.some(s => s.segment_id === handleId)) throw messageError(new Error(''), "errors.editor.selectAValidJointForTheNewOrigin", {});
    const adjacency = new Map();
    const add = (node, other, index) => { const list = adjacency.get(node) ?? []; list.push({other, index}); adjacency.set(node, list); };
    figure.segments.forEach((segment, index) => { add(segment.parent_id, segment.segment_id, index); add(segment.segment_id, segment.parent_id, index); });
    const remap = id => id === 0 ? handleId : id === handleId ? 0 : id;
    const visited = new Set([handleId]), queue = [handleId], orientation = new Map();
    for (let q = 0; q < queue.length; q++) for (const edge of adjacency.get(queue[q]) ?? []) {
      if (visited.has(edge.other)) continue;
      visited.add(edge.other); queue.push(edge.other);
      orientation.set(edge.index, {parent: remap(queue[q]), id: remap(edge.other), reverse: figure.segments[edge.index].parent_id !== queue[q]});
    }
    for (const [index, edge] of orientation) if (edge.reverse && ['image', 'text'].includes(figure.segments[index].segment_type))
      throw messageError(new Error(''), "errors.editor.chooseAnOriginWhosePathContainsOrdinaryLines", {});
    const previousOrigin = figure._styk?.animationOrigin;
    const referenceIndex = previousOrigin?.support ? null : previousOrigin ? figure.segments.findIndex(segment => segment.segment_id === previousOrigin.rotationHandleId) : 0;
    const animationOrigin = previousOrigin?.support ? previousOrigin : {handleId: remap(previousOrigin?.handleId ?? 0),
      rotationHandleId: orientation.get(referenceIndex).id,
      reversed: Boolean(previousOrigin?.reversed) !== orientation.get(referenceIndex).reverse};
    return this._topologyEdit('Set figure origin', fig => {
      for (const frame of this._allSourceFrames()) {
        if (!frame.objects.some(o => o.figure_type_id === fig.figure_type_id)) continue;
        const geometry = buildGeometry(this.report, frame);
        // Retarget external children while all joins still use the old handle table.
        for (const object of frame.objects) if (object.join && frame.objects[object.join.target_object_slot]?.figure_type_id === fig.figure_type_id)
          object.join.target_handle_id = remap(object.join.target_handle_id);
        for (const object of frame.objects) if (object.figure_type_id === fig.figure_type_id) {
          let pivot = object._stykAnimationOrigin && !object.join ? object._stykAnimationOrigin :
            geometry.objects.get(object.object_slot)?.joints.get(previousOrigin?.handleId ?? 0);
          if (previousOrigin && object._stykAnimationOrigin && object.join) {
            const root = geometry.objects.get(object.object_slot)?.root, offset = animationOriginOffset(fig, object);
            if (root) pivot = {x: root.x + offset.x, y: root.y + offset.y};
          }
          if (pivot) object._stykAnimationOrigin = {...object._stykAnimationOrigin, x: pivot.x, y: pivot.y};
          const origin = geometry.objects.get(object.object_slot)?.joints.get(handleId);
          if (origin) { object.root_x = origin.x; object.root_y = origin.y; }
          object.join = null;
          for (const [index, edge] of orientation) if (edge.reverse) {
            const bend = object.bend_flag ? object.bends[index] : (fig.segments[index].bend_rad ?? 0);
            object.angles[index] += bend + Math.PI; if (object.bend_flag) object.bends[index] = -bend;
          }
          delete object.runtime_segments;
        }
      }
      fig.segments = fig.segments.map((segment, index) => {
        const edge = orientation.get(index), out = {...segment, parent_id: edge.parent, segment_id: edge.id};
        if (edge.reverse) { out.angle_rad += (out.bend_rad ?? 0) + Math.PI; out.bend_rad = -(out.bend_rad ?? 0); }
        return edge.reverse ? reverseGradientEndpoints(out) : out;
      });
      fig._styk = {...fig._styk, animationOrigin};
      for (const poly of fig.polyfills ?? []) {poly.segment_ids = poly.segment_ids.map(remap);remapSurface(poly,remap);}
      this.selectedJoint = -1;
    }, {preserveAnimationOrigins: true, originReRoot: {handleId, mappings: new Map(figure.segments.map((segment,index) => [segment.segment_id, orientation.get(index)]))}, segmentMap: new Map(figure.segments.map((segment, index) => [segment.segment_id, [orientation.get(index).id]])),
      reversedGradients: new Set(figure.segments.filter((segment, index) => orientation.get(index).reverse).map(segment => segment.segment_id))});
  }
  addSegment(options = {}) { return this.addSegments([options])[0]; }
  /** Append a connected pen stroke as one topology command. */
  addSegments(specs) {
    if (!Array.isArray(specs) || !specs.length) return [];
    if ((this.figure?.segments.length ?? 0) + specs.length > 30000) throw messageError(new Error(''), "errors.editorRigConstraints.figureSegmentCapacityReached", {});
    const prepared = specs.map(({parentId, type = 'line', length = 50, angle = 0, thickness, start}) => {
      finite(length, 'Segment length'); finite(angle, 'Segment angle'); if (thickness !== undefined) finite(thickness, 'Segment thickness');
      if (length < 0 || thickness < 0) throw messageError(new Error(''), "errors.editor.segmentLengthAndThicknessCannotBeNegative", {});
      const code = typeof type === 'number' ? type : {line:0,circle:1,circleFill:3,circleClear:4,squareLine:6}[type];
      if (![0,1,3,4,6].includes(code)) throw messageError(new Error(''), "errors.editor.chooseALineOrCircleSegment", {});
      return {parentId,type,length,angle,thickness,start,code};
    });
    const {parentId,type,length,angle,thickness,start,code} = prepared[0];
    if ((this.report._styk?.layerSheet || this.animationChannels.length || this.report._styk?.movieclipSource) && !this.figure && !this._authoredPoseEdit) {
      let result; this.transaction('Draw figure', () => { result = this.addSegments(specs); }, {structural: true}); return result;
    }
    finite(length, 'Segment length'); finite(angle, 'Segment angle'); if (thickness !== undefined) finite(thickness, 'Segment thickness');
    if (length < 0 || thickness < 0) throw messageError(new Error(''), "errors.editor.segmentLengthAndThicknessCannotBeNegative", {});
    const parent = parentId ?? this.figure?.segments[this.selectedJoint]?.segment_id ?? 0;
    if (parent !== 0 && !this.figure?.segments.some(s => s.segment_id === parent)) throw messageError(new Error(''), "errors.editor.theSegmentParentDoesNotExist", {});
    const handles = new Set([0, ...(this.figure?.segments ?? []).map(s => s.segment_id)]);
    for (const item of prepared) if (item.parentId != null && !handles.has(item.parentId)) throw messageError(new Error(''), "errors.editor.theSegmentParentDoesNotExist", {});
    let nextId = Math.max(0, ...handles) + 1;
    if (nextId + specs.length - 1 > 65535) throw messageError(new Error(''), "errors.editorBuilderBranch.figureJointCapacityReached", {});
    const make = (item, id, parent, color, z) => ({segment_id:id,parent_id:parent,length:item.length,angle_rad:item.angle,thickness:item.thickness ?? 8,bend_rad:0,primitive_code:item.code,aux_code:0,flags:item.code,segment_type:[1,3,4].includes(item.code)?'circle':'line',segment_kind:['line','circle','image','circleFill','circleClear','text','squareLine'][item.code],color_rgb:clone(color),transparency:0,visible:(item.thickness ?? 8)>0||item.code>0,z_order:z});
    if (!this.figure) {
      const x = finite(start?.x ?? this.report.canvas_width / 2, 'Figure X');
      const y = finite(start?.y ?? this.report.canvas_height / 2, 'Figure Y');
      const before = {figures: [], frame: clone(this.frame)}, beforeSelection = this._selectionState();
      const figureIndex = this.report.figure_types.length;
      const typeId = Math.max(0, ...this.report.figure_types.map(f => f.figure_type_id)) + 1;
      const segments = prepared.map((item,i) => make(item,i+1,item.parentId ?? (i ? i : 0),[106,77,234],i+1));
      const figure = {figure_type_id:typeId,name:specs.length>1?'Chain':([1,3,4].includes(code)?'Circle':'Line'),segment_count:segments.length,segments,polyfills:[],image_assets:[],text_assets:[]};
      const uid = this._identity(), order = frameOrder(this.frame); this.report.figure_types.push(figure);
      this.frame.objects.push(createObject(figure, uid, x, y)); setOrder(this.frame, [...order, uid]); normalizeFrame(this.frame);
      this.selectedUid = uid; this.selectedJoint = segments.length - 1;
      this._record({kind: this._authoredPoseEdit?.transaction ? 'import' : 'figure-splice', label: 'Draw figure', index: this.frameIndex, figureIndex, before,
        after: {figures: [clone(figure)], frame: clone(this.frame)}, beforeSelection,
        afterSelection: this._selectionState(), structural: true, timing: false});
      this._invalidate(); this._emit('edit', {label: 'Draw figure', structural: true}); return segments;
    }
    // Resolve per-instance edits once, then inherit by native parent ID, including
    // links created earlier in this chain. Explicit widths still win.
    const styles = new Map(resolveInstanceFigure(this.figure, this.object).segments.map(segment => [segment.segment_id, segment]));
    const result = prepared.map((item,i) => {
      const parentHandle = item.parentId ?? (i ? nextId+i-1 : parent), source = styles.get(parentHandle);
      const segment = make({...item, thickness:item.thickness ?? source?.thickness}, nextId+i, parentHandle,
        source?.color_rgb ?? this.figure.segments[0]?.color_rgb ?? [48,48,56], this.figure.segments.length+i+1);
      styles.set(segment.segment_id, segment);
      return segment;
    });
    if(hasRigConstraints(this.figure)){
      const spaces=new Map(this.geometry.objects.get(this.selectedSlot).segments.map(s=>[s.seg.segment_id,s.rigChildSpace??{rotation:s.rigRotation??0}]));
      result.forEach((s,i)=>{
        const space=spaces.get(s.parent_id)??{rotation:0};
        const target=authoredRigTarget({start:{x:0,y:0},rigSpace:space},s.length*Math.cos(s.angle_rad),s.length*Math.sin(s.angle_rad));
        s.angle_rad=Math.atan2(target.y,target.x);s.length=Math.hypot(target.x,target.y);
        prepared[i].angle=s.angle_rad;prepared[i].length=s.length;spaces.set(s.segment_id,space);
      });
    }
    this._topologyEdit(specs.length > 1 ? 'Draw chain' : 'Add segment', figure => {
      figure.segments.push(...result);
      for (const frame of this._allSourceFrames()) for (const obj of frame.objects) if (obj.figure_type_id === figure.figure_type_id) {
        for (const item of prepared) {obj.angles.push(item.angle); if(obj.len_flag)obj.lengths.push(item.length);if(obj.bend_flag)obj.bends.push(0);}
        delete obj.runtime_segments;
      }
      this.selectedJoint = figure.segments.length - 1;
    }, {appendOnly: true}); return result;
  }
  deleteSegment({handleIds, branch = true} = {}) {
    if (!this.figure || this.selectedJoint < 0 || !this.figure.segments[this.selectedJoint]) return false;
    const figure = this.figure;
    const ids = new Set(handleIds ?? [figure.segments[this.selectedJoint].segment_id]);
    const valid = new Set(figure.segments.map(segment => segment.segment_id));
    if (!ids.size || [...ids].some(id => !valid.has(id))) throw messageError(new Error(''), "errors.editor.selectExistingSegmentsToDelete", {});
    if (branch) {
      const children = new Map();
      for (const segment of figure.segments) {const list = children.get(segment.parent_id) ?? [];list.push(segment.segment_id);children.set(segment.parent_id,list);}
      const queue = [...ids];
      for (let i=0;i<queue.length;i++) for (const child of children.get(queue[i]) ?? []) if (!ids.has(child)) {ids.add(child);queue.push(child);}
    }
    if (ids.size === figure.segments.length) throw messageError(new Error(''), "errors.editorBuilderTopology.aFigureNeedsAtLeastOneSegmentDelete", {});
    return this._topologyEdit(branch ? 'Delete segment branches' : 'Delete selected segments', fig => {
      const keep = fig.segments.map((s, i) => ids.has(s.segment_id) ? -1 : i).filter(i => i >= 0);
      // Resolve every detached child before changing its parent's handle table.
      for (const frame of this._allSourceFrames()) {
        const detached = frame.objects.filter(o => o.join && ids.has(o.join.target_handle_id) && frame.objects[o.join.target_object_slot]?.figure_type_id === fig.figure_type_id);
        if (detached.length) {
          const geometry = buildGeometry(this.report, frame);
          for (const obj of detached) { const root = geometry.objects.get(frame.objects.indexOf(obj))?.root;
            if (root) { obj.root_x = root.x; obj.root_y = root.y; } obj.join = null;
          }
        }
        for (const obj of frame.objects) if (obj.figure_type_id === fig.figure_type_id) {
          obj.angles = keep.map(i => obj.angles[i]); if (obj.len_flag) obj.lengths = keep.map(i => obj.lengths[i]);
          if (obj.bend_flag) obj.bends = keep.map(i => obj.bends[i]); delete obj.runtime_segments;
        }
      }
      const parents = new Map(fig.segments.map(segment => [segment.segment_id, segment.parent_id]));
      for (const index of keep) {
        const segment = fig.segments[index];
        while (ids.has(segment.parent_id)) segment.parent_id = parents.get(segment.parent_id);
      }
      this._segmentSelection = null;
      protectSurfaceReferences(fig,ids);
      fig.segments = keep.map(i => fig.segments[i]); fig.polyfills = (fig.polyfills ?? []).filter(poly => !surfaceHandles(poly).some(id => ids.has(id)));
      this.selectedJoint = -1;
    });
  }
  setFPS(value) {
    if (!Number.isInteger(value) || value < 1 || value > 1000) throw messageError(new Error(''), "errors.editor.fpsMustBeAnIntegerBetween1And", {});
    return this._fields('Change frame rate', {fps: value, ...(this.report.version < 5 ? {frame_delay_ms: Math.round(1000 / value)} : {})}, {timing: true});
  }
  _fields(label, patch, {timing = false} = {}) {
    const before = Object.fromEntries(Object.keys(patch).map(key => [key, this.report[key]])), selection = this._selectionState();
    if (same(before, patch)) return false;
    Object.assign(this.report, patch); this._invalidate({timing});
    this._record({kind: 'fields', label, before, after: clone(patch), beforeSelection: selection, afterSelection: selection, structural: false, timing});
    this._emit('edit', {label, timing, projectFields: Object.keys(patch)}); return true;
  }
  setFrameDuration(ticks) {
    if(this.report._styk?.layerSheet)return this.sheetSetDuration(ticks);
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > 65535) throw messageError(new Error(''), "errors.editorRanges.keyframeDurationMustBe065535Frames", {});
    return Boolean(this.setFramesDuration([this.frameIndex], ticks));
  }
  setCanvasSize(width, height) {
    if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 100000)) throw messageError(new Error(''), "errors.editor.canvasDimensionsMustBe1100000Pixels", {});
    return this._fields('Resize canvas', {canvas_width: width, canvas_height: height});
  }
  updateProject(patch) {
    for (const key of Object.keys(patch)) if (!['canvas_width', 'canvas_height', 'fps'].includes(key)) throw messageError(new Error(''), "errors.editor.projectSettingIsNotEditableHere", {key: key});
    const width = patch.canvas_width ?? this.report.canvas_width, height = patch.canvas_height ?? this.report.canvas_height;
    if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 100000)) throw messageError(new Error(''), "errors.editor.canvasDimensionsMustBe1100000Pixels", {});
    if ('fps' in patch && (!Number.isInteger(patch.fps) || patch.fps < 1 || patch.fps > 1000)) throw messageError(new Error(''), "errors.editor.fpsMustBeAnIntegerBetween1And", {});
    const fields = {...patch};
    if ('fps' in fields && this.report.version < 5) fields.frame_delay_ms = Math.round(1000 / fields.fps);
    return this._fields('Project settings', fields, {timing: 'fps' in fields});
  }
  setBackgroundColor(color) {
    if(this.report._styk?.layerSheet&&!this._authoredPoseEdit)return this._sheetPropertyEntries([{target:{kind:'scene'},property:'color',tick:this.tick,value:color}],'Background color');
    if (!Number.isInteger(color) || color < 0 || color > 0xffffffff) throw messageError(new Error(''), "errors.editor.backgroundColorMustBeAnArgbValue", {});
    if (this._drag) this.commitDrag();
    const before = {fields: {backgrounds: clone(this.report.backgrounds ?? [])}, frame: clone(this.frame)}, beforeSelection = this._selectionState();
    // Reuse an identical swatch. Changing a frame's background never recolors
    // another frame that happened to share its original background table entry.
    let background = this.report.backgrounds?.find(b => b.kind === 2 && b.color === color);
    if (!background) {
      background = {background_id: Math.max(0, ...(this.report.backgrounds ?? []).map(b => b.background_id)) + 1,
        kind: 2, color, name: `Color ${color.toString(16).slice(-6).toUpperCase()}`};
      this.report.backgrounds = [...(this.report.backgrounds ?? []), background];
    }
    this.frame.background_id = background.background_id; this.frame.background_id_b = 0; this.frame.background_mix = 0;
    const after = {fields: {backgrounds: clone(this.report.backgrounds)}, frame: clone(this.frame)};
    if (same(before, after)) return false;
    this._record({kind: 'project', label: 'Background color', index: this.frameIndex, before, after,
      beforeSelection, afterSelection: this._selectionState(), structural: false, timing: false});
    this._invalidate(); this._emit('edit', {label: 'Background color'}); return true;
  }
  importBackground(background) {
    if(this.report._styk?.layerSheet&&!this._authoredPoseEdit){let result;this.transaction('Import background',()=>{result=this.importBackground(background);});return result;}
    const source = background?.background ?? background;
    if (!source || ![0, 1, 2, 3, 4].includes(source.kind)) throw messageError(new Error(''), "errors.editor.expectedADecodedImageColorOrGradientBackground", {});
    if (this._drag && !this._authoredPoseEdit?.transaction) this.commitDrag();
    const imported = clone(source);
    imported.background_id = Math.max(0, ...(this.report.backgrounds ?? []).map(bg => bg.background_id)) + 1;
    imported.name ||= 'Background';
    const backgrounds = [...(this.report.backgrounds ?? []), imported], frame = clone(this.frame);
    Object.assign(frame, {background_id: imported.background_id, background_id_b: 0, background_mix: 0});
    validateScene({...this.report, backgrounds, keyframes: [frame]});
    const before = {fields: {backgrounds: clone(this.report.backgrounds ?? [])}, frame: clone(this.frame)}, beforeSelection = this._selectionState();
    this.report.backgrounds = backgrounds; this.report.keyframes[this.frameIndex] = frame;
    this._record({kind: 'project', label: 'Import background', index: this.frameIndex, before,
      after: {fields: {backgrounds: clone(backgrounds)}, frame: clone(frame)}, beforeSelection,
      afterSelection: this._selectionState(), structural: false, timing: false});
    this._invalidate(); this._emit('edit', {label: 'Import background'}); return imported;
  }
  importFigure(document, {position} = {}) {
    if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) throw messageError(new Error(''), "errors.editorRangeCommands.chooseAValidCanvasPosition", {});
    const incoming=document?.document??document?.report??document;
    const movieclipInsertion=!this._insertingMovieclip&&incoming?.figure_types?.some(isMovieclip);
    const source = document?.document ?? document?.report ?? document;
    const figures = source.figure_types ?? (source.segments ? [source] : []);
    if (!figures.length) throw messageError(new Error(''), "errors.editor.theImportedFileContainsNoFigureDefinitions", {});
    if(figures.some(isMovieclip))prepareEditorLoad(source);
    // Validate imported movieclips once before their placement checks.
    const insert = () => {
      const sourceFrame = source.keyframes?.[0], sources = sourceFrame?.objects?.length ? sourceFrame.objects : [createObject(figures[0], 1, 0, 0)];
      const bySlot = new Map(sources.map((object, index) => [object.object_slot ?? index, object.unique_id]));
      const objects = sources.map(object => ({...object, join: object.join && bySlot.has(object.join.target_object_slot)
        ? {...object.join, target_unique_id: bySlot.get(object.join.target_object_slot)} : null}));
      // Imported files and clipboard pastes use the same atomic planner. History
      // owns only new definitions and affected poses, independent of library size.
      const result = this.applyFigureRange({kind:'paste', importing:true, newIdentities:true,
        position:position ?? {x:this.report.canvas_width/2,y:this.report.canvas_height/2},
        clipboard:{objects,figures,order:sourceFrame?.objects?.length ? frameOrder(sourceFrame) : objects.map(object=>object.unique_id)}},
        {atPlayhead:true,label:'Import figure'});
      this._selectedUid = result.insertedUids[0] ?? null;
      return this.object;
    };
    return movieclipInsertion ? this._insertMovieclip(insert) : insert();
  }
  serialize() {
    const document = clone(this.report); document._styk = {...document._styk, format: 'StykAnimate', format_version: 1, name: this.name};
    for (const frame of document.keyframes) for (const object of frame.objects) delete object.runtime_segments;
    syncDerived(document); validateScene(document); validateLayerState(document._styk.layers); validateAnimationDocument(document); validateFrameIdentities(document); validateLayerSheet(document); return document;
  }
}

Object.assign(Editor.prototype, editorRangeMethods);
Object.assign(Editor.prototype, editorColorMethods);
Object.assign(Editor.prototype, editorBuilderMethods);
Object.assign(Editor.prototype, editorCombineMethods);
Object.assign(Editor.prototype, editorDisconnectMethods);
Object.assign(Editor.prototype, editorRigMethods);
Object.assign(Editor.prototype, editorRigConstraintMethods, editorSpatialMethods);
Object.assign(Editor.prototype, editorSelectionMethods);
Object.assign(Editor.prototype, editorLayerMethods, editorLayerFolderMethods, editorLayerFocusMethods);
Object.assign(Editor.prototype, editorLayerAsyncMethods);
Object.defineProperties(Editor.prototype, Object.getOwnPropertyDescriptors(editorAnimationMethods));
Object.assign(Editor.prototype, editorFrameMethods);
Object.assign(Editor.prototype, editorFrameClipboardMethods);
Object.assign(Editor.prototype, editorAuthoredPoseMethods);
Object.assign(Editor.prototype, editorCameraMethods, editorCameraMotionMethods);
Object.assign(Editor.prototype, editorHandleEditMethods);
Object.assign(Editor.prototype, editorIKMethods);
Object.assign(Editor.prototype, editorMovieclipMethods);
Object.assign(Editor.prototype, editorLayerSheetMethods);
Object.assign(Editor.prototype, editorDrawingMethods);
Object.assign(Editor.prototype, editorFigureTransformMethods);
Object.assign(Editor.prototype, editorDuplicateDragMethods);
Object.assign(Editor.prototype, editorRangeCommandMethods);
Object.assign(Editor.prototype, editorSceneMethods);
Object.assign(Editor.prototype, editorVfxMethods, editorVfxClipMethods);
Object.assign(Editor.prototype, editorHandleCommandMethods);
Object.assign(Editor.prototype, editorInbetweenMethods);
Object.assign(Editor.prototype, editorInbetweenAsyncMethods);
Object.assign(Editor.prototype, editorOriginMutationMethods);
Object.assign(Editor.prototype, editorMotionPathMethods);
Object.assign(Editor.prototype, editorTweenerMethods);
Object.assign(Editor.prototype, editorAudioMethods);
Object.assign(Editor.prototype, editorSessionMethods);
Object.defineProperties(Editor.prototype, Object.getOwnPropertyDescriptors(editorFrameDraftMethods));
Editor.prototype._topologyEdit.frameDraftAware = true;
Editor.prototype.replaceFigureDefinition.frameDraftAware = true;
installFrameDraftPreflights(Editor);
export {createDemo, emptyDocument, defaultFigure};
