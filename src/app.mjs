import {installColorPickers} from './color-picker.mjs';
import {installMovieclipUI} from './movieclip-ui.mjs';
import {isMovieclip} from './movieclips.mjs';
import {animationPropertyState} from './animation-property-state.mjs';
import {segmentPaint, parseColor, hexColor, backgroundPaint, paintBackground} from './paint.mjs';
import {resolveInstanceFigure, polygonIdentity} from './animation-style.mjs';
import { applicationMenuItems } from "./application-menu.mjs";
import { Editor } from "./editor.mjs";
import { createRenderer } from "./renderer.mjs";
import { Timeline } from "./layer-timeline.mjs";
import { SheetFilmstrip as SimpleTimeline } from "./sheet-filmstrip.mjs";
import { OnionSkinCache } from "./onion-skin.mjs";
import {hasPinnedIK} from './ik.mjs';
import { OnionControls } from "./onion-controls.mjs";
import { ThumbnailRenderer } from "./thumbnail-renderer.mjs";
import { BackgroundDialog } from "./background-dialog.mjs";
import { ImportClient } from "./import-client.mjs";
import { encodeWebM } from "./video-export.mjs";
import { encodeNativeVideo } from "./native-video-export.mjs";
import { encodeVfwVideo } from "./vfw-video-export.mjs";
import { VfwExportControls } from "./vfw-export-controls.mjs";
import { getExportCapabilities } from "./export-capabilities.mjs";
import { PlaybackCache } from "./playback.mjs";
import { PlaybackMetrics } from "./playback-metrics.mjs";
import { DesktopTelemetryClient } from './telemetry-core.mjs';
import { PrivacyUI } from './privacy-ui.mjs';
import { UpdateUI } from './update-ui.mjs';
import { ReleaseSplash } from './support-ui.mjs';
import { EditableScenePreparation } from './editable-scene-preparation.mjs';
import { TextDialog } from "./text-dialog.mjs";
import { SegmentValuesDialog } from "./segment-values-dialog.mjs";
import { SpritePlacementDialog } from "./sprite-placement-dialog.mjs";
import { PolygonDraft } from "./polygon-draft.mjs";
import { polygonPreviewPoints } from "./polygon-preview.mjs";
import {
  isBuilderContext,
  builderBackgroundColor,
  builderShowsStaticHandles,
  drawBuilderHighlight,
} from "./builder-aids.mjs";
import { InsertInbetweenDialog } from "./insert-inbetween-dialog.mjs";
import { materializeSimpleFrameDraftForPivot } from "./pivot-frame-draft.mjs";
import { installNativeFrameClipboard } from "./frame-clipboard-storage.mjs";
import { ClipboardWorkerClient } from "./clipboard-worker-client.mjs";
import { exportAnimation } from "./image-export.mjs";
import { defaultGIFDither } from "./gif-options.mjs";
import { ExportFrameRenderer } from "./export-frame-renderer.mjs";
import {
  EXPORT_SMOOTHING,
  normalizeExportSmoothing,
} from "./export-sampling.mjs";
import { initWorkspaceLayout } from "./studio-layout.mjs";
import { initStudioShell, mountExportFlow } from "./studio-shell.mjs";
import { inspectorView } from "./inspector-view.mjs";
import { updateInspectorDOM } from "./inspector-dom.mjs";
import {syncCameraControls, drawCameraMonitor} from './camera-monitor.mjs';
import { AssetLibrary } from "./asset-library.mjs";
import { UserLibrary } from './user-library.mjs';
import { PropertyControls } from "./property-controls.mjs";
import {
  canEditNativeProperty,
  beginNativePropertyEdit,
  previewNativePropertyEdit,
  commitNativePropertyEdit,
  cancelNativePropertyEdit,
  getNativePropertyValue,
} from "./native-property-edit.mjs";
import {
  getPivotHandles,
  PIVOT_HANDLE_COLORS,
  pickCanvasHandle,
  invalidatePivotHandleTopology,
} from "./canvas-interactions.mjs";
import {
  cameraViewport,
  pickCameraHandle,
  cameraDragDelta,
  cameraKeyboardDelta,
  cameraHandleCursor,
  drawCameraViewport,
} from "./camera-overlay.mjs";
import { EditorSettings, normalizeEditorSettings } from "./settings.mjs";
import { AppLocalization } from "./localization-bindings.mjs";
import { layerIdForUid, layerVisible, layerLocked } from "./layers.mjs";
import { DocumentExporter } from "./document-export.mjs";
import { writeNativeBlob, readNativeRecovery } from "./native-files.mjs";
import { objectBounds } from "./renderer-geometry.mjs";
import {
  imageFileToFigure,
  imageFileToBackground,
} from "./media-authoring.mjs";
import { icon, hydrateIcons } from "./icons.mjs";
import { buildGeometry, evaluatedFrame, shortest } from "./pivot/geometry.mjs";
import {
  cameraIsIdentity,
  gradientAngleFromBackground,
  inverseCameraScale,
} from "./pivot/background.mjs";

const $ = (id) => document.getElementById(id),
  esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const editor = new Editor({ demo: true, propertyChannels: true, layerTimeline: true }),
  desktop = window.stykDesktop,
  importer = new ImportClient(),
  documentExporter = new DocumentExporter(),
  clipboardWorker = new ClipboardWorkerClient(),
  preparedScenes = new WeakMap(),
  exportJobs = new Set();
editor.setFrameClipboardWorker(clipboardWorker);
function interruptRecovery() {
  for (const job of exportJobs) if (job.recovery) job.controller.abort();
  clearTimeout(state.recoveryTimer);
  if (editor.dirty) scheduleRecovery();
}
async function runDocumentExport(format, consume, { recovery = false } = {}) {
  if (!recovery) finishCurrentEdit();
  const controller = new AbortController(),
    job = { controller, recovery };
  exportJobs.add(job);
  const metric = recovery ? 'recovery' : format === 'styk' ? 'save' : 'export';
  const started = performance.now();
  if (!recovery) telemetry.count(metric + '_started');
  try {
    const blob = await documentExporter.export(recovery ? editor.movieclipProjectReport() : editor.report, {
      format,
      name: recovery ? editor._movieclipScopes?.[0]?.parent.name ?? editor.name : editor.name,
      sourceId: state.sourceId,
      figureTypeId: editor.object?.figure_type_id,
      figureUid: editor.selectedUid,
      tick: editor.tick,
      signal: controller.signal,
      getRevision: () => `${editor.revision}:${editor.frameDraftRevision}`,
    });
    telemetry.timing(metric + '_ms', performance.now() - started);
    const saved = await consume(blob, controller.signal);
    if (recovery) { if (saved) telemetry.count('recovery_saved'); }
    else {
      telemetry.count(metric + (saved ? '_succeeded' : '_cancelled'));
      if (saved) { telemetry.milestone(metric === 'save' ? 'first_save' : 'first_export'); if (metric === 'export') telemetry.count(['piv', 'stk'].includes(format) ? 'export_pivot' : 'export_native'); }
    }
    return saved;
  } catch (error) {
    if (!recovery || error.name !== 'AbortError') telemetry.count(metric + (error.name === 'AbortError' ? '_cancelled' : '_failed'));
    if (error.name !== 'AbortError') telemetry.error(error, metric);
    throw error;
  } finally {
    exportJobs.delete(job);
    state.lastExport = documentExporter.lastTimings;
  }
}
const state = {
  renderer: null,
  view: { x: 0, y: 0, scale: 1 },
  playing: false,
  previewing: false,
  loop: true,
  onion: false,
  handles: true,
  tool: "select",
  rigMode: "move",
  builderBranch: false,
  builderShiftHeld: false,
  locked: new Set(),
  hidden: new Set(),
  sourceId: null,
  documentToken: null,
  dirtyRender: true,
  drag: null,
  space: false,
  importing: false,
  samples: [],
  search: "",
  activeTab: "layers",
  inspectorTab: "design",
  inspectorContext: "figure",
  selectedTrackId: "layer-1",
  settings: normalizeEditorSettings({}),
  lastImport: null,
  renderSamples: [],
  lastPresent: 0,
  drawCalls: 0,
  recoveryTimer: null,
  loadedName: null,
  playbackPacket: null,
  playbackRevision: null,
  playbackScale: null,
  loopRange: null,
  buffering: false,
  backgroundPending: null,
  rangeIndices: [],
  applyRange: false,
  scrubbing: false,
  cameraGuides: true,
};
const viewport = $("viewport"),
  canvas = $("scene"),
  overlay = $("overlay"),
  ctx = overlay.getContext("2d"),
  images = new Map();
hydrateIcons();
let timelineUI,
  studioShell,
  propertyControls,
  editorSettings,
  appLocalization,
  vfwExportControls,
  workspaceLayout,
  assetLibrary,
  toastTimer,
  raf = 0,
  playStart = 0,
  playTick = 0,
  lastUI = 0,
  importSequence = 0,
  canvasPointerId = null,
  inspectorDisclosureOwner = null,
  spritePlacementDialog,
  spriteImportController;
let warmTimer = null,
  playDeadline = 0,
  playStarted = false,
  uiScheduled = 0;
const playbackMetrics = new PlaybackMetrics();
const exportTelemetry = new WeakMap();
const telemetry = new DesktopTelemetryClient(desktop, { getContext: () => ({
  mode: state.settings.timelineMode, locale: state.settings.locale,
  playing: state.playing,
  backend: state.renderer?.stats?.backend === 'WebGPU' ? 'webgpu' : 'unavailable',
  gauges: { gpu_memory_mb: state.renderer?.stats?.gpuBytes / 1048576, draw_calls: state.renderer?.stats?.drawCalls,
    upload_kb: state.renderer?.stats?.uploadBytes / 1024, scene_figures: state.renderer?.stats?.objects,
    scene_primitives: state.renderer?.stats?.primitives, scene_frames: editor.totalTicks },
  gpuFamily: coarseGPUFamily(state.renderer?.stats?.adapter),
}) });
function coarseGPUFamily(value = '') {
  return ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'software'].find(name => String(value).toLowerCase().includes(name)) || 'unknown';
}
const privacyUI = new PrivacyUI(desktop, telemetry);
const releaseSplash = new ReleaseSplash(desktop);
let updateNotice;
const telemetryInit = telemetry.init().catch(() => null);
globalThis.addEventListener('error', event => telemetry.error(event.error));
globalThis.addEventListener('unhandledrejection', event => telemetry.error(event.reason));
globalThis.addEventListener('pagehide', () => { void telemetry.flush(); telemetry.dispose(); });
const editablePreparation = new EditableScenePreparation(editor, {
  onPending(pending) {
    state.editablePreparing=pending;
    thumbnailRenderer?.setPaused(pending||state.playing||editingGestureActive());
    playback.setInteractionActive(pending||editingGestureActive()||state.scrubbing);
    if(!pending){
      timelineUI?.setPaused?.(state.playing);
      state.editablePreparationStats=editablePreparation.stats;
      queueUI();requestRender();
    }
  },
  onReady(){state.editingPacket=null;status('Ready');warmPlayback();},
  onError:fail,
});
let lastFpsUI = 0;
function editingGestureActive(){return Boolean(state.drag||keyboardHandleGesture||editor._drag||editor._authoredPoseEdit||propertyControls?.active);}
function queueUI() {
  if(state.editablePreparing)return;
  if (!uiScheduled)
    uiScheduled = requestAnimationFrame(() => {
      uiScheduled = 0;
      updateUI();
    });
}
const playback = new PlaybackCache({
  onReady: (packet) => {
    state.lastPacketBytes = packet.byteLength;
    state.renderer
      ?.prepareBackgrounds?.(editor.report, packet.frame)
      .catch(() => {});
    if (state.playing && state.buffering) requestRender();
  },
  onError: (error) => {
    if (state.playing) {
      pause();
      fail(error);
    }
  },
});
function playbackScale() {
  // Quantize only after applying the native camera in the worker. Rounding
  // both here and there can quadruple texture memory at an ordinary zoom.
  return (
    state.view.scale *
    (state.renderer?.dpr ||
      Math.max(0.5, Math.min(3, window.devicePixelRatio || 1)))
  );
}
function syncPlayback() {
  const scale = playbackScale(),
    cameraEnabled = !state.scrubbing,
    storedFrames = !editor.report._styk?.layerSheet && state.settings.timelineMode === "simple";
  if (
    state.playbackRevision !== editor.revision ||
    playback.report !== editor.report ||
    state.playbackScale !== scale ||
    state.playbackCameraEnabled !== cameraEnabled ||
    state.playbackStoredFrames !== storedFrames ||
    state.playbackDraftRevision !== editor.frameDraftRevision
  ) {
    if (
      state.playbackRevision !== editor.revision ||
      playback.report !== editor.report
    )
      playback.load(editor.report, {
        revision: editor.revision,
        scale,
        cameraEnabled,
        storedFrames,
      });
    else if (state.playbackDraftRevision !== editor.frameDraftRevision)
      playback.updateDocument({
        revision: editor.revision,
        scale,
        cameraEnabled,
        storedFrames,
        frameIndices: [],
      });
    else playback.updateView({ scale, cameraEnabled, storedFrames });
    state.playbackRevision = editor.revision;
    state.playbackScale = scale;
    state.playbackCameraEnabled = cameraEnabled;
    state.playbackStoredFrames = storedFrames;
    state.playbackDraftRevision = editor.frameDraftRevision;
    state.playbackPacket = null;
    state.renderer?.clearPreparedFrames?.();
  }
}
function playbackRange() {
  return state.loopRange
    ? {
        start: Math.min(state.loopRange.startTick, editor.totalTicks - 1),
        end: Math.min(state.loopRange.endTick, editor.totalTicks),
      }
    : { start: 0, end: editor.totalTicks };
}
function prepareAhead(start = editor.tick, count = 24) {
  if (state.drag || state.scrubbing || !editor.totalTicks) return;
  syncPlayback();
  const range = playbackRange(),
    ticks = [];
  count = Math.min(
    count,
    Math.max(
      1,
      Math.floor(
        (playback.maxBytes * 0.65) /
          (state.playbackPacket?.byteLength ||
            state.lastPacketBytes ||
            playback.maxBytes / 4),
      ),
    ),
  );
  for (let n = 0; n < Math.min(count, range.end - range.start); n++)
    ticks.push(
      range.start +
        ((Math.max(start, range.start) - range.start + n) %
          (range.end - range.start)),
    );
  playback.prepareRange(ticks, { replacePending: true }).catch((error) => {
    if (error.name !== "AbortError" && state.playing) {
      pause();
      fail(error);
    }
  });
}
function warmPlayback() {
  if(state.editablePreparing)return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    if (!state.playing && !state.drag && !state.scrubbing) prepareAhead();
  }, 250);
}
function previewScrub() {
  // Scrubbing is editing: render the current pose with selection and onions.
  requestRender();
}

let preparationDefinitions, preparationRevision, preparationSizes;
let preparationRequest=0;
function queueEditingFrame(){
  const request=++preparationRequest;
  // Simple mode updates its working-frame checkpoint in a nested change event.
  // Capture the final revision after every listener has finished that seek.
  queueMicrotask(()=>{if(request===preparationRequest)prepareEditingFrame();});
}
function prepareEditingFrame() {
  const renderer=state.renderer;
  if(state.playing||state.previewing||state.drag||propertyControls?.active||!renderer?.prepareSceneUpdate||renderer.activeReport!==editor.report)return;
  if(preparationDefinitions!==editor.report.figure_types||preparationRevision!==editor.definitionRevision){
    preparationDefinitions=editor.report.figure_types;preparationRevision=editor.definitionRevision;
    preparationSizes=new Map(preparationDefinitions.map(figure=>[figure.figure_type_id,figure.segments.length]));
  }
  const objects=editor.frame.objects;
  const dense=objects.length>=128||objects.reduce((count,object)=>count+(preparationSizes.get(object.figure_type_id)||0),0)>=2000;
  if(!dense)return;
  editablePreparation.start(renderer,geometry=>({
    frame:currentFrame(),view:{...state.view},getView:()=>({...state.view}),cameraEnabled:false,
    editorBackgroundColor:builderBackgroundColor(state.settings,state),onionFrames:onionSkins(),
    geometry,artworkRevision:editor.definitionRevision,
  }));
}

let nameRevision = -1,
  nameReport = null,
  nameMap = new Map();
function nameOf(o) {
  if (o?.name) return o.name;
  if (nameRevision !== editor.revision || nameReport !== editor.report) {
    nameRevision = editor.revision;
    nameReport = editor.report;
    nameMap = new Map(
      editor.report.figure_types.map((f) => [f.figure_type_id, f.name]),
    );
  }
  return nameMap.get(o?.figure_type_id) || `Figure ${o?.unique_id ?? ""}`;
}
const showStaticHandles = () =>
  builderShowsStaticHandles(state.settings, {
    tool: state.tool,
    handleEditHeld: state.handleEditHeld,
    connecting: Boolean(state.spritePlacement || state.duplicatePlacement),
  });
const usesBuilderBranch = (event) =>
  Boolean(
    editor.branchSelected ||
    event?.shiftKey ||
      (isBuilderContext(state.tool) &&
        (state.builderBranch || state.builderShiftHeld)),
  );
function updateBuilderStyle(patch, event) {
  return editor.updateBuilderSegmentStyle(patch, {
    branch: usesBuilderBranch(event),
  });
}
const selection = () =>
  editor.selectedUids ||
  new Set(editor.selectedUid == null ? [] : [editor.selectedUid]);
const isSelected = (uid) => selection().has(uid);
const isHidden = (uid) =>
  state.hidden.has(uid) || !layerVisible(editor.report, uid);
const isLocked = (uid) =>
  state.locked.has(uid) || layerLocked(editor.report, uid);
const renderHidden = { has: isHidden };
// A membership view avoids evaluating or scanning a worker-prepared scene.
function effectiveHidden() {
  return renderHidden;
}
function selectTrack(track) {
  if (track.kind === 'assembly') {
    pause(); propertyControls?.cancel();
    state.selectedTrackId = track.id;
    state.inspectorContext = 'figure'; state.inspectorTab = 'animation';
    queueUI(); return;
  }
  const target = track.target || track;
  if (target.kind === "segment") {
    // A scalar row selects one exact curve; branch controls select the rig.
    if (track.property) state.builderBranch = false;
    pause();
    propertyControls?.cancel();
    const object = editor.selectionFrame.objects.find(
      (object) => object.unique_id === target.uid,
    );
    if (
      target.figureTypeId !== undefined &&
      object?.figure_type_id !== target.figureTypeId
    ) {
      editor.select(null);
      state.selectedTrackId = track.id;
      state.inspectorContext = "frame";
      state.inspectorTab = "animation";
      queueUI();
      return;
    }
    editor.select(target.uid);
    const index =
      editor.figure?.segments?.findIndex(
        (segment) => Number(segment.segment_id) === target.handleId,
      ) ?? -1;
    if (index >= 0) editor.select(target.uid, index);
    state.selectedTrackId =
      track.id || `segment:${target.uid}:${target.handleId}`;
    state.inspectorContext = "figure";
    state.inspectorTab = "design";
    queueUI();
    return;
  }
  if (target.kind === "figure" || track.uid !== undefined) {
    pause();
    propertyControls?.cancel();
    editor.select(target.uid ?? track.uid);
    state.selectedTrackId = track.id || `figure:${target.uid ?? track.uid}`;
    queueUI();
    return;
  }
  const id = ["camera", "scene"].includes(target.kind)
    ? target.kind
    : target.id || track.id;
  pause();
  propertyControls?.cancel();
  if(editor.report._styk?.layerSheet&&target.kind==='layer'){if(editor._sheetSelection?.id!==id)editor.selectSheetLayer(id);}
  else if (id !== "camera") editor.select(null);
  if (editor.layers?.some((layer) => layer.id === id))
    editor.setActiveLayer(id);
  state.selectedTrackId = track.id || id;
  state.inspectorContext =
    id === "camera" ? "camera" : id === "scene" ? "scene" : "layer";
  if (id === "camera" && !state.settings.showCamera)
    editorSettings?.commit({ showCamera: true });
  state.inspectorTab = "design";
  queueUI();
}
function reconcileSelectedSegmentTrack(
  track = timelineUI?.trackById?.get(state.selectedTrackId),
) {
  if (state.playing || state.previewing) return;
  const target = track?.target;
  if (target?.kind !== "segment" || target.figureTypeId === undefined) return;
  const object = editor.selectionFrame.objects.find(
    (object) => object.unique_id === target.uid,
  );
  const figure = editor.report.figure_types.find(
    (figure) => figure.figure_type_id === target.figureTypeId,
  );
  const index =
    object?.figure_type_id === target.figureTypeId
      ? (figure?.segments?.findIndex(
          (segment) => Number(segment.segment_id) === target.handleId,
        ) ?? -1)
      : -1;
  if (index >= 0) {
    if (editor.selectedUid !== target.uid || editor.selectedJoint !== index)
      editor.select(target.uid, index);
    state.inspectorContext = "figure";
    state.inspectorTab = "design";
  } else {
    if (editor.selectedUid !== null) editor.select(null);
    state.inspectorContext = "frame";
    state.inspectorTab = "animation";
  }
  state.selectedTrackId = track.id;
}
function propertyChannel(key) {
  const camera = {
    camera_x: "x",
    camera_y: "y",
    camera_scale: "scale",
    camera_angle: "rotation",
  };
  const figure = {
    scale: "scale",
    figure_opacity: "opacity",
    outline_opacity: "outlineOpacity",
    outline_width: "outlineWidth",
    figure_color: "color",
    outline_color: "outlineColor",
    figure_z_order: "zIndex",
  };
  const segment = {
    segment_opacity: "opacity",
    segment_gradient_opacity: "gradientOpacity",
    segment_color: "color",
    segment_paint: "paint",
    segment_gradient_color: "gradientColor",
    thickness: "thickness",
  };
  const scene = { scene_color: "color", scene_background: "backgroundId" };
  let target, property, options;
  const polygon=/^polygon_(\d+)_(color|opacity)$/.exec(key);
  if (polygon && editor.object && editor.figure?.polyfills?.[Number(polygon[1])]) {
    const index=Number(polygon[1]);target={kind:'polygon',uid:editor.object.unique_id,polygonId:polygonIdentity(editor.figure.polyfills[index],index),figureTypeId:editor.figure.figure_type_id};property=polygon[2];
  } else if (camera[key]) {
    target = { kind: "camera" };
    property = camera[key];
  } else if (scene[key]) {
    target = { kind: "scene" };
    property = scene[key];
  } else if (figure[key] && editor.object && selection().size === 1) {
    target = { kind: "figure", uid: editor.object.unique_id };
    property = figure[key];
  } else if (segment[key] && editor.object && selection().size === 1) {
    const selected = resolveInstanceFigure(editor.figure,editor.object)?.segments?.[editor.selectedJoint];
    if (
      !selected ||
      (key === "segment_gradient_opacity" && !selected.secondary)
    )
      return null;
    property = segment[key];
    const track = timelineUI?.trackById?.get(state.selectedTrackId);
    const persisted = track?.target;
    if (
      track?.property === property &&
      persisted?.kind === "segment" &&
      persisted.uid === editor.object.unique_id &&
      persisted.handleId === Number(selected.segment_id) &&
      (persisted.figureTypeId === undefined ||
        persisted.figureTypeId === editor.object.figure_type_id)
    ) {
      target = persisted;
      options = { exactTarget: true };
    } else
      target = editor.segmentAnimationTarget(
        editor.object.unique_id,
        Number(selected.segment_id),
        property,
      );
  } else return null;
  const factor =
    property === "rotation"
      ? 180 / Math.PI
      : ["scale", "opacity", "outlineOpacity", "gradientOpacity"].includes(
            property,
          )
        ? 100
        : 1;
  return {
    target,
    property,
    options,
    fromUI: (value) =>
      property === "color" && typeof value === "string"
        ? (0xff000000 | parseInt(value.slice(1), 16)) >>> 0
        : value / factor,
    toUI: (value) =>
      value === null
        ? undefined
        : property === "color"
          ? "#" + (value & 0xffffff).toString(16).padStart(6, "0")
          : value * factor,
  };
}
function propertyState(key) {
  const binding = propertyChannel(key);
  if (!binding || !editor.animationChannel) return {};
  const value = editor.animationValue(
    binding.target,
    binding.property,
    editor.tick,
    binding.options,
  );
  return {
    ...animationPropertyState(editor, binding.target, binding.property, binding.options),
    value: value === undefined ? undefined : binding.toUI(value),
  };
}
function selectionBounds() {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const g of editor.geometry.objects.values()) {
    if (!g || !isSelected(g.obj.unique_id)) continue;
    const b = boundsOf(g);
    bounds.minX = Math.min(bounds.minX, b.minX);
    bounds.minY = Math.min(bounds.minY, b.minY);
    bounds.maxX = Math.max(bounds.maxX, b.maxX);
    bounds.maxY = Math.max(bounds.maxY, b.maxY);
  }
  return bounds;
}
function alignSelection(axis, edge) {
  if (rangeFrames())
    return editor.alignFiguresInFrames(axis, edge, rangeFrames(), { boundsOf });
  return editor.alignSelection(axis, edge, { boundsOf });
}
function orderSelection(direction) {
  pause();
  finishCurrentEdit();
  return editor.orderSelection(direction, {frameIndices: rangeFrames()});
}
function rangeFrames() {
  if(editor.report._styk?.layerSheet){if(!state.applyRange||timelineUI?.selectedTicks?.length<2)return undefined;const indices=[editor.frameIndex];indices.sheetTicks=[...new Set([...timelineUI.selectedTicks,editor.tick])];return indices;}
  if (editor.frameDraft?.mode === "add") return undefined;
  return state.applyRange && state.rangeIndices.length > 1
    ? [...new Set([...state.rangeIndices, editor.frameIndex])]
    : undefined;
}
function updateSelection(patch) {
  if (rangeFrames()) return editor.updateFiguresInFrames(patch, rangeFrames());
  if (selection().size < 2) return editor.updateObject(patch);
  return editor.updateFiguresInFrames(patch, [editor.frameIndex], {
    ticks: [editor.tick],
  });
}
function moveSelected(dx, dy) {
  if (rangeFrames())
    return editor.moveSelectionInFrames(dx, dy, rangeFrames());
  return editor.moveSelection(dx, dy);
}
const assetUrl = (a) =>
  a?.asset_url ||
  a?.data_url ||
  a?.url ||
  (a?.base64
    ? `data:${a.mime_type || "image/png"};base64,${a.base64}`
    : null) ||
  a?.asset_path_relative ||
  a?.asset_path ||
  a?.path;
function imageFor(url) {
  if (!url) return null;
  if (images.has(url)) return images.get(url);
  const img = new Image();
  img.onload = requestRender;
  img.onerror = () => status("One image asset could not be loaded", true);
  img.src = url;
  images.set(url, img);
  return img;
}
const resources = { url: assetUrl, image: imageFor };
function status(text, error = false, busy = false) {
  $("status").textContent = text;
  $("status-dot").className =
    `status-dot${error ? " error" : busy ? " busy" : ""}`;
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4400);
}
function fail(error) {
  telemetry.error(error);
  const message = error?.message || String(error);
  status(message, true);
  toast(message);
  console.error(error);
}
function guarded(fn) {
  return (...args) => {
    try {
      const value = fn(...args);
      if (value?.catch) value.catch(fail);
      return value;
    } catch (error) {
      fail(error);
    }
  };
}
function requestRender() {
  state.dirtyRender = true;
  if (!raf) raf = requestAnimationFrame(loop);
}
function currentFrame() {
  const frame = editor.evaluatedFrame || editor.frame;
  return editor.report._styk?.layers?.fixed?.camera?.visible === false
    ? { ...frame, camera: null }
    : frame;
}
function scenePoint(x, y, inverse = false) {
  if (!state.playing && !state.previewing) return { x, y };
  const c = currentFrame()?.camera,
    w = editor.report.canvas_width,
    h = editor.report.canvas_height;
  if (cameraIsIdentity(c)) return { x, y };
  const a = Number(c.angle_rad || 0),
    scale = 1 / inverseCameraScale(c);
  if (inverse) {
    const dx = (x - w / 2) * scale,
      dy = (y - h / 2) * scale;
    return {
      x: dx * Math.cos(a) - dy * Math.sin(a) + w / 2 + Number(c.x || 0),
      y: dx * Math.sin(a) + dy * Math.cos(a) + h / 2 + Number(c.y || 0),
    };
  }
  const dx = x - w / 2 - Number(c.x || 0),
    dy = y - h / 2 - Number(c.y || 0);
  return {
    x: (dx * Math.cos(a) + dy * Math.sin(a)) / scale + w / 2,
    y: (-dx * Math.sin(a) + dy * Math.cos(a)) / scale + h / 2,
  };
}
function screenPoint(p) {
  const q = scenePoint(p.x, p.y);
  return {
    x: q.x * state.view.scale + state.view.x,
    y: q.y * state.view.scale + state.view.y,
  };
}
function worldPoint(event) {
  const r = viewport.getBoundingClientRect();
  return scenePoint(
    (event.clientX - r.left - state.view.x) / state.view.scale,
    (event.clientY - r.top - state.view.y) / state.view.scale,
    true,
  );
}
function cameraSelected() {
  return state.inspectorContext === 'camera' && state.selectedTrackId === 'camera';
}
function activeCameraHandle(point) {
  const track = editor.report._styk?.layers?.fixed?.camera;
  if (!cameraSelected() || !state.settings.showCamera || track?.visible === false || track?.locked)
    return null;
  return pickCameraHandle(
    cameraViewport(editor.report, currentFrame(), state.view),
    point,
    state.view,
  );
}
function placeArtboard() {
  const v = state.view,
    r = editor.report,
    a = $("artboard");
  Object.assign(a.style, {
    left: `${v.x}px`,
    top: `${v.y}px`,
    width: `${r.canvas_width * v.scale}px`,
    height: `${r.canvas_height * v.scale}px`,
  });
  $("zoom-label").textContent = `${Math.round(v.scale * 100)}% ⌄`;
}
function fittedView(r = editor.report) {
  const rect = viewport.getBoundingClientRect(),
    s = Math.max(
      0.01,
      Math.min(
        (rect.width - 64) / r.canvas_width,
        (rect.height - 72) / r.canvas_height,
        2,
      ),
    );
  return {
    scale: s,
    x: (rect.width - r.canvas_width * s) / 2,
    y: (rect.height - r.canvas_height * s) / 2 - 3,
  };
}
function fit() {
  state.view = fittedView();
  placeArtboard();
  requestRender();
}
function resize() {
  const r = viewport.getBoundingClientRect(),
    d = window.devicePixelRatio || 1;
  overlay.width = Math.round(r.width * d);
  overlay.height = Math.round(r.height * d);
  state.renderer?.resize(r.width, r.height, d);
  timelineUI?.resize();
  placeArtboard();
  requestRender();
}
function zoom(factor, point) {
  const r = viewport.getBoundingClientRect(),
    px = point?.x ?? r.width / 2,
    py = point?.y ?? r.height / 2,
    v = state.view,
    s = Math.min(12, Math.max(0.02, v.scale * factor)),
    k = s / v.scale;
  state.view = { x: px - (px - v.x) * k, y: py - (py - v.y) * k, scale: s };
  placeArtboard();
  requestRender();
}
function fitSelection() {
  const b = selectionBounds();
  if (!Number.isFinite(b.minX)) return fit();
  const points = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ].map(screenPoint);
  const left = Math.min(...points.map((p) => p.x)),
    right = Math.max(...points.map((p) => p.x)),
    top = Math.min(...points.map((p) => p.y)),
    bottom = Math.max(...points.map((p) => p.y)),
    rect = viewport.getBoundingClientRect();
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  zoom(
    Math.min(
      (rect.width - 120) / Math.max(1, right - left),
      (rect.height - 150) / Math.max(1, bottom - top),
    ),
    center,
  );
  state.view.x += rect.width / 2 - center.x;
  state.view.y += rect.height / 2 - 15 - center.y;
  placeArtboard();
  requestRender();
}
const boundsCache = new WeakMap();
function boundsOf(g) {
  let b = boundsCache.get(g);
  if (!b) {
    const items = [
        ...g.segments.map((s) => ({
          ...s,
          type: s.seg.segment_type || "line",
        })),
        ...g.polys,
      ],
      r = objectBounds(items, resources);
    b = { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height };
    boundsCache.set(g, b);
  }
  return b;
}
let blueHandles = null;
// Keep one surface alive to avoid deferred GPU-context destruction on input.
const handleSurface = new OffscreenCanvas(1, 1),
  handleContext = handleSurface.getContext("2d");
let handleCache = null;
const handleDescriptors = {};
function canvasHandles(geometry) {
  const frame = currentFrame(),
    settings = state.settings;
  const key = [
    editor.layerRevision,
    showStaticHandles(),
    state.tool,
    state.handleEditHeld,
    usesBuilderBranch(),
    isBuilderContext(state.tool) || editor.branchSelected ? editor.selectedJoint : -1,
    settings.showUnselectedHandles,
    settings.handleSize,
    settings.autoSizeHandles,
    settings.outlineHandles,
    state.view.scale,
    frame.camera?.scale,
    ...selection(),
    ...state.hidden,
    ...state.locked,
  ].join("|");
  if (handleCache?.geometry === geometry && handleCache.key === key)
    return handleCache.handles;
  const hidden = effectiveHidden(frame),
    locked = new Set(state.locked);
  for (const object of frame.objects)
    if (layerLocked(editor.report, object.unique_id))
      locked.add(object.unique_id);
  const handles = getPivotHandles(geometry, {
    descriptorCache: handleDescriptors,
    frame,
    selectedUid: editor.selectedUid,
    selectedUids: selection(),
    hiddenUids: hidden,
    lockedUids: locked,
    showUnselected: settings.showUnselectedHandles,
    showStatic: showStaticHandles(),
    selectedJoint: isBuilderContext(state.tool) || editor.branchSelected ? editor.selectedJoint : -1,
    selectedBranch: usesBuilderBranch(),
    builder: isBuilderContext(state.tool),
    attaching: state.tool === "attach",
    allowStaticManipulation:
      state.tool === "rig" ||
      state.tool === "handle-edit" ||
      state.handleEditHeld,
    viewScale: state.view.scale,
    autoSize: settings.autoSizeHandles,
    maxDiameter: settings.handleSize * 2,
  });
  handleCache = { geometry, key, handles };
  return handles;
}
function paintHandle(context, handle, delta) {
  const point = delta
    ? { x: handle.point.x + delta.x, y: handle.point.y + delta.y }
    : handle.point;
  const p = screenPoint(point);
  context.beginPath();
  context.arc(p.x, p.y, handle.screenRadius, 0, Math.PI * 2);
  context.fillStyle = handle.color;
  context.strokeStyle = handle.ik ? '#0d99ff' : '#000000';
  context.lineWidth = 1;
  context.fill();
  if (state.settings.outlineHandles || handle.ik) context.stroke();
}
function gpuHandlesEnabled() {
  return Boolean(state.renderer?.handleRenderer) && !state.playing && !state.previewing &&
    !(!editor.branchSelected && isBuilderContext(state.tool) && state.settings.builderHighlightSegment);
}
function drawCanvasHandles(geometry) {
  const handles = canvasHandles(geometry),
    translations = state.drag?.translations;
  const d = window.devicePixelRatio || 1;
  const key = [
    handleCache.key,
    state.view.x,
    state.view.y,
    currentFrame().camera?.x,
    currentFrame().camera?.y,
    currentFrame().camera?.angle_rad,
    ...(translations?.keys() || []),
  ].join("|");
  if (
    !blueHandles ||
    blueHandles.handles !== handles ||
    blueHandles.key !== key ||
    handleSurface.width !== overlay.width ||
    handleSurface.height !== overlay.height
  ) {
    if (handleSurface.width !== overlay.width)
      handleSurface.width = overlay.width;
    if (handleSurface.height !== overlay.height)
      handleSurface.height = overlay.height;
    handleContext.setTransform(d, 0, 0, d, 0, 0);
    handleContext.clearRect(0, 0, overlay.width / d, overlay.height / d);
    for (const handle of handles)
      if (!translations?.has(handle.uid)) paintHandle(handleContext, handle);
    blueHandles = { handles, key };
  }
  ctx.drawImage(handleSurface, 0, 0, overlay.width / d, overlay.height / d);
  if (translations)
    for (const handle of handles) {
      const delta = translations.get(handle.uid);
      if (delta) paintHandle(ctx, handle, delta);
    }
}
const onionCache = new OnionSkinCache();
let onionControls;
function onionSkins() {
  if (!state.onion || state.playing || state.previewing) return [];
  return onionCache.get(editor, state.settings, {selected: selection(), hidden: effectiveHidden(), visibilityKey:[...state.hidden]});
}
function overlayRender(geometry) {
  const d = window.devicePixelRatio || 1;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, overlay.width / d, overlay.height / d);
  if (state.playing || state.previewing) return;
  if (
    !editor.branchSelected && isBuilderContext(state.tool) && state.settings.builderHighlightSegment &&
    !isHidden(editor.selectedUid)
  )
    drawBuilderHighlight(ctx, geometry, {
      uid: editor.selectedUid,
      jointIndex: editor.selectedJoint,
      report: editor.report,
      frame: currentFrame(),
      view: state.view,
      resources,
      dragTranslations: state.drag?.translations,
      cameraEnabled: false,
    });
  if (state.handles && !gpuHandlesEnabled()) drawCanvasHandles(geometry);
  if (
    cameraSelected() &&
    editor.report._styk?.layers?.fixed?.camera?.visible !== false &&
    (state.settings.showCamera || !cameraIsIdentity(currentFrame().camera))
  ) {
    if (state.onion && state.settings.onionCamera && editor.frameIndex > 0)
      drawCameraViewport(
        ctx,
        cameraViewport(
          editor.report,
          evaluatedFrame(editor.report, editor.frameIndex - 1),
          state.view,
        ),
        screenPoint,
        { active: false, onion: true },
      );
    drawCameraViewport(
      ctx,
      cameraViewport(editor.report, currentFrame(), state.view),
      screenPoint,
      {
        active:
          state.settings.showCamera &&
          editor.report._styk?.layers?.fixed?.camera?.locked !== true,
        guides: state.cameraGuides,
        hover: state.hoverCameraHandle,
        dragging: state.drag?.kind === 'camera' ? state.drag.handle : null,
      },
    );
  }
  if (state.drag?.kind === "marquee") {
    const a = screenPoint(state.drag.start),
      b = screenPoint(state.drag.current);
    ctx.fillStyle = "#0d99ff14";
    ctx.strokeStyle = "#0d99ff";
    ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }
  if (state.polygon) {
    const g = [...geometry.objects.values()].find(
      (g) => g?.obj.unique_id === state.polygon.uid,
    );
    const markers = state.polygon.handles
      .map((id) => g?.joints.get(id))
      .filter(Boolean)
      .map(screenPoint);
    const pts = polygonPreviewPoints(g, state.polygon.handles, {
      closed: state.polygon.handles.length >= 3,
    }).map(screenPoint);
    if (pts.length) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (state.polygon.handles.length >= 3) ctx.closePath();
      ctx.strokeStyle = "#0d99ff";
      ctx.fillStyle = "#0d99ff18";
      ctx.lineWidth = 2;
      if (state.polygon.handles.length >= 3) ctx.fill();
      ctx.stroke();
      for (let index = 0; index < markers.length; index++) {
        const p = markers[index];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = PIVOT_HANDLE_COLORS.segment;
        ctx.fill();
        if (index === 0) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.3, 0, Math.PI * 2);
          ctx.fillStyle = "#000000";
          ctx.fill();
        }
      }
    }
  }
  if ((state.spritePlacement || state.duplicatePlacement)?.point) {
    const pending = state.spritePlacement || state.duplicatePlacement,
      target = pending.hover,
      point = screenPoint(target?.point || pending.point);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = target ? "#0d99ff" : "#888";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (state.drag?.kind === "draw") {
    const p = screenPoint(state.drag.start),
      q = screenPoint(state.drag.current || state.drag.start);
    ctx.strokeStyle = "#0d99ff";
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    if (state.tool === "circle") {
      ctx.arc(
        (p.x + q.x) / 2,
        (p.y + q.y) / 2,
        Math.hypot(q.x - p.x, q.y - p.y) / 2,
        0,
        Math.PI * 2,
      );
    } else {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
function loop(now) {
  raf = 0;
  playback.setInteractionActive(Boolean(editingGestureActive()||state.scrubbing||state.editablePreparing));
  thumbnailRenderer?.setPaused(Boolean(editingGestureActive()||state.playing||state.editablePreparing));
  let advancedPlayback = false;
  if (!$("renderer-error").hidden) return;
  if (state.playing) {
    const fps = editor.report.frame_delay_ms
        ? 1000 / editor.report.frame_delay_ms
        : editor.report.fps,
      range = playbackRange(),
      interval = 1000 / fps;
    playbackMetrics.targetFps = fps;
    if (range.end <= range.start) {
      pause();
    } else if (!playStarted || now >= playDeadline) {
      let next = playStarted ? editor.tick + 1 : playTick;
      if (next >= range.end) {
        if (state.loop) next = range.start;
        else {
          pause();
          next = null;
        }
      }
      if (next !== null) {
        const packet = playback.get(next);
        const backgroundsReady =
          packet &&
          (state.renderer.backgroundsReady?.(editor.report, packet.frame) ??
            true);
        if (packet && backgroundsReady) {
          editor.seek(next, { evaluate: false });
          state.playbackPacket = packet;
          advancedPlayback = true;
          playDeadline =
            !playStarted || state.buffering
              ? now + interval
              : Math.max(playDeadline + interval, now);
          playStarted = true;
          if (state.buffering) {
            state.buffering = false;
            status("Playing");
            $("preview-badge").textContent = "PLAYING";
          }
          prepareAhead(next + 1, 24);
          state.dirtyRender = true;
        } else {
          state.buffering = true;
          $("preview-badge").textContent = "PREPARING";
          if (
            packet &&
            !backgroundsReady &&
            state.backgroundPending !== packet.key
          ) {
            state.backgroundPending = packet.key;
            state.renderer
              .prepareBackgrounds(editor.report, packet.frame)
              .then(() => {
                state.backgroundPending = null;
                requestRender();
              })
              .catch((error) => {
                state.backgroundPending = null;
                pause();
                fail(error);
              });
          }
          prepareAhead(next, 24);
        }
      }
    }
  }
  if (state.dirtyRender && state.renderer) {
    state.dirtyRender = false;
    const start = performance.now();
    const packet = state.playing ? state.playbackPacket : null;
    if(state.editablePreparing){
      const held=state.editingPacket?.packet;
      if(held)state.renderer.renderPrepared(held.key,{report:editor.report,view:state.view,cameraEnabled:held.cameraEnabled,hiddenUids:effectiveHidden()});
    } else if (packet && state.renderer.renderPrepared) {
      if (!state.renderer.hasPreparedFrame(packet.key))
        state.renderer.prepareFrame(packet, {
          report: editor.report,
          view: state.view,
          cameraEnabled: !state.scrubbing,
        });
      const presented = state.renderer.renderPrepared(packet.key, {
        report: editor.report,
        view: state.view,
        cameraEnabled: !state.scrubbing,
        hiddenUids: effectiveHidden(),
      });
      if (advancedPlayback && presented !== false)
        playbackMetrics.present(performance.now());
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    } else if (!state.playing || !state.buffering) {
      const frame = currentFrame(),
        geometry =
          state.drag?.geometry ||
          keyboardHandleGesture?.geometry ||
          editor.geometry;
      const onionFrames = onionSkins(),
        editing = state.editingPacket;
      state.editingPacket = null;
      state.renderer.render({
        preparedPacket:
          editing?.report === editor.report &&
          editing.revision === editor.revision &&
          editing.tick === editor.tick
            ? editing.packet
            : undefined,
        report: editor.report,
        frame,
        geometry,
        view: state.view,
        cameraEnabled: state.playing || state.previewing,
        editorBackgroundColor: builderBackgroundColor(state.settings, state),
        selectedUid: null,
        showHandles: false,
        liveEditing: Boolean(state.drag || keyboardHandleGesture),
        artworkRevision: editor.definitionRevision,
        canvasHandles: state.handles && gpuHandlesEnabled() ? canvasHandles(geometry) : undefined,
        outlineHandles: state.settings.outlineHandles,
        onionFrames,
        hiddenUids: effectiveHidden(),
        clipToCanvas: false,
        dragTranslations: state.drag?.translations,
      });
      state.lastEditingPresentation = {tick:editor.tick,revision:editor.revision,at:performance.now(),
        sequence:(state.lastEditingPresentation?.sequence ?? 0)+1};
      if (advancedPlayback) playbackMetrics.present(performance.now());
      overlayRender(geometry);
    }
    if (state.inspectorContext === 'camera') {
      const frame = currentFrame();
      syncCameraControls($('inspector'), frame, {activeKey:propertyControls?.activeKey,guides:state.cameraGuides});
      if (!state.editablePreparing) drawCameraMonitor($('inspector').querySelector('[data-camera-monitor]'), {
        report:editor.report,frame,geometry:state.playing?null:state.drag?.geometry || keyboardHandleGesture?.geometry || editor.geometry,
        resources:state.renderer.resources,hiddenUids:effectiveHidden(),
      });
    }
    const elapsed = performance.now() - start;
    state.renderSamples.push(elapsed);
    if (telemetry.consent.diagnostics && state.drawCalls % 30 === 0) {
      telemetry.timing('frame_ms', elapsed);
      if (elapsed > 33) telemetry.count('slow_frames');
    }
    if (state.renderSamples.length > 300) state.renderSamples.shift();
    state.lastPresent = elapsed;
    state.drawCalls++;
    if (now - lastUI > 200) {
      updateTransport();
      $("render-time").textContent = `${elapsed.toFixed(1)} ms`;
      $("renderer-label").textContent =
        state.renderer.stats?.backend === "Canvas 2D fallback"
          ? "Compatibility mode"
          : state.renderer.stats?.backend || "WebGPU";
      lastUI = now;
    }
  }
  if (state.playing) {
    const measuredAt = performance.now();
    playbackMetrics.buffering(state.buffering, measuredAt);
    if (measuredAt - lastFpsUI >= 250) {
      const sample = playbackMetrics.snapshot(measuredAt), badge = $("playback-fps");
      badge.textContent = sample.fps === null ? "— fps" : `${sample.fps.toFixed(1)} fps`;
      badge.dataset.health = sample.coherent === null ? "pending" : sample.coherent ? "good" : "low";
      badge.title = `Scene target: ${sample.targetFps.toFixed(1)} fps`;
      lastFpsUI = measuredAt;
    }
  }
  // A seek/edit event can request the next frame while this callback runs.
  // Keep that request instead of starting a second animation loop.
  if (!raf && (state.playing || state.dirtyRender)) raf = requestAnimationFrame(loop);
}
function play() {
  if (!$("renderer-error").hidden) return;
  if (state.playing) return pause();
  editablePreparation.cancel();
  state.previewing = false;
  if (editor.totalTicks < 1) return;
  cancelDrag();
  const range = playbackRange();
  playTick =
    editor.tick >= range.end - 1 || editor.tick < range.start
      ? range.start
      : editor.tick;
  playStart = performance.now();
  telemetry.count('playback_started');
  playbackMetrics.reset(playStart, editor.report.frame_delay_ms
    ? 1000 / editor.report.frame_delay_ms : editor.report.fps);
  lastFpsUI = playStart;
  $("playback-fps").textContent = "— fps";
  $("playback-fps").dataset.health = "pending";
  $("playback-fps").hidden = false;
  playStarted = false;
  playDeadline = playStart;
  state.playbackPacket = null;
  prepareAhead(playTick, 24);
  state.playing = true;
  thumbnailRenderer?.setPaused(true);
  timelineUI?.setPaused?.(true);
  $("preview-badge").hidden = false;
  $("play-button").innerHTML = icon("pause");
  $("play-button").setAttribute("aria-label", "Pause");
  appLocalization?.updatePlayback($("play-button"), state);
  requestRender();
}
function pause() {
  const wasPlaying = state.playing || state.previewing;
  if (state.playing) {
    playbackMetrics.stop(performance.now());
    const summary = playbackMetrics.snapshot(performance.now());
    telemetry.count('playback_frames', summary.totalFrames);
    telemetry.count('playback_seconds', Math.round(summary.elapsedMs / 1000));
    telemetry.count('playback_buffering', summary.bufferingEvents);
    telemetry.timing('playback_startup_ms', summary.startupMs);
    telemetry.timing('playback_buffering_ms', summary.bufferingMs);
    for (const interval of summary.intervalsMs) telemetry.timing('playback_interval_ms', interval);
  }
  $("playback-fps").hidden = true;
  if (wasPlaying && state.playbackPacket)
    state.editingPacket = {
      packet: state.playbackPacket,
      report: editor.report,
      revision: editor.revision,
      tick: editor.tick,
    };
  state.playing = false;
  state.previewing = false;
  if (editor.endFrameDraftPreview()) state.editingPacket = null;
  const prepareEditable=Boolean(wasPlaying&&state.editingPacket&&state.renderer?.prepareSceneUpdate);
  thumbnailRenderer?.setPaused(prepareEditable);
  timelineUI?.setPaused?.(prepareEditable);
  state.buffering = false;
  state.playbackPacket = null;
  $("preview-badge").hidden = true;
  $("play-button").innerHTML = icon("play");
  $("play-button").setAttribute("aria-label", "Play");
  appLocalization?.updatePlayback($("play-button"), state);
  if(prepareEditable){
    editablePreparation.start(state.renderer,geometry=>({
      frame:currentFrame(),view:{...state.view},getView:()=>({...state.view}),
      cameraEnabled:false,editorBackgroundColor:builderBackgroundColor(state.settings,state),
      onionFrames:onionSkins(),geometry,artworkRevision:editor.definitionRevision,
    }));
  }
  requestRender();
  if (wasPlaying) {
    reconcileSelectedSegmentTrack();
    queueUI();
    status(state.editablePreparing?'Preparing canvas':'Ready');
  }
}
function previewFrame() {
  pause();
  editablePreparation.cancel();
  cancelDrag();
  state.previewing = true;
  $("preview-badge").textContent = "PREVIEW";
  $("preview-badge").hidden = false;
  $("play-button").innerHTML = icon("stop");
  $("play-button").setAttribute("aria-label", "Stop preview");
  appLocalization?.updatePlayback($("play-button"), state);
  requestRender();
}
function updateTransport() {
  const fps = editor.report.fps,
    tick = editor.tick;
  $("time-display").textContent =
    `${String(Math.floor(tick / fps / 60)).padStart(2, "0")}:${String(Math.floor(tick / fps) % 60).padStart(2, "0")}:${String(tick % fps).padStart(2, "0")}`;
  $("frame-badge").textContent = `FRAME ${String(tick + 1).padStart(2, "0")}`;
  const storedSummary =
    state.settings.timelineMode === "simple"
      ? `${editor.report._styk?.layerSheet ? timelineUI?.frameCount ?? 0 : editor.frameDraft?.storedCount ?? editor.report.keyframes.length} keys · `
      : "";
  $("timeline-summary").textContent =
    `${storedSummary}${editor.totalTicks} frames · ${(editor.totalTicks / fps).toFixed(2)}s`;
  $("fps").value = fps;
  timelineUI?.update(state.settings.timelineMode !== 'advanced');
}
function updateTitle() {
  document.title = `${editor.dirty ? "• " : ""}${editor.name || "Untitled"} — StykAnimate`;
  $("project-name").textContent = editor.name || "Untitled";
  $("dirty-dot").classList.toggle("dirty", editor.dirty);
  $("save-state").textContent = editor.dirty ? "Unsaved changes" : "Saved";
  $("save-state").dataset.dirty = String(editor.dirty);
  desktop?.setDocumentState?.({
    name: editor.name || "Untitled",
    dirty: editor.dirty,
    revision: `${state.documentToken}:${editor.revision}:${editor.frameDraftRevision}`,
  });
}
function updateUI() {
  if(state.editablePreparing)return;
  updateTitle();
  updateTransport();
  renderLayers();
  renderInspector();
  $("stage-size").textContent =
    `${editor.report.canvas_width} × ${editor.report.canvas_height}`;
  $("object-count").textContent =
    `${editor.frame.objects.length.toLocaleString()} figures`;
  $("selection-summary").textContent =
    selection().size > 1
      ? `${selection().size} figures selected`
      : editor.object
        ? nameOf(editor.object)
        : "No figure selected";
  if (state.activeTab === "assets") renderAssets();
  studioShell?.sync();
  requestRender();
}
function renderLayers() {
  if ($("layer-count"))
    $("layer-count").textContent =
      editor.layers?.filter((layer) => !["scene", "camera"].includes(layer.id))
        .length || 1;
  timelineUI?.selectTrack?.(state.selectedTrackId);
}
function renderAssets() {
  const figures = editor.report.figure_types;
  assetLibrary?.setVisible(state.activeTab === "assets");
  assetLibrary?.update(figures, { selectedId: editor.object?.figure_type_id });
  $("sample-list").innerHTML = state.samples.length
    ? state.samples
        .map(
          (s) =>
            `<button class="sample-item" data-sample="${esc(s.path)}">${icon(s.kind === "stk" ? "person" : "file")}<span>${esc(s.name)}</span><small>${esc(s.kind?.toUpperCase() || "PIV")}</small></button>`,
        )
        .join("")
    : '<p class="property-note" style="padding:0 15px">Open StykAnimate, Pivot or Stick Nodes projects, figures and movie clips.</p>';
}
function renderInspector() {
  if (propertyControls?.active || (state.drag && state.drag.kind !== "pan"))
    return;
  const disclosureOwner = {
    document: editor._documentToken,
    figureTypeId: editor.figure?.figure_type_id,
    polygonCount: editor.figure?.polyfills?.length,
  };
  const preserveDisclosure =
    inspectorDisclosureOwner &&
    Object.keys(disclosureOwner).every(
      (key) => disclosureOwner[key] === inspectorDisclosureOwner[key],
    );
  const disclosedSections = new Set([...$("inspector").querySelectorAll('details[data-section][open]')].map(el => el.dataset.section));
  const openPolygons = preserveDisclosure
    ? [
        ...$("inspector").querySelectorAll("details[data-polygon-index][open]"),
      ].map((element) => element.dataset.polygonIndex)
    : [];
  updateInspectorDOM($("inspector"), inspectorView({
    editor,
    tab: state.inspectorTab,
    context: editor.branchSelected ? "figure" : state.inspectorContext,
    propertyState,
    tool: editor.branchSelected ? "rig" : state.tool,
    rigMode: state.rigMode,
    builderBranch: usesBuilderBranch(),
    selectionCount: editor.branchSelected ? 1 : selection().size,
    bounds: selection().size > 1 ? selectionBounds() : null,
    rangeIndices: editor.frameDraft?.mode === "add" ? [] : state.rangeIndices,
    applyRange: state.applyRange,
    polygonPage: state.polygonPage || 0,
  }), {preserveDisclosure});
  if (state.polygon) {
    for (const input of $("inspector").querySelectorAll(
      "input,select,textarea,button",
    )) {
      input.disabled = true;
      input.title = "Finish or cancel the polygon first.";
    }
  }
  for (const section of $("inspector").querySelectorAll('details[data-section]')) {
    if (preserveDisclosure && disclosedSections.has(section.dataset.section)) section.open = true;
  }
  studioShell?.sync();
  inspectorDisclosureOwner = disclosureOwner;
  for (const index of openPolygons)
    $("inspector")
      .querySelector(`details[data-polygon-index="${index}"]`)
      ?.setAttribute("open", "");
  document
    .querySelectorAll("[data-inspector]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        button.dataset.inspector === state.inspectorTab,
      ),
    );
}

function setTool(tool) {
  if (tool !== state.tool && ['rig', 'line', 'circle', 'polygon', 'handle-edit'].includes(tool)) telemetry.count('builder');
  if (isMovieclip(editor.figure) && ['rig','line','circle','polygon','handle-edit'].includes(tool)) {
    editor.enterMovieclip();
  }
  if (tool === "polygon" && state.tool === "polygon" && state.polygon) {
    finishPolygon();
    return;
  }
  if (state.drag) cancelDrag();
  if (state.tool !== tool) {
    cancelSpritePlacement();
    state.polygon = null;
    $("polygon-controls").hidden = true;
  }
  state.tool = tool;
  document
    .querySelectorAll("[data-tool]")
    .forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  viewport.classList.toggle("panning", tool === "hand");
  viewport.classList.toggle(
    "drawing",
    ["line", "circle", "polygon"].includes(tool),
  );
  $("viewport-hint").textContent = {
    "handle-edit": "Move a handle · Hold R for temporary handle editing",
    select: "Drag to select · Shift-click to add · Drag a joint to pose",
    pose: "Rotate a joint · Ctrl-drag to stretch",
    rig: "Edit figure joints · Changes update every instance",
    hand: "Drag or scroll to pan · Ctrl-scroll to zoom",
    line: "Drag anywhere to draw · Start on a joint to extend a figure",
    circle: "Drag anywhere to draw · Start on a joint to extend a figure",
    polygon:
      "Click figure joints to trace a polygon · Enter to finish · Esc to cancel",
    attach: "Click the parent joint · Esc to cancel",
  }[tool];
  if (["rig", "line", "circle", "polygon"].includes(tool)) {
    state.inspectorTab = "design";
    state.inspectorContext = editor.object ? "figure" : "scene";
  }
  document
    .querySelectorAll("[data-inspector]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.inspector === state.inspectorTab),
    );
  renderInspector();
  requestRender();
}
function closestHandle(p, excludedUid = null, { uid } = {}) {
  const threshold = 10 / state.view.scale;
  let best = threshold * threshold,
    hit = null;
  for (const g of editor.geometry.objects.values()) {
    if (
      !g ||
      g.obj.unique_id === excludedUid ||
      (uid !== undefined && g.obj.unique_id !== uid) ||
      isHidden(g.obj.unique_id) ||
      isLocked(g.obj.unique_id)
    )
      continue;
    for (const [id, point] of g.joints) {
      const distance = (point.x - p.x) ** 2 + (point.y - p.y) ** 2;
      if (distance <= best) {
        best = distance;
        hit = { g, id, point };
      }
    }
  }
  return hit;
}
function cancelPolygonDraft() {
  if (!state.polygon) return;
  state.polygon = null;
  $("polygon-controls").hidden = true;
  queueUI();
  requestRender();
}
function refreshPolygonDraft() {
  if (!state.polygon) return;
  state.polygon.handles = state.polygon.draft.handles;
  $("polygon-controls").hidden = false;
  $("polygon-count").textContent = `${state.polygon.handles.length} joints`;
  $("finish-polygon").disabled = state.polygon.handles.length < 3;
  requestRender();
}
function polygonClick(p, event = {}) {
  let g = state.polygon
    ? [...editor.geometry.objects.values()].find(
        (g) => g.obj.unique_id === state.polygon.uid,
      )
    : pick(p)?.g;
  if (!g) {
    toast("Choose a figure joint to begin a polygon.");
    return;
  }
  const maxDistance = 10 / state.view.scale;
  let closest = null,
    best = Infinity;
  for (const [id, point] of g.joints) {
    const distance = (point.x - p.x) ** 2 + (point.y - p.y) ** 2;
    if (distance < best) {
      best = distance;
      closest = [id, point];
    }
  }
  if (
    !closest ||
    Math.hypot(closest[1].x - p.x, closest[1].y - p.y) > maxDistance
  ) {
    toast("Polygons attach to joints. Click a red, orange, or gray joint.");
    return;
  }
  if (!state.polygon) {
    editor.select(g.obj.unique_id);
    state.polygon = {
      uid: g.obj.unique_id,
      handles: [],
      draft: new PolygonDraft(g),
    };
  }
  state.polygon.draft.append(closest[0], {
    chain: Boolean(event.ctrlKey || event.metaKey),
  });
  refreshPolygonDraft();
  if (state.polygon.draft.complete) finishPolygon();
}
function finishPolygon() {
  if (!state.polygon || state.polygon.handles.length < 3) {
    toast("Choose at least three different joints.");
    return;
  }
  const draft = state.polygon;
  editor.select(draft.uid);
  editor.addPolygon(draft.handles, { color: [43, 43, 43] });
  state.polygon = null;
  $("polygon-controls").hidden = true;
  setTool("select");
  status("Polygon added");
}
function pick(p) {
  if (!state.handles) return null;
  const geometry = editor.geometry;
  return pickCanvasHandle(geometry, p, {
    handles: canvasHandles(geometry),
    project: screenPoint,
    projectionScale: !state.playing&&!state.previewing?state.view.scale:undefined,
    minRadius: 8,
    nearest: true,
  });
}
overlay.addEventListener(
  "pointerdown",
  guarded((e) => {
    if (!$("renderer-error").hidden || !e.isPrimary) return;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    if (state.previewing) {
      pause();
      return;
    }
    finishKeyboardHandle();
    playback.setInteractionActive(true);
    interruptRecovery();
    $("toast").hidden = true;
    clearTimeout(toastTimer);
    pause();
    viewport.focus({ preventScroll: true });
    editablePreparation.cancel();
    overlay.setPointerCapture(e.pointerId);
    canvasPointerId = e.pointerId;
    if (e.button === 1 || state.space || state.tool === "hand") {
      if (state.space) state.spacePanned = true;
      state.drag = {
        kind: "pan",
        x: e.clientX,
        y: e.clientY,
        view: { ...state.view },
      };
      viewport.classList.add("dragging");
      return;
    }
    const p = worldPoint(e);
    if (state.spritePlacement || state.duplicatePlacement) {
      releaseCanvasPointer();
      if (e.button !== 0) return;
      const duplicate = state.duplicatePlacement,
        pending = duplicate || state.spritePlacement,
        target = closestHandle(
          p,
          null,
          duplicate ? { uid: duplicate.uid } : {},
        );
      if (!target) {
        toast(
          duplicate
            ? "Choose a joint on the source figure."
            : "Choose an unlocked figure joint to attach the sprite.",
        );
        return;
      }
      if (pending.document !== editor._documentToken)
        return cancelSpritePlacement();
      if (duplicate) {
        editor.select(duplicate.uid);
        const sourceIndex = editor.figure?.segments.findIndex(
          (segment) => segment.segment_id === duplicate.handleId,
        );
        if (
          sourceIndex === undefined ||
          sourceIndex < 0 ||
          editor.figure.figure_type_id !== duplicate.figureTypeId
        ) {
          cancelSpritePlacement();
          return;
        }
        editor.select(duplicate.uid, sourceIndex);
        const added = editor.duplicateSegment({
          parentId: target.id,
          branch: duplicate.branch,
          flip: duplicate.flip,
        });
        cancelSpritePlacement();
        editor.select(
          duplicate.uid,
          editor.figure.segments.findIndex(
            (segment) => segment.segment_id === added.selectedHandleId,
          ),
        );
        status(duplicate.branch ? "Branch duplicated" : "Segment duplicated");
      } else {
        editor.select(target.g.obj.unique_id);
        const added = editor.addSpriteSegment(pending.figure, {
          parentId: target.id,
        });
        cancelSpritePlacement();
        editor.select(target.g.obj.unique_id, added.segmentIndex);
        status("Sprite attached");
      }
      queueUI();
      return;
    }
    const camera = activeCameraHandle(p);
    if (
      (e.button === 0 || e.button === 2) &&
      camera &&
      ["select", "pose"].includes(state.tool)
    ) {
      selectTrack({ id: "camera", kind: "camera" });
      renderInspector();
      const geometry = editor.geometry;
      editor.beginCameraDrag({
        indices: rangeFrames(),
        label: `${camera.kind === "position" ? "Move" : camera.kind === "rotation" ? "Rotate" : "Scale"} camera`,
      });
      state.drag = {
        kind: "camera",
        handle: camera,
        start: p,
        viewport: cameraViewport(editor.report, currentFrame(), state.view),
        constrain: undefined,
        axis: null,
        geometry,
      };
      if (e.button === 2) state.suppressContext = true;
      return;
    }
    if (state.tool === "attach") {
      const target = closestHandle(p, editor.selectedUid);
      if (!target) {
        toast("Click a joint on the parent figure.");
        return;
      }
      if (rangeFrames())
        editor.joinFiguresInFrames(
          target.g.obj.unique_id,
          target.id,
          rangeFrames(),
        );
      else editor.joinFigure(target.g.obj.unique_id, target.id);
      setTool("select");
      status("Figures attached");
      return;
    }
    if (state.tool === "polygon") {
      polygonClick(p, e);
      return;
    }
    if (state.tool === "line" || state.tool === "circle") {
      const hit = pick(p),
        threshold = 10 / state.view.scale;
      let parent = null;
      if (hit) {
        let joint = -1,
          best = threshold * threshold;
        for (const [id, point] of hit.g.joints) {
          const distance = (point.x - p.x) ** 2 + (point.y - p.y) ** 2;
          if (distance < best) {
            best = distance;
            parent = point;
            joint =
              hit.g.fig?.segments?.findIndex((s) => s.segment_id === id) ??
              editor.report.figure_types
                .find((f) => f.figure_type_id === hit.g.obj.figure_type_id)
                .segments.findIndex((s) => s.segment_id === id);
          }
        }
        if (parent) editor.select(hit.g.obj.unique_id, joint);
      }
      if (!parent) editor.select(null);
      state.drag = {
        kind: "draw",
        start: parent ? { ...parent } : p,
        current: p,
      };
      requestRender();
      return;
    }
    const hit = pick(p);
    if (e.button === 2 && (!hit || hit.joint < 0)) return;
    if (!hit) {
      const initial = e.shiftKey ? [...selection()] : [];
      if (!e.shiftKey) editor.select(null);
      state.drag = {
        kind: "marquee",
        start: p,
        current: p,
        initial,
        mode: e.shiftKey ? "toggle" : "replace",
      };
      requestRender();
      return;
    }
    if (e.shiftKey && !e.altKey) {
      editor.select(hit.g.obj.unique_id, -1, { toggle: true });
      return;
    }
    editor.select(hit.g.obj.unique_id, hit.joint, {
      add: hit.joint < 0 && isSelected(hit.g.obj.unique_id),
    });
    if (
      hit.joint >= 0 &&
      hit.g.segments[hit.joint].static &&
      !hit.g.obj._stykIK?.[hit.g.segments[hit.joint].seg.segment_id]?.enabled &&
      state.tool !== "rig" &&
      state.tool !== "handle-edit" &&
      !state.handleEditHeld
    ) {
      toast("This joint follows its parent. Rotate a movable parent joint.");
      return;
    }
    const handleEdit = state.tool === "handle-edit" || state.handleEditHeld;
    const figureTransform = e.altKey && hit.joint >= 0 && !handleEdit;
    if (e.button === 2) state.suppressContext = true;
    if (handleEdit) editor.beginHandleEditDrag({ bend: e.button === 2 });
    else if (figureTransform)
      editor.beginFigureHandleDrag(p.x, p.y, { rotate: true, scale: true });
    else if (hit.joint >= 0 && state.tool === "rig")
      editor.beginRigDrag({ reposition: state.rigMode !== "rotate" });
    else if (hit.joint >= 0) editor.beginDrag("Pose joint");
    else editor.beginTranslationDrag("Move connected figures");
    state.drag = {
      kind: handleEdit
        ? "handle-edit"
        : figureTransform
          ? "figure-transform"
          : hit.joint >= 0
            ? state.tool === "rig"
              ? "rig"
              : e.button === 2
                ? "bend"
                : "pose"
            : "move",
      bend: e.button === 2,
      constrain: e.ctrlKey || e.metaKey,
      axis: null,
      start: p,
      root: { x: hit.g.obj.root_x, y: hit.g.obj.root_y },
      joint: hit.joint,
      moved: false,
    };
    if (hit.joint < 0 && !handleEdit) {
      const uids = editor.resolveTranslationSelection().affectedUids;
      state.drag.ikLive = editor._drag.before.some(hasPinnedIK);
      if (!state.drag.ikLive) {
        state.drag.geometry = editor.geometry;
        state.drag.translations = new Map([...uids].map((uid) => [uid, { x: 0, y: 0 }]));
      }
    }
    requestRender();
  }),
);
overlay.addEventListener(
  "pointermove",
  guarded((e) => {
    const drag = state.drag;
    if (!drag) {
      // Playback uses worker packets; hover must not materialize an editable
      // scene (and all its handles) for every mouse move between ticks.
      if (state.previewing || state.playing || state.editablePreparing) return;
      if (state.spritePlacement || state.duplicatePlacement) {
        const point = worldPoint(e),
          pending = state.spritePlacement || state.duplicatePlacement;
        pending.point = point;
        pending.hover = closestHandle(
          point,
          null,
          state.duplicatePlacement ? { uid: state.duplicatePlacement.uid } : {},
        );
        requestRender();
        return;
      }
      const previousCameraHandle = state.hoverCameraHandle;
      state.hoverCameraHandle = activeCameraHandle(worldPoint(e));
      overlay.style.cursor = cameraHandleCursor(state.hoverCameraHandle, cameraViewport(editor.report,currentFrame(),state.view));
      if (previousCameraHandle?.index !== state.hoverCameraHandle?.index) requestRender();
      const geometry = editor.geometry;
      const handle =
        state.handles && !state.hoverCameraHandle
          ? pickCanvasHandle(geometry, worldPoint(e), {
              handles: canvasHandles(geometry),
              project: screenPoint,
              projectionScale: !state.playing&&!state.previewing?state.view.scale:undefined,
              minRadius: 8,
              nearest: true,
            })
          : null;
      state.hoverHandle = handle
        ? {
            uid: handle.uid,
            joint: handle.joint,
            id: handle.id,
            static: handle.static,
          }
        : null;
      return;
    }
    if (drag.kind === "pan") {
      state.view.x = drag.view.x + e.clientX - drag.x;
      state.view.y = drag.view.y + e.clientY - drag.y;
      placeArtboard();
      requestRender();
      return;
    }
    const p = worldPoint(e);
    if (drag.kind === "camera") {
      if (
        (p.x === drag.lastPoint?.x && p.y === drag.lastPoint?.y) ||
        (!drag.lastPoint && p.x === drag.start.x && p.y === drag.start.y)
      )
        return;
      drag.constrain ??= e.ctrlKey || e.metaKey;
      drag.snap = e.shiftKey;
      drag.lastPoint = p;
      editor.updateCameraDrag(cameraDragDelta(drag, p));
      requestRender();
      return;
    }
    if (drag.kind === "draw" || drag.kind === "marquee") {
      drag.current = p;
      requestRender();
      return;
    }
    drag.moved = true;
    if (drag.kind === "move") {
      const dx = p.x - drag.start.x,
        dy = p.y - drag.start.y;
      if (drag.constrain && !drag.axis && Math.hypot(dx, dy) > 0.5)
        drag.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      const delta = {
        x: drag.axis === "y" ? 0 : dx,
        y: drag.axis === "x" ? 0 : dy,
      };
      if (drag.ikLive) { drag.delta = delta; editor.moveSelection(delta.x, delta.y, {fromStart: true}); }
      else for (const uid of drag.translations.keys()) drag.translations.set(uid, delta);
    } else if (drag.kind === "handle-edit")
      editor.editHandlePosition(p.x, p.y, { bend: drag.bend });
    else if (drag.kind === "figure-transform")
      editor.transformFigureHandle(p.x, p.y, {
        ctrlKey: e.ctrlKey || e.metaKey,
        shiftKey: e.shiftKey,
      });
    else if (drag.kind === "rig")
      editor.editRigJoint(p.x, p.y, {
        reposition: state.rigMode !== "rotate",
        stretch: e.ctrlKey || e.metaKey,
        isolate: Boolean(state.isolateHeld || state.isolateMode),
      });
    else if (drag.kind === "bend")
      editor.bendJoint(p.x, p.y, {
        stretch: e.ctrlKey || e.metaKey,
        isolate: Boolean(state.isolateHeld || state.isolateMode),
        snapTolerance: 6 / state.view.scale,
      });
    else
      editor.poseJoint(p.x, p.y, {
        stretch: e.ctrlKey || e.metaKey,
        isolate: Boolean(state.isolateHeld || state.isolateMode),
        snapTolerance: 6 / state.view.scale,
      });
    requestRender();
  }),
);
function releaseCanvasPointer() {
  const id = canvasPointerId;
  canvasPointerId = null;
  if (id !== null && overlay.hasPointerCapture(id))
    overlay.releasePointerCapture(id);
}
function endDrag() {
  const drag = state.drag;
  state.drag = null;
  releaseCanvasPointer();
  if (!drag) return;
  viewport.classList.remove("dragging");
  if (drag.kind === "draw") {
    const p = drag.start,
      q = drag.current,
      length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length > 1) {
      if (!editor.addSegment)
        throw new Error("Segment authoring is unavailable.");
      editor.addSegment({
        type: state.tool,
        length,
        angle: Math.atan2(q.y - p.y, q.x - p.x),
        thickness: 7,
        start: p,
      });
      status("Segment added");
    }
  } else if (drag.kind === "marquee") {
    const a = screenPoint(drag.start),
      b = screenPoint(drag.current);
    const left = Math.min(a.x, b.x),
      right = Math.max(a.x, b.x),
      top = Math.min(a.y, b.y),
      bottom = Math.max(a.y, b.y);
    const uids = new Set();
    if (Math.hypot(right - left, bottom - top) > 3)
      for (const g of editor.geometry.objects.values()) {
        if (!g || isHidden(g.obj.unique_id) || isLocked(g.obj.unique_id))
          continue;
        const box = boundsOf(g),
          points = [
            screenPoint({ x: box.minX, y: box.minY }),
            screenPoint({ x: box.maxX, y: box.minY }),
            screenPoint({ x: box.maxX, y: box.maxY }),
            screenPoint({ x: box.minX, y: box.maxY }),
          ];
        if (
          Math.max(...points.map((p) => p.x)) >= left &&
          Math.min(...points.map((p) => p.x)) <= right &&
          Math.max(...points.map((p) => p.y)) >= top &&
          Math.min(...points.map((p) => p.y)) <= bottom
        )
          uids.add(g.obj.unique_id);
      }
    editor.selectMarquee([...uids], { mode: drag.mode, initial: drag.initial });
  } else if (drag.kind === "camera") editor.commitCameraDrag();
  else if (drag.kind !== "pan") {
    if (drag.kind === "move" && drag.moved) {
      const delta = drag.ikLive ? drag.delta : drag.translations.get(editor.selectedUid);
      if (rangeFrames()) {
        editor.cancelDrag();
        moveSelected(delta.x, delta.y);
      } else if (!drag.ikLive) editor.moveSelection(delta.x, delta.y, { fromStart: true });
    }
    editor.commitDrag();
  }
  queueUI();
}
function cancelDrag() {
  releaseCanvasPointer();
  cancelSpritePlacement();
  cancelPolygonDraft();
  if (!state.drag) return;
  if (state.drag.kind === "camera") editor.cancelCameraDrag();
  if (
    ["move", "pose", "rig", "bend", "handle-edit", "figure-transform"].includes(
      state.drag.kind,
    )
  )
    editor.cancelDrag();
  state.drag = null;
  viewport.classList.remove("dragging");
  queueUI();
}
overlay.addEventListener("pointerup", guarded(endDrag));

overlay.addEventListener("dblclick", guarded((event) => {
  if (event.button !== 0 || state.space || state.playing || state.previewing ||
      state.spritePlacement || state.duplicatePlacement ||
      !["select", "pose", "rig"].includes(state.tool)) return;
  const hit = pick(worldPoint(event));
  if (!hit || isHidden(hit.uid) || isLocked(hit.uid)) return;
  event.preventDefault();
  if (hit.joint < 0) {
    state.builderBranch = false;
    editor.selectConnected(hit.uid, {add: event.shiftKey, candidates: editor.selectionFrame.objects
      .filter(o => !isHidden(o.unique_id) && !isLocked(o.unique_id)).map(o => o.unique_id)});
    status(`${editor.selectedUids.size} connected figures selected`);
  } else {
    editor.selectBranch(hit.uid, hit.joint);
    status("Branch selected — copy or edit the complete branch");
  }
  queueUI();
}));
overlay.addEventListener("pointercancel", cancelDrag);
overlay.addEventListener("lostpointercapture", (event) => {
  if (
    event.pointerId === canvasPointerId &&
    !overlay.hasPointerCapture(event.pointerId)
  )
    cancelDrag();
});
overlay.addEventListener("pointerleave", () => {
  if (state.spritePlacement || state.duplicatePlacement) {
    const pending = state.spritePlacement || state.duplicatePlacement;
    pending.point = null;
    pending.hover = null;
    requestRender();
  }
  state.hoverHandle = null;
  state.hoverCameraHandle = null;
  if (!state.drag) overlay.style.cursor = '';
  requestRender();
});
viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    interruptRecovery();
    const r = viewport.getBoundingClientRect();
    if (!e.ctrlKey && !e.metaKey) {
      state.view.x -= e.shiftKey ? e.deltaY : e.deltaX;
      state.view.y -= e.shiftKey ? e.deltaX : e.deltaY;
      placeArtboard();
      requestRender();
    } else
      zoom(Math.exp(-e.deltaY * 0.005), {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      });
  },
  { passive: false },
);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.error?.message || data.error || data.message || message;
    } catch {}
    throw new Error(message);
  }
  return response;
}
async function confirmReplace() {
  finishCurrentEdit();
  if (!editor.dirty) return true;
  return new Promise((resolve) => {
    showDialog(
      "Save your changes?",
      `<p>Your current project has unsaved changes. Save a StykAnimate project to keep editing it later.</p><div class="dialog-actions"><button class="button" id="keep-editing">Cancel</button><button class="button" id="discard-changes">Discard</button><button class="button primary" id="save-changes">Save project</button></div>`,
    );
    $("keep-editing").onclick = () => {
      closeDialog();
      resolve(false);
    };
    $("discard-changes").onclick = () => {
      closeDialog();
      resolve(true);
    };
    $("save-changes").onclick = guarded(async () => {
      const saved = await saveNative();
      if (saved) {
        closeDialog();
        resolve(true);
      }
    });
    $("dialog").addEventListener("cancel", () => resolve(false), {
      once: true,
    });
  });
}
async function acceptImport(
  result,
  name,
  { replaceApproved = false, openToken } = {},
) {
  let report = result.document ?? result.report ?? result;
  if (report.format === "stykanimate") report = report.document;
  const savedDraft = Boolean(report._styk?.simpleFrameDraft);
  const kind =
    result.kind ||
    ((name || result.filename || "").toLowerCase().endsWith(".stk")
      ? "stk"
      : "piv");
  if (kind === "stk" || kind === "stkz" || kind === "stykmov") {
    finishCurrentEdit();
    editor.importFigure(report);
    status(`Imported ${result.filename || name || "figure"}`);
  } else {
    const approvalCurrent =
      replaceApproved &&
      replaceApproved.report === editor.report &&
      replaceApproved.revision === editor.revision &&
      replaceApproved.draftRevision === editor.frameDraftRevision &&
      !editor._drag &&
      !editor._animationEdit;
    if (!approvalCurrent && !(await confirmReplace())) return false;
    let initialScene;
    try {
      await editor.loadAsync(
        report,
        (name || result.filename || "Untitled").replace(
          /\.(piv|stk|styk|stkz|stykmov|json|nodes|nodemc|stknds)$/i,
          "",
        ),
        {
          initialFrameIndex: kind === "piv" && !savedDraft ? "last" : 0,
          prepareScene: state.renderer?.prepareInitialScene
            ? async (incoming) => {
                const renderer = state.renderer;
                initialScene = await renderer.prepareInitialScene({
                  ...incoming,
                  view: fittedView(incoming.report),
                  getView: () => fittedView(incoming.report),
                  cameraEnabled: false,
                  editorBackgroundColor: builderBackgroundColor(
                    state.settings,
                    state,
                  ),
                  checkCurrent: () => {
                    incoming.checkCurrent();
                    if (state.renderer !== renderer)
                      throw new DOMException(
                        "The graphics device changed while importing.",
                        "AbortError",
                      );
                  },
                });
                preparedScenes.set(incoming.report, initialScene);
                return initialScene;
              }
            : undefined,
        },
      );
    } finally {
      if (initialScene) {
        preparedScenes.delete(initialScene.report);
        initialScene.dispose();
      }
    }
    state.sourceId = result.sourceId || null;
    if (!initialScene?.activated) {
      state.hidden.clear();
      state.locked.clear();
      images.clear();
      fit();
    }
    if (desktop?.activateDocument)
      state.documentToken = (
        await desktop.activateDocument({ openToken })
      ).documentToken;
  }
  state.lastImportWarnings = result.warnings || report._styk?.sticknodes?.warnings || [];
  if(state.lastImportWarnings.length)showDialog('Stick Nodes import notes',`<p>The asset is ready to edit. These source features may look or behave differently:</p><ul>${state.lastImportWarnings.map(w=>`<li>${esc(w.message)}</li>`).join('')}</ul>`);
  state.lastImport = result.timings || null;
  const ms = result.timings?.total_ms ?? result.timings?.decode_ms;
  status(
    `Opened ${result.filename || name || editor.name}${ms !== undefined ? ` · ${Math.round(ms)} ms${result.timings?.cache_hit ? " · cached" : ""}` : ""}`,
  );
  warmPlayback();
  return true;
}
function cancelSpritePlacement() {
  spriteImportController?.abort();
  spriteImportController = null;
  spritePlacementDialog?.cancel();
  const pending = state.spritePlacement || state.duplicatePlacement;
  if (!pending) return;
  $("viewport-hint").textContent = pending.previousHint;
  state.spritePlacement = null;
  state.duplicatePlacement = null;
  viewport.classList.remove("sprite-placement");
  requestRender();
}
function beginDuplicatePlacement({ branch = false, flip = false } = {}) {
  if (state.duplicatePlacement) {
    cancelSpritePlacement();
    return;
  }
  finishCurrentEdit();
  cancelSpritePlacement();
  const segment = editor.figure?.segments?.[editor.selectedJoint];
  if (!segment || !editor.object) return;
  setTool("rig");
  state.duplicatePlacement = {
    document: editor._documentToken,
    uid: editor.selectedUid,
    figureTypeId: editor.figure.figure_type_id,
    handleId: segment.segment_id,
    branch,
    flip,
    point: null,
    hover: null,
    previousHint: $("viewport-hint").textContent,
  };
  viewport.classList.add("sprite-placement");
  $("viewport-hint").textContent =
    "Choose a parent joint for the copy · Esc to cancel";
  viewport.focus({ preventScroll: true });
  requestRender();
}
async function beginSpritePlacement(file) {
  finishCurrentEdit();
  cancelSpritePlacement();
  const controller = new AbortController(),
    source = editor._documentToken,
    content = $("dialog-content"),
    originalContent = content.firstChild,
    dialog = $("dialog"),
    originalOpen = dialog.open;
  spriteImportController = controller;
  const changed = () => {
    if (editor._documentToken !== source) {
      controller.abort();
      spritePlacementDialog?.cancel();
    }
  };
  editor.addEventListener("change", changed);
  try {
    const sprite = await imageFileToFigure(file, { signal: controller.signal });
    if (
      controller.signal.aborted ||
      editor._documentToken !== source ||
      content.firstChild !== originalContent ||
      dialog.open !== originalOpen
    )
      return false;
    spritePlacementDialog ??= new SpritePlacementDialog({ dialog, content });
    const figure = await spritePlacementDialog.open(sprite);
    if (
      !figure ||
      controller.signal.aborted ||
      editor._documentToken !== source
    )
      return false;
    state.spritePlacement = {
      document: source,
      figure,
      image: imageFor(assetUrl(figure.image_assets[0])),
      point: null,
      hover: null,
      previousHint: $("viewport-hint").textContent,
    };
    viewport.classList.add("sprite-placement");
    $("viewport-hint").textContent =
      "Choose an attachment joint · Esc to cancel";
    viewport.focus({ preventScroll: true });
    requestRender();
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    throw error;
  } finally {
    editor.removeEventListener("change", changed);
    if (spriteImportController === controller) spriteImportController = null;
  }
}
async function importMediaFile(
  file,
  { background = false, isCurrent = () => true } = {},
) {
  finishCurrentEdit();
  const destination = editor.report,
    controller = new AbortController();
  const changed = () => {
    if (editor.report !== destination) controller.abort();
  };
  editor.addEventListener("change", changed);
  status("Importing image…", false, true);
  try {
    const media = await (
      background ? imageFileToBackground : imageFileToFigure
    )(file, { signal: controller.signal });
    if (
      controller.signal.aborted ||
      editor.report !== destination ||
      !isCurrent()
    )
      return false;
    finishCurrentEdit();
    if (editor.report !== destination) return false;
    if (background) editor.importBackground(media);
    else editor.importFigure(media);
    status(`Imported ${file.name}`);
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    throw error;
  } finally {
    editor.removeEventListener("change", changed);
  }
}
async function chooseSticknodesFile(file,isCurrent=()=>true) {
  const onProgress=p=>{if(isCurrent())status(`${p.phase || 'Importing'}…`,false,true);};
  let result=await importer.importFile(file,{onProgress});
  if(!isCurrent())return null;
  if(result.kind==='sticknodes-archive'){
    const index=await new Promise(resolve=>{
      showDialog('Choose a Stick Nodes asset',`<p>This pack contains ${result.entries.length} assets.</p><select id="sticknodes-archive-entry" style="width:100%" size="12">${result.entries.map(e=>`<option value="${e.index}">${esc(e.name)}</option>`).join('')}</select><div class="dialog-actions"><button id="sticknodes-archive-open" class="primary">Import selected asset</button></div>`);
      const dialog=$('dialog'),select=$('sticknodes-archive-entry');select.selectedIndex=0;
      const cancel=()=>{dialog.removeEventListener('close',cancel);resolve(null);};
      dialog.addEventListener('close',cancel,{once:true});
      $('sticknodes-archive-open').onclick=()=>{const index=Number(select.value);dialog.removeEventListener('close',cancel);dialog.close();resolve(index);};
    });
    if(index===null||!isCurrent())return null;
    result=await importer.importFile(file,{entryIndex:index,onProgress});
  }
  return isCurrent()?result:null;
}
async function importFiles(files) {
  const started = performance.now(); telemetry.count('import_started');
  try {
    const result = await importFilesTracked(files);
    telemetry.count(result === false ? 'import_cancelled' : 'import_succeeded');
    if (result !== false) telemetry.timing('import_ms', performance.now() - started);
    return result;
  } catch (error) { telemetry.count(error.name === 'AbortError' ? 'import_cancelled' : 'import_failed'); telemetry.error(error, 'import'); throw error; }
}
function recordImportKind(filename = '') {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  telemetry.count(['piv', 'stk'].includes(extension) ? 'import_pivot' : ['nodes', 'nodemc', 'stknds', 'zip'].includes(extension) ? 'import_sticknodes' : ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(extension) ? 'import_media' : 'import_native');
}
async function importFilesTracked(files) {
  finishCurrentEdit();
  const seq = ++importSequence;
  importer.cancelPending();
  state.importing = true;
  status("Importing…", false, true);
  try {
    for (const file of files) {
      recordImportKind(file.name);
      if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name)) {
        if (
          !(await importMediaFile(file, {
            isCurrent: () => seq === importSequence,
          }))
        )
          return false;
        continue;
      }
      const result = await chooseSticknodesFile(file,()=>seq===importSequence);
      if (!result || seq !== importSequence) return false;
      await acceptImport(result, file.name);
      telemetry.timing('import_decode_ms', result.timings?.decode_ms);
    }
  } catch(error) {
    if(error.name!=="AbortError")throw error;
    return false;
  } finally {
    if(seq===importSequence)state.importing = false;
  }
}
async function openFile() {
  pause();
  if (desktop) {
    status("Opening file…", false, true);
    const result = await desktop.openFile();
    if (result) await acceptNativeFile(result);
    else status("Ready");
  } else {
    $("file-input").value = "";
    $("file-input").click();
  }
}
async function acceptNativeFile(result) {
  const started = performance.now(); telemetry.count('import_started'); recordImportKind(result.filename);
  try {
    const accepted = await acceptNativeFileTracked(result);
    telemetry.count(accepted === false ? 'import_cancelled' : 'import_succeeded');
    if (accepted !== false) telemetry.timing('import_ms', performance.now() - started);
    telemetry.timing('import_decode_ms', state.lastImport?.decode_ms);
    return accepted;
  } catch (error) { telemetry.count(error.name === 'AbortError' ? 'import_cancelled' : 'import_failed'); telemetry.error(error, 'import'); throw error; }
}
async function acceptNativeFileTracked(result) {
  pause();
  const decoded = result.bytes
    ? await chooseSticknodesFile(new File([result.bytes], result.filename))
    : result;
  if(!decoded)return false;
  decoded.timings = { ...decoded.timings, ...result.timings };
  return acceptImport(decoded, result.filename, {
    openToken: result.openToken,
  });
}
async function openSample(path) {
  pause();
  status("Decoding Pivot file…", false, true);
  await acceptImport(await importer.openSample(path));
}
async function saveBlob(blob, filename, signal) {
  const exportStart = signal && exportTelemetry.get(signal);
  if (exportStart !== undefined) { telemetry.timing('export_ms', performance.now() - exportStart); exportTelemetry.delete(signal); }
  if (desktop) {
    return writeNativeBlob(desktop, blob, {
      signal,
      defaultPath: filename,
      filters: [
        {
          name: filename.split(".").at(-1).toUpperCase(),
          extensions: [filename.split(".").at(-1)],
        },
      ],
    });
  }
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
async function saveNative({ saveAs = false } = {}) {
  finishCurrentEdit();
  while(editor._movieclipScopes?.length)editor.leaveMovieclip();
  interruptRecovery();
  status("Saving project…", false, true);
  const revision = editor.revision,
    draftRevision = editor.frameDraftRevision,
    report = editor.report,
    documentToken = state.documentToken,
    name = editor.name;
  let saved;
  try {
    saved = await runDocumentExport("styk", (blob, signal) =>
      desktop?.beginProjectWrite
        ? writeNativeBlob(desktop, blob, {
            signal,
            documentToken,
            saveAs,
            defaultPath: `${name || "Untitled"}.styk`,
            filters: [{ name: "StykAnimate project", extensions: ["styk"] }],
          })
        : saveBlob(blob, `${name || "Untitled"}.styk`, signal),
    );
  } catch (error) {
    if (error.name === "AbortError") {
      status("Save cancelled");
      return false;
    }
    throw error;
  }
  if (saved) {
    if (editor.report === report && state.documentToken === documentToken) {
      if (
        editor.revision === revision &&
        editor.frameDraftRevision === draftRevision
      ) {
        editor.markSaved();
        if (desktop?.deleteRecovery) await desktop.deleteRecovery();
      }
    }
    updateTitle();
    status(
      editor.dirty ? "Saved copy · Newer changes are unsaved" : "Project saved",
    );
  } else status("Save cancelled");
  return Boolean(
    saved &&
      editor.report === report &&
      state.documentToken === documentToken &&
      editor.revision === revision &&
      editor.frameDraftRevision === draftRevision &&
      !editor.dirty,
  );
}
async function exportPivot(format = "piv") {
  finishCurrentEdit();
  interruptRecovery();
  status(`Writing .${format}…`, false, true);
  const filename = `${["stk", "stkz", "stykmov"].includes(format) ? nameOf(editor.object) : editor.name || "Untitled"}.${format}`;
  let saved;
  try {
    saved = await runDocumentExport(format, (blob, signal) =>
      saveBlob(blob, filename, signal),
    );
  } catch (error) {
    if (error.name === "AbortError") {
      status("Export cancelled");
      return;
    }
    throw error;
  }
  if (saved) {
    status(`Exported .${format}`);
    toast(
      `Your ${["stk", "stkz", "stykmov"].includes(format) ? "figure" : "animation"} was exported as .${format}.`,
    );
  }
  closeDialog();
}
function exportOptions({ animation = true } = {}) {
  const number = (id, fallback) => ($(id) ? Number($(id).value) : fallback);
  const options = {
    width: number("export-width", editor.report.canvas_width),
    height: number("export-height", editor.report.canvas_height),
    start: number("export-start", 1) - 1,
    end: number("export-end", editor.totalTicks),
    quality: number("export-quality", 94) / 100,
    dither: $("export-gif-dither")?.checked ?? defaultGIFDither(editor.report),
    smoothing: normalizeExportSmoothing(
      $("export-smoothing")?.value || "edges",
    ),
  };
  if (
    !Number.isInteger(options.width) ||
    !Number.isInteger(options.height) ||
    options.width < 1 ||
    options.height < 1 ||
    options.width > 16384 ||
    options.height > 16384 ||
    options.width * options.height > 16777216
  )
    throw new Error(
      "Export size must be whole pixels, up to 16 million pixels per frame.",
    );
  if (
    animation &&
    (!Number.isInteger(options.start) ||
      !Number.isInteger(options.end) ||
      options.start < 0 ||
      options.start >= options.end ||
      options.end > editor.totalTicks)
  )
    throw new Error("Choose a valid export frame range.");
  if (
    !Number.isFinite(options.quality) ||
    options.quality < 0.01 ||
    options.quality > 1
  )
    throw new Error("Quality must be between 1 and 100 percent.");
  return options;
}
/** Keep rendering off the UI thread and cancel the whole job if its document changes. */
async function withExportRenderer(
  options,
  report,
  render,
  { frames = 1, title = "Exporting animation" } = {},
) {
  const controller = new AbortController(),
    job = { controller, recovery: false },
    source = editor.report;
  exportJobs.add(job);
  telemetry.count('export_started'); exportTelemetry.set(controller.signal, performance.now());
  let frameRenderer;
  showDialog(
    title,
    `<progress id="export-progress" max="${frames}" style="width:100%;accent-color:#0d99ff"></progress><div class="dialog-actions"><button class="button" id="cancel-export">Cancel</button></div>`,
  );
  const progress = $("export-progress"),
    dialog = $("dialog"),
    cancel = () => controller.abort();
  const onClose = () => {
    if (!dialog.open || !progress.isConnected) cancel();
  };
  $("cancel-export").onclick = cancel;
  dialog.addEventListener("close", onClose);
  try {
    frameRenderer = new ExportFrameRenderer({
      width: options.width,
      height: options.height,
      smoothing: options.smoothing,
      baseURL: importer.baseURL,
      token: importer.token,
      signal: controller.signal,
      getRevision: () =>
        editor.report === source
          ? `${editor.revision}:${editor.frameDraftRevision}`
          : "replaced",
    });
    await frameRenderer.load(report);
    progress.value = 0;
    const saved = await render(
      frameRenderer,
      controller.signal,
      ({ completed, total }) => {
        if (!progress.isConnected) return;
        if (Number.isFinite(total) && total > 0) progress.max = total;
        progress.value = completed;
      },
    );
    telemetry.count(saved ? 'export_succeeded' : 'export_cancelled');
    if (saved) telemetry.milestone('first_export');
    return saved;
  } catch (error) {
    telemetry.count(error.name === 'AbortError' ? 'export_cancelled' : 'export_failed');
    if (error.name !== 'AbortError') telemetry.error(error, 'export');
    if (error.name === "AbortError") {
      status("Export cancelled");
      return false;
    }
    throw error;
  } finally {
    frameRenderer?.dispose();
    exportJobs.delete(job);
    dialog.removeEventListener("close", onClose);
    if (progress.isConnected) closeDialog();
  }
}
async function exportPNG() {
  telemetry.count('export_png');
  finishCurrentEdit();
  const options = exportOptions({ animation: false }),
    frame = currentFrame(),
    filename = `${editor.name}-frame-${editor.tick + 1}.png`;
  await withExportRenderer(
    options,
    editor.report,
    async (renderer, signal) => {
      const canvas = await renderer.renderFrame(frame);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("PNG export failed.");
      if (signal.aborted)
        throw new DOMException("Export cancelled.", "AbortError");
      const saved = await saveBlob(blob, filename, signal);
      if (saved) status("PNG exported");
      return saved;
    },
    { title: "Exporting frame" },
  );
}
async function exportSVGFrame() {
  telemetry.count('export_svg');
  finishCurrentEdit();
  const options = {
      ...exportOptions({ animation: false }),
      smoothing: "edges",
    },
    frame = currentFrame(),
    filename = `${editor.name}-frame-${editor.tick + 1}.svg`;
  await withExportRenderer(
    options,
    editor.report,
    async (renderer, signal) => {
      const blob = await renderer.renderSVGFrame(frame);
      const saved = await saveBlob(blob, filename, signal);
      if (saved) status("SVG exported");
      return saved;
    },
    { title: "Exporting vector frame" },
  );
}
async function exportImages(format) {
  telemetry.count(format.startsWith('svg') ? 'export_svg' : format.startsWith('gif') ? 'export_gif' : format.startsWith('jpeg') ? 'export_jpeg' : 'export_png');
  finishCurrentEdit();
  const options = exportOptions(),
    report =
      state.settings.timelineMode === "simple"
        ? materializeSimpleFrameDraftForPivot(editor.report)
        : editor.report,
    ticks = options.end - options.start,
    fps = report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps,
    extension = format.endsWith("sequence")
      ? "zip"
      : format === "apng"
        ? "png"
        : "gif",
    filename = `${editor.name}${format.endsWith("sequence") ? "-" + format : ""}.${extension}`,
    loop = state.loop;
  if (format === "svg-sequence") options.smoothing = "edges";
  await withExportRenderer(
    options,
    report,
    async (renderer, signal, onProgress) => {
      const blob = await exportAnimation({
        format,
        width: options.width,
        height: options.height,
        quality: options.quality,
        dither: options.dither,
        fps,
        totalFrames: ticks,
        loop,
        signal,
        onProgress,
        renderFrame: (index) => renderer.renderTick(index + options.start),
        renderSVGFrame: (index) =>
          renderer.renderSVGTick(index + options.start),
      });
      const saved = await saveBlob(blob, filename, signal);
      if (saved) status("Animation exported");
      return saved;
    },
    { frames: ticks },
  );
}
async function exportVideo(format = "webm") {
  telemetry.count('export_video');
  finishCurrentEdit();
  const vfw = format === "vfw" ? vfwExportControls.getOptions() : null;
  const codec = $(`export-${format}-codec`)?.value || undefined;
  const nativeWebm =
    format === "webm" &&
    document.querySelector('[data-action="export-video"]')?.dataset.provider ===
      "FFmpeg";
  const bitrate =
    format === "webm"
      ? Number($("export-webm-bitrate")?.value || 8) * 1e6
      : undefined;
  if (
    bitrate !== undefined &&
    (!Number.isFinite(bitrate) || bitrate < 100000 || bitrate > 200e6)
  )
    throw new Error("Choose a WebM bitrate between 0.1 and 200 Mbit/s.");
  const options = exportOptions(),
    report =
      state.settings.timelineMode === "simple"
        ? materializeSimpleFrameDraftForPivot(editor.report)
        : editor.report,
    ticks = options.end - options.start,
    fps = report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps,
    extension = format === "vfw" ? "avi" : format,
    filename = `${editor.name}.${extension}`;
  await withExportRenderer(
    options,
    report,
    async (renderer, signal, onProgress) => {
      const encode =
        format === "vfw"
          ? encodeVfwVideo
          : format === "webm" && !nativeWebm
            ? encodeWebM
            : encodeNativeVideo;
      const blob = await encode({
        format,
        codec,
        bitrate,
        desktop,
        quality: options.quality,
        ...vfw,
        width: options.width,
        height: options.height,
        fps,
        totalFrames: ticks,
        signal,
        onProgress,
        renderFrame: (index) => renderer.renderTick(index + options.start),
      });
      const saved = await saveBlob(blob, filename, signal);
      if (saved) status(`${extension.toUpperCase()} exported`);
      return saved;
    },
    { frames: ticks },
  );
}
function showDialog(title, body) {
  $("dialog-content").innerHTML =
    `<div class="dialog-head"><h2>${esc(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon("close")}</button></div><div class="dialog-body">${body}</div>`;
  if (!$("dialog").open) $("dialog").showModal();
}
let textDialog;
let segmentValuesDialog;
function showSegmentValues({ hover = false } = {}) {
  finishKeyboardHandle();
  pause();
  cancelDrag();
  if (hover && state.hoverCameraHandle) {
    selectTrack({ id: "camera", kind: "camera" });
    requestAnimationFrame(() =>
      $("inspector").querySelector('[data-field="camera_x"]')?.focus(),
    );
    return;
  }
  const handle = hover ? state.hoverHandle : null;
  if (handle) editor.select(handle.uid, handle.joint);
  if (editor.selectedJoint < 0 || editor.selectedUid == null) return;
  segmentValuesDialog ??= new SegmentValuesDialog({
    dialog: $("dialog"),
    content: $("dialog-content"),
    editor,
    clipboard:
      desktop?.readClipboardText && desktop?.writeClipboardText
        ? {
            readText: () => desktop.readClipboardText(),
            writeText: (text) => desktop.writeClipboardText(text),
          }
        : navigator.clipboard,
    onClose: queueUI,
    onError: fail,
  });
  segmentValuesDialog.open({
    editMode: state.tool === "handle-edit" || state.handleEditHeld,
    isolate: Boolean(state.isolateHeld || state.isolateMode),
  });
}
function showTextDialog(editExisting = false) {
  pause();
  const report = editor.report,
    figure = editExisting ? editor.figure : null,
    typeId = figure?.figure_type_id;
  textDialog ??= new TextDialog({
    dialog: $("dialog"),
    content: $("dialog-content"),
    fontService:
      desktop?.listFonts && desktop?.readFont
        ? { listFonts: desktop.listFonts, readFont: desktop.readFont }
        : undefined,
  });
  const segment = figure?.segments?.[editor.selectedJoint];
  const initialOptions =
    segment?.primitive_code === 5
      ? { assetIndex: segment.extra_u16 ?? segment.extra?.[0] ?? 0 }
      : undefined;
  textDialog.open({
    figure,
    initialOptions,
    onApply: async (definition) => {
      if (editor.report !== report)
        throw new Error("The document changed. Open the text editor again.");
      if (editExisting)
        editor.replaceFigureDefinition(typeId, definition, {
          label: "Edit text",
        });
      else editor.importFigure(definition);
      status(editExisting ? "Text updated" : "Text added");
    },
  });
}
let backgroundDialog;
function showBackgroundDialog() {
  pause();
  backgroundDialog ??= new BackgroundDialog({
    dialog: $("dialog"),
    content: $("dialog-content"),
    resources,
    onError: fail,
  });
  const options = {
      indices: rangeFrames(),
    },
    report = editor.report;
  const apply = (operation) => {
    if (editor.report !== report)
      throw new Error("The document changed. Open background settings again.");
    return operation();
  };
  backgroundDialog.open({
    report: editor.report,
    frame: currentFrame(),
    onUse: (id) => apply(() => editor.setSceneBackground(id, options)),
    onCreate: (asset) =>
      apply(() => editor.importSceneBackground(asset, options)),
    onRename: (id, name) => apply(() => editor.renameSceneBackground(id, name)),
  });
}
function closeDialog() {
  $("dialog").close();
}
function showExport() {
  finishCurrentEdit();
  vfwExportControls?.dispose();
  showDialog(
    "Export your animation",
    `<details class="export-settings"><summary>Render settings <span>${editor.report.canvas_width} × ${editor.report.canvas_height} · ${editor.totalTicks} frames</span></summary><div class="text-options"><label>Width<input id="export-width" type="number" min="1" value="${editor.report.canvas_width}"></label><label>Height<input id="export-height" type="number" min="1" value="${editor.report.canvas_height}"></label><label class="check-row"><input type="checkbox" id="export-aspect" checked>Lock ratio</label></div><div class="text-options"><label>First frame<input id="export-start" type="number" min="1" max="${editor.totalTicks}" value="1"></label><label>Last frame<input id="export-end" type="number" min="1" max="${editor.totalTicks}" value="${editor.totalTicks}"></label><label>Lossy quality %<input id="export-quality" type="number" min="1" max="100" value="94"></label></div></details><div class="export-grid"><button class="export-option" data-action="export-stkz" ${editor.object ? "" : "disabled"}>${icon("person")}<span><strong>${isMovieclip(editor.figure)?"StykAnimate movieclip":"StykAnimate figure"}</strong><small>${isMovieclip(editor.figure)?".stykmov":".stkz"}</small></span></button><button class="export-option" data-action="export-piv">${icon("file")}<span><strong>Pivot animation</strong><small>.piv · Editable animation and media</small></span></button><button class="export-option" data-action="export-stk" ${editor.object ? "" : "disabled"}>${icon("person")}<span><strong>Pivot figure</strong><small>.stk · Reusable Pivot figure</small></span></button><button class="export-option" data-action="export-png">${icon("frame")}<span><strong>Current frame</strong><small>.png · Full canvas resolution</small></span></button><button class="export-option" data-action="export-svg">${icon("nodes")}<span><strong>Vector frame</strong><small>.svg · Editable paths and embedded media</small></span></button><button class="export-option" data-action="export-video">${icon("play")}<span><strong>Animation video</strong><small>.webm · Exact frame timing</small></span></button><button class="export-option" data-action="export-gif">${icon("loop")}<span><strong>Animated GIF</strong><small>.gif · Looping animation</small></span></button><button class="export-option" data-action="export-apng">${icon("frame")}<span><strong>Animated PNG</strong><small>.png · Lossless color and transparency</small></span></button><button class="export-option" data-action="export-png-sequence">${icon("duplicate")}<span><strong>PNG sequence</strong><small>.zip · Numbered lossless frames</small></span></button><button class="export-option" data-action="export-jpeg-sequence">${icon("duplicate")}<span><strong>JPEG sequence</strong><small>.zip · Numbered compact frames</small></span></button></div>`,
  );
  $("dialog-content")
    .querySelector(".export-settings")
    .insertAdjacentHTML(
      "beforeend",
      `<div class="text-options"><label>Smoothing<select id="export-smoothing" title="Pixel exports only. SVG keeps editable vector paths.">${EXPORT_SMOOTHING.map((option) => `<option value="${option.value}" title="${esc(option.description)}">${esc(option.label)}</option>`).join("")}</select></label><label class="check-row" title="Improve gradients and photographs in GIF exports."><input type="checkbox" id="export-gif-dither" ${defaultGIFDither(editor.report) ? "checked" : ""}>Dither (GIF)</label></div>`,
    );
  const grid = $("dialog-content").querySelector(".export-grid");
  grid.insertAdjacentHTML(
    "beforeend",
    `<button class="export-option" data-action="export-vfw" disabled>${icon("play")}<span><strong>Windows AVI</strong><small>Installed video codecs</small></span></button>`,
  );
  vfwExportControls = new VfwExportControls({
    container: $("dialog-content").querySelector(".export-settings"),
    button: grid.querySelector('[data-action="export-vfw"]'),
    dialog: $("dialog"),
    canExport: () => editor.totalTicks > 0,
    getDimensions: () => ({
      width: Number($("export-width").value),
      height: Number($("export-height").value),
    }),
    onError: fail,
  });
  if (
    editor.frameDraft?.mode === "add" &&
    editor.frameDraft.dirty &&
    editor.totalTicks > 0
  )
    grid.insertAdjacentHTML(
      "beforebegin",
      '<p class="property-note">Add the working pose as a frame to include it in animation exports. Your .styk project keeps the working pose.</p>',
    );
  const defaultBitrate =
    Math.round(
      Math.max(
        1,
        Math.min(
          50,
          (editor.report.canvas_width *
            editor.report.canvas_height *
            editor.report.fps *
            0.18) /
            1e6,
        ),
      ) * 10,
    ) / 10;
  $("dialog-content")
    .querySelector(".export-settings")
    .insertAdjacentHTML(
      "beforeend",
      `<div class="text-options"><label>WebM bitrate · Mbit/s<input id="export-webm-bitrate" type="number" min="0.1" max="200" step="0.1" value="${defaultBitrate}"></label></div><div class="text-options export-codecs"><label>MP4 codec<select id="export-mp4-codec" aria-label="MP4 codec" disabled></select></label><label>AVI codec<select id="export-avi-codec" aria-label="AVI codec" disabled></select></label></div>`,
    );
  for (const [id, label, note] of [
    ["mp4", "MP4 video", "H.264 video"],
    ["avi", "AVI video", "MPEG-4 video"],
    ["wmv", "Windows Media video", "WMV video"],
    ["gif-sequence", "GIF sequence", "Numbered GIF frames"],
    ["svg-sequence", "SVG sequence", "Numbered vector frames"],
  ])
    grid.insertAdjacentHTML(
      "beforeend",
      `<button class="export-option" data-action="export-${id}" ${id.endsWith("sequence") ? "" : "disabled"}>${icon(id.endsWith("sequence") ? "duplicate" : "play")}<span><strong>${label}</strong><small>${note}</small></span></button>`,
    );
  const singleFrameActions = new Set([
    "export-piv",
    "export-stk",
    "export-stkz",
    "export-png",
    "export-svg",
  ]);
  if (editor.totalTicks === 0) {
    for (const id of ["export-start", "export-end"]) {
      $(id).value = "0";
      $(id).disabled = true;
    }
    for (const button of grid.querySelectorAll("[data-action]")) {
      if (!singleFrameActions.has(button.dataset.action)) {
        button.disabled = true;
        button.title = "Add a frame to export an animation.";
      }
    }
    grid.insertAdjacentHTML(
      "beforebegin",
      '<p class="property-note">Add a frame to export an animation.</p>',
    );
  }
  let capabilitySequence = 0;
  async function refreshCapabilities() {
    const sequence = ++capabilitySequence;
    try {
      const width = Number($("export-width")?.value),
        height = Number($("export-height")?.value);
      const capabilities = await getExportCapabilities({
        width,
        height,
        fps: editor.report.frame_delay_ms
          ? 1000 / editor.report.frame_delay_ms
          : editor.report.fps,
        desktop,
      });
      if (sequence !== capabilitySequence || !grid.isConnected) return;
      for (const format of capabilities.formats) {
        const button = grid.querySelector(
          `[data-action="export-${format.id === "webm" ? "video" : format.id}"]`,
        );
        if (!button) continue;
        const select = $(`export-${format.id}-codec`);
        if (select) {
          const selected = select.value || format.defaultCodec;
          select.innerHTML = (format.codecs || [])
            .map(
              (codec) =>
                `<option value="${esc(codec.id)}" ${codec.supported ? "" : "disabled"}>${esc(codec.label)}${codec.lossless && !/lossless|uncompressed/i.test(codec.label) ? " · Lossless" : ""}</option>`,
            )
            .join("");
          select.disabled = !(format.codecs || []).some(
            (codec) => codec.supported,
          );
          if (
            [...select.options].some(
              (option) => option.value === selected && !option.disabled,
            )
          )
            select.value = selected;
          else
            select.value =
              [...select.options].find((option) => !option.disabled)?.value ||
              "";
        }
        const selectedCodec = format.codecs?.find(
          (codec) => codec.id === select?.value,
        );
        const encodedWidth = selectedCodec?.encodedWidth || format.encodedWidth,
          encodedHeight = selectedCodec?.encodedHeight || format.encodedHeight;
        button.dataset.provider = format.provider || "";
        button.disabled =
          !format.supported ||
          selectedCodec?.supported === false ||
          (editor.totalTicks === 0 &&
            !singleFrameActions.has(button.dataset.action));
        button.title =
          (editor.totalTicks === 0 &&
          !singleFrameActions.has(button.dataset.action)
            ? "Add a frame to export an animation."
            : "") ||
          format.reason ||
          (selectedCodec ? selectedCodec.notice : format.notice) ||
          "";
        if (format.kind === "video")
          button.querySelector("small").textContent = format.supported
            ? `.${format.extension} · ${selectedCodec?.label || format.codec || format.label}${encodedWidth && (encodedWidth !== width || encodedHeight !== height) ? ` · ${encodedWidth} × ${encodedHeight} (padded)` : ""}`
            : format.reason;
      }
    } catch (error) {
      for (const button of grid.querySelectorAll(
        '[data-action="export-video"],[data-action="export-mp4"],[data-action="export-avi"],[data-action="export-wmv"]',
      )) {
        button.disabled = true;
        button.title = error.message;
      }
    }
  }
  for (const id of ["export-width", "export-height"])
    $(id).oninput = () => {
      if ($("export-aspect").checked) {
        const value = Number($(id).value),
          ratio = editor.report.canvas_width / editor.report.canvas_height;
        if (value > 0)
          $(id === "export-width" ? "export-height" : "export-width").value =
            Math.max(
              1,
              Math.round(id === "export-width" ? value / ratio : value * ratio),
            );
      }
      void refreshCapabilities();
    };
  for (const id of ["export-mp4-codec", "export-avi-codec"])
    $(id).onchange = () => void refreshCapabilities();
  void refreshCapabilities();
  mountExportFlow($("dialog-content"));
}

function showHelp() {
  showDialog(
    "Keyboard shortcuts",
    `<div class="shortcut-grid">${[
      ["Timeline range", "Shift + click"],
      ["Timeline actions", "Right-click"],
      ["Copy / paste figure", "Ctrl + C / V"],
      ["Select figures", "Shift + click / drag"],
      ["Nudge selection", "Alt + arrow"],
      ["Create text", "T"],
      ["Play / pause", "Space"],
      ["Selection / pose", "V / P"],
      ["Handle edit", "Hold R / Ctrl R"],
      ["Pan canvas", "Hold Space / middle drag"],
      ["Zoom at pointer", "Ctrl + scroll"],
      ["Bend joint", "Right drag"],
      ["Stretch joint", "Ctrl + drag"],
      ["Isolate joint", "Caps Lock"],
      ["Add line / circle", "L / C"],
      ["New keyframe", "F6"],
      ["Duplicate frame after current", "Ctrl+Enter"],
      ["Previous / next frame", "← / →"],
      ["Onion skins / joints", "O / J"],
      ["Stretch a joint", "Ctrl + drag"],
      ["Duplicate figure", "Ctrl + D"],
      ["Undo / redo", "Ctrl + Z / Shift + Z"],
      ["Open / save", "Ctrl + O / S"],
      ["Fit canvas", "Shift + 1"],
      ["Fit selection", "Shift + 2"],
      ["Cancel drag", "Esc"],
    ]
      .map(([a, b]) => `<span>${a}</span><kbd>${b}</kbd>`)
      .join("")}</div>`,
  );
}
function showPerformance() {
  const presentation = playbackMetrics.snapshot(performance.now());
  const sorted = [...state.renderSamples].sort((a, b) => a - b),
    p = (n) =>
      sorted[
        Math.min(sorted.length - 1, Math.floor(sorted.length * n))
      ]?.toFixed(2) || "—";
  showDialog(
    "Performance",
    `<table class="metric-table">${[
      ["Renderer", state.renderer?.stats?.backend || "Initializing"],
      ["Playback FPS / target", presentation.fps === null ? "—"
        : `${presentation.fps.toFixed(1)} / ${presentation.targetFps.toFixed(1)}`],
      ["Playback startup", presentation.startupMs === null ? "—" : `${presentation.startupMs.toFixed(1)} ms`],
      ["Playback buffering", `${presentation.bufferingMs.toFixed(1)} ms · ${presentation.bufferingEvents} waits`],
      ["Recent CPU frame p50", `${p(0.5)} ms`],
      ["Recent CPU frame p95", `${p(0.95)} ms`],
      ["Recent CPU frame p99", `${p(0.99)} ms`],
      ["Measured frames", sorted.length],
      ["Current scene figures", editor.frame.objects.length.toLocaleString()],
      [
        "Current scene segments",
        editor.frame.objects
          .reduce(
            (n, o) =>
              n +
              (editor.report.figure_types.find(
                (f) => f.figure_type_id === o.figure_type_id,
              )?.segments.length || 0),
            0,
          )
          .toLocaleString(),
      ],
      [
        "Import decode",
        state.lastImport?.decode_ms !== undefined
          ? `${state.lastImport.decode_ms.toFixed(1)} ms`
          : "—",
      ],
    ]
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
      .join(
        "",
      )}</table><p>CPU submission timings include geometry evaluation and selection overlays. They do not measure GPU completion or input-to-display latency. Performance varies with hardware, scene complexity, effects, and media.</p>`,
  );
}
function openAppMenu(anchor) {
  showCommandMenu(applicationMenuItems(anchor.dataset.appMenu, editor, desktop), anchor);
}
const menuButtons = [...document.querySelectorAll('[data-app-menu]')];
menuButtons.forEach((button, index) => {
  button.tabIndex = index === 0 ? 0 : -1;
  button.addEventListener('focus', () => menuButtons.forEach(item => { item.tabIndex = item === button ? 0 : -1; }));
  button.addEventListener('pointerenter', () => {
    if (!$('menu').hidden && menuButtons.some(item => item.getAttribute('aria-expanded') === 'true')) openAppMenu(button);
  });
  button.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      menuButtons[(index + (event.key === 'ArrowRight' ? 1 : -1) + menuButtons.length) % menuButtons.length].focus();
    } else if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); openAppMenu(button); }
  });
});
new MutationObserver(() => {
  if ($('menu').hidden) menuButtons.forEach(button => button.setAttribute('aria-expanded', 'false'));
}).observe($('menu'), {attributes: true, attributeFilter: ['hidden']});
function showMenu(anchor) {
  const items = [
    ["new", "plus", "New animation", "Ctrl N"],
    ["open", "folder", "Open project…", "Ctrl O"],
    ["open-recent", "clock", "Open recent…", "", !desktop?.listRecentFiles],
    ["save", "save", "Save", "Ctrl S"],
    ["save-as", "save", "Save as…", "Ctrl Shift S"],
    null,
    ["undo", "undo", "Undo", "Ctrl Z"],
    ["redo", "redo", "Redo", "Ctrl Shift Z"],
    null,
    ["import", "import", "Import figures…", ""],
    ["import-sprite", "frame", "Import sprite image…", ""],
    ["import-background", "frame", "Import background image…", ""],
    ["add-text", "text", "Create text…", "T"],
    ["export", "export", "Export…", ""],
    null,
    ["settings", "settings", "Settings…", "Ctrl ,"],
    ["help", "help", "Keyboard shortcuts", "?"],
    ["performance", "activity", "Performance", ""],
  ];
  showCommandMenu(items, anchor);
}
function showCommandMenu(items, anchor) {
  menuButtons.forEach(button => button.setAttribute('aria-expanded', String(button === anchor)));
  $('menu')._anchor = anchor;
  $("menu").innerHTML = items
    .map((i) =>
      i
        ? `<button class="menu-item" role="menuitem" data-action="${i[0]}" ${i[4] ? "disabled" : ""}>${icon(i[1])}<span>${i[2]}</span><kbd>${i[3] || ""}</kbd></button>`
        : '<div class="menu-separator"></div>',
    )
    .join("");
  appLocalization?.applyMenu($("menu"));
  const r = anchor.getBoundingClientRect?.() || anchor;
  $("menu").hidden = false;
  const bounds = $("menu").getBoundingClientRect();
  $("menu").style.left =
    `${Math.max(8, Math.min(r.left, innerWidth - bounds.width - 8))}px`;
  $("menu").style.top =
    `${Math.max(8, Math.min(r.bottom + 5, innerHeight - bounds.height - 8))}px`;
  $("menu")
    .querySelector("button:not(:disabled)")
    ?.focus({ preventScroll: true });
}
$("menu").addEventListener("keydown", (e) => {
  const buttons = [...$("menu").querySelectorAll("button:not(:disabled)")],
    index = buttons.indexOf(document.activeElement);
  let next;
  if (e.key === "ArrowDown") next = (index + 1) % buttons.length;
  else if (e.key === "ArrowUp")
    next = (index + buttons.length - 1) % buttons.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = buttons.length - 1;
  else if (e.key === "Escape") {
    $("menu").hidden = true;
    ($("menu")._anchor?.focus ? $("menu")._anchor : viewport).focus({ preventScroll: true });
  } else if (["ArrowLeft", "ArrowRight"].includes(e.key) && menuButtons.includes($("menu")._anchor)) {
    const index = menuButtons.indexOf($("menu")._anchor);
    openAppMenu(menuButtons[(index + (e.key === "ArrowRight" ? 1 : -1) + menuButtons.length) % menuButtons.length]);
  } else if (e.key === " " || e.key === "Enter") {
    e.stopPropagation();
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
  buttons[next]?.focus({ preventScroll: true });
});
function showZoomMenu(anchor) {
  showCommandMenu(
    [
      ["zoom-in", "plus", "Zoom in", "+"],
      ["zoom-out", "minus", "Zoom out", "−"],
      null,
      ["zoom-reset", "frame", "Fit canvas", "Shift 1"],
      ["zoom-selection", "center", "Fit selection", "Shift 2", !editor.object],
      null,
      ...[25, 50, 100, 200].map((n) => ["zoom-" + n, "zoom", n + "%", ""]),
    ],
    anchor,
  );
}
overlay.addEventListener(
  "contextmenu",
  guarded((e) => {
    e.preventDefault();
    if (state.suppressContext) {
      state.suppressContext = false;
      return;
    }
    pause();
    const hit = pick(worldPoint(e));
    if (hit && !isSelected(hit.g.obj.unique_id))
      editor.select(hit.g.obj.unique_id, hit.joint);
    const disabled = !editor.object;
    showCommandMenu(
      [
        ["copy", "duplicate", "Copy", "Ctrl C", disabled],
        ["paste", "clipboard", "Paste", "Ctrl V"],
        ["duplicate", "duplicate", "Duplicate", "Ctrl D", disabled],
        ["add-to-library", "plus", "Add to library", "", disabled],
        null,
        ["mirror", "flip", "Flip horizontal", "Shift H", disabled],
        ["mirror-vertical", "flip", "Flip vertical", "Shift V", disabled],
        ["layer-front", "bring-to-front", "Bring to front", "", disabled],
        ["layer-back", "send-to-back", "Send to back", "", disabled],
        null,
        ["select-same", "person", "Select same figure", "", disabled],
        ["select-invert", "cursor", "Invert selection", ""],
        ["attach-figure", "link", "Attach to joint", "", disabled],
        ["detach-figure", "detach", "Detach", "", !editor.object?.join],
        null,
        [
          "locate-previous",
          "chevron-left",
          "Match previous pose",
          "L",
          disabled,
        ],
        [
          "locate-next",
          "chevron-right",
          "Match next pose",
          "Shift L",
          disabled,
        ],
        [
          "segment-values",
          "sliders",
          "Segment values",
          "I",
          disabled || editor.selectedJoint < 0,
        ],
        null,
        ["zoom-selection", "center", "Fit selection", "Shift 2", disabled],
        ["delete", "trash", "Delete", "Delete", disabled],
      ],
      { left: e.clientX, bottom: e.clientY },
    );
  }),
);
const actions = {
  "open-recent": async () => {
    pause();
    const entries = await desktop.listRecentFiles();
    showDialog(
      "Recent files",
      `<div class="recent-files">${entries.length ? entries.map((entry) => `<button type="button" class="recent-file" data-recent-id="${esc(entry.id)}" ${entry.missing ? "disabled" : ""}><strong>${esc(entry.name)}</strong><small>${esc(entry.directory)}${entry.missing ? " · Unavailable" : ""}</small></button>`).join("") : "<p>No recent files.</p>"}</div>${entries.length ? '<div class="dialog-actions"><button class="button" id="clear-recent">Clear history</button></div>' : ""}`,
    );
    $("dialog-content")
      .querySelectorAll("[data-recent-id]")
      .forEach(
        (button) =>
          (button.onclick = guarded(async () => {
            const result = await desktop.openRecentFile(
              button.dataset.recentId,
            );
            closeDialog();
            await acceptNativeFile(result);
          })),
      );
    if ($("clear-recent"))
      $("clear-recent").onclick = guarded(async () => {
        await desktop.clearRecentFiles();
        await actions["open-recent"]();
      });
  },
  "segment-values": () => showSegmentValues(),
  menu: (e) =>
    showMenu(e?.closest?.("button") || document.querySelector(".brand")),
  open: openFile,
  import: () => {
    $("file-input").value = "";
    $("file-input").click();
  },
  save: () => saveNative(),
  "save-as": () => saveNative({ saveAs: true }),
  'check-updates': () => updateNotice?.check(),
  'release-notes': () => releaseSplash.open(),
  donate: () => desktop?.openDonate(),
  'restart-update': async () => {
    finishCurrentEdit();
    await workspaceLayout?.flushPreferences();
    await editorSettings?.flush();
    await nativeFrameClipboard?.flush();
    await desktop?.setDocumentState({ name: editor.name, dirty: editor.dirty, revision: `${state.documentToken}:${editor.revision}:${editor.frameDraftRevision}` });
    await desktop?.restartForUpdate();
  },
  'save-and-update': async () => { if (await saveNative()) await actions['restart-update'](); },
  "save-and-close": async () => {
    if (await saveNative()) {
      await workspaceLayout?.flushPreferences();
      await editorSettings?.flush();
      await nativeFrameClipboard?.flush();
      await desktop?.setDocumentState({ name: editor.name, dirty: false });
      await desktop?.close();
    }
  },
  export: showExport,
  "export-piv": () => exportPivot(),
  "export-stk": () => exportPivot("stk"),
  "export-stkz": () => exportPivot(isMovieclip(editor.figure)?"stykmov":"stkz"),
  "export-stykmov": () => exportPivot("stykmov"),
  "export-png": exportPNG,
  "export-video": () => exportVideo(),
  "export-mp4": () => exportVideo("mp4"),
  "export-avi": () => exportVideo("avi"),
  "export-wmv": () => exportVideo("wmv"),
  "export-vfw": () => exportVideo("vfw"),
  "export-gif-sequence": () => exportImages("gif-sequence"),
  "export-svg-sequence": () => exportImages("svg-sequence"),
  "export-svg": exportSVGFrame,
  "export-gif": () => exportImages("gif"),
  "export-apng": () => exportImages("apng"),
  "export-png-sequence": () => exportImages("png-sequence"),
  "export-jpeg-sequence": () => exportImages("jpeg-sequence"),
  new: async () => {
    if (await confirmReplace()) {
      pause();
      editor.newDocument();
      if (desktop?.activateDocument)
        state.documentToken = (
          await desktop.activateDocument({})
        ).documentToken;
      state.sourceId = null;
      fit();
    }
  },
  rename: () => {
    showDialog(
      "Name your project",
      `<input id="rename-input" aria-label="Project name" value="${esc(editor.name)}" maxlength="120"><div class="dialog-actions"><button class="button primary" id="rename-submit">Save name</button></div>`,
    );
    $("rename-submit").onclick = () => {
      editor.name = $("rename-input").value.trim() || "Untitled";
      editor.dirty = true;
      updateTitle();
      closeDialog();
    };
  },
  undo: () => {
    pause();
    if (state.polygon) {
      state.polygon.draft.undo();
      refreshPolygonDraft();
      return;
    }
    editor.undo();
  },
  redo: () => {
    pause();
    if (state.polygon) {
      state.polygon.draft.redo();
      refreshPolygonDraft();
      return;
    }
    editor.redo();
  },
  play: play,
  "first-frame": () => {
    pause();
    if (state.settings.timelineMode === "simple")
      return timelineUI.selectFrame(0);
    editor.seek(0);
  },
  "previous-frame": () => {
    pause();
    if (state.settings.timelineMode === "simple")
      return timelineUI.selectFrame(Math.max(0, timelineUI.selectedIndex - 1));
    editor.seek(Math.max(0, editor.tick - 1));
  },
  "next-frame": () => {
    pause();
    if (state.settings.timelineMode === "simple")
      return timelineUI.selectFrame(
        Math.min(timelineUI.frameCount - 1, timelineUI.selectedIndex + 1),
      );
    editor.seek(Math.min(editor.totalTicks - 1, editor.tick + 1));
  },
  "last-frame": () => {
    pause();
    if (state.settings.timelineMode === "simple")
      return timelineUI.selectFrame(timelineUI.frameCount - 1);
    editor.seek(Math.max(0, editor.totalTicks - 1));
  },
  "add-frame": () => {
    if(editor.report._styk?.layerSheet){pause();return state.settings.timelineMode === "simple"?editor.sheetAppendFrame():editor.sheetInsertKey();}
    pause();
    if (state.settings.timelineMode === "simple")
      timelineUI.action(
        editor.frameDraft?.mode === "update" ? "update" : "add",
      );
    else editor.addFrame();
  },
  "duplicate-frame-after": () => {
    pause();finishCurrentEdit();
    if(editor.report._styk?.layerSheet) {
      const ids=state.settings.timelineMode==='simple'?['scene','camera',...editor.report._styk.layers.order]:timelineUI.ids;
      return editor.sheetDuplicateFrameAfter(ids);
    }
    return editor.duplicateFrame();
  },
  "blank-frame": () => {
    pause();finishCurrentEdit();
    if(editor.report._styk?.layerSheet)return editor.sheetInsertKey(timelineUI.ids,editor.tick,{blank:true});
  },
  "delete-frame": () => {
    pause();
    if(editor.report._styk?.layerSheet)return state.settings.timelineMode === "simple"?timelineUI.action("delete"):timelineUI.removeFrames();
    editor.deleteFrame();
  },
  "add-figure": () => {
    pause();
    if (rangeFrames()) editor.addFigureInFrames(undefined, rangeFrames());
    else editor.addFigure();
  },
  "add-text": () => showTextDialog(),
  "edit-text": () => showTextDialog(true),
  "attach-figure": () => {
    if (editor.object) setTool("attach");
  },
  "detach-figure": () =>
    rangeFrames()
      ? editor.detachFiguresInFrames(rangeFrames())
      : editor.unjoinFigure(),
  "combine-figures": () => {
    const roots = editor.resolveTranslationSelection().rootUids;
    if (roots.length !== 1)
      throw new Error("Select figures in one connected group.");
    editor.combineJoinedFigure(roots[0]);
  },
  "segment-order-back": (button, event) => actions["builder-order"]({dataset: {kind: 'segment', direction: 'back'}}, event),
  "segment-order-down": (button, event) => actions["builder-order"]({dataset: {kind: 'segment', direction: 'down'}}, event),
  "segment-order-up": (button, event) => actions["builder-order"]({dataset: {kind: 'segment', direction: 'up'}}, event),
  "segment-order-front": (button, event) => actions["builder-order"]({dataset: {kind: 'segment', direction: 'front'}}, event),
  "builder-order": (button, event) => {
    finishCurrentEdit();
    return editor.moveBuilderOrder(
      {
        kind: button.dataset.kind,
        index:
          button.dataset.index === undefined
            ? undefined
            : Number(button.dataset.index),
      },
      button.dataset.direction,
      { branch: usesBuilderBranch(event) },
    );
  },
  "polygons-previous": () => {
    state.polygonPage = Math.max(0, (state.polygonPage || 0) - 1);
    renderInspector();
  },
  "polygons-next": () => {
    state.polygonPage = (state.polygonPage || 0) + 1;
    renderInspector();
  },
  "background-style": showBackgroundDialog,
  "finish-polygon": finishPolygon,
  "cancel-polygon": cancelPolygonDraft,
  "split-segment": (button, event) =>
    editor.splitBuilderSegments({
      branch: usesBuilderBranch(event),
      fraction: 0.5,
    }),
  "unsplit-segment": () => editor.unsplitSegment(),
  "delete-single-segment": () => editor.deleteSingleSegment(),
  "mirror-segment": () => editor.mirrorSegment("horizontal"),
  "mirror-segment-vertical": () => editor.mirrorSegment("vertical"),
  "mirror-branch": () => editor.mirrorSegmentBranch("horizontal"),
  "mirror-branch-vertical": () => editor.mirrorSegmentBranch("vertical"),
  "origin-segment": () => editor.setOrigin(),
  "duplicate-segment": (button, event) =>
    beginDuplicatePlacement({
      branch: usesBuilderBranch(event),
      flip: Boolean(event?.ctrlKey || event?.metaKey),
    }),
  "duplicate-branch": (button, event) =>
    beginDuplicatePlacement({
      branch: true,
      flip: Boolean(event?.ctrlKey || event?.metaKey),
    }),
  "delete-segment": () => editor.deleteSegment(),
  duplicate: () => {
    pause();
    if (editor.branchSelected) return editor.duplicateSelection();
    if (rangeFrames()) editor.duplicateInFrames(rangeFrames());
    else if (selection().size > 1) editor.duplicateSelection();
    else editor.duplicateFigure();
  },
  delete: () => {
    pause();
    if (editor.branchSelected) return editor.deleteSelection();
    if (rangeFrames()) editor.deleteFiguresInFrames(rangeFrames());
    else editor.deleteSelection();
  },
  mirror: () =>
    rangeFrames()
      ? editor.mirrorFiguresInFrames("horizontal", rangeFrames())
      : editor.mirrorFigure("horizontal"),
  "mirror-vertical": () =>
    rangeFrames()
      ? editor.mirrorFiguresInFrames("vertical", rangeFrames())
      : editor.mirrorFigure("vertical"),
  rotate: () =>
    rangeFrames()
      ? editor.rotateFiguresInFrames(Math.PI / 12, rangeFrames())
      : editor.rotateFigure(Math.PI / 12),
  center: () => {
    if (rangeFrames()) return editor.centerFiguresInFrames(rangeFrames());
    if (selection().size > 1) {
      const b = selectionBounds();
      editor.moveSelection(
        editor.report.canvas_width / 2 - (b.minX + b.maxX) / 2,
        editor.report.canvas_height / 2 - (b.minY + b.maxY) / 2,
      );
    } else editor.centerFigure();
  },
  "align-left": () => alignSelection("x", "start"),
  "align-center-x": () => alignSelection("x", "center"),
  "align-right": () => alignSelection("x", "end"),
  "align-top": () => alignSelection("y", "start"),
  "align-center-y": () => alignSelection("y", "center"),
  "align-bottom": () => alignSelection("y", "end"),
  "locate-previous": () => locateHovered(-1),
  "locate-next": () => locateHovered(1),
  "reset-pose": () =>
    rangeFrames()
      ? editor.resetPoseInFrames(rangeFrames())
      : editor.resetPose?.(),
  "reset-color": () => updateSelection({ color_override_raw: 0 }),
  "selection-up": () => orderSelection(1),
  "selection-down": () => orderSelection(-1),
  "selection-front": () => orderSelection("front"),
  "selection-back": () => orderSelection("back"),
  "layer-up": () =>
    rangeFrames()
      ? editor.orderFiguresInFrames(1, rangeFrames())
      : editor.moveSelectionLayer(1),
  "layer-down": () =>
    rangeFrames()
      ? editor.orderFiguresInFrames(-1, rangeFrames())
      : editor.moveSelectionLayer(-1),
  "layer-front": () =>
    rangeFrames()
      ? editor.orderFiguresInFrames("front", rangeFrames())
      : editor.bringToFront(),
  "layer-back": () =>
    rangeFrames()
      ? editor.orderFiguresInFrames("back", rangeFrames())
      : editor.sendToBack(),
  "select-same": () =>
    editor.selectSameDefinition({
      candidates: editor.selectionFrame.objects
        .filter((o) => !isHidden(o.unique_id) && !isLocked(o.unique_id))
        .map((o) => o.unique_id),
    }),
  "select-invert": () =>
    editor.invertSelection(
      editor.selectionFrame.objects
        .filter((o) => !isHidden(o.unique_id) && !isLocked(o.unique_id))
        .map((o) => o.unique_id),
    ),
  copy: () => {
    if (document.activeElement?.closest("#timeline"))
      return timelineUI.copySelection();
    return editor.copySelection();
  },
  cut: () => {
    if (document.activeElement?.closest("#timeline"))
      return timelineUI.cutSelection();
    else if (editor.branchSelected) return editor.cutSelection();
    else if (rangeFrames()) {
      editor.copySelection();
      editor.deleteFiguresInFrames(rangeFrames());
    } else editor.cutSelection();
  },
  paste: () => {
    if (document.activeElement?.closest("#timeline"))
      return timelineUI.pasteSelection();
    else if (editor._selectionClipboard?.freshTypes?.size) return editor.pasteSelection();
    else if (rangeFrames()) editor.pasteFiguresInFrames(rangeFrames());
    else editor.pasteSelection();
  },
  "select-all": () => {
    if (document.activeElement?.closest("#timeline")) timelineUI.selectAll?.();
    else
      editor.selectMany(
        editor.frame.objects
          .filter((o) => !isHidden(o.unique_id) && !isLocked(o.unique_id))
          .map((o) => o.unique_id),
      );
  },
  "add-sprite-segment": () => {
    finishCurrentEdit();
    cancelSpritePlacement();
    setTool("rig");
    $("media-input").dataset.mode = "builder-sprite";
    $("media-input").click();
  },
  "import-sprite": () => {
    $("media-input").dataset.mode = "sprite";
    $("media-input").click();
  },
  "import-background": () => {
    $("media-input").dataset.mode = "background";
    $("media-input").click();
  },
  "toggle-onion": () => {
    state.onion = !state.onion;
    $("onion-button").classList.toggle("active", state.onion);
    onionControls?.sync();
    requestRender();
  },
  "toggle-isolate": () => {
    state.isolateMode = !state.isolateMode;
    const button = document.querySelector('[data-action="toggle-isolate"]');
    button?.setAttribute("aria-pressed", String(state.isolateMode));
    button?.classList.toggle("active", state.isolateMode);
  },
  "toggle-unselected-handles": () =>
    editorSettings.commit({
      showUnselectedHandles: !state.settings.showUnselectedHandles,
    }),
  "toggle-handles": () => {
    editorSettings.commit({ showHandles: !state.handles });
    $("handles-button").classList.toggle("active", state.handles);
    requestRender();
  },
  "toggle-loop": () => {
    editorSettings.commit({ loopPlayback: !state.loop });
    $("loop-button").classList.toggle("active", state.loop);
  },
  "zoom-in": () => zoom(1.2),
  "zoom-out": () => zoom(1 / 1.2),
  "zoom-reset": fit,
  "zoom-selection": fitSelection,
  "zoom-menu": showZoomMenu,
  ...Object.fromEntries(
    [25, 50, 100, 200].map((n) => [
      "zoom-" + n,
      () => zoom(n / 100 / state.view.scale),
    ]),
  ),
  "scene-settings": () => selectTrack({ id: "scene", kind: "scene" }),
  settings: () => editorSettings?.open(),
  privacy: () => privacyUI.open(),
  website: () => desktop?.openServicePage('home'),
  "builder-static-handles": () =>
    editorSettings.commit({
      builderShowStaticHandles: !state.settings.builderShowStaticHandles,
    }),
  "builder-highlight": () =>
    editorSettings.commit({
      builderHighlightSegment: !state.settings.builderHighlightSegment,
    }),
  "builder-canvas-color": () => {
    editorSettings.open("canvas");
    editorSettings.dialog
      .querySelector('[data-setting="builderCanvasColor"]')
      ?.focus();
  },
  "camera-copy": () => {
    editor.copyCamera();
    queueUI();
  },
  "toggle-camera": () => {
    if(!cameraSelected())selectTrack({id:'camera',kind:'camera'});
    else editorSettings?.commit({showCamera:!state.settings.showCamera});
  },
  "camera-paste": () => editor.pasteCamera(rangeFrames()),
  "camera-guides": () => {state.cameraGuides=!state.cameraGuides;requestRender();},
  "camera-level": () => editor.setCameraValues({angle_rad:0},rangeFrames()),
  "camera-reset": () => editor.resetCamera(rangeFrames()),
  "camera-center": () =>
    editor.centerCamera("both", rangeFrames(), { boundsOf }),
  "camera-center-x": () =>
    editor.centerCamera("x", rangeFrames(), { boundsOf }),
  "camera-center-y": () =>
    editor.centerCamera("y", rangeFrames(), { boundsOf }),
  "camera-align-view": () => {
    const rect = viewport.getBoundingClientRect();
    editor.alignCameraToView(
      { ...state.view, width: rect.width, height: rect.height },
      rangeFrames(),
    );
  },
  "camera-apply-figures": () => editor.applyCameraToFigures(rangeFrames()),
  "camera-locate-previous": () =>
    editor.locateCamera(-1, "pose", rangeFrames()),
  "camera-locate-next": () => editor.locateCamera(1, "pose", rangeFrames()),
  "close-dialog": closeDialog,
  help: showHelp,
  about: showHelp,
  performance: showPerformance,
  minimize: () => desktop?.minimize(),
  maximize: () => desktop?.maximize(),
  close: async () => {
    await workspaceLayout?.flushPreferences?.();
    await editorSettings?.flush();
    await nativeFrameClipboard?.flush();
    await desktop?.close();
  },
};
const polygonSafeActions = new Set([
  "menu",
  "settings",
  "privacy",
  "check-updates",
  "release-notes",
  "donate",
  "website",
  "help",
  "about",
  "performance",
  "minimize",
  "maximize",
  "close",
  "new",
  "open",
  "open-recent",
  "undo",
  "redo",
  "finish-polygon",
  "cancel-polygon",
  "first-frame",
  "previous-frame",
  "next-frame",
  "last-frame",
  "builder-static-handles",
  "builder-highlight",
  "builder-canvas-color",
]);
for (const [name, action] of Object.entries(actions)) {
  actions[name] = (...args) => {
    if (state.polygon) {
      if (["new", "open", "open-recent", "close"].includes(name))
        cancelPolygonDraft();
      else if (
        !polygonSafeActions.has(name) &&
        !name.startsWith("zoom-") &&
        !name.startsWith("toggle-")
      ) {
        toast("Finish or cancel the polygon first.");
        return false;
      }
    }
    telemetry.action(name);
    return action(...args);
  };
}
for (const id of ["timeline", "fps"]) {
  $(id).addEventListener("focusin", cancelPolygonDraft);
  $(id).addEventListener("pointerdown", cancelPolygonDraft, true);
}
document.addEventListener(
  "click",
  guarded((e) => {
    const menuButton = e.target.closest('[data-app-menu]');
    if (menuButton) { openAppMenu(menuButton); return; }
    const action = e.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "play" && !state.polygon) {
        if (state.previewing) return pause();
        if (e.ctrlKey || e.metaKey) return previewFrame();
      }
      if (action.dataset.action !== "menu") $("menu").hidden = true;
      const name = e.shiftKey ? action.dataset.shiftAction ?? action.dataset.action : action.dataset.action;
      return actions[name]?.(action, e);
    }
    if (!$("menu").contains(e.target)) $("menu").hidden = true;
    const tool = e.target.closest("[data-tool]");
    if (tool) setTool(tool.dataset.tool);
    const asset = e.target.closest("[data-figure]");
    if (asset) {
      if (rangeFrames())
        editor.addFigureInFrames(Number(asset.dataset.figure), rangeFrames());
      else editor.addFigure(Number(asset.dataset.figure));
    }
    const sample = e.target.closest("[data-sample]");
    if (sample) openSample(sample.dataset.sample).catch(fail);
    const joint = e.target.closest("[data-joint]");
    if (joint) editor.select(editor.selectedUid, Number(joint.dataset.joint));
    const polygon = e.target.closest("[data-delete-polygon]");
    if (polygon) editor.removePolygon(Number(polygon.dataset.deletePolygon));
  }),
);

$("inspector").addEventListener(
  "change",
  guarded((e) => {
    const target = e.target,
      key = target.dataset.field;
    pause();
    if(target.id==='figure-layer'){
      finishCurrentEdit();editor.assignFiguresToLayer([...editor.selectedUids],target.value);
      editor.setActiveLayer(target.value);state.selectedTrackId=target.value;timelineUI?.selectTrack?.(target.value);queueUI();requestRender();return;
    }
    if (target.id === "builder-branch") {
      state.builderBranch = target.checked;
      if (!target.checked && editor.branchSelected) {
        const uid = editor.selectedUid, joint = editor.selectedJoint;
        editor._branchSelection = null; editor.select(uid, joint);
      }
      if (target.checked && editor.selectedUid != null) {
        state.selectedTrackId = layerIdForUid(
          editor.report,
          editor.selectedUid,
        );
        state.inspectorContext = "figure";
        state.inspectorTab = "design";
      }
      queueUI();
      requestRender();
      return;
    }
    if (target.id === "inspector-layer-name") {
      editor.renameLayer(
        target.dataset.layerId || editor.activeLayerId,
        target.value,
      );
      return;
    }
    if (target.id === "inspector-layer-visible") {
      editor.setLayerVisible(
        target.dataset.layerId || editor.activeLayerId,
        target.checked,
      );
      return;
    }
    if (target.id === "inspector-layer-locked") {
      editor.setLayerLocked(
        target.dataset.layerId || editor.activeLayerId,
        target.checked,
      );
      return;
    }
    if (target.id === "rig-mode") {
      state.rigMode = target.value;
      return;
    }
    if (target.id === 'node-is-ik') { editor.setNodeIK({enabled: target.checked}); return; }
    if (target.id === 'node-ik-pinned') { telemetry.count('ik'); editor.setNodeIK({pinned: target.checked}); return; }
    if (target.id === 'node-ik-chain') { editor.setNodeIK({chainLength: target.valueAsNumber}); return; }
    if (target.id === 'node-ik-rotation') { editor.rotateIKTarget(target.valueAsNumber * Math.PI / 180); return; }
    if (target.id === 'node-ik-stretch') { editor.setNodeIK({allowStretch: target.checked}); return; }
    if (target.name === 'node-ik-bend') { editor.setNodeIK({bendDirection: Number(target.value)}); return; }
    if (target.id === "apply-range-movement") {
      state.applyRange = target.checked;
      return;
    }
    if (target.id === "figure-name") {
      editor.updateFigureStyle({ name: target.value });
      return;
    }
    if (target.id === "outline-color") {
      editor.updateFigureStyle({ outlineColor: target.value });
      return;
    }
    if (target.id === "segment-gradient-enabled") {
      updateBuilderStyle(
        {
          gradient: target.checked ? { color: "#ffffff" } : null,
        },
        e,
      );
      return;
    }
    if (target.id === "segment-gradient-color") {
      updateBuilderStyle({ gradient: { color: target.value } }, e);
      return;
    }
    if (target.id === "segment-shape") {
      if (usesBuilderBranch(e) && ["line", "squareLine"].includes(target.value))
        editor.setBranchCaps(target.value === "squareLine");
      else if (
        usesBuilderBranch(e) &&
        [1, 3, 4].includes(
          editor.figure?.segments[editor.selectedJoint]?.primitive_code,
        )
      )
        editor.setBranchFill(target.value);
      else editor.convertSegment(target.value);
      return;
    }
    if (target.id === "segment-color") {
      updateBuilderStyle({ color: target.value }, e);
      return;
    }
    if (target.id === "segment-opacity") {
      updateBuilderStyle({ opacity: Number(target.value) / 100 }, e);
      return;
    }
    if (target.dataset.polygonColor !== undefined) {
      editor.updatePolygon(Number(target.dataset.polygonColor), {
        color: target.value,
      });
      return;
    }
    if (key) {
      const value = Number(target.value);
      if (!Number.isFinite(value)) throw new Error("Enter a finite number.");
      if (key === "fps") editor.setFPS(value);
      else if (key === "outline_width")
        editor.updateFigureStyle({ outlineWidth: value });
      else if (key === "duration") editor.setFrameDuration(value);
      else if (key.startsWith("group_")) {
        const b = selectionBounds();
        if (key === "group_x") moveSelected(value - b.minX, 0);
        else if (key === "group_y") moveSelected(0, value - b.minY);
        else {
          const old = key === "group_width" ? b.maxX - b.minX : b.maxY - b.minY;
          if (value <= 0 || old <= 0)
            throw new Error("Selection size must be greater than zero.");
          editor.scaleSelection(value / old);
        }
      } else if (key === "rotation")
        editor.rotateFigure(
          shortest(
            (value * Math.PI) / 180 -
              ((editor.object.angles[0] ?? 0) -
                (editor.figure.segments[0]?.angle_rad ?? 0)),
          ),
        );
      else if (key === "scale") editor.updateObject({ scale: value / 100 });
      else if (["root_x", "root_y"].includes(key)) {
        if (rangeFrames())
          moveSelected(
            key === "root_x" ? value - editor.object.root_x : 0,
            key === "root_y" ? value - editor.object.root_y : 0,
          );
        else editor.updateObject({ [key]: value });
      } else if (key === "thickness")
        updateBuilderStyle({ thickness: value }, e);
      else if (key === "joint_angle") {
        const angle = (value * Math.PI) / 180,
          obj = editor.object,
          delta = shortest(angle - obj.angles[editor.selectedJoint]);
        editor.rotateJoint?.(delta);
        if (!editor.rotateJoint)
          editor.transaction("Joint angle", () => {
            obj.angles[editor.selectedJoint] = angle;
          });
      } else if (key === "joint_length" || key === "joint_bend") {
        editor.updateSegment(
          key === "joint_length"
            ? { length: value }
            : { bend_rad: (value * Math.PI) / 180 },
        );
      } else if (key.startsWith("camera_")) {
        editor.transaction("Camera", (frame) => {
          frame.camera = {
            x: 0,
            y: 0,
            scale: 1,
            angle_rad: 0,
            ...frame.camera,
            is_default: false,
          };
          frame.camera[key === "camera_angle" ? "angle_rad" : key.slice(7)] =
            key === "camera_scale"
              ? value / 100
              : key === "camera_angle"
                ? (value * Math.PI) / 180
                : value;
        });
      } else if (key === "canvas_width" || key === "canvas_height") {
        if (value < 1 || value > 16384 || !Number.isInteger(value))
          throw new Error(
            "Canvas dimensions must be whole pixels between 1 and 16,384.",
          );
        if (editor.updateProject) editor.updateProject({ [key]: value });
        else
          editor.transaction(
            "Canvas size",
            (_, report) => (report[key] = value),
          );
        fit();
      } else if (key === "join_handle")
        editor.transaction("Join handle", () => {
          const parent =
              editor.frame.objects[editor.object.join.target_object_slot],
            fig = editor.report.figure_types.find(
              (f) => f.figure_type_id === parent.figure_type_id,
            );
          if (value !== 0 && !fig.segments.some((s) => s.segment_id === value))
            throw new Error("That parent joint does not exist.");
          editor.object.join.target_handle_id = value;
        });
      return;
    }
    if (target.id === "figure-color") {
      const hex = target.value.slice(1),
        r = parseInt(hex.slice(0, 2), 16),
        g = parseInt(hex.slice(2, 4), 16),
        b = parseInt(hex.slice(4, 6), 16);
      updateSelection({
        color_override_raw: (0xff000000 | (b << 16) | (g << 8) | r) >>> 0,
      });
    } else if (target.id === "figure-opacity")
      updateSelection({
        field28: Math.round(
          (1 - Math.max(0, Math.min(100, Number(target.value))) / 100) * 255,
        ),
      });
    else if (target.id === "static-joint") {
      updateBuilderStyle({ static: target.checked }, e);

    } else if (target.id === "background-color") {
      const raw = (0xff000000 | parseInt(target.value.slice(1), 16)) >>> 0;
      if (editor.setSceneColor)
        editor.setSceneColor(raw, {
          indices: rangeFrames(),
        });
      else
        editor.transaction("Background color", (f, r) => {
          const id =
            Math.max(0, ...(r.backgrounds || []).map((b) => b.background_id)) +
            1;
          r.backgrounds = [
            ...(r.backgrounds || []),
            { background_id: id, kind: 2, color: raw },
          ];
          f.background_id = id;
        });
    } else if (target.id === "join-target") {
      if (rangeFrames()) {
        if (target.value)
          editor.joinFiguresInFrames(Number(target.value), 0, rangeFrames());
        else editor.detachFiguresInFrames(rangeFrames());
      } else if (editor.joinFigure) {
        editor.joinFigure(target.value ? Number(target.value) : null, 0);
      } else {
        editor.transaction("Attach figure", () => {
          const o = editor.object,
            parent = editor.frame.objects.find(
              (p) => p.unique_id === Number(target.value),
            );
          if (!parent) {
            const g = editor.geometry.objects.get(o.object_slot);
            o.root_x = g.root.x;
            o.root_y = g.root.y;
            o.join = null;
            return;
          }
          let p = parent,
            seen = new Set([o.unique_id]);
          while (p) {
            if (seen.has(p.unique_id))
              throw new Error("This attachment would create a cycle.");
            seen.add(p.unique_id);
            p = p.join ? editor.frame.objects[p.join.target_object_slot] : null;
          }
          o.join = {
            target_object_slot: parent.object_slot,
            target_unique_id: parent.unique_id,
            target_handle_id: 0,
          };
        });
      }
    }
  }),
);
$("fps").addEventListener(
  "change",
  guarded((e) => editor.setFPS(Number(e.target.value))),
);
$("timeline-zoom").addEventListener("input", (e) =>
  timelineUI?.setZoom?.(Number(e.target.value)),
);
$("file-input").addEventListener(
  "change",
  guarded((e) => importFiles([...e.target.files])),
);
$("media-input").addEventListener(
  "change",
  guarded(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const mode = e.target.dataset.mode;
    e.target.value = "";
    if (mode === "builder-sprite") await beginSpritePlacement(file);
    else await importMediaFile(file, { background: mode === "background" });
  }),
);
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    $("canvas-empty").hidden = false;
  }
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) $("canvas-empty").hidden = true;
});
document.addEventListener(
  "drop",
  guarded((e) => {
    e.preventDefault();
    $("canvas-empty").hidden = true;
    if (e.dataTransfer.files.length)
      return importFiles([...e.dataTransfer.files]);
  }),
);
const heldArrows = new Set();
let keyboardHandleGesture = null;
function finishKeyboardHandle() {
  if (!keyboardHandleGesture) return;
  if (keyboardHandleGesture.ownsDrag) editor.commitDrag();
  keyboardHandleGesture = null;
  heldArrows.clear();
  queueUI();
}
function finishCurrentEdit() {
  pause();
  finishKeyboardHandle();
  endDrag();
  propertyControls?.commit();
  editor.commitDrag();
  editor.commitAnimationEdit();
}
function cycleFigure(direction) {
  const objects = editor.selectionFrame.objects,
    order = editor.selectionFrame.object_draw_order || objects.map((_, i) => i);
  const candidates = order
    .map((slot) => objects[slot])
    .filter(
      (object) =>
        object && !isHidden(object.unique_id) && !isLocked(object.unique_id),
    );
  if (!candidates.length) return;
  const index = candidates.findIndex(
    (object) => object.unique_id === editor.selectedUid,
  );
  editor.select(
    candidates[(index + direction + candidates.length) % candidates.length]
      .unique_id,
  );
}
function keyboardHandle(event, key) {
  if (
    keyboardHandleGesture?.camera ||
    (cameraSelected() && state.settings.showCamera &&
      (state.hoverCameraHandle || state.inspectorContext === "camera"))
  ) {
    if (
      editor.report._styk?.layers?.fixed?.camera?.locked ||
      editor.report._styk?.layers?.fixed?.camera?.visible === false
    )
      return;
    const target = keyboardHandleGesture?.target ||
      state.hoverCameraHandle || { kind: "position", index: 4 };
    if (!keyboardHandleGesture) {
      pause();
      interruptRecovery();
      const geometry = editor.geometry;
      editor.beginCameraDrag({ indices: rangeFrames(), label: "Nudge camera" });
      keyboardHandleGesture = {
        camera: true,
        target,
        ownsDrag: true,
        geometry,
      };
    }
    heldArrows.add(key);
    editor.updateCameraDrag(
      cameraKeyboardDelta(
        cameraViewport(editor.report, currentFrame(), state.view),
        target,
        key === "arrowleft" ? -1 : key === "arrowright" ? 1 : 0,
        key === "arrowup" ? -1 : key === "arrowdown" ? 1 : 0,
      ),
      { fromStart: false },
    );
    requestRender();
    return;
  }
  const target = keyboardHandleGesture?.target ||
    state.hoverHandle || { uid: editor.selectedUid, joint: -1 };
  const editMode = state.tool === "handle-edit" || state.handleEditHeld;
  if (
    target.uid == null ||
    isHidden(target.uid) ||
    isLocked(target.uid) ||
    (target.static && !editMode)
  )
    return;
  if (event.shiftKey && target.joint < 0) return;
  if (!keyboardHandleGesture) {
    pause();
    interruptRecovery();
    editor.select(target.uid, target.joint, {
      add: target.joint < 0 && selection().has(target.uid),
    });
    const ownsDrag = !editor.dragging;
    if (ownsDrag) {
      if (editMode) editor.beginHandleEditDrag();
      else if (target.joint < 0) editor.beginTranslationDrag("Nudge figures");
      else editor.beginDrag("Adjust joint");
    }
    keyboardHandleGesture = { target, ownsDrag };
  }
  heldArrows.add(key);
  const options = {
    uid: target.uid,
    jointIndex: target.joint,
    view: state.view,
    cameraEnabled: false,
    editMode,
    isolate: Boolean(state.isolateHeld || state.isolateMode),
    bend: state.drag?.kind === "bend",
  };
  if (event.shiftKey)
    editor.alignHandle(
      Number(heldArrows.has("arrowright")) -
        Number(heldArrows.has("arrowleft")),
      Number(heldArrows.has("arrowdown")) - Number(heldArrows.has("arrowup")),
      options,
    );
  else
    editor.nudgeHandle(
      key === "arrowleft" ? -1 : key === "arrowright" ? 1 : 0,
      key === "arrowup" ? -1 : key === "arrowdown" ? 1 : 0,
      options,
    );
  requestRender();
}
function locateHovered(direction) {
  finishKeyboardHandle();
  pause();
  if (state.hoverCameraHandle)
    return editor.locateCamera(
      direction,
      state.hoverCameraHandle.kind,
      rangeFrames(),
    );
  if (state.inspectorContext === "camera")
    return editor.locateCamera(direction, "pose", rangeFrames());
  const target = state.hoverHandle || {
    uid: editor.selectedUid,
    joint: editor.selectedJoint,
  };
  if (target.uid == null || isHidden(target.uid) || isLocked(target.uid))
    return;
  editor.locateHandle(direction, {
    uid: target.uid,
    jointIndex: target.joint,
    editMode: state.tool === "handle-edit" || state.handleEditHeld,
  });
}
document.addEventListener(
  "keydown",
  guarded((e) => {
    state.builderShiftHeld = e.shiftKey;
    if (e.code === "CapsLock") state.isolateHeld = true;
    const builderCheckboxShortcut =
      isBuilderContext(state.tool) &&
      ["F9", "F10", "F12"].includes(e.key) &&
      e.target.matches('input[type="checkbox"],input[type="radio"]');
    if (
      (e.target.closest("input,textarea,select,[contenteditable=true]") &&
        !builderCheckboxShortcut) ||
      document.querySelector("dialog[open]")
    )
      return;
    if (e.defaultPrevented) return;
    editablePreparation.cancel();
    const mod = e.ctrlKey || e.metaKey,
      k = e.key.toLowerCase();
    if (
      isBuilderContext(state.tool) &&
      ["f9", "f10", "f12"].includes(k) &&
      !mod &&
      !e.altKey
    ) {
      e.preventDefault();
      if (!e.repeat)
        actions[
          {
            f9: "builder-canvas-color",
            f10: "builder-static-handles",
            f12: "builder-highlight",
          }[k]
        ]();
      return;
    }
    if (
      state.polygon &&
      ((mod && !["z", "y", "o", "n", "s", ","].includes(k)) ||
        (!mod &&
          [
            "delete",
            "backspace",
            "arrowleft",
            "arrowright",
            "arrowup",
            "arrowdown",
            "home",
            "end",
            "pageup",
            "pagedown",
            "f6",
            "f8",
            "f10",
            "t",
            "r",
          ].includes(k)))
    ) {
      e.preventDefault();
      return;
    }
    if (
      !$("renderer-error").hidden &&
      !(mod && ["s", "o", "n"].includes(k)) &&
      !["tab", "escape"].includes(k)
    ) {
      e.preventDefault();
      return;
    }
    if (
      state.tool === "rig" &&
      editor.selectedJoint >= 0 &&
      (k === "delete" || k === "backspace")
    ) {
      e.preventDefault();
      if (!e.repeat)
        actions[
          mod
            ? "unsplit-segment"
            : e.shiftKey
              ? "delete-segment"
              : "delete-single-segment"
        ]();
      return;
    }
    if (k === "r" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (mod) {
        if (!e.repeat)
          setTool(state.tool === "handle-edit" ? "select" : "handle-edit");
      } else {
        state.handleEditHeld = true;
        requestRender();
      }
      return;
    }
    if (mod && k === 'enter') {
      e.preventDefault();if(!e.repeat)actions['duplicate-frame-after']();return;
    }
    if (!mod && k === "a" && state.settings.timelineMode === "simple") {
      e.preventDefault();
      if (!e.repeat) actions["add-frame"]();
      return;
    }
    if (!mod && k === " ") {
      e.preventDefault();
      if (!e.repeat) {
        state.space = true;
        state.spacePanned = false;
        viewport.classList.add("panning");
      }
      return;
    }
    const stageFocused = Boolean(e.target.closest("#viewport"));
    if (stageFocused && k === "i" && !mod && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) showSegmentValues({ hover: true });
      return;
    }
    if (
      state.settings.timelineMode === "simple" &&
      ["<", ">", ",", "."].includes(k) &&
      !e.altKey
    ) {
      e.preventDefault();
      timelineUI.selectFrame(
        timelineUI.selectedIndex + (["<", ","].includes(k) ? -1 : 1),
        e,
      );
      return;
    }
    if (
      stageFocused &&
      ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k) &&
      !e.altKey
    ) {
      e.preventDefault();
      if (mod) {
        finishKeyboardHandle();
        if (k === "arrowleft" || k === "arrowright")
          cycleFigure(k === "arrowleft" ? -1 : 1);
      } else keyboardHandle(e, k);
      return;
    }
    if (
      stageFocused &&
      k === "l" &&
      (state.hoverHandle || state.hoverCameraHandle) &&
      !mod &&
      !e.altKey
    ) {
      e.preventDefault();
      if (!e.repeat) locateHovered(e.shiftKey ? 1 : -1);
      return;
    }
    if (state.polygon && k === "enter") {
      e.preventDefault();
      return finishPolygon();
    }
    if (
      e.altKey &&
      ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(k)
    ) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      return moveSelected(
        k === "arrowleft" ? -step : k === "arrowright" ? step : 0,
        k === "arrowup" ? -step : k === "arrowdown" ? step : 0,
      );
    }
    let action;
    if (mod) {
      action = {
        o: "open",
        s: e.shiftKey ? "save-as" : "save",
        ",": "settings",
        h: "toggle-unselected-handles",
        k: e.altKey ? "camera-reset" : "toggle-camera",
        n: "new",
        d: "duplicate",
        c: "copy",
        x: "cut",
        v: "paste",
        a: "select-all",
        z: e.shiftKey ? "redo" : "undo",
        y: "redo",
      }[k];
    } else {
      action = {
        t: "add-text",
        arrowleft: "previous-frame",
        arrowright: "next-frame",
        home: "first-frame",
        end: "last-frame",
        f6: "add-frame",
        f8: "camera-center",
        f10: "camera-align-view",
        f11: "camera-copy",
        f12: "camera-paste",
        delete: "delete",
        backspace: "delete",
        o: "toggle-onion",
        j: "toggle-handles",
        "?": "help",
        "+": "zoom-in",
        "=": "zoom-in",
        "-": "zoom-out",
      }[k];
      if (k === "1" && e.shiftKey) action = "zoom-reset";
      if ((k === "!" || e.code === "Digit1") && e.shiftKey)
        action = "zoom-reset";
      if ((k === "@" || e.code === "Digit2") && e.shiftKey)
        action = "zoom-selection";
      if (k === "h" && e.shiftKey) action = "mirror";
      if (k === "v" && e.shiftKey) action = "mirror-vertical";
      if (k === "escape") {
        if (keyboardHandleGesture) {
          if (keyboardHandleGesture.ownsDrag) editor.cancelDrag();
          keyboardHandleGesture = null;
          heldArrows.clear();
        }
        cancelDrag();
        if (state.tool === "attach") setTool("select");
        $("menu").hidden = true;
      }
      if (["v", "p", "h", "l", "c"].includes(k) && !e.shiftKey)
        setTool(
          {
            v: "select",
            p: "pose",
            h: "hand",
            l: "line",
            c: "circle",
          }[k],
        );
    }
    if (action) {
      e.preventDefault();
      if (!e.repeat || action.includes("frame")) return actions[action]?.();
    }
  }),
);
window.addEventListener("blur", () => {
  finishKeyboardHandle();
  if (state.drag) cancelDrag();
  state.space = false;
  state.handleEditHeld = false;
  state.isolateHeld = false;
  state.builderShiftHeld = false;
  state.spacePanned = false;
  viewport.classList.toggle("panning", state.tool === "hand");
});
document.addEventListener(
  "keyup",
  guarded((e) => {
    state.builderShiftHeld = e.shiftKey;
    if (e.code === "CapsLock") state.isolateHeld = false;
    if (e.key.startsWith("Arrow")) {
      heldArrows.delete(e.key.toLowerCase());
      if (!heldArrows.size) finishKeyboardHandle();
    }
    if (e.key.toLowerCase() === "r") {
      state.handleEditHeld = false;
      requestRender();
      return;
    }
    if (e.code !== "Space" || !state.space) return;
    e.preventDefault();
    state.space = false;
    viewport.classList.toggle("panning", state.tool === "hand");
    if (!state.spacePanned && !state.polygon) {
      if (state.settings.timelineMode === "simple") actions["add-frame"]();
      else play();
    }
  }),
);
editor.addEventListener("change", (e) => {
  const kind = e.detail?.kind;
  if (kind === 'edit' && !e.detail?.live) { telemetry.count('edits'); telemetry.milestone('first_edit'); }
  if(['edit','history','document','preview','frame-draft','seek'].includes(kind))editablePreparation.cancel();
  const selectedTrack = ["seek", "history", "frame-draft"].includes(kind)
    ? timelineUI?.trackById?.get(state.selectedTrackId)
    : null;
  if (
    kind === "document" ||
    (state.duplicatePlacement &&
      ["edit", "history", "frame-draft"].includes(kind))
  )
    cancelSpritePlacement();
  if (
    kind === "document" ||
    kind === "seek" ||
    (kind === "selection" &&
      state.polygon &&
      editor.selectedUid !== state.polygon.uid)
  )
    cancelPolygonDraft();
  if (kind === "document" && e.detail?.scenePrepared) {
    const prepared = preparedScenes.get(editor.report);
    if (prepared) {
      state.hidden.clear();
      state.locked.clear();
      images.clear();
      for (const [url, image] of prepared.images) images.set(url, image);
      state.view = prepared.view;
      state.renderer.activatePreparedScene(prepared, {
        report: editor.report,
        frame: editor.evaluatedFrame,
        geometry: editor.geometry,
        view: state.view,
      });
      preparedScenes.delete(editor.report);
      placeArtboard();
      requestRender();
    }
  }
  if (kind === "document" || kind === "seek") {
    keyboardHandleGesture = null;
    heldArrows.clear();
    state.hoverHandle = null;
    state.hoverCameraHandle = null;
  }
  if (["edit", "history", "document", "preview", "frame-draft"].includes(kind))
    state.editingPacket = null;
  if (
    (kind === "selection" || (e.detail?.structural &&
      !(e.detail?.layerSheet && ['camera','scene'].includes(state.inspectorContext)))) &&
    editor.selectedUid != null
  ) {
    state.inspectorContext = "figure";
    state.inspectorTab = "design";
    state.selectedTrackId = layerIdForUid(editor.report, editor.selectedUid);
  }
  if (kind === "document") {
    state.inspectorContext = editor.selectedUid == null ? "scene" : "figure";
    state.selectedTrackId = editor.activeLayerId;
  }
  if (selectedTrack) reconcileSelectedSegmentTrack(selectedTrack);
  if (!cameraSelected()) {
    state.hoverCameraHandle=null;
    overlay.style.cursor='';
  }
  if (
    e.detail?.definition ||
    e.detail?.structural ||
    (kind === "history" && !e.detail?.animation) ||
    kind === "document"
  ) {
    invalidatePivotHandleTopology();
    handleCache = null;
    blueHandles = null;
    assetLibrary?.invalidate();
  }
  if (["edit", "history", "document", "frame-draft"].includes(kind))
    for (const job of exportJobs) job.controller.abort();
  if (
    (kind === "edit" || kind === "frame-draft" || (kind === "history" && (e.detail.frameIndices || e.detail.animation) && !e.detail.structural)) &&
    !e.detail?.live &&
    playback.report === editor.report &&
    (state.playbackRevision !== editor.revision ||
      state.playbackDraftRevision !== editor.frameDraftRevision)
  ) {
    const metadataOnly = Boolean(
      kind === "frame-draft" || e.detail.animation || e.detail.layerMetadata,
    );
    const frameIndices =
      e.detail.frameIndices ??
      e.detail.changedFrames ??
      (metadataOnly ? [] : [editor.frameIndex]);
    playback.updateDocument({
      revision: editor.revision,
      frameIndices,
      sourceIds: e.detail.sourceIds || [],
      definition: Boolean(e.detail.definition),
      structural: Boolean(e.detail.structural && !metadataOnly),
    });
    state.playbackRevision = editor.revision;
    state.playbackDraftRevision = editor.frameDraftRevision;
    state.playbackPacket = null;
    if (state.renderer?.retainPreparedFrames)
      state.renderer.retainPreparedFrames(editor.report, playback.cache.values());
    else state.renderer?.clearPreparedFrames?.();
  }
  if (kind === "seek") interruptRecovery();
  if (kind === "seek") {
    queueEditingFrame();
    requestRender();
    if (!state.playing && !state.scrubbing) {
      queueUI();
      warmPlayback();
    }
    return;
  }
  if (kind === "preview" || e.detail?.live || state.drag || state.scrubbing) {
    requestRender();
    return;
  }
  queueUI();
  if (["edit", "history", "document", "frame-draft"].includes(kind))
    warmPlayback();
  if (
    kind === "edit" ||
    kind === "history" ||
    (kind === "frame-draft" && editor.dirty)
  )
    scheduleRecovery();
});
function scheduleRecovery() {
  clearTimeout(state.recoveryTimer);
  if (!state.settings.autosaveSeconds) return;
  state.recoveryTimer = setTimeout(async () => {
    if (
      state.playing ||
      state.drag ||
      propertyControls?.active ||
      state.scrubbing ||
      exportJobs.size
    ) {
      scheduleRecovery();
      return;
    }
    if (!editor.dirty) return;
    const report = editor.report,
      name = editor._movieclipScopes?.[0]?.parent.name ?? editor.name;
    try {
      await runDocumentExport(
        "styk",
        async (blob, signal) => {
          if (
            editor.report !== report ||
            !editor.dirty ||
            state.drag ||
            state.playing ||
            signal.aborted
          )
            return;
          if (desktop) {
            await writeNativeBlob(desktop, blob, {
              recovery: true,
              name,
              signal,
            });
            return;
          }
          await new Promise((resolve, reject) => {
            const request = indexedDB.open("stykanimate-recovery", 1);
            request.onupgradeneeded = () =>
              request.result.createObjectStore("documents");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              if (signal.aborted) {
                db.close();
                resolve();
                return;
              }
              const tx = db.transaction("documents", "readwrite");
              const cancel = () => {
                try {
                  tx.abort();
                } catch {}
              };
              signal.addEventListener("abort", cancel, { once: true });
              tx.objectStore("documents").put(
                { blob, name, savedAt: Date.now() },
                "latest",
              );
              const complete = () => {
                signal.removeEventListener("abort", cancel);
                db.close();
                resolve();
              };
              tx.oncomplete = complete;
              tx.onabort = complete;
              tx.onerror = () => {
                complete();
                reject(tx.error);
              };
            };
          });
        },
        { recovery: true },
      );
    } catch (error) {
      if (error.name !== "AbortError")
        status(`Recovery copy could not be written: ${error.message}`, true);
    }
  }, state.settings.autosaveSeconds * 1000);
}
function offerRecovery() {
  if (desktop?.getRecoveryInfo) {
    desktop
      .getRecoveryInfo()
      .then((record) => {
        if (!record) return;
        showRecovery({
          ...record,
          native: true,
        });
      })
      .catch((error) =>
        status(`Recovery could not be read: ${error.message}`, true),
      );
    return;
  }
  const req = indexedDB.open("stykanimate-recovery", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("documents");
  req.onsuccess = () => {
    const db = req.result,
      tx = db.transaction("documents"),
      get = tx.objectStore("documents").get("latest");
    get.onsuccess = () => {
      const record = get.result;
      showRecovery(record);
    };
    tx.oncomplete = () => db.close();
  };
}
function showRecovery(record) {
  if (!record) return;
  const banner = document.createElement("div");
  banner.className = "recovery-banner";
  banner.innerHTML = `<span>Recovered project: ${esc(record.name)}</span><button class="button small" id="restore-recovery">Restore</button><button class="icon-button" id="dismiss-recovery" aria-label="Dismiss recovery">${icon("close")}</button>`;
  viewport.append(banner);
  $("restore-recovery").onclick = guarded(async () => {
    if (await confirmReplace()) {
      const replaceApproved = {
        report: editor.report,
        revision: editor.revision,
        draftRevision: editor.frameDraftRevision,
      };
      if (record.native) {
        const native = await readNativeRecovery(desktop);
        if (!native)
          throw new Error("The recovery file is no longer available.");
        record = { ...record, ...native };
      }
      if (record.blob) {
        const restored = await importer.importNative(
          new File([record.blob], `${record.name}.styk`),
        );
        await acceptImport(restored, record.name, {
          replaceApproved,
        });
      } else {
        if (
          (replaceApproved.report !== editor.report ||
            replaceApproved.revision !== editor.revision ||
            replaceApproved.draftRevision !== editor.frameDraftRevision ||
            editor._drag ||
            editor._animationEdit) &&
          !(await confirmReplace())
        )
          return;
        await editor.loadAsync(record.document, record.name);
        if (desktop?.activateDocument)
          state.documentToken = (
            await desktop.activateDocument({})
          ).documentToken;
        state.sourceId = null;
      }
      editor.dirty = true;
      fit();
      updateUI();
      telemetry.count('recovery_restored');
      banner.remove();
    }
  });
  $("dismiss-recovery").onclick = () => banner.remove();
}
if (desktop) {
  if (desktop.platform !== "darwin") $("window-controls").hidden = false;
  else document.querySelector(".titlebar").style.paddingLeft = "84px";
  desktop.onMenuAction?.(
    guarded((action) => {
      if (
        document.activeElement?.matches(
          "input,textarea,[contenteditable=true]",
        ) &&
        [
          "cut",
          "copy",
          "paste",
          "select-all",
          "undo",
          "redo",
          "delete",
        ].includes(action)
      ) {
        document.execCommand(action === "select-all" ? "selectAll" : action);
        return;
      }
      if (!$("dialog").open) return actions[action]?.();
    }),
  );
  desktop.onOpenFile?.(guarded(acceptNativeFile));
  desktop.onBackendError?.(fail);
}
window.addEventListener("pagehide", () => clipboardWorker.dispose());
window.addEventListener("beforeunload", (e) => {
  if (editor.dirty && !desktop) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.styk = {
  editor,
  state,
  actions,
  importFiles,
  acceptImport,
  fit,
  performance: () => ({
    editingPresentation:state.lastEditingPresentation,
    editablePreparation:{pending:editablePreparation.pending,...editablePreparation.stats},
    samples: [...state.renderSamples],
    renderer: state.renderer?.stats,
    import: state.lastImport,
    playback: { ...playback.stats },
    presentation: playbackMetrics.snapshot(performance.now()),
  }),
  ready: false,
};
let thumbnailRenderer, nativeFrameClipboard;
let inbetweenDialog;
async function changeFigureLayer(label, operation) {
  pause();
  finishKeyboardHandle();
  cancelDrag();
  interruptRecovery();
  const controller = new AbortController();
  let dialogShown = false,
    latest;
  const originalDialogContent = $("dialog-content").firstChild,
    originalDialogOpen = $("dialog").open;
  const cancel = () => controller.abort();
  let progressElement;
  const refresh = () => {
    if (
      !dialogShown ||
      !latest ||
      !progressElement?.isConnected ||
      controller.signal.aborted
    )
      return;
    $("layer-progress-label").textContent =
      latest.phase === "staging"
        ? "Applying layer changes"
        : "Preserving animation";
    const progress = progressElement;
    if (Number.isFinite(latest.total) && latest.total > 0) {
      progress.max = latest.total;
      progress.value = latest.completed || 0;
    } else progress.removeAttribute("value");
  };
  const timer = setTimeout(() => {
    if (
      $("dialog-content").firstChild !== originalDialogContent ||
      $("dialog").open !== originalDialogOpen
    ) {
      controller.abort();
      return;
    }
    dialogShown = true;
    showDialog(
      label,
      '<p id="layer-progress-label">Preserving animation</p><progress id="layer-progress" style="width:100%;accent-color:#0d99ff"></progress><div class="dialog-actions"><button class="button" id="cancel-layer-change">Cancel</button></div>',
    );
    progressElement = $("layer-progress");
    $("cancel-layer-change").onclick = cancel;
    $("dialog").addEventListener("close", cancel, { once: true });
    refresh();
  }, 150);
  try {
    return await operation({
      signal: controller.signal,
      onProgress: (progress) => {
        latest = progress;
        refresh();
      },
    });
  } catch (error) {
    if (error.name !== "AbortError") throw error;
    status("Layer change cancelled");
    return false;
  } finally {
    clearTimeout(timer);
    if (dialogShown) {
      $("dialog").removeEventListener("close", cancel);
      if (progressElement?.isConnected) closeDialog();
    }
    queueUI();
  }
}
let clipboardOperationTail = Promise.resolve();
function runClipboardOperation(kind, execute) {
  const source = editor._documentToken;
  const operation = clipboardOperationTail.then(() => {
    if (editor._documentToken !== source) return 0;
    return performClipboardOperation(kind, execute);
  });
  clipboardOperationTail = operation.catch(() => {});
  return operation;
}
async function performClipboardOperation(kind, execute) {
  finishCurrentEdit();
  interruptRecovery();
  const controller = new AbortController(),
    source = editor._documentToken,
    dialog = $("dialog"),
    originalContent = $("dialog-content").firstChild,
    originalOpen = dialog.open;
  const labels = {
    copy: "Copying frames",
    cut: "Cutting frames",
    paste: "Pasting frames",
  };
  let progressElement, latest;
  const cancel = () => controller.abort();
  const changed = () => {
    if (editor._documentToken !== source) cancel();
  };
  const onClose = () => {
    if (!dialog.open || !progressElement?.isConnected) cancel();
  };
  const refresh = () => {
    if (!progressElement?.isConnected || !latest) return;
    if (Number.isFinite(latest.total) && latest.total > 0) {
      progressElement.max = latest.total;
      progressElement.value = latest.completed || 0;
    } else progressElement.removeAttribute("value");
  };
  editor.addEventListener("change", changed);
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    if (
      $("dialog-content").firstChild !== originalContent ||
      dialog.open !== originalOpen
    ) {
      cancel();
      return;
    }
    showDialog(
      labels[kind] || "Updating frames",
      '<progress id="clipboard-progress" style="width:100%;accent-color:#0d99ff"></progress><div class="dialog-actions"><button class="button" id="cancel-clipboard">Cancel</button></div>',
    );
    progressElement = $("clipboard-progress");
    $("cancel-clipboard").onclick = cancel;
    dialog.addEventListener("close", onClose);
    refresh();
  }, 150);
  try {
    const count = await execute({
      signal: controller.signal,
      onProgress: (progress) => {
        latest = progress;
        refresh();
      },
    });
    if (count && kind === "copy")
      status(`${count} frame${count === 1 ? "" : "s"} copied`);
    return count;
  } catch (error) {
    if (error.name !== "AbortError") throw error;
    status("Clipboard operation cancelled");
    return 0;
  } finally {
    clearTimeout(timer);
    editor.removeEventListener("change", changed);
    dialog.removeEventListener("close", onClose);
    if (progressElement?.isConnected) closeDialog();
    queueUI();
  }
}
function mountTimeline() {
  pause();
  finishKeyboardHandle();
  propertyControls?.commit();
  if (editor._animationEdit) editor.commitAnimationEdit();
  if (editor.dragging) editor.commitDrag();
  if (state.settings.timelineMode === "advanced") editor.disableFrameDrafts();
  state.rangeIndices = [];
  state.loopRange = null;
  timelineUI?.destroy();
  $("timeline").replaceChildren();
  const TimelineClass =
    state.settings.timelineMode === "simple" ? SimpleTimeline : Timeline;
  timelineUI = new TimelineClass($("timeline"), editor, {
    runClipboardOperation,
    confirmDiscardFrame: () =>
      new Promise((resolve) => {
        showDialog(
          "Discard frame changes?",
          '<p>Restore the frame to its saved pose? You can undo this change.</p><div class="dialog-actions"><button class="button" id="keep-frame-draft">Keep changes</button><button class="button primary" id="discard-frame-draft">Discard</button></div>',
        );
        const cancel = () => resolve(false);
        $("dialog").addEventListener("close", cancel, { once: true });
        $("keep-frame-draft").onclick = () => closeDialog();
        $("discard-frame-draft").onclick = () => {
          resolve(true);
          closeDialog();
        };
      }),
    onTrackSelect: selectTrack,
    onKeysChange: () => {
      state.inspectorTab = "animation";
      if (!["camera", "scene"].includes(state.inspectorContext))
        state.inspectorContext = "frame";
      queueUI();
    },
    renderThumbnail: (index, canvas, options) =>
      thumbnailRenderer.renderThumbnail(index, canvas, {
        ...options,
        storedFrames: !editor.report._styk?.layerSheet && state.settings.timelineMode === "simple",
      }),
    onInsertInbetween: (indices) => {
      finishKeyboardHandle();
      pause();
      cancelDrag();
      propertyControls?.cancel();
      inbetweenDialog ??= new InsertInbetweenDialog({
        editor,
        getSettings: () => state.settings,
        renderThumbnail: (index, canvas, options) =>
          thumbnailRenderer.renderThumbnail(index, canvas, {
            ...options,
            storedFrames: !editor.report._styk?.layerSheet && state.settings.timelineMode === "simple",
          }),
        onApply: queueUI,
        onClose: queueUI,
        onError: fail,
      });
      inbetweenDialog.open(indices);
    },
    onUpdateFrame: () => {
      if (editor.dragging) editor.commitDrag();
      queueUI();
    },
    onSeek: () => pause(),
    onScrubStart: () => {
      pause();
      interruptRecovery();
      clearTimeout(warmTimer);
      state.scrubbing = true;
      requestRender();
    },
    onScrub: previewScrub,
    onScrubEnd: () => {
      state.scrubbing = false;
      queueUI();
      requestRender();
      warmPlayback();
      if (editor.dirty) scheduleRecovery();
    },
    onError: fail,
    onRangeChange: (indices) => {
      state.rangeIndices = indices;
      if (!state.scrubbing) renderInspector();
      $("selection-summary").textContent =
        `${indices.length} keyframe${indices.length === 1 ? "" : "s"} selected`;
    },
    onLoopRangeChange: (range) => {
      pause();
      state.loopRange = range;
      warmPlayback();
    },
  });
  // Zoom lives beside frame navigation in the advanced timeline itself.
  $("timeline-zoom").closest(".timeline-actions").hidden = true;
  $("timeline")
    .closest(".timeline-panel")
    .classList.toggle("simple-mode", state.settings.timelineMode === "simple");
  window.styk.timeline = timelineUI;
}
async function init() {
  if (desktop?.activateDocument)
    state.documentToken = (await desktop.activateDocument({})).documentToken;
  const settingsValue = desktop?.getEditorSettings
    ? await desktop.getEditorSettings()
    : undefined;
  appLocalization = new AppLocalization({ locale: settingsValue?.locale });
  editorSettings = new EditorSettings({
    value: settingsValue,
    localization: appLocalization.localization,
    onChange: (patch, next) => {
      const previousMode = state.settings.timelineMode;
      const previousSettings = state.settings;
      state.settings = next;
      try { if (previousMode !== next.timelineMode) mountTimeline(); }
      catch (error) { state.settings = previousSettings; throw error; }
      onionControls?.sync();
      state.handles = next.showHandles;
      state.loop = next.loopPlayback;
      appLocalization.setLocale(next.locale);
      blueHandles = null;
      scheduleRecovery();
      requestRender();
      queueUI();
    },
    onPersist: desktop?.setEditorSettings
      ? (value) => desktop.setEditorSettings(value)
      : undefined,
    onResetWorkspace: () => workspaceLayout?.reset(),
    onPrivacy: desktop?.getTelemetryState ? () => privacyUI.open() : undefined,
  });
  state.settings = editorSettings.value;
  appLocalization.bindChrome();
  appLocalization.updatePlayback($("play-button"), state);
  window.styk.localization = appLocalization;
  state.handles = state.settings.showHandles;
  state.loop = state.settings.loopPlayback;
  window.styk.settingsUI = editorSettings;
  onionControls = new OnionControls({button: $("onion-settings-button"), toggleButton: $("onion-button"),
    getSettings: () => state.settings, getEnabled: () => state.onion,
    onChange: patch => editorSettings.commit(patch), onToggle: () => actions["toggle-onion"]()});
  window.styk.onionCache = onionCache;
  const preferences = desktop?.getWorkspacePreferences
    ? await desktop.getWorkspacePreferences()
    : undefined;
  workspaceLayout = initWorkspaceLayout({
    preferences,
    onPersist: desktop?.setWorkspacePreferences
      ? (snapshot) => desktop.setWorkspacePreferences(snapshot)
      : undefined,
    onPersistError: (error) => status(error.message, true),
  });
  window.styk.workspace = workspaceLayout;
  editor.setLayerMigrationPlanner((params, options) => {
    syncPlayback();
    return playback.planLayerMigration(params, options);
  });
  editor.setInbetweenPlanner((params, options) => {
    syncPlayback();
    return playback.planInsertInbetweens(params, options);
  });
  propertyControls = new PropertyControls($("inspector"), {
    canHandle: (key) =>
      Boolean(propertyChannel(key)) || canEditNativeProperty(editor, key),
    getValue: (key) => {
      const value = propertyState(key).value;
      return (
        value ??
        getNativePropertyValue(editor, key, { bounds: selectionBounds })
      );
    },
    begin: ({ key }) => {
      pause();
      interruptRecovery();
      const branch = usesBuilderBranch();
      const binding =
        branch && ["segment_opacity", "segment_gradient_opacity"].includes(key)
          ? null
          : propertyChannel(key);
      if (
        binding &&
        (editor.propertyChannels || binding.property === 'zIndex' || editor.animationChannel(
          binding.target,
          binding.property,
          binding.options,
        )?.keys.length)
      ) {
        editor.beginAnimationEdit(
          binding.target,
          binding.property,
          binding.options,
        );
        const indices=rangeFrames();return { binding, indices, ticks:indices?.sheetTicks };
      }
      return {
        native: beginNativePropertyEdit(editor, key, {
          bounds: selectionBounds,
          indices: rangeFrames(),
          rangeMode: "absolute",
          branch,
        }),
      };
    },
    preview: ({ value, token }) => {
      if (token.binding)
        editor.previewAnimationEdit(token.binding.fromUI(value));
      else previewNativePropertyEdit(token.native, value);
      requestRender();
    },
    commit: ({ token, value }) => {
      if(token.binding&&token.ticks){editor.cancelAnimationEdit();editor.addAnimationKeys(token.ticks.map(tick=>({target:token.binding.target,property:token.binding.property,tick,value:token.binding.fromUI(value),...token.binding.options})));
      } else if (token.binding && token.indices?.length > 1) {
        editor.cancelAnimationEdit();editor.addAnimationKeys(token.indices.map(index=>({target:token.binding.target,property:token.binding.property,
          tick:editor.timeline[index].start,value:token.binding.fromUI(value),...token.binding.options})));
      } else if (token.binding) editor.commitAnimationEdit();
      else commitNativePropertyEdit(token.native);
      queueUI();
    },
    cancel: ({ token }) => {
      if (token?.binding) editor.cancelAnimationEdit();
      else if (token?.native) cancelNativePropertyEdit(token.native);
      queueUI();
      requestRender();
    },
    keyframe: ({ key }) => {
      const binding = propertyChannel(key);
      if (!binding) return;
      pause();
      const channel = editor.animationChannel(
          binding.target,
          binding.property,
          binding.options,
        ),
        existing = channel?.keys.find((key) => key.tick === editor.tick && !key.hidden && !key.passthrough);
      if (existing)
        editor.deleteAnimationKeys([
          { channelId: channel.id, keyIds: [existing.id] },
        ]);
      else
        editor.addAnimationKey(
          binding.target,
          binding.property,
          editor.tick,
          editor.animationValue(
            binding.target,
            binding.property,
            editor.tick,
            binding.options,
          ),
          binding.options,
        );
      queueUI();
    },
    navigate: ({ key, direction }) => {
      const info = propertyState(key);
      const next = direction < 0 ? info.previousKey : info.nextKey;
      if (next) {
        pause();
        editor.seek(next.tick);
      }
    },
    onError: fail,
  });
  window.styk.properties = propertyControls;
  assetLibrary = new AssetLibrary($("asset-list"), {
    onAdd: (id) => {
      pause();
      if (rangeFrames()) editor.addFigureInFrames(id, rangeFrames());
      else editor.addFigure(id);
      $("insert-dialog").close();
      setTool("select");
    },
    onError: fail,
    resources,
  });
  window.styk.assets = assetLibrary;
  window.styk.library = new UserLibrary({editor, desktop, exporter:documentExporter, importer, pause, finishEdit:finishCurrentEdit, setTool});
  $('library-tab')?.addEventListener('click', () => telemetry.count('library'));
  actions['add-to-library'] = () => { telemetry.count('library'); return window.styk.library.run(() => window.styk.library.save()); };
  window.styk.movieclips = installMovieclipUI({editor,actions,pause,finishEdit:finishCurrentEdit,
    getTimeline:()=>timelineUI,setTool,onError:fail,queueUI,exportClip:()=>exportPivot('stykmov')});
  for (const [name, action] of Object.entries(actions)) if (name.startsWith('movieclip-')) actions[name] = (...args) => { telemetry.count('movieclip'); return action(...args); };
  editor.addEventListener('change',event=>{
    if(event.detail?.kind==='movieclip-scope' || event.detail?.movieclipScope) {
      mountTimeline(); state.inspectorContext=editor.object?'figure':'scene';state.inspectorTab='design';queueUI();
    }
  });
  studioShell = initStudioShell({editor, state, setTool, renderAssets, renderInspector, showCommandMenu,
    actions, openTimelineSettings: () => editorSettings.open("interface"), getTimeline: () => timelineUI});
  window.styk.studio = studioShell;
  if (desktop?.beginClipboardRead)
    nativeFrameClipboard = installNativeFrameClipboard(editor, desktop, {
      onError: fail,
      onRestored: queueUI,
    });
  thumbnailRenderer = new ThumbnailRenderer(editor, { onError: fail });
  window.styk.thumbnails = thumbnailRenderer;
  mountTimeline();
  state.renderer = await createRenderer(canvas, rendererOptions());
  new ResizeObserver(resize).observe(viewport);
  resize();
  fit();
  updateUI();
  status("Ready");
  window.styk.ready = true;
  window.styk.telemetry = telemetry;
  window.styk.privacyUI = privacyUI;
  updateNotice = new UpdateUI(desktop, { onRestart: () => actions['restart-update']() });
  void releaseSplash.open({ startup: true }).catch(console.warn);
  void telemetryInit.then(info => {
    telemetry.timing('startup_ms', performance.now());
    if (info && !info.decided) {
      const offer = () => { if (document.querySelector('dialog[open]')) return; document.removeEventListener('close', offer, true); void privacyUI.open({ firstRun: true }).catch(() => {}); };
      document.addEventListener('close', offer, true); setTimeout(offer, 300);
    }
  });
  warmPlayback();
  offerRecovery();
  try {
    const data = await (await api("/api/samples")).json();
    state.samples = data.samples || [];
    renderAssets();
  } catch (error) {
    status("Editor ready · File service unavailable", true);
    console.warn(error);
  }
}
function rendererOptions() {
  return {
    resources,
    onInvalidate: requestRender,
    onStatus: (message) => {
      const compatibility = message.backend === "Canvas 2D fallback";
      $("renderer-label").classList.toggle("compatibility", compatibility);
      $("renderer-label").textContent = compatibility
        ? "Compatibility mode"
        : message.backend || "WebGPU";
      $("renderer-label").title = compatibility
        ? `${message.reason || "WebGPU is unavailable."} Canvas compatibility rendering is active.`
        : "";
      status(
        typeof message === "string" ? message : message.message || "Ready",
      );
      if (message.backend === "WebGPU device lost") {
        telemetry.count('gpu_errors'); telemetry.error({ name: 'GPUError' }, 'gpu');
        pause();
        propertyControls?.cancel();
        cancelDrag();
        editor.cancelDrag();
        editor.cancelAnimationEdit();
        keyboardHandleGesture = null;
        heldArrows.clear();
        state.handleEditHeld = false;
        state.space = false;
        state.spacePanned = false;
        state.isolateHeld = false;
        state.hoverHandle = null;
        state.hoverCameraHandle = null;
        viewport.classList.toggle("panning", state.tool === "hand");
        $("renderer-error").hidden = false;
        $("renderer-error").innerHTML =
          '<p>The graphics device was disconnected. Your animation is still here.</p><button class="button" id="retry-renderer">Reconnect canvas</button>';
        $("retry-renderer").onclick = guarded(async () => {
          state.renderer.destroy();
          state.renderer = await createRenderer(canvas, rendererOptions());
          $("renderer-error").hidden = true;
          resize();
          requestRender();
        });
      }
    },
  };
}
init().catch((error) => {
  $("renderer-error").hidden = false;
  $("renderer-error").textContent = error.message;
  fail(error);
});

installColorPickers((input, event) => {
  if (input.id === 'segment-color') {
    const uid=editor.selectedUid, joint=editor.selectedJoint, figure=editor.figure;
    return {anchor:input, paint:segmentPaint(resolveInstanceFigure(figure,editor.object).segments[joint]), onChange:paint=>{
      if(editor.selectedUid!==uid || editor.selectedJoint!==joint || editor.figure!==figure) throw new Error('Selection changed. Reopen the color picker.');
      pause(); updateBuilderStyle({paint},event);
    }};
  }
  if(input.id==='background-color'){
    const bg=editor.report.backgrounds?.find(b=>b.background_id===editor.frame.background_id),override=editor.frame._stykBackgroundColor;
    return {anchor:input,paint:backgroundPaint(override===undefined?bg:{kind:2,color:override}),onChange:paint=>{
      if(paint.type==='solid')editor.setSceneColor(paintBackground(paint).color,{indices:rangeFrames()});
      else editor.importSceneBackground({...paintBackground(paint),name:paint.type+' gradient'},{indices:rangeFrames()});
    }};
  }
  if(input.id==='outline-color')return {anchor:input,gradients:false,paint:{type:'solid',stops:[{offset:0,color:parseColor(input.value).color,opacity:1-(resolveInstanceFigure(editor.figure,editor.object)?.segment_decode?.global_style?.u30??0)/255}]},onChange:paint=>editor.updateFigureStyle({outlineColor:paint.stops[0].color,outlineOpacity:paint.stops[0].opacity})};
  if(input.dataset.polygonColor!==undefined){const index=Number(input.dataset.polygonColor),p=resolveInstanceFigure(editor.figure,editor.object).polyfills[index];return {anchor:input,gradients:false,paint:{type:'solid',stops:[{offset:0,color:p.color_rgb,opacity:p.alpha_raw!==undefined?1-p.alpha_raw/255:p.color_alpha??1}]},onChange:paint=>editor.updatePolygon(index,{color:paint.stops[0].color,opacity:paint.stops[0].opacity})};}
  const pairs = {'background-first':'background-alpha','background-second':'background-alpha-b','text-color':'text-opacity','figure-color':'figure-opacity'};
  const opacityId=pairs[input.id], opacity=opacityId && document.getElementById(opacityId);
  if(opacity) return {anchor:input,paint:{type:'solid',stops:[{offset:0,color:parseColor(input.value).color,opacity:Number(opacity.value)/100}]},gradients:false,onChange:paint=>{
    const current=document.getElementById(input.id); if(!current)return;
    current.value=hexColor(paint.stops[0].color); current.dispatchEvent(new Event('input',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));
    const field=document.getElementById(opacityId);if(field){field.value=paint.stops[0].opacity*100;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
  }};
});
