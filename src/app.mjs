import {tupleMessages, messageTuple, messageHTML, localizedAttribute, localizedText, appendLocalized, localizedMarkup, clearTranslation, AppLocalization, menuLabelKey} from './localization-bindings.mjs';

import {messageError} from './localized-error.mjs';
import {errorText, presentError} from './error-presentation.mjs';

import {t as interfaceText} from './localization.mjs';

import {installSpatialControls,drawSpatialGizmo,spatialGizmoDrag,updateSpatialGizmo,spatialControlMode} from './spatial-controls.mjs';
import {rigDetailsShown} from './rig-control-details.mjs';
import {drawingBarrier,drawingResourcesFor} from './drawing-resources.mjs';
import {drawingMetadata} from './drawing-model.mjs';
import {builderStrokeAppearance, setBuilderStroke, copyBuilderAppearance, pasteBuilderAppearance} from './builder-appearance.mjs';
import {drawRigGuides, drawConnectorGuides} from './rig-controls.mjs';
import {displayedSegmentPaint,displayedColor} from './figure-colors.mjs';
import {openSurfaceReference} from './builder-surface-ui.mjs';
import {openRigTest, openRigExamples} from './rig-test-ui.mjs';
import {bucketRegion, pickFigureFill, drawFillHighlight} from './builder-fill.mjs';
import {figureJoinAction, joinTargetUids} from './figure-join-action.mjs';
import {duplicatePreview, drawDuplicatePreview} from './builder-duplicate-preview.mjs';
import {createConstruction, strokeSegments} from './builder-construction.mjs';
import {CameraMotionControls} from './camera-motion-ui.mjs';
import {installColorPickers} from './color-picker.mjs';
import {bindProjectPalette, projectColors} from './color-palette.mjs';
import {sampleCanvasRegion} from './canvas-color-sample.mjs';
import {installMovieclipUI} from './movieclip-ui.mjs';
import {isMovieclip} from './movieclips.mjs';
import {segmentPaint, parseColor, hexColor, backgroundPaint, paintBackground, paintCSS} from './paint.mjs';
import {resolveInstanceFigure, polygonIdentity} from './animation-style.mjs';
import { applicationMenuItems } from "./application-menu.mjs";
import { Editor } from "./editor.mjs";
import { worldToScreen, screenToWorld, objectBounds } from "./renderer-geometry.mjs";
import { createStage } from "./engine/engine-stage.mjs";
import { createStagePlayback } from "./engine/engine-playback.mjs";
import { installEngineOwner } from "./engine/engine-owner.mjs";
import { loadEngine } from "./engine/engine.mjs";
import { useEngine } from "./engine/engine-open.mjs";
import { engineDocument } from "./engine/engine-document.mjs";
import { engineComposite } from "./engine/engine-composite.mjs";
import { markAppBounds } from "./engine/engine-edit-bounds.mjs";
import {DrawingController} from './drawing-controller.mjs';
import { ROW as TIMELINE_ROW, HEADER as TIMELINE_RULER } from "./layer-timeline.mjs";
import { createTimelineHost } from "./timeline-host.mjs";
import {hasPinnedIK} from './ik.mjs';
import { OnionControls } from "./onion-controls.mjs";
import { OnionController } from "./onion-controller.mjs";
import { createThumbnailRenderer } from "./engine/engine-thumbnails.mjs";
import { EnginePoses } from "./engine/engine-pictures.mjs";
import { BackgroundDialog } from "./background-dialog.mjs";
import { ImportClient } from "./import-client.mjs";
import { browserCodecHost, codecProfile } from "./codec-web-host.mjs";
import {playbackWindow,playbackLookaheadSize,playbackStartupWindow,normalizePlaybackRange} from './playback-window.mjs';
import {AudioEngine} from './audio-engine.mjs';
import {audioState, audioFps, audibleClips} from './audio-model.mjs';
import {PreviewImages} from './preview-images.mjs';
import { PlaybackMetrics } from "./playback-metrics.mjs";
import {PlaybackCadence} from './playback-cadence.mjs';
import {previewQualityLevels, previewMsaaLevels, updatePreviewQuality, playbackQualityIndex} from './preview-quality.mjs';
import { DesktopTelemetryClient } from './telemetry-core.mjs';
import { workload, documentComplexity } from './telemetry-workload.mjs';
import { sizeBucket,complexityBucket,fpsBucket } from './telemetry-schema.mjs';
import { BrowserRecoverySession, readBrowserRecovery } from './browser-recovery.mjs';
import {DocumentSave, RecoveryDeadline, documentCheckpoint, matchesDocumentCheckpoint} from './document-save.mjs';
import {createProjectTabsHost} from './project-tabs-host.mjs';
import {createHome} from './home/home.mjs';
import {createTutorials} from './tutorials/tutorials.mjs';
import {installProjectTabs} from './shell/project-tabs-view.mjs';
import {createProjectSwitcher} from './shell/project-switcher.mjs';
import {sessionProject} from './editor-sessions.mjs';
import { PrivacyUI } from './privacy-ui.mjs';
import { FeedbackUI } from './feedback-ui.mjs';
import { UpdateUI } from './update-ui.mjs';
import { ReleaseSplash } from './support-ui.mjs';
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
import { installShell } from "./shell/dock-host.mjs";
import { createDockKeyboard } from "./shell/dock-keyboard.mjs";
import { installDockTabs } from "./shell/dock-tabs.mjs";
import { createLayoutPopover } from "./shell/layout-popover.mjs";
import { installShellCommands } from "./shell/shell-commands.mjs";
import { bandBottom, syncBandSession } from "./shell/topbar.mjs";
import { installRail, syncRailQuick } from "./shell/rail.mjs";
import { initStudioShell } from "./studio-shell.mjs";
import { createExportFlow } from "./export-flow.mjs";
import { createAppDialogs } from "./app-dialogs.mjs";
import { dragSlop, beyondSlop, installPenMenuGuard } from "./pen-input.mjs";
import { installCanvasPinch } from "./canvas-pinch.mjs";
import { createWheelZoom, smoothWheelZoom } from "./canvas-wheel-zoom.mjs";
import { createPoseInputQueue } from './canvas-pose-input.mjs';
import { CanvasHandleOverlay } from './canvas-handle-overlay.mjs';
import { installTouchMode } from "./touch/touch-mode.mjs";
import { installTouchShell } from "./touch/touch-shell.mjs";
import { installLongPress } from "./touch/long-press.mjs";
import { installCanvasTouch } from "./touch/canvas-touch.mjs";
import { installModifierDock } from "./touch/modifier-dock.mjs";
import { initBuilderMode } from "./builder-mode.mjs";
import { configureInspectorSections, inspectorView } from "./inspector-view.mjs";
import { updateInspectorDOM } from "./inspector-dom.mjs";
import { installInspectorBindings } from "./inspector-bindings.mjs";
import {syncCameraControls, drawCameraMonitor} from './camera-monitor.mjs';
import { AssetLibrary } from "./asset-library.mjs";
import { UserLibrary } from './user-library.mjs';
import { LocalLibrary, createBrowserLibraryApi } from './web-library.mjs';
import { CommunityLibrary, DownloadLedger, localStorageLedgerStorage } from './community-library.mjs';
import { installLibraryDrag, installLibraryDrop } from './library-drag.mjs';
import { SharedClipboard } from './shared-clipboard.mjs';
import { PropertyControls } from "./property-controls.mjs";
import {VfxInspector} from './vfx-inspector.mjs';
import {VfxGizmos} from './vfx-gizmos.mjs';
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
  pickCanvasSegment,
  figureIntersectsMarquee,
  invalidatePivotHandleTopology,
} from "./canvas-interactions.mjs";
import {
  cameraViewport,
  pickCameraHandle,
  cameraDragDelta,
  cameraKeyboardDelta,
  cameraHandleCursor,
  drawCameraViewport,
  drawCameraOutline,
} from "./camera-overlay.mjs";
import { EditorSettings, normalizeEditorSettings } from "./settings.mjs";
import { HotkeyManager, HOTKEY_BY_ID, isHotkeyInput } from "./hotkeys.mjs";
import { hotkeyCommandId, refreshHotkeyHints } from "./hotkey-hints.mjs";
import { runTimelineHotkey } from "./timeline-hotkeys.mjs";

import { layerIdForUid, layerVisible, layerLocked } from "./layers.mjs";
import { DocumentExporter } from "./document-export.mjs";
import { writeNativeBlob as writeNativeBlobRaw, readNativeRecovery } from "./native-files.mjs";
import {
  imageFileToFigure,
  imageFileToBackground,
} from "./media-authoring.mjs";
import { icon, hydrateIcons } from "./icons.mjs";
import { MotionTrails, motionPathTargets, motionPathTargetKey, pickMotionPathPoint, drawMotionPath, drawMotionPathGhost, affineProjection } from "./motion-path.mjs";
import { MOTION_PATH_FALLOFF_MAX } from "./motion-path-falloff.mjs";
import { CanvasGuides } from "./canvas-guides.mjs";
import { MotionPathControls } from "./motion-path-controls.mjs";
import { TweenerControls } from "./tweener-controls.mjs";
import { onFontsReady } from "./ui/font-loading.mjs";
import { createOverlayManager } from "./ui/overlay-manager.mjs";
import { createInvalidator } from "./ui/ui-invalidation.mjs";
import { setAttr, setHidden, setMarkup, setText } from "./ui/dom-write.mjs";
import { installMenuBar, menuFor, openMenu } from "./ui/ui-menu.mjs";
import { createToasts } from "./ui/ui-toast.mjs";
import { createStageHead } from "./shell/stage-head.mjs";
import { UserActionError } from "./user-action-error.mjs";
import { prompt as promptText, showLegacyDialog } from "./ui/ui-dialog.mjs";
import { createCommandRegistry, fuzzyMatch } from "./ui/command-registry.mjs";
import { createCommandPalette } from "./ui/command-palette.mjs";
import { kitText } from "./ui/ui-strings.mjs";
import { installTooltips } from "./ui/ui-tooltip.mjs";
import { withShiftHint } from "./ui/quick-actions.mjs";
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
// The engine opens every document (src/engine/engine-open.mjs): it loads before the first one.
useEngine(await loadEngine());
const editor = new Editor({ demo: false, propertyChannels: true, layerTimeline: true }).newDocument(),
  desktop = window.stykDesktop,
  importer = new ImportClient(),
  documentExporter = new DocumentExporter(),
  exportJobs = new Set();
const browserRecovery = desktop ? null : new BrowserRecoverySession();
const manualSave = new DocumentSave(), recoveryDeadline = new RecoveryDeadline();
let saveMutationEpoch = 0, finalizingDocument = false;
let documentActivation = Promise.resolve();
// The mutation epoch the project in front had when its recovery copy was last written (-1: it has none).
let recoveredEpoch = -1;
// A project is opening or closing: its save target is being bound, so nothing else may come to the front.
let projectTransitions = 0;
// The open projects (project-tabs-host.mjs, docs/PROJECT-TABS.md): one is live in this editor, the others rest
// with their history. The hooks are this file's side of a project leaving the front or coming to it.
const projects = createProjectTabsHost({editor, hooks: {
  settle: () => settleProject(),
  capture: () => captureProject(),
  restore: (saved) => restoreProject(saved),
  shown: (record, saved) => projectShown(saved),
  confirmClose: () => dialogs.confirmReplace(),
  blank: () => blankProject(),
  release: (record) => releaseProject(record),
  refuse: (reason) => projectRefused(reason),
  busy: () => Boolean(projectTransitions || manualSave.active || state.importing || finalizingDocument || [...exportJobs].some((job) => job.raster)),
  idle: () => !(state.playing || state.scrubbing || state.importing || manualSave.active || exportJobs.size || editingGestureActive()),
  checkpoint: (record, signal) => writeRestingRecovery(record, signal),
  checkpointFailed: (error) => status({messageKey: "app.recoveryCopyCouldNotBeWritten", messageParams: {message: error.message}}, true),
}});
const audioEngine = new AudioEngine({desktop, onError: error => { pause(); fail(error); }});
let audioPreparation, audioScrubController, audioScrubAt = 0;
function interruptRecovery() {
  let aborted = false;
  // A resting project's copy is not interrupted: nothing the person does in front can change what it stores.
  for (const job of exportJobs) if (job.recovery && !job.resting) { job.controller.abort(); aborted = true; }
  // Every gesture that kills a running export restarts its serialization from
  // zero; on large documents that work can never finish while the user keeps
  // interacting. Back off so attempts spread out instead of churning forever.
  if (aborted) state.recoveryBackoff = Math.min(12, (state.recoveryBackoff || 1) * 2);
  clearTimeout(state.recoveryTimer);
  if (editor.dirty) scheduleRecovery();
}
async function runDocumentExport(format, consume, { recovery = false, controller = new AbortController() } = {}) {
  if (!recovery){finishCurrentEdit();await drawingController?.barrier();}
  const job = { controller, recovery };
  exportJobs.add(job);
  const metric = recovery ? 'recovery' : format === 'styk' ? 'save' : 'export';
  const started = performance.now();
  const context = telemetry.consent.diagnostics ? workload({ format, report: editor.report }) : {};
  let stage = 'serialize';
  telemetry.count(metric + '_started');
  try {
    const drawingRevision=editor.revision;await drawingBarrier(editor.report,{signal:controller.signal});if(drawingRevision!==editor.revision)throw messageError(new DOMException('', 'AbortError'), "errors.app.theDrawingChangedDuringExport", {});
    // The engine makes Pivot and figure files from the document it holds: its session starts on the open document and takes what the editor changed.
    if (format !== 'styk' && !editor._shown?.active) throw Object.assign(messageError(new Error(''), "errors.documentExport.theEngineCannotMakeThisFileHere", {}), {telemetryCode: 'engine_failed', telemetryStage: 'prepare'});
    const blob = await documentExporter.export(recovery ? editor.movieclipProjectReport() : editor.report, {
      format,
      name: recovery ? editor._movieclipScopes?.[0]?.parent.name ?? editor.name : editor.name,
      sourceId: state.sourceId,
      figureTypeId: editor.object?.figure_type_id,
      figureUid: editor.selectedUid,
      tick: editor.tick,
      revision: editor.revision,
      signal: controller.signal,
      getRevision: () => `${editor.revision}:${saveMutationEpoch}`,
    });
    context.size = sizeBucket(blob.size);
    telemetry.performance.record('serialize',performance.now()-started);
    telemetry.timing(metric + '_ms', performance.now() - started);
    telemetry.operation({ ...context, operation: metric, stage: 'serialize', outcome: 'succeeded' }, performance.now() - started);
    stage = 'write';
    const writeStarted = performance.now();
    const saved = await consume(blob, controller.signal);
    telemetry.operation({ ...context, operation: metric, stage: 'write', outcome: saved ? 'succeeded' : 'cancelled' }, performance.now() - writeStarted);
    telemetry.operation({ ...context, operation: metric, stage: 'complete', outcome: saved ? 'succeeded' : 'cancelled' }, performance.now() - started);
    if (recovery) telemetry.count(saved ? 'recovery_saved' : 'recovery_cancelled');
    else {
      telemetry.count(metric + (saved ? '_succeeded' : '_cancelled'));
      if (saved) { telemetry.milestone(metric === 'save' ? 'first_save' : 'first_export'); if (metric === 'export') telemetry.count(['piv', 'stk'].includes(format) ? 'export_pivot' : 'export_native'); }
    }
    return saved;
  } catch (error) {
    telemetry.count(metric + (error.name === 'AbortError' ? '_cancelled' : '_failed'));
    telemetry.operation({ ...context, operation: metric, stage: 'complete', outcome: error.name === 'AbortError' ? 'cancelled' : 'failed' }, performance.now() - started);
    if (error.name !== 'AbortError') telemetry.error(error, metric, { ...context, stage });
    throw persistentFailure(error);
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
  onion: true,
  handles: true,
  tool: "select",
  rigMode: "move",
  builderBranch: false,
  builderShiftHeld: false,
  depthHeld: false,
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
  recoveryBackoff: 1,
  loadedName: null,
  playbackPacket: null,
  playbackRevision: null,
  playbackHiddenKey: "",
  previewGovernor: { index: 0 },
  loopRange: null,
  buffering: false,
  rangeIndices: [],
  applyRange: false,
  scrubbing: false,
  cameraGuides: true,
  vfxEnabled: true,
  motionPaths: false,
  hoverPathPoint: null,
};
// A lost device usually returns once the browser's GPU process settles, so
// reconnects back off per consecutive loss; a stage surviving the stable
// window restores the retry budget for the next transient loss.
const GPU_RECOVERY_DELAYS = [1000, 5000], GPU_STABLE_MS = 30000;
let canvas = $("scene"), rendererRecovery, gpuRecoveryTimer, gpuRecoveryAttempts = 0, gpuStableTimer;
const viewport = $("viewport"),
  overlay = $("overlay"),
  ctx = overlay.getContext("2d"),
  // The pictures the interface's own painters read (picking, the asset previews): the stage decodes its own.
  images = new PreviewImages({managedInvalidation:true,onReady: () => requestRender(), onError: error => status(error, true)});
hydrateIcons();
// One owner for dialogs, menus and messages (src/ui/overlay-manager.mjs): the
// hotkey gate, focus return, and the message slot that stays above every modal.
// The HotkeyManager joins once it exists, so held keys are released whenever a
// blocking overlay opens.
const overlays = createOverlayManager({ fallbackFocus: () => viewport });
overlays.install();
// The stage header (src/shell/stage-head.mjs): the crumb or the tool's options, the message's place,
// the view cluster and zoom. Its tool options bar is created on first use, after the command registry.
const stageHead = createStageHead({
  root: document.querySelector(".stage-head"),
  toasts: () => toasts,
  openMenu: (items, anchor, options) => showCommandMenu(items, anchor, options),
  toolOptions: () => ({ registry: commands, context: commandContext, icon: (name, className) => icon(name, className), t: kitT, overlays,
    onChange: ({ id, value }) => { if (id === "rig-mode") { flushPoseMove(); state.rigMode = value; queueUI(); } } }),
});
const toasts = createToasts({
  host: $("toast"),
  overlays,
  icon: (name) => icon(name),
  // The stage header's centre, or a line of its own under it; the stage's bottom centre while the header is not shown.
  // While Home shows (src/home/home.mjs) the header is under it: the message keeps its fallback place, in Home's box.
  slot: { place: (size) => (state.home ? null : stageHead.placeMessage(size)), release: () => stageHead.releaseMessage() },
  area: () => (state.home ? $("home") : viewport).getBoundingClientRect(),
  topInset: () => bandBottom(document),
  t: (key, params) => appLocalization?.t(key, params),
  feedback: desktop?.sendTelemetryFeedback
    ? { label: interfaceText("app.sendFeedback"), labelKey: "app.sendFeedback", run: () => feedbackUI.open({ category: "bug" }) }
    : null,
});
let drawingController, timelineUI, timelineHost,
  studioShell,
  builderMode,
  propertyControls, cameraMotionControls,
  vfxInspector,
  vfxGizmos,
  editorSettings,
  appLocalization,
  shell,
  workspaceLayout,
  touchMode,
  touchModifiers,
  assetLibrary,
  raf = 0,
  playStart = 0,
  playTick = 0,
  lastUI = 0,
  importSequence = 0,
  canvasPointerId = null,
  inspectorDisclosureOwner = null,
  spritePlacementDialog,
  spriteImportController;
// Settles once the editor is ready (styk.ready): work that can wait, such as the band's first measurement, waits for it.
let markEditorReady;
const editorReady = new Promise((resolve) => { markEditorReady = resolve; });
let warmTimer = null,
  playDeadline = 0,
  playStarted = false,
  playStartupFrames = 2;
const playbackMetrics = new PlaybackMetrics();
const playbackCadence = new PlaybackCadence();
let presentationDeadline = null;
function writeNativeBlob(bridge,blob,options={}){
  const context=telemetry.consent.diagnostics?telemetry.performance.context():null,epoch=telemetry.epoch;
  return writeNativeBlobRaw(bridge,blob,{...options,...(context?{onTiming:(metric,ms)=>{if(epoch===telemetry.epoch)telemetry.performance.record(metric,ms,context);}}:{})});
}
/** The stage's graphics backend as telemetry names it: the engine draws with WebGPU, or with WebGL2 where there is none. */
const telemetryBackend = () => ({WebGPU: 'webgpu', WebGL2: 'webgl2'})[state.renderer?.stats?.backend] ?? 'unavailable';
const telemetry = new DesktopTelemetryClient(desktop, { getContext: () => ({
  mode: state.settings.timelineMode, locale: state.settings.locale,
  playing: state.playing,
  pending:playback.stats.pendingFrames,cacheBytes:playback.stats.bytes,cache:playback.stats,
  performance:{
    backend:telemetryBackend(),
    complexity:complexityBucket(state.renderer?.stats?.primitives),fps:fpsBucket(editor.report?.fps),
    pixels:canvas.width*canvas.height<1e6?'under-1mp':canvas.width*canvas.height<4e6?'1-4mp':'4mp-plus',
    phase:state.playing?'playing':'editing',quality:images.reduced||state.previewGovernor?.index?'reduced':'full',
    features:(state.onion?1:0)|(state.inspectorContext==='camera'?2:0)|(state.vfxEnabled?4:0)|(state.motionPaths?8:0)|(state.renderer?.stats?.textureObjects?16:0),
  },
  backend: telemetryBackend(),
  gauges: { gpu_memory_mb: state.renderer?.stats?.gpuBytes / 1048576, draw_calls: state.renderer?.stats?.drawCalls,
    upload_kb: state.renderer?.stats?.uploadBytes / 1024, scene_figures: state.renderer?.stats?.objects,
    scene_primitives: state.renderer?.stats?.primitives, scene_frames: editor.totalTicks },
  gpuFamily: coarseGPUFamily(state.renderer?.stats?.adapter),
}) });
function recordPlaybackPresentation() {
  const now = performance.now();
  playbackMetrics.present(now);
  telemetry.playbackPresent(now, playbackMetrics.targetFps,{deadline:presentationDeadline,refreshMs:playbackCadence.interval});
}
function coarseGPUFamily(value = '') {
  return ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'software'].find(name => String(value).toLowerCase().includes(name)) || 'unknown';
}
const feedbackUI = new FeedbackUI(desktop);
importer.diagnostics=telemetry.performance;
const privacyUI = new PrivacyUI(desktop, telemetry, feedbackUI);
const releaseSplash = new ReleaseSplash(desktop);
let updateNotice;
const telemetryInit = telemetry.init().catch(() => null);
globalThis.addEventListener('error', event => telemetry.error(event.error));
globalThis.addEventListener('unhandledrejection', event => telemetry.error(event.reason));
globalThis.addEventListener('pagehide', () => { telemetry.performance.finish();void telemetry.flush(); telemetry.dispose(); });
let lastFpsUI = 0;
function editingGestureActive(){return Boolean(state.drag||keyboardHandleGesture||editor._drag||editor._authoredPoseEdit||propertyControls?.active||vfxInspector?.active||vfxGizmos?.active||drawingController?.interacting);}
// The editor chrome as surfaces (src/ui/ui-invalidation.mjs), in today's update order. queueUI()
// marks them all; one pass a frame updates what is marked. While playing, only the transport updates
// (at most every 200 ms); the quiet surfaces wait and update in the first pass after playback stops
// (pause() queues one). Surfaces write through dom-write.mjs, so an unchanged value writes nothing.
const ui = createInvalidator({
  isPlaying: () => state.playing,
  afterPass: () => requestRender(),
});
ui.surface("title", { on: ["document", "save", "revision"], update: () => updateTitle() });
ui.surface("transport", { on: ["tick", "document", "settings"], playbackInterval: 200, update: () => timelineHost?.updateTransport() });
ui.surface("layers", { on: ["selection", "document", "revision"], quiet: true, update: () => renderLayers() });
ui.surface("vfx", { on: ["selection", "revision", "context", "tick"], quiet: true, update: () => vfxInspector?.sync() });
ui.surface("inspector", { on: ["selection", "revision", "context", "tick"], quiet: true, update: () => renderProperties() });
ui.surface("selection", { on: ["selection", "range", "drag"], quiet: true, update: () => { if (!state.drag) syncSelectionControls(); } });
ui.surface("status", { on: ["objects", "document", "selection"], quiet: true, update: () => updateStatus() });
ui.surface("assets", { on: ["document", "revision"], quiet: true, update: () => { if (state.activeTab === "assets") renderAssets(); } });
ui.surface("shell", { on: ["mode", "settings", "selection", "context"], quiet: true, update: () => syncShell() });
ui.surface("stagehead", { on: ["mode", "settings", "selection", "context", "document", "revision", "tick"], quiet: true, update: () => syncStageHead() });
function queueUI() {
  ui.invalidate("all");
}
/** The band's session (experience.md §2): Build, a movieclip being edited, or the camera (outside Draw and Build). */
function bandSession() {
  if (builderMode?.active) return "build";
  if (editor._movieclipScopes?.length) return "movieclip";
  if (!drawingController?.active && cameraSelected()) return "camera";
  return "";
}
/** The scene's background as the crumb's chip shows it: the frame's colour override, else its background. */
function sceneBackground() {
  const frame = editor.frame, background = editor.report.backgrounds?.find((item) => item.background_id === frame?.background_id);
  const override = frame?._stykBackgroundColor;
  const paint = backgroundPaint(override === undefined ? background : { kind: 2, color: override });
  return { css: paintCSS(paint), label: paint.type === "solid" ? hexColor(paint.stops[0].color).toUpperCase() : interfaceText('app.valueValue1Gradient', {value: {messageKey: 'colorPicker.' + paint.type}, value1: ''}) };
}
/** The stage header (experience.md §4.2-4.4): the crumb or scope path, the workspace's view toggles and their states, a mode's message. */
function syncStageHead() {
  const session = bandSession(), scopes = editor._movieclipScopes ?? [];
  stageHead.update({
    mode: drawingController?.active ? "draw" : builderMode?.active ? "rig" : "animate",
    size: `${editor.report.canvas_width} × ${editor.report.canvas_height}`,
    background: sceneBackground(),
    session: session === "movieclip" ? { done: "movieclip-done", name: scopes.map((scope) => scope.name).join(" › ") }
      : session === "camera" ? { done: "camera-done", nameKey: "layers.camera" } : null,
    handles: state.handles, motionPaths: state.motionPaths, grid: Boolean(state.settings.canvasGrid), vfx: state.vfxEnabled,
    staticHandles: state.settings.builderShowStaticHandles !== false, highlight: Boolean(state.settings.builderHighlightSegment),
    isolate: Boolean(state.isolateMode),
  });
  if (builderMode?.active) syncRailQuick(document.querySelector(".studio-rail"), {
    "toggle-builder-branch": Boolean(state.builderBranch || state.builderShiftHeld),
    "toggle-builder-snap": construction?.snapping ?? state.settings.builderSmartSnapping !== false,
    "toggle-isolate": Boolean(state.isolateMode),
  });
  // The tool's options are written when the tool or its values change (the bar syncs its own pressed states).
  const optionsKey = `${drawingController?.active ? "draw" : state.tool}|${state.rigMode}`;
  if (optionsKey !== shownToolOptions) { shownToolOptions = optionsKey; stageHead.setToolOptions(toolOptionDescriptors(), { tool: state.tool, label: interfaceText("app.toolOptions"), labelKey: "app.toolOptions" }); }
  syncModeMessage();
}
let shownToolOptions = "";
/**
 * The active tool's options in the stage header (ui/tool-options.mjs): Build's Edit joints tool drags joints or
 * turns branches (Whole branch is Build's rail option, as it reaches every tool's edits). Other tools show where
 * you are (the crumb).
 */
function toolOptionDescriptors() {
  if (state.tool !== "rig" || drawingController?.active) return [];
  return [
    { id: "rig-mode", kind: "select", label: interfaceText("app.drag"), labelKey: "app.drag", showLabel: true, description: interfaceText("app.rigEditMode"), descriptionKey: "app.rigEditMode", elementId: "rig-mode", value: state.rigMode,
      options: [{ value: "move", label: interfaceText("app.moveJoint"), labelKey: "app.moveJoint" }, { value: "rotate", label: interfaceText("app.rotateBranch"), labelKey: "app.rotateBranch" }] },
  ];
}
/**
 * The pick mode that is active, as the stage header's mode message (experience.md §4.3): its instruction
 * for as long as it lasts, with Cancel where the mode has one (Esc cancels too). Today these hints were
 * written to the hidden #viewport-hint (R16).
 */
function modeMessage() {
  if (state.spritePlacement) return { key: "sprite", icon: "image", title: interfaceText("app.chooseAnAttachmentJoint"), titleKey: "app.chooseAnAttachmentJoint", message: interfaceText("app.forTheImage"), messageKey: "app.forTheImage", cancel: cancelSpritePlacement };
  if (state.duplicatePlacement) return { key: "duplicate", icon: "duplicate", title: interfaceText("app.chooseAParentJoint"), titleKey: "app.chooseAParentJoint", message: interfaceText("app.forTheCopy"), messageKey: "app.forTheCopy", cancel: cancelSpritePlacement };
  const pick = state.rigAnchorPick;
  if (pick) return { key: `connect-${pick.key ?? ""}`, icon: "link", cancel: () => { state.rigAnchorPick = null; syncModeMessage(); requestRender(); },
    ...(pick.key === "driver" ? { title: interfaceText("app.clickASmartStretchJoint"), titleKey: "app.clickASmartStretchJoint", message: interfaceText("app.onThisFigure"), messageKey: "app.onThisFigure" }
      : pick.key ? { title: interfaceText("app.clickTheNewAnchor"), titleKey: "app.clickTheNewAnchor", message: interfaceText("app.onThisFigure"), messageKey: "app.onThisFigure" } : { title: interfaceText("app.clickTheSecondJoint"), titleKey: "app.clickTheSecondJoint", message: interfaceText("app.toConnectIt"), messageKey: "app.toConnectIt" }) };
  if (drawingController?.active) return null;
  if (state.tool === "attach" && state.figureJoin) return { key: "join", icon: "join-figure", title: interfaceText("app.clickTheJoint"), titleKey: "app.clickTheJoint", message: interfaceText("app.toJoinTo"), messageKey: "app.toJoinTo", cancel: () => setTool("select") };
  if (state.tool === "chain") return { key: "chain", icon: "builder-chain", title: interfaceText("app.clickToAddPoints"), titleKey: "app.clickToAddPoints", message: interfaceText("app.enterFinishesBackspaceRemovesTheLast"), messageKey: "app.enterFinishesBackspaceRemovesTheLast" };
  // Build's drawing tools say what a drag does, so a new figure never starts from a blank guess.
  const started = Boolean(builderMode?.session?.figure);
  if (builderMode?.active && state.tool === "line")
    return { key: `build-line-${started}`, icon: "line", title: started ? interfaceText("app.dragFromAJoint") : interfaceText("app.dragOnTheCanvas"), titleKey: (started ? "app.dragFromAJoint" : "app.dragOnTheCanvas"), titleParams: (started ? {} : {}), message: started ? interfaceText('app.toAddALine') : interfaceText("app.toDrawTheFigureSFirstLine"), messageKey: (started ? 'app.toAddALine' : "app.toDrawTheFigureSFirstLine"), messageParams: (started ? {} : {}) };
  if (builderMode?.active && state.tool === "circle")
    return { key: `build-circle-${started}`, icon: "circle", title: started ? interfaceText("app.dragFromAJoint") : interfaceText("app.dragOnTheCanvas"), titleKey: (started ? "app.dragFromAJoint" : "app.dragOnTheCanvas"), titleParams: (started ? {} : {}), message: started ? interfaceText('app.toAddACircle') : interfaceText("app.toDrawTheFigureSFirstCircle"), messageKey: (started ? 'app.toAddACircle' : "app.toDrawTheFigureSFirstCircle"), messageParams: (started ? {} : {}) };
  if (state.tool === "polygon") return { key: "polygon", icon: "polygon", title: interfaceText("app.clickJointsToTrace"), titleKey: "app.clickJointsToTrace", message: interfaceText("app.shiftClickAnAreaToFillEnterFinishes"), messageKey: "app.shiftClickAnAreaToFillEnterFinishes" };
  if (state.tool === "tweener" && !builderMode?.active) {
    const type = tweenerControls?.button?.getAttribute("aria-label")?.replace(/ tweener$/, "") ?? interfaceText("app.breakdown");
    return { key: "tweener", icon: "tween", title: interfaceText("app.dragAcrossTheCanvas"), titleKey: "app.dragAcrossTheCanvas", message: interfaceText("app.toTweenShiftForPrecisionEscCancels", {type: type}), messageKey: "app.toTweenShiftForPrecisionEscCancels", messageParams: {type: type} };
  }
  return null;
}
/** The stage message while right-dragging a motion arc. */
function falloffModeMessage() {
  if (!state.motionPaths || !["select", "pose"].includes(state.tool) || builderMode?.active) return null;
  const falloff = editor.motionPathFalloff();
  if (!falloff) return null;
  return { key: "falloff", icon: "motion-path", title: interfaceText("app.reshapingFrames", {radius: falloff.radius}), titleKey: "app.reshapingFrames", titleParams: {radius: falloff.radius}, message: interfaceText("app.scrollToResizeEscCancels"), messageKey: "app.scrollToResizeEscCancels" };
}
function syncModeMessage() {
  stageHead.showMode(modeMessage() ?? falloffModeMessage());
}
/** The workspace chrome: the rail, the stage's context, and the band's session buttons. */
function syncShell() {
  studioShell?.sync();
  syncBandSession(document.querySelector(".titlebar"), bandSession());
  // A workspace change runs this directly (builder onModeChange), outside the invalidator: the stage header follows.
  syncStageHead();
}
// The stage: the engine draws every frame of the scene canvas (docs/engine/rendering.md).
const createRenderer = (surface, options) => createStage(surface, options);
// D19: the engine owns the document; the editor's calls run in the session its open started (docs/engine/editing.md).
installEngineOwner(editor);
// Playback is the engine's: it holds the document already, and a tick is a ticket for a frame it has ready.
const playback = createStagePlayback({stage: () => state.renderer});
// Who is hidden is part of each prepared frame, so the engine's frames observe the same
// inputs effectiveHidden() reads on the UI thread.
function playbackHiddenKey() {
  const layers = editor.report?._styk?.layers?.byId;
  const layerBits = layers ? Object.keys(layers).sort().map((id) => `${id}:${layers[id].visible === false ? 0 : 1}`).join(",") : "";
  return `${[...state.hidden].sort((a, b) => a - b).join(",")}|${layerBits}`;
}
function syncPlayback() {
  const hiddenUids = [...state.hidden], hiddenKey = playbackHiddenKey();
  if (
    state.playbackRevision !== editor.revision ||
    playback.report !== editor.report ||
    state.playbackHiddenKey !== hiddenKey
  ) {
    if (
      state.playbackRevision !== editor.revision ||
      playback.report !== editor.report
    )
      playback.load(editor.report, {revision: editor.revision, hiddenUids, hiddenKey});
    else playback.updateView({hiddenUids, hiddenKey});
    state.playbackRevision = editor.revision;
    state.playbackHiddenKey = hiddenKey;
    state.playbackPacket = null;
  }
}
function playbackRange() {
  if(state.motionPreviewRange)return state.motionPreviewRange;
  return normalizePlaybackRange(state.loopRange, editor.totalTicks);
}
function prepareAhead(start = editor.tick, count = 48, {bidirectional = false} = {}) {
  if (state.drag || state.scrubbing || !editor.totalTicks) return;
  syncPlayback();
  // Preparation shares the CPU with the UI thread: shallow lookahead keeps
  // few-core machines responsive while deep buffers still cover fast cores.
  const cores = navigator.hardwareConcurrency || 4;
  count = playbackLookaheadSize(count, cores);
  const range = playbackRange();
  // The engine admits the frames it prepares by their footprints.
  const ticks=playbackWindow(start,count,range,{loop:state.loop,bidirectional});
  return playback.prepareRange(ticks).catch((error) => {
    if (error.name !== "AbortError" && state.playing) {
      pause();
      fail(error);
    }
  });
}
let warmGeneration=0;
function warmPlayback({immediate = false} = {}) {
  const generation=++warmGeneration;
  clearTimeout(warmTimer);
  const report=editor.report,revision=editor.revision,tick=editor.tick;
  const current=()=>generation===warmGeneration&&editor.report===report&&editor.revision===revision&&editor.tick===tick&&!state.playing&&!editingGestureActive()&&!state.scrubbing&&!document.hidden;
  warmTimer = setTimeout(async () => {
    if(!current())return;
    // Learn the current frame's real footprint before widening the idle window.
    // User input owns the foreground; obsolete warm-up never chases the playhead.
    await prepareAhead(tick,2);
    if(current())await prepareAhead(tick,48,{bidirectional:true});
  }, immediate||playback.report!==report ? 0 : 150);
}
function previewScrub() {
  // Scrubbing is editing: render the current pose with selection and onions.
  requestRender();
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
    builderActive: Boolean(builderMode?.active),
  });
const usesBuilderBranch = (event) =>
  Boolean(
    editor.branchSelected ||
    event?.shiftKey ||
      ((isBuilderContext(state.tool) || builderMode?.active) &&
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
// During a builder session only bound-figure instances are selectable or
// editable; every other object behaves as locked for picking and commands.
const isLocked = (uid) =>
  state.locked.has(uid) || layerLocked(editor.report, uid) ||
  Boolean(builderMode?.boundUids && !builderMode.boundUids.has(uid));
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
  const trackUid = track.target?.uid ?? track.uid;
  if (builderMode?.active && trackUid !== undefined && !builderMode.boundUids.has(trackUid)) {
    toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo"), "app.finishTheFigureOrReturnToAnimateTo", {});
    return;
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
    figure_color: "color",
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
  } else if (figure[key] && editor.object && selection().size === 1 && !isMovieclip(editor.figure)) {
    // Scalar channels cannot reach presence-clocked movieclip objects: they are
    // stored inside movieclip patch frames, not the composed pose. The native
    // pose path edits them directly instead.
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
      : ["scale", "opacity", "gradientOpacity"].includes(
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
  return {value: value === undefined ? undefined : binding.toUI(value)};
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
function rangeFrames(enabled = state.applyRange) {
  if (!enabled) return undefined;
  if (editor.report._styk?.layerSheet) {
    if (timelineUI?.start !== undefined && timelineUI.start === timelineUI.end) return undefined;
    if (timelineUI?.selected?.size < 2) return undefined;
    const ticks = timelineUI?.selectedTicks ?? [];
    if (ticks.length < 2) return undefined;
    const indices = [editor.frameIndex];
    indices.sheetTicks = [...new Set([...ticks, editor.tick])];
    return indices;
  }
  if (editor.frameDraft?.mode === "add") return undefined;
  return state.rangeIndices.length > 1
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
function moveSelected(dx, dy, options) {
  if (rangeFrames())
    return editor.moveSelectionInFrames(dx, dy, rangeFrames(), options);
  return editor.moveSelection(dx, dy, options);
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
  return images.image(url);
}
const resources = { url: assetUrl, image: imageFor, drawing:figure=>drawingController?.resource(figure), drawingLoad:figure=>{if(!drawingMetadata(figure))return null;drawingController?.resource(figure);return editor?.drawingResources.surface(figure);} };
/**
 * The editor's activity: the last messages, newest first (Help › Performance shows them).
 * There is no status bar: what someone must see goes through toast() or fail(); slow work
 * (busy) shows a quiet task message if it is still running after a moment, until the next
 * status ends it. #status keeps the latest line for tests and the Performance report.
 */
const activityLog = [];
let activityTask = null;
/** Records a line of activity: #status, the log, and the slow-work message while `busy`. */
function logActivity(text, error = false, busy = false) {
  const messageKey = text?.messageKey, messageParams = text?.messageParams;
  text = messageKey ? interfaceText(messageKey, messageParams) : errorText(text);
  if (messageKey) localizedText($("status"), messageKey, messageParams);
  else setText($("status"), text);
  setAttr($("status-dot"), "class", `status-dot${error ? " error" : busy ? " busy" : ""}`);
  activityLog.unshift({ time: Date.now(), text: String(text), error: Boolean(error) });
  if (activityLog.length > 40) activityLog.length = 40;
  if (busy) {
    if (activityTask) activityTask.update({ title: text, titleKey: messageKey, titleParams: messageParams });
    else activityTask = toasts.task({ title: text, titleKey: messageKey, titleParams: messageParams, cancellable: false, delay: 400 });
  } else if (activityTask) {
    activityTask.done();
    activityTask = null;
  }
  return {message: text, messageKey, messageParams};
}
/** Activity; a problem (error) is also a warning in the message slot that goes after 8 seconds. */
function status(text, error = false, busy = false) {
  const message = logActivity(text, error, busy);
  if (error) toasts.show({ ...message, tone: "warning", timeout: 8000, dismissible: true });
}
/** A short message in the stage's message slot, above any open dialog. */
function toast(text, messageKey, messageParams = {}) {
  toasts.show({ message: text, messageKey, messageParams });
}
/** A result worth seeing (an import, a copy): the activity line and a short message. */
function notify(text, messageKey, messageParams = {}) {
  logActivity(messageKey ? {messageKey, messageParams} : text);
  toast(text, messageKey, messageParams);
}
/** Failed saves, exports and imports (see persistentFailure): their message stays until dismissed. */
const persistentFailures = new WeakSet();
/** Marks `error` as a failed save, export or import and returns it (for a rethrow). */
function persistentFailure(error) {
  if (error && typeof error === "object" && error.name !== "AbortError") persistentFailures.add(error);
  return error;
}
/** How long a routine failure (a command's precondition) stays: long enough to read, then it goes. */
const FAILURE_MESSAGE_MS = 8000;
/** Reports a failure: the status line, and a message (a UserActionError is a
 * timed warning, an AbortError says nothing). A failed save, export or import
 * stays until dismissed; any other error goes after 8 seconds. */
function fail(error) {
  telemetry.error(error);
  logActivity(error, true);
  toasts.fail(error, error instanceof UserActionError || persistentFailures.has(error) ? {} : { timeout: FAILURE_MESSAGE_MS, dismissible: true });
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
let pendingColorSample;
function sampleCanvasColor(clientX,clientY,signal,radius=0) {
  if(signal.aborted)return Promise.reject(messageError(new Error(''), "errors.app.colorSamplingCancelled", {}));
  pendingColorSample?.finish(messageError(new Error(''), "errors.app.colorSamplingSuperseded", {}));
  return new Promise((resolve,reject)=>{
    const finish=(error,color)=>{
      clearTimeout(timeout);signal.removeEventListener('abort',cancel);
      if(pendingColorSample?.finish===finish)pendingColorSample=null;
      if(error)reject(error);else resolve(color);
    };
    const cancel=()=>finish(messageError(new Error(''), "errors.app.colorSamplingCancelled", {}));
    const timeout=setTimeout(()=>finish(messageError(new Error(''), "errors.app.canvasIsNotReadyTryAgain", {})),2000);
    signal.addEventListener('abort',cancel,{once:true});
    pendingColorSample={clientX,clientY,finish,radius};
    requestRender();
  });
}
function requestRender() {
  state.dirtyRender = true;
  if (!raf) raf = requestAnimationFrame(loop);
}
function requestOverlayRender() {
  state.dirtyOverlay = true;
  if (!raf) raf = requestAnimationFrame(loop);
}
/** A camera monitor picture arrived: only the monitor is painted again, not the scene. */
function requestMonitorRender() {
  state.dirtyMonitor = true;
  if (!raf) raf = requestAnimationFrame(loop);
}
/** The frame on show; with `shot`, as the scene camera shoots it (the preview and playback always are). */
/** The pose a motion-path edit shows at the playhead while it changes it (the engine's session builds it), else null. */
function motionDisplay() { return editor._drag?.motionPath ? editor._drag.display : null; }
function currentFrame({ shot = state.playing || state.previewing } = {}) {
  // Playback already evaluated this exact tick in the worker. Overlays need
  // its camera/scene metadata, not another evaluation of all figures on input.
  const packet = state.playing && state.playbackPacket;
  const frame = motionDisplay()?.frame ?? (packet?.tick === editor.tick ? packet.frame : editor.evaluatedFrame || editor.frame);
  const seen = shot ? shotThrough(frame) : frame;
  return editor.report._styk?.layers?.fixed?.camera?.visible === false
    ? { ...seen, camera: null }
    : seen;
}
const shotFrames = new WeakMap();
/** A frame of the editor seen through the scene camera: shot with the camera the engine works out for the playhead (follow travel,
 * then the presets' shake) instead of the authored one. A playback frame already is. */
function shotThrough(frame) {
  if (frame.engine || !editor.report._styk?.cameraMotion?.clips.length) return frame;
  let shot = shotFrames.get(frame);
  if (!shot) shotFrames.set(frame, shot = { ...frame, camera: editor._shown?.shot() ?? frame.camera });
  return shot;
}
function previewPacket() {
  if (!state.previewing || state.scrubbing) return null;
  const packet = playback.has(editor.tick) ? playback.get(editor.tick) : null;
  return packet && packet.cameraEnabled !== false ? packet : null;
}
function screenPoint(p) {
  return worldToScreen(p,{report:editor.report,frame:currentFrame(),view:state.view,cameraEnabled:state.playing||state.previewing});
}
function worldPoint(event) {
  const r = viewport.getBoundingClientRect();
  return screenToWorld({x:(event.clientX-r.left)*viewport.clientWidth/r.width,y:(event.clientY-r.top)*viewport.clientHeight/r.height},{report:editor.report,frame:currentFrame(),view:state.view,cameraEnabled:state.playing||state.previewing});
}
function cameraSelected() {
  return state.inspectorContext === 'camera' && state.selectedTrackId === 'camera';
}
const trails = new MotionTrails(editor);
const PATH_COLORS = ['#0d99ff', '#e8590c', '#12b886', '#7048e8', '#e64980', '#f08c00', '#0ca678', '#1098ad'];
/** Every active trail: the camera, each selected figure, or every figure when
 * "all targets" is on — with limb tips per figure when that is chosen. Each
 * figure keeps one colour; the primary selection keeps the first (accent). All
 * trails sample together, one animation evaluation per display frame. */
function activeMotionPaths({sample = true} = {}) {
  if (!state.motionPaths || state.playing || state.previewing || builderMode?.active) return [];
  if (!["select", "pose"].includes(state.tool)) return [];
  const camera = cameraSelected() && state.settings.showCamera;
  const range = Math.round(state.settings.motionPathRange) || 0;
  let targets;
  if (camera) {
    const track = editor.report._styk?.layers?.fixed?.camera;
    targets = track?.visible !== false && !track?.locked ? [{kind: 'camera'}] : [];
  } else targets = motionPathTargets(editor, {all: Boolean(state.settings.motionPathAllTargets), joints: state.settings.motionPathJoints})
    .filter(target => !isHidden(target.uid) && !isLocked(target.uid));
  if (!targets.length) return [];
  const maxPoints = Math.min(1600, Math.floor(6400 / targets.length));
  const entries = sample
    ? trails.read(targets, {range, maxPoints})
    : targets.map(target => trails.peek(target));
  const colors = new Map(), out = [];
  let pending = false;
  targets.forEach((target, i) => {
    const entry = entries[i];
    if (!entry) return;
    pending ||= !entry.complete;
    const group = target.kind === 'camera' ? 'camera' : target.uid, lead = !colors.has(group);
    if (lead) colors.set(group, target.kind === 'camera' ? '#e8a13c' : PATH_COLORS[colors.size % PATH_COLORS.length]);
    const strong = target.kind === 'node' && target.uid === editor.selectedUid && target.joint === editor.selectedJoint;
    // A figure's first trail carries its frame numbers; its limb tips do not repeat them.
    out.push({target, entry, color: colors.get(group), strong, lead});
  });
  // Trail sampling continues across frames until every entry is complete.
  if (sample && pending) requestOverlayRender();
  return out;
}
/** Trail hit test in screen space against the trails' cached projections. */
function pickMotionPath(screen) {
  const project = affineProjection(screenPoint), relative = Boolean(state.settings.motionPathRelative);
  let best = null;
  for (const motionPath of activeMotionPaths({sample: false})) {
    const hit = pickMotionPathPoint(motionPath.entry, screen, {project, radius: 10, tick: editor.tick, relative});
    if (hit && (!best || hit.distance < best.hit.distance)) best = {hit, motionPath};
  }
  return best;
}
/** The saved influence used by secondary-button trail drags. */
function pathFalloff() {
  return {radius: state.settings.motionPathFalloffRadius, shape: state.settings.motionPathFalloffShape};
}
/** Resizing retargets the open reshape gesture. */
function syncPathFalloff() {
  if (state.drag?.kind === "motion-path" && state.drag.falloff) editor.setMotionPathFalloff(pathFalloff());
  syncPathTooltip();
  syncModeMessage();
  requestRender();
}
function nudgePathFalloff(step) {
  const current = state.settings.motionPathFalloffRadius;
  const radius = Math.max(1, Math.min(MOTION_PATH_FALLOFF_MAX, current + step));
  if (radius !== current) editorSettings.commit({ motionPathFalloffRadius: radius });
}
/** The canvas tooltip for the hovered trail point names both gestures. */
function syncPathTooltip() {
  const hover = state.hoverPathPoint;
  if (!hover) { clearTranslation(overlay, 'title'); overlay.title = ""; return; }
  const frame = {messageKey:hover.tick===editor.tick?'exportSheet.currentFrame':'filmstrip.card',messageParams:{frame:hover.tick+1}};
  localizedAttribute(overlay, "title", (editor.motionPathFalloff() ? 'app.frameDragToReshapeMotionpathfalloffradiusFramesOfTheArc' : 'app.frameDragToReposeValue1RightDragToReshape'), (editor.motionPathFalloff() ? {frame, motionPathFalloffRadius: state.settings.motionPathFalloffRadius} : {frame, value1: hover.tick === editor.tick ? "" : {messageKey:'app.withoutLeavingThisFrameDoubleClickToGo'}}));
}
/** Double-clicking a trail point goes to its frame. */
function seekMotionPathTick(tick) {
  pause();
  const rows = editor.timeline, index = rows.findIndex(row => row.start === tick);
  if (state.settings.timelineMode === "simple" && index >= 0) timelineUI.selectFrame(index);
  else editor.seek(tick);
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
  stageHead.setZoom(`${Number((v.scale * 100).toFixed(v.scale < 0.01 ? 2 : v.scale < 0.1 ? 1 : 0))}%`);
}
/** Timeline frames shown by the Simple (Pivot-style) timeline, or null in Advanced. */
function simpleFrameCount() {
  if (state.settings.timelineMode !== "simple") return null;
  return editor.report._styk?.layerSheet
    ? timelineUI?.frameCount ?? 0
    : editor.frameDraft?.storedCount ?? editor.report.keyframes.length;
}
/**
 * The view that fits the artboard inside #viewport (architecture §3.11.8): the
 * layout solver's stage insets are pure clearance, and nothing floats inside
 * #viewport (the stage header holds the view controls, zoom and Draw's quick
 * bar), so the artboard is never under chrome. Offsets land on whole pixels
 * (crisp artboard edges; whole-pixel pans keep exact offsets).
 */
function fittedView(r = editor.report) {
  const rect = viewport.getBoundingClientRect(),
    inset = shell?.stageInsets() ?? { top: 24, right: 28, bottom: 24, left: 28 },
    width = rect.width - inset.left - inset.right, height = rect.height - inset.top - inset.bottom,
    s = Math.max(0.01, Math.min(width / r.canvas_width, height / r.canvas_height, 2));
  return { scale: s, x: Math.round(inset.left + (width - r.canvas_width * s) / 2), y: Math.round(inset.top + (height - r.canvas_height * s) / 2) };
}
// A fitted view follows viewport size changes (panel toggles, Build figure's
// outliner, window resizes) until the user zooms or pans it.
let fittedSnapshot = null;
const isFittedView = (v = state.view) =>
  !!fittedSnapshot && !v.rotation && !v.flip &&
  v.scale === fittedSnapshot.scale &&
  Math.abs(v.x - fittedSnapshot.x) < 0.5 && Math.abs(v.y - fittedSnapshot.y) < 0.5;
function fit() {
  flushPoseMove();
  state.view = fittedView();
  fittedSnapshot = { ...state.view };
  placeArtboard();
  requestRender();
}
// Sustained playback deficits lower the preview backing resolution and MSAA;
// recovered headroom restores full quality. The overlay stays at native DPR so
// handles and tool feedback remain crisp.
function previewRenderScale() {
  return previewQualityLevels[state.previewGovernor?.index ?? 0];
}
let pendingPreviewQuality = null;
function applyPreviewQuality(index) {
  pendingPreviewQuality = index;
  requestRender();
}
function commitPreviewQuality() {
  if (pendingPreviewQuality === null) return;
  const index = pendingPreviewQuality;
  pendingPreviewQuality = null;
  resize();
  state.renderer?.setMsaa(previewMsaaLevels[index]);
}
function resetPreviewQuality() {
  const governor = state.previewGovernor;
  state.previewGovernor = { index: 0 };
  if (governor?.index) applyPreviewQuality(0);
}
function selectPlaybackQuality() {
  const index = playbackQualityIndex(state.settings.playbackQuality);
  const previous = state.previewGovernor?.index ?? 0;
  state.previewGovernor = {index};
  if (index !== previous) applyPreviewQuality(index);
}
function adaptPreviewQuality(sample, now) {
  if (state.settings.playbackQuality !== 'auto') return;
  const governor = (state.previewGovernor ??= { index: 0 });
  if (updatePreviewQuality(governor, sample, now, state.buffering)) applyPreviewQuality(governor.index);
}
function resize() {
  flushPoseMove();
  const r = viewport.getBoundingClientRect(),
    d = window.devicePixelRatio || 1;
  overlay.width = Math.round(r.width * d);
  overlay.height = Math.round(r.height * d);
  state.renderer?.resize(r.width, r.height, d * previewRenderScale());
  timelineUI?.resize();
  if (isFittedView()) {
    state.view = fittedView();
    fittedSnapshot = { ...state.view };
  }
  placeArtboard();
  requestRender();
}
function zoom(factor, point) {
  flushPoseMove();
  const r = viewport.getBoundingClientRect(),
    px = point?.x ?? r.width / 2,
    py = point?.y ?? r.height / 2,
    v = state.view,
    s = Math.min(100, Math.max(0.001, v.scale * factor)),
    k = s / v.scale;
  // Keep the view's other properties (drawing rotation and flip) when zooming.
  state.view = { ...v, x: px - (px - v.x) * k, y: py - (py - v.y) * k, scale: s };
  placeArtboard();
  requestRender();
}
const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const wheelZoom = createWheelZoom({
  getScale: () => state.view.scale,
  zoomBy: zoom,
  smooth: () => smoothWheelZoom(state.settings.smoothZoom, state.renderer?.stats?.backend),
  reducedMotion: () => Boolean(reducedMotionQuery?.matches),
  onSettled: requestRender,
});
let canvasPinch, panIdle = null;
function viewGestureActive() { return wheelZoom.interacting || panIdle !== null || canvasPinch?.active || drawingController?.touchNavigation?.active || drawingController?.gesture?.kind === 'pan' || ['zoom', 'pan'].includes(state.drag?.kind); }
// A pan ends once the view has been still for 100 ms, which paints full
// detail: wheel panning has no end event, and quick drag strokes stay one gesture.
function continuePan() { clearTimeout(panIdle); panIdle = setTimeout(() => { panIdle = null; requestRender(); }, 100); }
function fitSelection() {
  flushPoseMove();
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
// The engine measures this callback itself where it owns the document (engine-edit-bounds.mjs).
markAppBounds(boundsOf);
const boundsCache = new WeakMap();
function boundsOf(g) {
  // The engine measured a group of its geometry with it (drawlist::app_bounds).
  if (g.bounds) return g.bounds;
  let b = boundsCache.get(g);
  if (!b) {
    const items = [
        ...g.segments.map((s) => ({
          ...s,
          type: s.seg.segment_type || "line",
        })),
        ...g.polys,
        ...(g.meshDrawables ?? []),
      ],
      r = objectBounds(items, resources);
    b = { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height };
    boundsCache.set(g, b);
  }
  return b;
}
// Keep one surface alive to avoid deferred GPU-context destruction on input.
const canvasHandleOverlay = new CanvasHandleOverlay(new OffscreenCanvas(1, 1));
let handleCache = null;
const handleDescriptors = {};
const selectionHandleCache = new WeakMap();
const selectionHandleDescriptors = {};
function canvasHandles(geometry, {selectStatic = false} = {}) {
  const frame = currentFrame(),
    settings = state.settings;
  const key = [
    builderMode?.active ? [...editor.selectedSegmentIds].join(',') : '',
    editor.layerViewKey,
    showStaticHandles(),
    state.tool,
    state.figureJoin?.uid,
    state.handleEditHeld,
    usesBuilderBranch(),
    editor.selectedJoint,
    spatialControlMode(editor),
    rigDetailsShown(editor),
    settings.showUnselectedHandles,
    settings.handleSize,
    settings.autoSizeHandles,
    settings.outlineHandles,
    state.view.scale,
    frame.camera?.scale,
    builderMode?.session?.typeId ?? "none",
    ...selection(),
    ...state.hidden,
    ...state.locked,
  ].join("|");
  const cached = selectStatic ? selectionHandleCache.get(geometry) : handleCache;
  if (cached?.key === key && (selectStatic || cached.geometry === geometry)) return cached.handles;
  const bound = builderMode?.boundUids;
  const hidden = effectiveHidden(frame),
    locked = new Set(state.locked);
  for (const object of frame.objects)
    if (layerLocked(editor.report, object.unique_id) || (bound && !bound.has(object.unique_id)))
      locked.add(object.unique_id);
  const handles = getPivotHandles(geometry, {
    showDetailed: rigDetailsShown(editor),
    spatialMode: builderMode?.active || !['select','pose'].includes(state.tool) ? 'pose' : spatialControlMode(editor),
    descriptorCache: selectStatic ? selectionHandleDescriptors : handleDescriptors,
    selectStatic,
    joinTargetUids: state.figureJoin?.targets,
    frame,
    selectedUid: editor.selectedUid,
    selectedUids: selection(),
    hiddenUids: hidden,
    lockedUids: locked,
    showUnselected: settings.showUnselectedHandles,
    showStatic: showStaticHandles(),
    selectedJoint: editor.selectedJoint,
    selectedHandleIds: builderMode?.active ? editor.selectedSegmentIds : undefined,
    selectedBranch: usesBuilderBranch(),
    builder: isBuilderContext(state.tool),
    attaching: state.tool === "attach",
    allowStaticManipulation:
      state.tool === "rig" ||
      state.handleEditHeld,
    viewScale: state.view.scale,
    autoSize: settings.autoSizeHandles,
    maxDiameter: settings.handleSize * 2,
  });
  if (selectStatic) selectionHandleCache.set(geometry, {key, handles});
  else handleCache = { geometry, key, handles };
  return handles;
}
function drawCanvasHandles(geometry) {
  const handles = canvasHandles(geometry),
    translations = state.drag?.translations;
  const d = window.devicePixelRatio || 1;
  const key = [
    handleCache.key,
    state.view.x,
    state.view.y,
    state.view.rotation ?? 0,
    state.view.flip ?? false,
    editor.report.canvas_width,
    editor.report.canvas_height,
    currentFrame().camera?.x,
    currentFrame().camera?.y,
    currentFrame().camera?.angle_rad,
  ].join("|");
  canvasHandleOverlay.draw(ctx, handles, {project: screenPoint, projectionKey: key,
    width: overlay.width / d, height: overlay.height / d, dpr: d, translations,
    outline: state.settings.outlineHandles});
}
let onionControls;
const onionController = new OnionController({editor,
  getSettings: () => state.settings, getEnabled: () => state.onion,
  onCommit: patch => editorSettings.commit(patch),
  onToggle: () => actions["toggle-onion"](), onRender: () => requestRender(), onError: fail});
let pathControls;
let tweenerControls;
let canvasGuides;
// Motion path badges on the overlay draw text in the bundled UI font.
onFontsReady(requestRender);
/** The onion skins the engine draws behind the frame, or none when they are off or the animation plays. */
function onionSkins() {
  if (!state.onion || state.playing || state.previewing) return null;
  return editor._shown?.onions(onionController.request({selected: selection(), hidden: state.hidden})) ?? null;
}
/** What the open falloff gesture changes. */
function pathInfluence(tick, falloff) {
  return falloff ? {tick, radius: falloff.radius, shape: falloff.shape, changed: falloff.changed,
    edges: new Set(falloff.writes.filter(write => write.kind === 'edge').map(write => write.tick))} : null;
}
/** Trails, plus the pose at the hovered or dragged point when it is another
 * frame: the ghost shows what a drag will change without seeking. */
function drawMotionPaths() {
  const motionPaths = activeMotionPaths();
  if (!motionPaths.length) return;
  const project = affineProjection(screenPoint), relative = Boolean(state.settings.motionPathRelative);
  const dragPath = state.drag?.kind === "motion-path" ? state.drag : null;
  const focus = dragPath ?? state.hoverPathPoint;
  const bounds = {width: viewport.clientWidth, height: viewport.clientHeight};
  const falloff = editor.motionPathFalloff();
  let ghost = null;
  for (const motionPath of motionPaths) {
    const key = motionPathTargetKey(motionPath.target);
    if (focus?.key === key && focus.tick !== editor.tick) ghost = motionPath;
    const influence = focus?.key === key ? pathInfluence(focus.tick, dragPath ? falloff : null) : null;
    drawMotionPath(ctx, motionPath.entry, project, {
      tick: editor.tick, relative, bounds, strong: motionPath.strong, currentBadge: motionPath.lead,
      influence, badgeSuffix: influence ? `· ±${influence.radius}` : '',
      hover: state.hoverPathPoint?.key === key ? state.hoverPathPoint : null,
      dragging: dragPath?.key === key ? {tick: dragPath.tick} : null,
      color: motionPath.color,
      labels: Boolean(state.settings.motionPathLabels) && motionPath.lead,
      dots: state.settings.motionPathDots !== false,
      speed: Boolean(state.settings.motionPathSpeed),
      faint: motionPaths.length > 1 && focus && focus.key !== key,
    });
  }
  if (ghost) drawMotionPathGhost(ctx, trails.ghost(ghost.target, focus.tick), project,
    {color: ghost.color, entry: ghost.entry, relative, tick: editor.tick});
}
function overlayRender(geometry) {
  const d = window.devicePixelRatio || 1;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, overlay.width / d, overlay.height / d);
  if (state.playing || state.previewing) return;
  if (
    !editor.branchSelected && (isBuilderContext(state.tool) || builderMode?.active) && state.settings.builderHighlightSegment &&
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
  drawMotionPaths();
  if (state.handles || state.tool === 'attach') drawCanvasHandles(geometry);
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
          { camera: editor._shown?.frameCamera(editor.timeline[editor.frameIndex - 1].start) },
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
        outline: false,
        active:
          state.settings.showCamera &&
          editor.report._styk?.layers?.fixed?.camera?.locked !== true,
        guides: state.cameraGuides,
        hover: state.hoverCameraHandle,
        dragging: state.drag?.kind === 'camera' ? state.drag.handle : null,
      },
    );
  }
  const transform = state.drag?.kind === 'figure-transform' && editor._drag?.figureHandle?.transform;
  if (transform) {
    const pivot = screenPoint(transform.origin), pointer = screenPoint(state.drag.current ?? state.drag.start);
    ctx.save();
    ctx.strokeStyle = '#e79b27'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pivot.x, pivot.y); ctx.lineTo(pointer.x, pointer.y); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 2; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(pivot.x, pivot.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pivot.x - 10, pivot.y); ctx.lineTo(pivot.x + 10, pivot.y);
    ctx.moveTo(pivot.x, pivot.y - 10); ctx.lineTo(pivot.x, pivot.y + 10); ctx.stroke();
    ctx.restore();
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
    drawDuplicatePreview(ctx,pending.preview,point,state.view.scale);
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = target ? "#0d99ff" : "#888";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  construction?.draw(ctx);
  if (state.handles) drawConnectorGuides(ctx,geometry,editor,screenPoint);
  if (state.handles && builderMode?.active) drawRigGuides(ctx,geometry,editor,screenPoint);
  if(state.handles&&!builderMode?.active)drawSpatialGizmo(ctx,editor,screenPoint);
  if(builderMode?.active) {
    const g=editor.geometry.objects.get(editor.selectedSlot);
    if(editor.selectedPolygonIndex>=0)drawFillHighlight(ctx,g?.polys.find(p=>p.index===editor.selectedPolygonIndex)?.points,screenPoint);
    if(state.tool==='polygon'&&state.builderShiftHeld)drawFillHighlight(ctx,state.bucketPreview?.points,screenPoint,{preview:true});
  }
  if (state.drag?.kind === "draw") {
    const p = screenPoint(state.drag.start),
      q = screenPoint(state.drag.current || state.drag.start);
    ctx.save();
    setBuilderStroke(ctx, state.drag.appearance, state.view.scale);
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
    ctx.restore();
  }
}
/** Thumbnails wait while the interface is busy: a gesture, a scrub or playback. */
function syncBackgroundInteraction(viewChanging) {
  const interacting=Boolean(viewChanging||editingGestureActive()||state.scrubbing||document.hidden);
  thumbnailRenderer?.setPaused(interacting||state.playing);
}
function loop(now) {
  flushPoseMove();
  canvasGuides?.render();
  raf = 0;
  wheelZoom.advance(now);
  // Resizing clears the backing surface. Commit at the start of a paint task,
  // before drawing, never after publishing that task's completed frame.
  commitPreviewQuality();
  if (state.playing) syncPlayback();
  const viewChanging=!state.playing&&!state.previewing&&Boolean(viewGestureActive());
  syncBackgroundInteraction(viewChanging);
  let advancedPlayback = false;
  if (!$("renderer-error").hidden) return;
  if (state.playing) {
    const fps = editor.report.frame_delay_ms
        ? 1000 / editor.report.frame_delay_ms
        : editor.report.fps,
      range = playbackRange(),
      interval = 1000 / fps;
    if(telemetry.consent.diagnostics&&telemetry.isForeground)playbackCadence.observe(now);else playbackCadence.reset();
    playbackMetrics.targetFps = fps;
    if (range.end <= range.start) {
      pause();
    } else if (state.audioReady !== false && !audioEngine.starting && (!playStarted || now >= playDeadline) &&
      (!audioEngine.running || audioEngine.position + .00001 >= (editor.tick + 1) / fps)) {
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
        if (!playStarted) playStartupFrames = Math.max(playStartupFrames, playbackStartupWindow(fps,
          Math.max(playback.stats.lastCompileMs, playback.stats.compileMs / Math.max(1, playback.stats.preparedFrames)), navigator.hardwareConcurrency || 4));
        const startupReady=playStarted || playback.bufferedAhead(next,playStartupFrames,range.end);
        if (packet && startupReady) {
          if (audioEngine.hasAudio && (!audioEngine.running || next < editor.tick || audioEngine.position > (next + 1.5) / fps))
            void audioEngine.start(next / fps, range.end / fps);
          editor.seek(next, { evaluate: false });
          state.playbackPacket = packet;
          advancedPlayback = true;
          presentationDeadline = playStarted ? playDeadline : null;
          playDeadline =
            !playStarted || state.buffering
              ? now + interval
              : Math.max(playDeadline + interval, now);
          playStarted = true;
          if (state.buffering) {
            state.buffering = false;
            status({messageKey: "app.playing", messageParams: {}});
            localizedText($("preview-badge"), "app.playing2", {});
          }
          prepareAhead(next + 1, 48);
          state.dirtyRender = true;
        } else {
          audioEngine.stop();
          state.buffering = true;
          localizedText($("preview-badge"), "app.preparing", {});
          prepareAhead(next, 48);
        }
      }
    }
  }
  const scenePainted = Boolean(state.dirtyRender && state.renderer);
  if (scenePainted) {
    state.dirtyRender = false;
    state.dirtyOverlay = false;
    const start = performance.now();
    const sampled=telemetry.isForeground&&telemetry.performance.sampleFrame(),stages=sampled?{}:null;
    state.renderer.measureFrame=sampled;state.renderer.telemetryStages=null;
    let stageStarted=sampled?performance.now():0;
    const packet = state.playing ? state.playbackPacket : previewPacket();
    let preparedPresented = false;
    if (packet && (packet.cameraEnabled ?? true) === !state.scrubbing) {
      // A frame the engine no longer has ready continues into the live render below
      // instead of showing a frozen frame.
      preparedPresented = state.renderer.renderPrepared(packet.key, {view: state.view, cameraEnabled: !state.scrubbing}) === true;
      if (advancedPlayback && preparedPresented)
        recordPlaybackPresentation();
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
    if (!preparedPresented && (!state.playing || !state.buffering)) {
      const drawingPreview=drawingController?.renderPreview;
      const frame = drawingPreview?.frame??currentFrame(),
        geometry =
          drawingPreview?.geometry ||
          motionDisplay()?.geometry ||
          state.drag?.geometry ||
          keyboardHandleGesture?.geometry ||
          editor.geometry;
      state.renderer.render({
        vfxEnabled: state.vfxEnabled,
        report: drawingPreview?.report??editor.report,
        documentReport: editor.report,
        frame,
        geometry,
        // The engine draws the frame its session shows; the interface's own frame (a drawing's first stroke) crosses as poses.
        source: drawingPreview ? null : editor._shown?.source(Boolean(motionDisplay())) ?? null,
        view: state.view,
        cameraEnabled: state.playing || state.previewing,
        editorBackgroundColor: builderBackgroundColor(state.settings, state),
        revision: editor.revision,
        artworkRevision: editor.definitionRevision,
        onions: onionSkins(),
        hiddenUids: effectiveHidden(),
        clipToCanvas: false,
        dragTranslations: state.drag?.translations,
      });
      // This paint can start or cancel the last capture. Reconcile both
      // directions before yielding; cancellation may leave no further RAF.
      syncBackgroundInteraction(viewChanging);
      state.lastEditingPresentation = {tick:editor.tick,revision:editor.revision,at:performance.now(),
        sequence:(state.lastEditingPresentation?.sequence ?? 0)+1};
      if (advancedPlayback) recordPlaybackPresentation();
      overlayRender(geometry);
      drawingController?.overlayDraw(ctx);
      setHidden($('preview-quality'), !(images.reduced || state.previewGovernor?.index));
    }
    if(pendingColorSample && (!state.playing || !state.buffering || preparedPresented)){
      const sample=pendingColorSample;
      try{
        const result=sampleCanvasRegion(state.renderer.canvas,sample.clientX,sample.clientY,sample.radius);
        sample.finish(null,sample.radius?result:result.color);
      }catch(error){sample.finish(error);}
      requestRender(); // Restore GPU handles after sampling the artwork before presentation.
    }
    // A project's picture is read here too: the canvas holds this frame only until it is presented.
    if(pendingProjectPicture && !state.playing){
      const request=pendingProjectPicture,pending=stagePicture();
      if(pending)void pending.then(bitmap=>{if(bitmap)projectTabsView.setPicture(request.id,bitmap);});
      request.finish(Boolean(pending));
      requestRender(); // The joints left out of the picture come back.
    }
    if(sampled){stages.scene=performance.now()-stageStarted;stageStarted=performance.now();Object.assign(stages,state.renderer.telemetryStages);}
    // Final editor overlay pass: keep the actual camera above artwork and tool feedback.
    drawFinalOverlay();
    if(sampled){stages.overlay=performance.now()-stageStarted;stageStarted=performance.now();}
    state.dirtyMonitor = false;
    paintCameraMonitor();
    const elapsed = performance.now() - start;
    if(sampled)stages.camera=performance.now()-stageStarted;
    if(telemetry.isForeground)telemetry.performance.frame(elapsed,stages||{},sampled);
    state.renderSamples.push(elapsed);
    if (telemetry.consent.diagnostics && state.drawCalls % 30 === 0) {
      telemetry.timing('frame_ms', elapsed);
      if (elapsed > 33) telemetry.count('slow_frames');
    }
    if (state.renderSamples.length > 300) state.renderSamples.shift();
    state.lastPresent = elapsed;
    state.drawCalls++;
    if (now - lastUI > 200) {
      ui.update("transport");
      localizedText($("render-time"), "app.ms", {value:{format:'number',value:elapsed,options:{minimumFractionDigits:1,maximumFractionDigits:1}}});
      if (state.renderer.stats?.backend === "WebGPU device lost") localizedText($("renderer-label"), "rendererStatus.deviceLost");
      else setText($("renderer-label"), state.renderer.stats?.backend || "WebGPU");
      lastUI = now;
    }
  }
  // Hover, previews and path sampling change only tool feedback. Keep the
  // displayed artwork intact; document edits still request a scene render.
  if (state.dirtyOverlay && !scenePainted) {
    state.dirtyOverlay = false;
    if (!state.playing && !state.previewing) {
      overlayRender(drawingController?.renderPreview?.geometry ?? motionDisplay()?.geometry ??
        state.drag?.geometry ?? keyboardHandleGesture?.geometry ?? editor.geometry);
      drawingController?.overlayDraw(ctx);
      drawFinalOverlay();
    }
  }
  if (state.playing) {
    const measuredAt = performance.now();
    playbackMetrics.buffering(state.buffering, measuredAt);
    if (measuredAt - lastFpsUI >= 250) {
      const sample = playbackMetrics.snapshot(measuredAt), badge = $("playback-fps");
      localizedText(badge, (sample.fps === null ? 'app.fps' : 'app.valueFps'), (sample.fps === null ? {} : {value: sample.fps.toFixed(1)}));
      setAttr(badge, "data-health", sample.coherent === null ? "pending" : sample.coherent ? "good" : "low");
      setAttr(badge, "title", interfaceText('app.sceneTargetValueFps', {value: sample.targetFps.toFixed(1)}));
      setHidden($('preview-quality'), !state.previewGovernor?.index);
      adaptPreviewQuality(sample, measuredAt);
      lastFpsUI = measuredAt;
    }
  }
  if (state.dirtyMonitor) {
    state.dirtyMonitor = false;
    paintCameraMonitor();
  }
  // A wheel zoom still gliding has more of the view to draw.
  if (wheelZoom.active) state.dirtyRender = true;
  // A seek/edit event can request the next frame while this callback runs.
  // Keep that request instead of starting a second animation loop.
  if (!raf && (state.playing || state.dirtyRender || state.dirtyOverlay || state.dirtyMonitor)) raf = requestAnimationFrame(loop);
}
/** The camera inspector's readouts and monitor, for the frame on show. */
function paintCameraMonitor() {
  if (state.inspectorContext !== 'camera') return;
  const frame = currentFrame();
  syncCameraControls($('inspector'), frame, {activeKey:propertyControls?.activeKey,guides:state.cameraGuides});
  drawCameraMonitor($('inspector').querySelector('[data-camera-monitor]'), {
    onError:error=>telemetry.error(error,'renderer'),onInvalidate:requestRender,onRecovery:(kind,outcome)=>telemetry.performance.recovery(kind,outcome),
    stage:state.renderer,report:editor.report,frame,
  });
}
function drawFinalOverlay() {
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  drawCameraOutline(ctx, cameraViewport(editor.report, currentFrame(), state.view), screenPoint);
  vfxGizmos?.draw(ctx);
}
async function play() {
  if(!state.playing){try{await drawingController?.barrier();}catch(error){fail(error);return;}}
  if (!$("renderer-error").hidden) return;
  if (state.playing) return pause();
  if ([...exportJobs].some(job => job.raster)) return notify(interfaceText("app.finishOrCancelTheExportBeforePlaying"), "app.finishOrCancelTheExportBeforePlaying", {});
  state.previewing = false;
  if (editor.totalTicks < 1) return;
  cancelDrag();
  // Optionally fit once on transport start; subsequent zoom and pan remain user-controlled.
  if (state.settings.fitViewOnPlayback) fit();
  selectPlaybackQuality();
  const range = playbackRange();
  playTick =
    editor.tick >= range.end - 1 || editor.tick < range.start
      ? range.start
      : editor.tick;
  playStart = performance.now();
  playbackCadence.reset();presentationDeadline=null;
  telemetry.count('playback_started');
  playbackMetrics.reset(playStart, editor.report.frame_delay_ms
    ? 1000 / editor.report.frame_delay_ms : editor.report.fps);
  telemetry.playbackStart(telemetry.consent.diagnostics ? workload({ report: editor.report, fps: playbackMetrics.targetFps }) : {});
  lastFpsUI = playStart;
  localizedText($("playback-fps"), "app.fps", {});
  setAttr($("playback-fps"), "data-health", "pending");
  setHidden($("playback-fps"), false);
  playStarted = false;
  playStartupFrames = 2;
  playDeadline = playStart;
  state.playbackPacket = null;
  // A changed density is committed with its repaint at the next animation task.
  // Avoid queuing obsolete full-size packets just before that transaction.
  if (pendingPreviewQuality === null) prepareAhead(playTick, 48);
  state.playing = true;
  audioScrubController?.abort();
  audioEngine.stop(); audioEngine.hasAudio = false;
  state.audioReady = !audibleClips(audioState(editor.report)).length;
  if (!state.audioReady) {
    audioPreparation?.abort(); const controller = audioPreparation = new AbortController();
    state.buffering = true;
    void audioEngine.unlock().then(() => audioEngine.prepare(editor.report, {start: range.start / audioFps(editor.report), end: range.end / audioFps(editor.report), signal: controller.signal}))
      .then(() => { if (!controller.signal.aborted) { state.audioReady = true; requestRender(); } })
      .catch(error => { if (!controller.signal.aborted) { pause(); fail(error); } });
  }
  thumbnailRenderer?.setPaused(true);
  timelineUI?.setPaused?.(true);
  setHidden($("preview-badge"), false);
  timelineHost?.syncPlayButton();
  requestRender();
}
function pause() {
  state.motionPreviewRange=null;
  if(state.playing)telemetry.performance.resources('stopped');
  audioPreparation?.abort(); audioScrubController?.abort(); audioEngine.stop(); state.audioReady = true;
  const wasPlaying = state.playing || state.previewing;
  if (state.playing) {
    playbackMetrics.stop(performance.now());
    const summary = playbackMetrics.snapshot(performance.now());
    telemetry.count('playback_frames', summary.totalFrames);
    telemetry.count('playback_seconds', Math.round(summary.elapsedMs / 1000));
    telemetry.count('playback_buffering', summary.bufferingEvents);
    telemetry.timing('playback_startup_ms', summary.startupMs);
    telemetry.timing('playback_buffering_ms', summary.bufferingMs);
    telemetry.playbackStop();
  }
  setHidden($("playback-fps"), true);
  setHidden($('preview-quality'), true);
  state.playing = false;
  state.previewing = false;
  resetPreviewQuality();
  editor.endFrameDraftPreview();
  thumbnailRenderer?.setPaused(document.hidden);
  timelineUI?.setPaused?.(document.hidden);
  state.buffering = false;
  state.playbackPacket = null;
  setHidden($("preview-badge"), true);
  timelineHost?.syncPlayButton();
  requestRender();
  if (wasPlaying) {
    reconcileSelectedSegmentTrack();
    queueUI();
    status({messageKey: "app.ready", messageParams: {}});
  }
}
function previewFrame() {
  pause();
  cancelDrag();
  state.previewing = true;
  localizedText($("preview-badge"), "app.preview", {});
  setHidden($("preview-badge"), false);
  timelineHost?.syncPlayButton();
  requestRender();
}
// What updateTitle last wrote: the title surface runs in every pass (playback too), so it writes only what changed.
let shownTitle = { name: null, dirty: null, revision: null, words: null };
// A save in progress, and the last save of this document ("Saved 12:04", formatted once when it lands).
let savingDocument = false, lastSave = null;
/** The document's state in the band (experience.md §2): Saving…, Edited, Saved 12:04 after a save, else Saved. */
function saveStateMessage(dirty) {
  if (savingDocument) return {key: 'app.saving'};
  if (dirty) return {key: 'app.edited'};
  return lastSave && lastSave.report === editor.report ? {key: 'app.savedAt', params: {time: {format: 'date', value: lastSave.time, options: {hour: 'numeric', minute: '2-digit'}}}} : {key: 'app.saved'};
}
function updateTitle() {
  const name = editor.name || "Untitled", dirty = editor.dirty, message = saveStateMessage(dirty), words = interfaceText(message.key, message.params);
  // The tab of the project in front shows its name and state (shell/project-tabs-view.mjs); the list changes only when they do.
  projects.sync({name, dirty, saved: savingDocument ? "saving" : dirty ? null : lastSave && lastSave.report === editor.report ? lastSave.time : null});
  const published = documentStateNow(), revision = published.revision;
  if (name === shownTitle.name && dirty === shownTitle.dirty && revision === shownTitle.revision && words === shownTitle.words) return;
  if (name !== shownTitle.name || dirty !== shownTitle.dirty || words !== shownTitle.words)
    localizedText(document.querySelector("title"), "app.stykanimate", {value: dirty ? "• " : "", name: name});
  const documentChanged = name !== shownTitle.name || dirty !== shownTitle.dirty || revision !== shownTitle.revision;
  shownTitle = { name, dirty, revision, words };
  if (documentChanged) desktop?.setDocumentState?.(published);
}
/** Auto key belongs to the Advanced timeline: edits on held frames key the playhead instead of the preceding key. */
function syncAutoKey() {
  editor.autoKey = Boolean(state.settings.autoKey) && state.settings.timelineMode !== "simple";
  for (const button of document.querySelectorAll('[data-action="toggle-auto-key"]')) button.setAttribute("aria-pressed", String(editor.autoKey));
  $("timeline")?.closest(".timeline-panel")?.classList.toggle("auto-keying", editor.autoKey);
}
function syncSelectionControls() {
  timelineHost.syncRangeEdit();
  touchModifiers?.sync();
  if (state.tool === 'select' && !builderMode?.active && !drawingController?.active)
    localizedText($('viewport-hint'), editor.object?.join ? 'app.joinedDragHint' : 'app.dragToSelectCtrlShiftClickToToggle');
}
/** Every chrome surface now (startup, a restored document); queueUI() marks them for the next frame instead. */
function updateUI() {
  ui.flushAll();
}
/** The scene's size and the figure count. (#selection-summary is the shell's: studio-shell writes the scope there.) */
function updateStatus() {
  localizedText($("object-count"), 'counts.figures', {count: editor.frame.objects.length});
}
function renderLayers() {
  if ($("layer-count"))
    $("layer-count").textContent =
      editor.layers?.filter((layer) => !["scene", "camera"].includes(layer.id))
        .length || 1;
  timelineUI?.selectTrack?.(state.selectedTrackId, {reveal: false});
}
function renderAssets() {
  const figures = editor.report.figure_types;
  assetLibrary?.setVisible(state.activeTab === "assets");
  assetLibrary?.update(figures, { selectedId: editor.object?.figure_type_id });
  setMarkup($("sample-list"), `<button class="sample-item" data-action="rig-examples"><span data-i18n="app.rigExamples">${messageHTML("app.rigExamples", {})}</span></button>` + (state.samples.length
    ? state.samples
        .map(
          (s) =>
            `<button class="sample-item" data-sample="${esc(s.path)}">${icon(s.kind === "stk" ? "person" : "file")}<span>${esc(s.name)}</span><small>${esc(s.kind?.toUpperCase() || interfaceText("app.piv"))}</small></button>`,
        )
        .join("")
    : `<p class="property-note" style="padding:0 15px" data-i18n="app.openStykanimatePivotOrStickNodesProjectsFigures">${messageHTML("app.openStykanimatePivotOrStickNodesProjectsFigures", {})}</p>`));
}
function renderInspector() {
  vfxInspector?.sync();
  renderProperties();
}
/** The Properties panel: the inspector's sections for the current context (not while a property or gesture is live). */
function renderProperties() {
  if (cameraMotionControls?.active || propertyControls?.active || (state.drag && state.drag.kind !== "pan"))
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
  const range = rangeFrames(true);
  updateInspectorDOM($("inspector"), inspectorView({
    editor,
    tab: state.inspectorTab,
    drawing: drawingController,
    hotkeyLabel:id=>hotkeys.label(id),
    context: editor.branchSelected ? "figure" : state.inspectorContext,
    propertyState,
    tool: editor.branchSelected ? "rig" : state.tool,
    rigMode: state.rigMode,
    builderBranch: usesBuilderBranch(),
    builder: Boolean(builderMode?.active),
    selectionCount: editor.branchSelected ? 1 : selection().size,
    bounds: selection().size > 1 ? selectionBounds() : null,
    rangeIndices: range?.sheetTicks ?? range ?? [],
    applyRange: state.applyRange,
    polygonPage: state.polygonPage || 0,
    palettePage: state.palettePage || 0,
  }), {preserveDisclosure});
  drawingController?.active && drawingController.paintPreview($("inspector"));
  cameraMotionControls?.sync();
  refreshHotkeyHints(hotkeys, $('inspector'));
  if (state.polygon) {
    for (const input of $("inspector").querySelectorAll(
      "input,select,textarea,button",
    )) {
      input.disabled = true;
      localizedAttribute(input, "title", "app.finishOrCancelThePolygonFirst", {});
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

let construction;
function setTool(tool) {
  if(drawingController?.active){const name=tool==='hand'?'pan':tool==='select'?'transform':tool.replace('drawing-','');if(['brush','eraser','fill','lasso','shape','transform','pan'].includes(name))return drawingController.setTool(name);return;}

  if (tool !== 'attach') state.figureJoin = null;
  if (state.tool !== tool) construction?.cancel();
  if (tool !== state.tool && ['rig', 'line', 'chain', 'circle', 'polygon'].includes(tool)) telemetry.count('builder');
  if (!builderMode?.active && isMovieclip(editor.figure) && ['rig','line','chain','circle','polygon'].includes(tool)) {
    editor.enterMovieclip();
  }
  // Choosing a construction tool outside the builder opens a bounded session —
  // on the selected figure when one is bound, or a new figure otherwise.
  if (!builderMode?.active && ['rig', 'line', 'chain', 'circle', 'polygon'].includes(tool)) builderMode?.enter();
  if (tool === "polygon" && state.tool === "polygon" && state.polygon) {
    finishPolygon();
    return;
  }
  if (state.drag) cancelDrag();
  if (state.tool !== tool) {
    state.bucketPreview = null;
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
    ["line", "chain", "circle", "polygon"].includes(tool),
  );
  $("viewport-hint").textContent = {
    select: interfaceText("app.dragToSelectCtrlShiftClickToToggle"),
    pose: interfaceText("app.dragToPoseCtrlDragToStretchShift"),
    rig: interfaceText("app.editFigureJointsChangesUpdateEveryInstance"),
    hand: state.settings.canvasZoomGesture === 'scroll'
      ? interfaceText("app.dragToPanScrollToZoom")
      : interfaceText("app.dragOrScrollToPanCtrlScrollTo"),
    chain: interfaceText("app.clickToExtendEnterToFinishBackspaceTo"),
    line: interfaceText("app.dragAnywhereToDrawStartOnAJoint"),
    circle: interfaceText("app.dragAnywhereToDrawStartOnAJoint"),
    polygon:
      interfaceText("app.clickJointsToTraceShiftClickAnEnclosed"),
    attach: interfaceText("app.clickTheParentJointEscToCancel"),
    tweener: interfaceText("app.dragHorizontallyToTweenShiftForPrecisionEsc"),
  }[tool];
  if (["rig", "line", "chain", "circle", "polygon"].includes(tool)) {
    state.inspectorTab = "design";
    state.inspectorContext = editor.object ? "figure" : "scene";
  }
  document
    .querySelectorAll("[data-inspector]")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.inspector === state.inspectorTab),
    );
  renderInspector();
  tweenerControls?.sync();
  syncModeMessage();
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
  localizedText($("polygon-count"), "app.joints", {length: state.polygon.handles.length});
  $("finish-polygon").disabled = state.polygon.handles.length < 3;
  requestRender();
}
function polygonClick(p, event = {}) {
  if (event.shiftKey && builderMode?.active) {
    const g=editor.geometry.objects.get(editor.selectedSlot),existing=pickFigureFill(g,p);
    if(existing){cancelPolygonDraft();editor.selectPolygon(editor.selectedUid,existing.index);return;}
    const region=bucketRegion(g,p);
    if(!region)return toast(interfaceText("app.noClosedRegionHereCloseTheOutlineAt"), "app.noClosedRegionHereCloseTheOutlineAt", {});
    cancelPolygonDraft();
    const polygon=editor.addPolygon(region.ids,{color:g.segments[editor.selectedJoint]?.rgb??g.segments[0]?.rgb??[43,43,43]});
    editor.selectPolygon(editor.selectedUid,editor.figure.polyfills.findIndex(item=>item.polyfill_id===polygon.polyfill_id));
    state.bucketPreview=null;status({messageKey: "app.fillAdded", messageParams: {}});return;
  }
  if (!state.polygon && builderMode?.active && !pick(p)) {
    const fill=pickFigureFill(editor.geometry.objects.get(editor.selectedSlot),p);
    if(fill){editor.selectPolygon(editor.selectedUid,fill.index);return;}
  }
  let g = state.polygon
    ? [...editor.geometry.objects.values()].find(
        (g) => g.obj.unique_id === state.polygon.uid,
      )
    : pick(p)?.g;
  if (!g) {
    toast(interfaceText("app.chooseAFigureJointToBeginAPolygon"), "app.chooseAFigureJointToBeginAPolygon", {});
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
    toast(interfaceText("app.polygonsAttachToJointsClickARedOrange"), "app.polygonsAttachToJointsClickARedOrange", {});
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
  appendLocalized(state.polygon.draft, closest[0], {
    chain: Boolean(event.ctrlKey || event.metaKey),
  });
  refreshPolygonDraft();
  if (state.polygon.draft.complete) finishPolygon();
}
function finishPolygon() {
  if (!state.polygon || state.polygon.handles.length < 3) {
    toast(interfaceText("app.chooseAtLeastThreeDifferentJoints"), "app.chooseAtLeastThreeDifferentJoints", {});
    return;
  }
  const draft = state.polygon;
  editor.select(draft.uid);
  editor.addPolygon(draft.handles, { color: [43, 43, 43] });
  state.polygon = null;
  $("polygon-controls").hidden = true;
  setTool("select");
  status({messageKey: "app.polygonAdded", messageParams: {}});
}
// A click on artwork asks the engine which figure the stage's frame paints at the point (engine-stage.mjs `pickArtwork`).
function pickedArtwork(p, geometry) {
  const hidden = [], locked = [];
  for (const object of editor.evaluatedFrame.objects) {
    if (isHidden(object.unique_id)) hidden.push(object.unique_id);
    if (isLocked(object.unique_id)) locked.push(object.unique_id);
  }
  const hit = state.renderer.pickArtwork?.(p, {scale: state.view.scale, hiddenUids: hidden, lockedUids: locked});
  const g = hit && geometry.objects.get(hit.slot);
  return g ? {g, uid: hit.uid, joint: -1, id: 0, kind: 'body', point: g.root, action: 'select'} : null;
}
function pick(p, {preferSelected = false, artwork = false} = {}) {
  const geometry = editor.geometry;
  const body = () => {
    if (!artwork || builderMode?.active || !['select','pose','tweener'].includes(state.tool) || state.handleEditHeld) return null;
    const hit = pickedArtwork(p, geometry);
    return (state.handles && state.tool !== 'tweener' && pickCanvasSegment(geometry, p,
      {handles: canvasHandles(geometry), uid: hit?.uid, scale: state.view.scale})) || hit;
  };
  if (!state.handles) return body();
  const options = {
    project: screenPoint,
    projectionScale: !state.playing&&!state.previewing?state.view.scale:undefined,
    minRadius: 8,
    nearest: true,
    preferredUid: preferSelected ? editor.selectedUid : undefined,
  };
  const hit = pickCanvasHandle(geometry, p, {...options, handles: canvasHandles(geometry)});
  // Visible handles keep priority. Hidden static endpoints are selection-only
  // fallback targets, prepared lazily on clicks, never on pointer hover.
  if (hit || builderMode?.active || !['select', 'pose', 'tweener'].includes(state.tool)) return hit;
  return pickCanvasHandle(geometry, p, {...options, handles: canvasHandles(geometry, {selectStatic: true})})
    ?? body();
}
overlay.addEventListener(
  "pointerdown",
  guarded((e) => {
    if (!$("renderer-error").hidden || !e.isPrimary) return;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    if (state.drag?.kind === 'tweener' && e.button === 2) {
      e.preventDefault();state.suppressContext = true;cancelDrag();return;
    }
    // A stationary right press opens actions; dragging bends the joint under
    // the pointer. Shift keeps the original immediate bend gesture.
    if (e.button === 2) state.suppressContext = e.shiftKey;
    if (state.previewing) {
      pause();
      return;
    }
    finishKeyboardHandle();
    interruptRecovery();
    toasts.clear({ tones: ["info"] });
    pause();
    viewport.focus({ preventScroll: true });
    overlay.setPointerCapture(e.pointerId);
    canvasPointerId = e.pointerId;
    // Where the press began, and how far a pen may wobble before it drags.
    state.press = { x: e.clientX, y: e.clientY, slop: dragSlop(e) };
    // Wheel-free navigation for tablets: Ctrl+Space drag zooms around the
    // press (drag right or up to zoom in); Shift+Space drag rotates the Draw view.
    if (state.spaceHeld && e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey && drawingController?.active)) {
      const r = viewport.getBoundingClientRect(), rotate = !(e.ctrlKey || e.metaKey), report = editor.report;
      const center = { x: r.left + state.view.x + report.canvas_width * state.view.scale / 2, y: r.top + state.view.y + report.canvas_height * state.view.scale / 2 };
      state.spacePanned = true;
      state.drag = rotate
        ? { kind: "rotate", center, angle: Math.atan2(e.clientY - center.y, e.clientX - center.x), rotation: state.view.rotation ?? 0 }
        : { kind: "zoom", x: e.clientX, y: e.clientY, scale: state.view.scale, anchor: { x: e.clientX - r.left, y: e.clientY - r.top } };
      viewport.classList.add("dragging");
      return;
    }
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
    // Bending is available while creating parts too, without changing tools.
    if (e.button === 2 && builderMode?.active) {
      const hit = pick(p);
      if (hit?.joint >= 0) {
        state.drag = {kind: "maybe-bend", hit, start: p, clientX: e.clientX, clientY: e.clientY};
        return;
      }
    }
    if(e.button===0&&state.handles&&!builderMode?.active&&['select','pose'].includes(state.tool)){
      const spatial=spatialGizmoDrag(editor,screenPoint(p),screenPoint);
      if(spatial){if(!editor.beginDrag('Rotate articulated joint'))return;state.drag={kind:'spatial',spatial};viewport.classList.add('dragging');return;}
    }
    // Joint editing tools turn a right drag into a bend; everywhere else a right
    // press stays a plain click that opens the context menu on release.
    if (e.button === 2 && !e.shiftKey && !["select", "pose", "rig"].includes(state.tool)) {
      releaseCanvasPointer();
      return;
    }
    if (state.tool === 'tweener') {
      if (e.button !== 0) {releaseCanvasPointer();return;}
      const hit = pick(p, {artwork: true});
      if (hit && !e.shiftKey && !isSelected(hit.uid)) editor.select(hit.uid, hit.joint);
      // A click only selects. Keep the existing selection when dragging empty
      // canvas or a selected figure, and prepare the tween once it is a drag.
      state.drag = {kind:'tweener', press: e, toggleUid: hit && e.shiftKey ? hit.uid : null};
      return;
    }
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
            ? interfaceText("app.chooseAJointOnTheSourceFigure")
            : interfaceText("app.chooseAnUnlockedFigureJointToAttachThe"),
         (duplicate ? "app.chooseAJointOnTheSourceFigure" : "app.chooseAnUnlockedFigureJointToAttachThe"), (duplicate ? {} : {}));
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
        status(duplicate.branch ? {messageKey: "app.branchDuplicated", messageParams: {}} : {messageKey: "app.segmentDuplicated", messageParams: {}});
      } else {
        editor.select(target.g.obj.unique_id);
        const added = editor.addSpriteSegment(pending.figure, {
          parentId: target.id,
        });
        cancelSpritePlacement();
        editor.select(target.g.obj.unique_id, added.segmentIndex);
        status({messageKey: "app.spriteAttached", messageParams: {}});
      }
      queueUI();
      return;
    }
    const camera = activeCameraHandle(p);
    if (
      (e.button === 0 || (e.button === 2 && e.shiftKey)) &&
      camera &&
      ["select", "pose"].includes(state.tool)
    ) {
      selectTrack({ id: "camera", kind: "camera" });
      renderInspector();
      const geometry = editor.geometry;
      editor.beginCameraDrag({
        indices: rangeFrames(),
        label: interfaceText("app.camera", {value: camera.kind === "position" ? {messageKey: "app.move"} : camera.kind === "rotation" ? {messageKey:"app.rotate"} : {messageKey:"app.scale"}}), labelKey: "app.camera", labelParams: {value: camera.kind === "position" ? {messageKey: "app.move"} : camera.kind === "rotation" ? {messageKey:"app.rotate"} : {messageKey:"app.scale"}},
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
    if (
      (e.button === 0 || e.button === 2) &&
      state.motionPaths &&
      ["select", "pose"].includes(state.tool) &&
      !builderMode?.active
    ) {
      const picked = pickMotionPath(screenPoint(p));
      const pathHit = picked?.hit, hitTarget = picked?.motionPath.target;
      const last = state.lastPathClick;
      if (e.button === 0 && pathHit && last && last.key === motionPathTargetKey(hitTarget) && last.tick === pathHit.tick && e.timeStamp - last.time < 450) {
        state.lastPathClick = null;
        releaseCanvasPointer();
        seekMotionPathTick(pathHit.tick);
        return;
      }
      if (pathHit && editor.beginMotionPathEdit(hitTarget, pathHit.tick, {falloff: e.button === 2 ? pathFalloff() : null})) {
        if (e.button === 2) { e.preventDefault(); state.suppressContext = true; }
        state.lastPathClick = null;
        state.falloffWheel = 0;
        state.drag = {
          kind: "motion-path",
          falloff: e.button === 2,
          key: motionPathTargetKey(hitTarget),
          tick: pathHit.tick,
          start: p,
          point: p,
          origin: {x: pathHit.x, y: pathHit.y},
          moved: false,
        };
        viewport.classList.add("dragging");
        syncPathTooltip();
        syncModeMessage();
        requestRender();
        return;
      }
    }
    if (state.rigAnchorPick) {
      const pending=state.rigAnchorPick,target=closestHandle(p);
      releaseCanvasPointer();
      if(pending.token!==editor._documentToken||pending.uid!==editor.selectedUid){state.rigAnchorPick=null;syncModeMessage();return;}
      if(!target||target.g.obj.unique_id!==pending.uid){toast(interfaceText("app.chooseAJointOnThisFigureEscapeCancels"), "app.chooseAJointOnThisFigureEscapeCancels", {});return;}
      if(pending.key==='driver')editor.bindStretchParts(target.id);
      else if(pending.key)editor.setRigBehavior({connector:{[pending.key]:target.id}});
      else editor.addConnector(pending.start,target.id);
      state.rigAnchorPick=null;syncModeMessage();toast(pending.key==='driver'?interfaceText("app.stretchDriverConnected"):pending.key?interfaceText("app.connectorAnchorUpdated"):interfaceText("app.connectorAddedDragItsMiddleJointToSlide"), (pending.key==='driver' ? "app.stretchDriverConnected" : (pending.key ? "app.connectorAnchorUpdated" : "app.connectorAddedDragItsMiddleJointToSlide")), (pending.key==='driver' ? {} : (pending.key ? {} : {})));requestRender();return;
    }
    if (state.tool === "attach") {
      releaseCanvasPointer();
      const pending = state.figureJoin;
      if (!pending || selectedFigureJoinAction()?.uid !== pending.uid) {setTool('select'); return;}
      const target = pickCanvasHandle(editor.geometry, p, {handles: canvasHandles(editor.geometry),
        project: screenPoint, projectionScale: state.view.scale, minRadius: 8, nearest: true});
      if (!target || isHidden(target.uid) || isLocked(target.uid)) {
        toast(interfaceText("app.clickAJointOnTheParentFigure"), "app.clickAJointOnTheParentFigure", {});
        return;
      }
      editor.joinFiguresInFrames(target.uid, target.id, pending.indices,
        {uids: [pending.uid], atPlayhead: !pending.indices});
      setTool("select");
      status({messageKey: "app.figuresAttached", messageParams: {}});
      return;
    }
    if (state.tool === "chain") { releaseCanvasPointer(); if(e.button===0)construction.click(p,e); return; }
    if (state.tool === "polygon") {
      polygonClick(p, e);
      return;
    }
    if (state.tool === "line" || state.tool === "circle") {
      const hit = pick(p),
        threshold = 10 / state.view.scale;
      let parent = null;
      const selectedPoint=builderMode?.active?editor.geometry.objects.get(editor.selectedSlot)?.joints.get(editor.figure?.segments[editor.selectedJoint]?.segment_id??0):null;
      if (hit&&(!selectedPoint||Math.hypot(p.x-selectedPoint.x,p.y-selectedPoint.y)>threshold)) {
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
      // In the builder the bound figure stays selected: a stroke off-joint
      // attaches to the selected joint or the root instead of a new figure.
      if (!parent && !builderMode?.active) editor.select(null);
      state.drag = {
        kind: "draw",
        start: builderMode?.active ? construction.start(p).point : (parent ? {...parent} : p),
        current: p,
      };
      state.drag.appearance = builderStrokeAppearance(editor);
      requestRender();
      return;
    }
    const hit = pick(p, {preferSelected: e.altKey && !state.handleEditHeld && !builderMode?.active, artwork: true});
    if (!hit && e.button === 0 && builderMode?.active && ['select','rig'].includes(state.tool)) {
      const polygon=pickFigureFill(editor.geometry.objects.get(editor.selectedSlot),p);
      if(polygon){releaseCanvasPointer();editor.selectPolygon(editor.selectedUid,polygon.index);return;}
    }
    if (e.button === 2 && (!hit || hit.joint < 0)) return;
    if (!hit) {
      const toggle = e.shiftKey || ((e.ctrlKey || e.metaKey) && !builderMode?.active);
      const initial = toggle ? [...selection()] : [];
      if (!toggle) editor.select(null);
      state.drag = {
        kind: "marquee",
        start: p,
        current: p,
        initial,
        mode: toggle ? "toggle" : "replace",
        selectionMode: builderMode?.active ? 'bounds' : state.settings.marqueeSelection,
      };
      requestRender();
      return;
    }
    // Origins defer Shift-click toggling so crossing the slop can carry IK pins.
    if (e.button === 0 && e.shiftKey && !e.altKey &&
        !(hit.joint < 0 && !state.handleEditHeld && !builderMode?.active && ['select', 'pose'].includes(state.tool))) {
      if (builderMode?.active && hit.joint >= 0) editor.toggleSegment(hit.g.obj.unique_id, hit.joint);
      else editor.select(hit.g.obj.unique_id, -1, { toggle: true });
      releaseCanvasPointer();
      return;
    }
    if (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey && hit.joint < 0) && !e.altKey && !state.handleEditHeld &&
        !builderMode?.active && ['select', 'pose'].includes(state.tool)) {
      // Keep selection and history intact until click versus drag is known.
      state.drag = {kind: 'toggle-selection', hit, start: p, press: e, moved: false};
      return;
    }
    if (e.button === 2 && !e.shiftKey) {
      // The press may still become a bend once the pointer travels; a release
      // in place opens the context menu instead of starting a pose gesture.
      if (hit.action === "select") {
        releaseCanvasPointer();
        return;
      }
      state.drag = {
        kind: "maybe-bend",
        hit,
        start: p,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      return;
    }
    if (e.button === 0 && e.altKey && hit.kind === 'origin' && !state.handleEditHeld &&
        !builderMode?.active && ['select', 'pose'].includes(state.tool)) {
      editor.select(hit.uid, -1, {add: isSelected(hit.uid)});
      state.drag = {kind: 'duplicate-pending', hit, start: p, press: e, moved: false};
      return;
    }
    beginFigurePointerDrag(hit, p, e);
  }),
);
function beginFigurePointerDrag(hit, p, e, {duplicate = false} = {}) {
  if(hit.g.segments[hit.joint]?.connector)editor._connectorInspector=null;
  const handleEdit = state.handleEditHeld;
  const figureTransform = e.altKey && hit.joint >= 0 && !handleEdit;
  editor.select(hit.g.obj.unique_id, hit.joint, {
    add: (hit.joint < 0 || figureTransform) && isSelected(hit.g.obj.unique_id),
  });
  if (
    hit.action === 'select' && !figureTransform
  ) {
    releaseCanvasPointer();
    return;
  }
  if (e.button === 2) state.suppressContext = true;
  if (duplicate) {
    if (!editor.beginDuplicateDrag({pasteMode: state.settings.altDragDuplicate})) {
      releaseCanvasPointer(); return;
    }
  }
  else if (handleEdit) editor.beginHandleEditDrag({ bend: e.button === 2 });
  else if (figureTransform)
    editor.beginFigureHandleDrag(p.x, p.y, { rotate: true, scale: true, joint: hit.joint });
  else if (hit.joint >= 0 && state.tool === "rig") {
    if (!editor.beginRigDrag({ reposition: state.rigMode !== "rotate", bend: e.button === 2 })) {
      releaseCanvasPointer(); return;
    }
  }
  else if (hit.joint >= 0) editor.beginDrag("Pose joint");
  else editor.beginTranslationDrag("Move connected figures");
  state.drag = {
    kind: handleEdit
      ? "handle-edit"
      : figureTransform
        ? "figure-transform"
        : hit.joint >= 0
          ? e.button === 2
            ? "bend"
            : state.tool === "rig" ? "rig" : "pose"
          : "move",
    bend: e.button === 2,
    constrain: e.ctrlKey || e.metaKey,
    axis: null,
    start: p,
    root: { x: hit.g.obj.root_x, y: hit.g.obj.root_y },
    joint: hit.joint,
    offset: hit.kind === 'segment-body' && !figureTransform ? {x: hit.point.x - p.x, y: hit.point.y - p.y} : null,
    moved: false,
    duplicate,
  };
  if (state.drag.kind === "rig" && builderMode?.active) construction.beginRig();
  if (hit.joint < 0 && !handleEdit) {
    const uids = editor.resolveTranslationSelection().affectedUids;
    state.drag.ikLive = editor._drag.before.some(o=>hasPinnedIK(o)||o._stykSpatial?.camera?.strength);
    if (!state.drag.ikLive) {
      state.drag.geometry = editor.geometry;
      state.drag.translations = new Map([...uids].map((uid) => [uid, { x: 0, y: 0 }]));
    }
  }
  requestRender();
}
const poseInput = createPoseInputQueue({
  apply: event => moveCanvasPointer(event),
  isCurrent: (drag, gesture) => drag === state.drag && gesture === editor._drag,
  schedule: requestRender,
});
function flushPoseMove() {
  poseInput.flush();
}
function coalescedPoseOptions(drag) {
  if (drag.poseInput !== undefined) return drag.poseInput;
  if (drag.kind === 'spatial' || drag.kind === 'move' && drag.ikLive ||
      drag.kind === 'pose' && editor.figure?.segments.some(segment => segment._stykRig?.spatial))
    return drag.poseInput = {};
  if (drag.kind === 'handle-edit' || drag.kind === 'rig' && !builderMode?.active) return drag.poseInput = {};
  if (!['pose', 'bend'].includes(drag.kind) || editor._drag.before.some(hasPinnedIK) ||
      editor.figure?.segments.some(segment => segment._stykRig) ||
      Object.values(editor.object?._stykIK ?? {}).some(controller => controller.enabled))
    return drag.poseInput = null;
  const shape = editor.geometry.objects.get(editor.selectedSlot)?.segments[drag.joint];
  const anchor = shape?.start;
  if (!anchor) return drag.poseInput = null;
  return drag.poseInput = {anchor};
}
function refreshOriginDragModifiers(event) {
  if (event.key !== 'Shift' || !['move', 'motion-path'].includes(state.drag?.kind)) return;
  flushPoseMove();
  const drag = state.drag, pointer = drag?.pointerEvent;
  if (!drag?.moved || !pointer) return;
  moveCanvasPointer(new PointerEvent('pointermove', {
    clientX: pointer.clientX, clientY: pointer.clientY, buttons: pointer.buttons,
    pointerId: pointer.pointerId, pointerType: pointer.pointerType,
    shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
  }));
}
const moveCanvasPointer = guarded((e) => {
    let drag = state.drag;
    if (drag?.kind === 'tweener') {
      if (e.buttons & 2) {e.preventDefault();state.suppressContext=true;cancelDrag();}
      else {
        if (drag.press) {
          const press = drag.press;
          if (Math.abs(e.clientX - press.clientX) < Math.max(3, dragSlop(press))) return;
          delete drag.press;
          if (drag.toggleUid !== null && !isSelected(drag.toggleUid)) editor.select(drag.toggleUid);
          if (!tweenerControls.begin(press)) {cancelDrag();return;}
        }
        tweenerControls.move(e);
      }
      return;
    }
    if (!drag && state.tool === 'tweener' && !state.space) return;
    if(drag&&telemetry.isForeground)telemetry.performance.action(drag.kind==='pan'?'pan':'edit');
    if (!drag && state.tool === 'polygon' && builderMode?.active) {
      state.bucketPreview = e.shiftKey ? bucketRegion(editor.geometry.objects.get(editor.selectedSlot),worldPoint(e)) : null;
      overlay.style.cursor = e.shiftKey ? (state.bucketPreview ? 'copy' : 'not-allowed') : '';
      requestOverlayRender();return;
    }
    if (!drag && state.tool === "chain" && construction?.active) {construction.move(worldPoint(e),e);return;}
    if (!drag) {
      // Playback uses worker packets; hover must not materialize an editable
      // scene (and all its handles) for every mouse move between ticks.
      if (state.previewing || state.playing) return;
      if (state.spritePlacement || state.duplicatePlacement) {
        const point = worldPoint(e),
          pending = state.spritePlacement || state.duplicatePlacement;
        pending.point = point;
        const snap = pending.preview?.index.nearest(point,10/state.view.scale,{jointsOnly:true});
        pending.hover = pending.preview ? (snap ? {point:snap,id:snap.id} : null) : closestHandle(point);
        if(state.duplicatePlacement)overlay.style.cursor="copy";
        requestOverlayRender();
        return;
      }
      const previousCameraHandle = state.hoverCameraHandle;
      state.hoverCameraHandle = activeCameraHandle(worldPoint(e));
      overlay.style.cursor = cameraHandleCursor(state.hoverCameraHandle, cameraViewport(editor.report,currentFrame(),state.view));
      if (previousCameraHandle?.index !== state.hoverCameraHandle?.index) requestOverlayRender();
      const previousPathPoint = state.hoverPathPoint;
      state.hoverPathPoint = null;
      if (state.motionPaths && !state.hoverCameraHandle && ["select", "pose"].includes(state.tool) && !builderMode?.active) {
        const picked = pickMotionPath(screenPoint(worldPoint(e)));
        if (picked) {
          const tick = picked.hit.tick;
          state.hoverPathPoint = { key: motionPathTargetKey(picked.motionPath.target), tick };
          overlay.style.cursor = "grab";
        }
      }
      if (state.hoverPathPoint || previousPathPoint) syncPathTooltip();
      if (previousPathPoint?.tick !== state.hoverPathPoint?.tick || previousPathPoint?.key !== state.hoverPathPoint?.key) requestOverlayRender();
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
    if (drag.kind === "zoom") {
      const target = drag.scale * Math.exp((e.clientX - drag.x - (e.clientY - drag.y)) * 0.01);
      zoom(target / state.view.scale, drag.anchor);
      return;
    }
    if (drag.kind === "rotate") {
      let angle = drag.rotation + Math.atan2(e.clientY - drag.center.y, e.clientX - drag.center.x) - drag.angle;
      angle = Math.atan2(Math.sin(angle), Math.cos(angle));
      // Settle on upright within 3 degrees so the view is easy to straighten.
      state.view.rotation = Math.abs(angle) < Math.PI / 60 ? 0 : angle;
      placeArtboard();
      requestRender();
      drawingController?.onUI?.();
      return;
    }
    // A pen tap wobbles; editing starts only once the press leaves its slop.
    if (!drag.moved && !drag.pastSlop && drag.kind !== "maybe-bend" && state.press) {
      if (!beyondSlop(e, state.press.x, state.press.y, state.press.slop)) return;
      drag.pastSlop = true;
    }
    const p = worldPoint(e);
    if (drag.kind === 'duplicate-pending') {
      if (!beyondSlop(e, drag.press.clientX, drag.press.clientY, dragSlop(drag.press, 3))) return;
      state.drag = null;
      beginFigurePointerDrag(drag.hit, drag.start, drag.press, {duplicate: true});
      drag = state.drag;
      if (!drag) return;
    }
    if (drag.kind === 'toggle-selection') {
      if (!beyondSlop(e, drag.press.clientX, drag.press.clientY, Math.max(3, dragSlop(drag.press)))) return;
      drag.moved = true;
      if (drag.hit.action === 'select') return;
      state.drag = null;
      beginFigurePointerDrag(drag.hit, drag.start, drag.press);
      drag = state.drag;
    }
    if (drag.kind === "maybe-bend") {
      // Crossing a few pixels turns the right press into a bend and suppresses
      // the context menu that a stationary release would open.
      if (Math.hypot(e.clientX - drag.clientX, e.clientY - drag.clientY) < 4)
        return;
      const hit = drag.hit;
      editor.select(hit.g.obj.unique_id, hit.joint);
      if (!(builderMode?.active || state.tool === "rig" ? editor.beginRigDrag({bend: true}) : editor.beginDrag("Pose joint"))) {
        state.drag = null;
        releaseCanvasPointer();
        return;
      }
      state.suppressContext = true;
      state.drag = {
        kind: "bend",
        bend: true,
        constrain: e.ctrlKey || e.metaKey,
        axis: null,
        start: drag.start,
        root: { x: hit.g.obj.root_x, y: hit.g.obj.root_y },
        joint: hit.joint,
        offset: hit.kind === 'segment-body' ? {x: hit.point.x - drag.start.x, y: hit.point.y - drag.start.y} : null,
        moved: true,
      };
      editor.bendJoint(p.x + (state.drag.offset?.x ?? 0), p.y + (state.drag.offset?.y ?? 0), {
        stretch: e.ctrlKey || e.metaKey,
        isolate: Boolean(state.isolateHeld || state.isolateMode),
        snapTolerance: 6 / state.view.scale,
        pixel: 1 / state.view.scale,
      });
      state.drag.current = p; state.drag.pointerEvent = e;
      requestRender();
      return;
    }
    drag.current = p; drag.pointerEvent = e;
    if(drag.kind==='spatial'){updateSpatialGizmo(editor,drag.spatial,screenPoint(p),e.shiftKey);requestRender();return;}
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
      drag.current = drag.kind === "draw" && builderMode?.active ? construction.snap(p,e,drag.start) : p;
      requestOverlayRender();
      return;
    }
    if (drag.kind === "motion-path") {
      const session = editor._drag;
      // On pinned origins Shift carries targets; Ctrl keeps axis locking
      // available. Joint/camera paths retain their existing Shift constraint.
      const pinnedOrigin = session?.target.kind === 'node' && session.target.handleId === 0 &&
        (session.grab?.baseline ?? session.baseline).some(hasPinnedIK);
      const movePins = pinnedOrigin && e.shiftKey;
      if (p.x !== drag.point?.x || p.y !== drag.point?.y || movePins !== Boolean(drag.movePins)) {
        drag.point = p;
        drag.movePins = movePins;
        drag.moved = true;
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        const constrained = (pinnedOrigin ? e.ctrlKey || e.metaKey : e.shiftKey)
          ? (Math.abs(dx) >= Math.abs(dy) ? {x: dx, y: 0} : {x: 0, y: dy})
          : {x: dx, y: dy};
        editor.updateMotionPathEdit({x: drag.origin.x + constrained.x, y: drag.origin.y + constrained.y}, {
          stretch: e.ctrlKey || e.metaKey,
          isolate: Boolean(state.isolateHeld || state.isolateMode),
          movePins,
        });
      }
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
      drag.movePins = e.shiftKey;
      if (drag.ikLive) { drag.delta = delta; editor.moveSelection(delta.x, delta.y, {fromStart: true, movePins: drag.movePins}); }
      else for (const uid of drag.translations.keys()) drag.translations.set(uid, delta);
    } else if (drag.kind === "handle-edit")
      editor.editHandlePosition(p.x, p.y, { bend: drag.bend });
    else if (drag.kind === "figure-transform") {
      drag.current = p;
      editor.transformFigureHandle(p.x, p.y, {
        ctrlKey: e.ctrlKey || e.metaKey,
        shiftKey: e.shiftKey,
      });
    }
    else if (drag.kind === "rig") {
      const target = builderMode?.active ? construction.rigSnap(p,e) : p;
      editor.editRigJoint(target.x, target.y, {
        reposition: state.rigMode !== "rotate",
        stretch: e.ctrlKey || e.metaKey,
        isolate: Boolean(state.isolateHeld || state.isolateMode),
      });
    } else if (drag.kind === "bend")
      editor.bendJoint(p.x + (drag.offset?.x ?? 0), p.y + (drag.offset?.y ?? 0), {
        stretch: e.ctrlKey || e.metaKey,
        isolate: Boolean(state.isolateHeld || state.isolateMode),
        snapTolerance: 6 / state.view.scale,
        pixel: 1 / state.view.scale,
      });
    else
      editor.poseJoint(p.x + (drag.offset?.x ?? 0), p.y + (drag.offset?.y ?? 0), {
        stretch: e.ctrlKey || e.metaKey,
        isolate: Boolean(state.isolateHeld || state.isolateMode),
        snapTolerance: 6 / state.view.scale,
        alternate: e.shiftKey,
        depth: state.depthHeld,
        pixel: 1 / state.view.scale,
        anchor: drag.offset ? {x: drag.start.x + drag.offset.x, y: drag.start.y + drag.offset.y} : drag.start,
      });
    requestRender();
  });
overlay.addEventListener('pointermove', e => {
  const drag=state.drag;
  const options = drag && editor.dragging && coalescedPoseOptions(drag);
  // Only absolute pose targets use this queue. Strokes, motion paths, snapping
  // construction and accumulated figure rotations keep their complete input.
  if (options && (drag.moved || drag.kind === 'spatial')) {
    const point = options.anchor ? worldPoint(e) : null;
    // The slop-crossing target is applied immediately. Start angular travel
    // from that applied target, so a burst after a large first move retains
    // its authored rotation winding rather than cancelling against the press.
    const appliedPoint = drag.current ?? drag.start;
    poseInput.enqueue({drag, gesture: editor._drag, event: e,
      modifiers: [e.shiftKey, e.ctrlKey, e.metaKey, e.altKey, e.buttons, state.isolateHeld, state.isolateMode, state.depthHeld].join('|'),
      initialAngle: options.anchor && appliedPoint ? Math.atan2(
        appliedPoint.y + (drag.offset?.y ?? 0) - options.anchor.y,
        appliedPoint.x + (drag.offset?.x ?? 0) - options.anchor.x) : null,
      angle: point ? Math.atan2(point.y + (drag.offset?.y ?? 0) - options.anchor.y,
        point.x + (drag.offset?.x ?? 0) - options.anchor.x) : null});
  } else { flushPoseMove(); moveCanvasPointer(e); }
});
function releaseCanvasPointer() {
  const id = canvasPointerId;
  canvasPointerId = null;
  if (id !== null && overlay.hasPointerCapture(id))
    overlay.releasePointerCapture(id);
}
function endDrag(event, {keepPointer = false} = {}) {
  flushPoseMove();
  // A pointer release may carry a newer position than its final move event.
  // Publish that target before the editor snapshots the one history entry.
  const lastPointer = state.drag?.pointerEvent;
  if (event?.type === 'pointerup' && lastPointer &&
      (event.clientX !== lastPointer.clientX || event.clientY !== lastPointer.clientY) &&
      ['pose', 'bend', 'rig', 'handle-edit', 'spatial', 'move'].includes(state.drag.kind))
    moveCanvasPointer(event);
  poseInput.clear();
  const drag = state.drag;
  if (drag?.kind === "draw" || drag?.kind === "rig") construction?.cancel();
  state.drag = null;
  if (!keepPointer) releaseCanvasPointer();
  if (!drag) return;
  viewport.classList.remove("dragging");
  if (drag.kind === "pan") continuePan();
  if (drag.kind === "maybe-bend" && drag.contextMenuOnPress && event) {
    overlay.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true,
      clientX: event.clientX, clientY: event.clientY, button: 2}));
    state.suppressContext = true;
  }
  if (drag.kind === 'duplicate-pending') {
    // Alt-click selects the root without inserting a figure.
  } else if (drag.kind === 'toggle-selection') {
    if (!drag.moved) editor.select(drag.hit.uid, -1, {toggle: true});
  } else if (drag.kind === 'tweener') {
    if (drag.press && drag.toggleUid !== null) editor.select(drag.toggleUid, -1, {toggle: true});
    tweenerControls.finish(true,event);
  } else if (drag.kind === "draw") {
    const p = drag.start,
      q = drag.current,
      length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length > 1) {
      if (!editor.addSegment)
        throw messageError(new Error(''), "errors.app.segmentAuthoringIsUnavailable", {});
      editor.addSegment({
        ...strokeSegments([p,q],editor.object?.scale??1)[0],
        type: state.tool,
        start: p,
      });
      status({messageKey: "app.segmentAdded", messageParams: {}});
    }
  } else if (drag.kind === "marquee") {
    const a = screenPoint(drag.start),
      b = screenPoint(drag.current);
    const left = Math.min(a.x, b.x),
      right = Math.max(a.x, b.x),
      top = Math.min(a.y, b.y),
      bottom = Math.max(a.y, b.y);
    const uids = new Set(), rect = {left, right, top, bottom};
    const options = {mode: drag.selectionMode, project: screenPoint, boundsOf};
    if (Math.hypot(right - left, bottom - top) > 3)
      for (const g of editor.geometry.objects.values()) {
        if (!g || isHidden(g.obj.unique_id) || isLocked(g.obj.unique_id))
          continue;
        if (figureIntersectsMarquee(g, rect, options))
          uids.add(g.obj.unique_id);
      }
    editor.selectMarquee([...uids], { mode: drag.mode, initial: drag.initial });
  } else if (drag.kind === "motion-path") {
    if (drag.moved) editor.commitMotionPathEdit();
    else editor.cancelMotionPathEdit();
    // A press that did not move arms the double-click that goes to this frame.
    state.lastPathClick = drag.moved || drag.falloff ? null : {key: drag.key, tick: drag.tick, time: event?.timeStamp ?? performance.now()};
    syncPathTooltip();
    syncModeMessage();
  } else if (drag.kind === "camera") editor.commitCameraDrag();
  else if (!["pan", "maybe-bend", "zoom", "rotate"].includes(drag.kind)) {
    if (drag.kind === "move" && drag.moved) {
      const delta = drag.ikLive ? drag.delta : drag.translations.get(editor.selectedUid);
      if (!drag.duplicate && rangeFrames()) {
        editor.cancelDrag();
        moveSelected(delta.x, delta.y, {movePins: drag.movePins});
      } else if (!drag.ikLive) editor.moveSelection(delta.x, delta.y, { fromStart: true, movePins: drag.movePins });
    }
    editor.commitDrag();
  }
  queueUI();
}
function addFrameKeepingDrag(insert) {
  pause(); flushPoseMove();
  const drag = state.drag, pointerId = canvasPointerId;
  const keep = !builderMode?.active && !drawingController?.active && !drag?.duplicate &&
    ['pose', 'bend', 'move'].includes(drag?.kind) && pointerId !== null && overlay.hasPointerCapture(pointerId);
  if (!keep) { finishCurrentEdit(); return insert(); }
  const held = {uid: editor.selectedUid, joint: editor.selectedJoint, point: drag.current ?? drag.start,
    event: drag.pointerEvent ?? {button: drag.bend ? 2 : 0, ctrlKey: drag.constrain}};
  // Commit this pose before inserting its successor, but retain native pointer
  // capture. Subsequent moves belong to a fresh, independently undoable pose.
  endDrag(undefined, {keepPointer: true});
  try { return insert(); }
  finally {
    if (canvasPointerId === pointerId && overlay.hasPointerCapture(pointerId)) {
      const g = [...editor.geometry.objects.values()].find(g => g.obj.unique_id === held.uid);
      if (g && !isHidden(held.uid) && !isLocked(held.uid) &&
          (held.joint < 0 || g.segments[held.joint])) {
        beginFigurePointerDrag({g, uid: held.uid, joint: held.joint, action: held.joint < 0 ? 'move' : 'pose',
          kind: drag.offset ? 'segment-body' : undefined, point: g.segments[held.joint]?.handle ?? g.segments[held.joint]?.end},
          held.point, {button: drag.bend ? 2 : 0, ctrlKey: held.event.ctrlKey, metaKey: held.event.metaKey});
        if (state.drag) { state.drag.pastSlop = true; state.drag.current = held.point; state.drag.pointerEvent = held.event; }
      } else releaseCanvasPointer();
    }
  }
}
function cancelDrag() {
  poseInput.clear();
  if (state.drag?.kind === "draw" || state.drag?.kind === "rig") construction?.cancel();
  releaseCanvasPointer();
  cancelSpritePlacement();
  cancelPolygonDraft();
  if (!state.drag) return;
  if (state.drag.kind === 'tweener') tweenerControls.finish(false);
  if (state.drag.kind === "camera") editor.cancelCameraDrag();
  if (state.drag.kind === "motion-path") { editor.cancelMotionPathEdit(); queueMicrotask(syncModeMessage); }
  if (
    ["move", "pose", "spatial", "rig", "bend", "handle-edit", "figure-transform"].includes(
      state.drag.kind,
    )
  )
    editor.cancelDrag();
  state.drag = null;
  viewport.classList.remove("dragging");
  syncPathTooltip();
  queueUI();
}
overlay.addEventListener("pointerup", guarded(endDrag));

overlay.addEventListener("dblclick", guarded((event) => {
  if (!builderMode?.active && ["select", "pose"].includes(state.tool) && (event.ctrlKey || event.metaKey)) return;
  if (event.button === 0 && state.tool === "chain" && construction?.active) {event.preventDefault();construction.commit();return;}
  if (event.button !== 0 || state.space || state.playing || state.previewing ||
      state.spritePlacement || state.duplicatePlacement ||
      !["select", "pose", "rig"].includes(state.tool)) return;
  const hit = pick(worldPoint(event));
  if (!hit || isHidden(hit.uid) || isLocked(hit.uid)) return;
  event.preventDefault();
  // Static and dynamic nodes both select their branch; bodies and origins
  // select the connected group.
  if (hit.joint < 0) {
    state.builderBranch = false;
    editor.selectConnected(hit.uid, {add: event.shiftKey, candidates: editor.selectionFrame.objects
      .filter(o => !isHidden(o.unique_id) && !isLocked(o.unique_id)).map(o => o.unique_id)});
    status({messageKey: "app.connectedFiguresSelected", messageParams: {size: editor.selectedUids.size}});
  } else {
    editor.selectBranch(hit.uid, hit.joint);
    notify(interfaceText("app.branchSelectedCopyOrEditTheCompleteBranch"), "app.branchSelectedCopyOrEditTheCompleteBranch", {});
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
    requestOverlayRender();
  }
  state.hoverHandle = null;
  state.hoverCameraHandle = null;
  state.hoverPathPoint = null;
  syncPathTooltip();
  if (!state.drag) overlay.style.cursor = '';
  requestOverlayRender();
});
viewport.addEventListener(
  "wheel",
  (e) => {
    // While right-dragging an arc, the wheel sizes the influence.
    if (editor.motionPathFalloff()) {
      e.preventDefault();
      state.falloffWheel = (state.falloffWheel ?? 0) + (e.deltaMode ? e.deltaY * 40 : e.deltaY);
      const steps = Math.trunc(state.falloffWheel / 40);
      if (steps) { state.falloffWheel -= steps * 40; nudgePathFalloff(-steps); }
      return;
    }
    const shouldZoom = state.settings.canvasZoomGesture === 'scroll' || e.ctrlKey || e.metaKey;
    if(telemetry.isForeground)telemetry.performance.action(shouldZoom ? 'zoom' : 'pan');
    e.preventDefault();
    // Notify preparation before the first projection/RAF; a busy graphics
    // process can delay that RAF while an awaited background preload resumes.
    if(!state.playing&&!state.previewing)syncBackgroundInteraction(true);
    interruptRecovery();
    flushPoseMove();
    const r = viewport.getBoundingClientRect();
    if (!shouldZoom) {
      state.view.x -= e.shiftKey ? e.deltaY : e.deltaX;
      state.view.y -= e.shiftKey ? e.deltaX : e.deltaY;
      continuePan();
      placeArtboard();
      requestRender();
    } else
      wheelZoom.wheel(e.deltaY, {
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      }, performance.now());
  },
  { passive: false },
);
// A press takes over the view (a pan, a pose): the glide stops where it is.
overlay.addEventListener("pointerdown", () => wheelZoom.cancel(), { capture: true });
// Two fingers zoom and pan the canvas; the first finger's drag is cancelled. Draw mode has its own pinch.
canvasPinch = installCanvasPinch({
  overlay, viewport,
  getView: () => state.view,
  setView: (view) => { state.view = view; placeArtboard(); requestRender(); },
  enabled: () => !drawingController?.active,
  onStart: () => {
    if (telemetry.isForeground) telemetry.performance.action('zoom');
    interruptRecovery();
    pause();
    if (state.drag) cancelDrag();
    syncBackgroundInteraction(true);
  },
  onEnd: requestRender,
});

async function acceptImport(
  result,
  name,
  { openToken, recoveryId } = {},
) {
  try {
  let report = result.document ?? result.report ?? result;
  if (report.format === "stykanimate") report = report.document;
  const savedDraft = result.savedDraft ?? Boolean(report._styk?.simpleFrameDraft);
  const kind =
    result.kind ||
    ((name || result.filename || "").toLowerCase().endsWith(".stk")
      ? "stk"
      : "piv");
  if (kind === "stk" || kind === "stkz" || kind === "stykmov") {
    finishCurrentEdit();
    editor.importFigure(report);
    const importedName = result.filename || name || {messageKey: "app.figure"};
    notify(interfaceText("app.imported", {value: importedName}), "app.imported", {value: importedName});
  } else {
    // The project opens in a tab of its own; the one in front rests beside it (openProject).
    if (!await openProject((session) => editor.loadAsync(
      report,
      (name || result.filename || "Untitled").replace(
        /\.(piv|stk|styk|stkz|stykmov|json|nodes|nodemc|stknds)$/i,
        "",
      ),
      {
        ...session,
        initialFrameIndex: kind === "piv" && !savedDraft ? "last" : 0,
      },
    ), {openToken, recoveryId})) return false;
    state.sourceId = result.sourceId || null;
    importer.adoptSource(result);
    state.hidden.clear();
    state.locked.clear();
    images.clear();
    fit();
  }
  state.lastImportWarnings = [...(result.warnings || report._styk?.sticknodes?.warnings || []), ...(report.import_warnings || [])];
  if(state.lastImportWarnings.length)dialogs.showImportNotes(state.lastImportWarnings, {pivot: Boolean(report.import_warnings?.length),report});
  state.lastImport = result.timings || null;
  const ms = result.timings?.total_ms ?? result.timings?.decode_ms;
  status(
    {messageKey: "app.opened", messageParams: {value: result.filename || name || editor.name, value2: ms !== undefined ? result.timings?.cache_hit ? {messageKey:'app.openedTimingCached',messageParams:{milliseconds:Math.round(ms)}} : ` · ${Math.round(ms)} ms` : ""}},
  );
  warmPlayback({immediate:true});
  return true;
  } finally {
    if (result.sourceOwner !== importer.activeSourceOwner) void importer.releaseSource(result);
  }
}
/**
 * Opens a project. `load(session)` publishes it in the editor: a load that takes the `session` options, which
 * park the project in front as a tab unless that one is the untouched empty animation, which gives its place.
 * The new project then gets its own save target on the desktop (`openToken`: the file it came from;
 * `recoveryId`: the recovery copy it was restored from). Resolves false when nothing opened.
 */
async function openProject(load, { blank = false, openToken, recoveryId } = {}) {
  if (!projects.canOpen() || !(await projects.settle()) || !projects.canOpen()) return false;
  const beside = !projects.replaceable(), replaced = beside ? null : state.documentToken;
  projectTransitions++;
  try {
    try { await load(beside ? { onDetach: (session) => projects.park(session) } : {}); }
    catch (error) { projects.failed(); throw error; }
    projects.opened({ blank });
    // The open document is a new project: nothing of the previous one in front applies to it.
    state.documentToken = null; state.sourceId = null; state.lastImport = null; state.lastImportWarnings = [];
    lastSave = null; recoveredEpoch = -1; recoveryDeadline.reset(); state.recoveryBackoff = 1;
    if (!beside) { importer.adoptSource(null); if (replaced) void desktop?.releaseDocument?.(replaced)?.catch(fail); }
    scheduleProjectPicture();
    if (desktop?.activateDocument) {
      // A launch-time file open races init()'s document activation; the file's
      // activation must be the one that binds the native save target.
      await documentActivation;
      try { state.documentToken = (await desktop.activateDocument({ openToken, recoveryId })).documentToken; }
      catch (error) {
        // The project is open either way; without its file it saves through Save as.
        state.documentToken = (await desktop.activateDocument({})).documentToken;
        throw error;
      }
    }
    return true;
  } finally { projectTransitions--; queueUI(); }
}
/** Ends what belongs to the project in front before another takes its place. Resolves false to keep it in front. */
async function settleProject() {
  finishCurrentEdit();
  if (state.drag) cancelDrag();
  cancelPolygonDraft();
  construction?.cancel();
  cancelSpritePlacement();
  closeMenu();
  // A figure being built ends by its own choice (keep or discard); Draw leaves once its pixels are published.
  if (builderMode?.active) { builderMode.requestExit(); if (builderMode.active) return false; }
  if (drawingController?.active) { await studioShell.changeMode("animate"); if (drawingController.active) return false; }
  await drawingController?.barrier();
  if (editor._drag || editor._animationEdit || editor._authoredPoseEdit) return false;
  // The tab keeps a picture of the project as it was left: one frame, drawn now.
  await requestProjectPicture();
  return !(editor._drag || editor._animationEdit || editor._authoredPoseEdit);
}
/**
 * A small picture of the stage as it is on screen, cropped to the artboard, for the project's tab and the
 * switcher. Read from the canvas the renderer already drew: nothing is rendered for it. Null when the
 * artboard is not on screen.
 */
function stagePicture() {
  if (!state.renderer || document.hidden) return null;
  const box = viewport.getBoundingClientRect(), board = $("artboard").getBoundingClientRect();
  if (!(box.width > 0) || state.view.rotation || state.view.flip) return null;
  // The surface the last frame was drawn on (the engine's while it draws the scene).
  const canvas = state.renderer.canvas;
  const ratio = canvas.width / box.width;
  const left = Math.max(0, board.left - box.left), top = Math.max(0, board.top - box.top),
    right = Math.min(box.width, board.right - box.left), bottom = Math.min(box.height, board.bottom - box.top);
  if (right - left < 16 || bottom - top < 16) return null;
  const width = Math.round((right - left) * ratio), height = Math.round((bottom - top) * ratio), scale = Math.min(1, 256 / width);
  try {
    return createImageBitmap(canvas, Math.round(left * ratio), Math.round(top * ratio), width, height,
      { resizeWidth: Math.max(1, Math.round(width * scale)), resizeHeight: Math.max(1, Math.round(height * scale)), resizeQuality: "medium" }).catch(() => null);
  } catch { return null; }
}
/**
 * Takes the picture of the project in front: the next frame is drawn without joints and read in the render
 * loop, as the colour picker's sample is. Resolves once it was read (false when it could not be, soon after).
 */
let pendingProjectPicture = null, pictureTimer = 0;
function requestProjectPicture() {
  return new Promise((resolve) => {
    pendingProjectPicture?.finish(false);
    const finish = (taken) => {
      clearTimeout(timeout);
      if (pendingProjectPicture?.finish === finish) pendingProjectPicture = null;
      resolve(taken);
    };
    const timeout = setTimeout(() => finish(false), 250);
    pendingProjectPicture = { id: projects.tabs.activeId, finish };
    requestRender();
  });
}
/** The picture of a project that just came to the front, or was saved: once nothing is moving. Leaving takes one too (settleProject). */
function scheduleProjectPicture(delay = 700, attempts = 4) {
  clearTimeout(pictureTimer);
  pictureTimer = setTimeout(() => {
    if (state.playing || editingGestureActive()) { if (attempts > 1) scheduleProjectPicture(1200, attempts - 1); return; }
    void requestProjectPicture();
  }, delay);
}
/** What this file holds for the project in front: read as it leaves, before the editor publishes the next one. */
function captureProject() {
  clearTimeout(pictureTimer);
  return {
    view: { ...state.view }, fitted: isFittedView(),
    hidden: new Set(state.hidden), locked: new Set(state.locked),
    documentToken: state.documentToken, sourceId: state.sourceId, sourceOwner: importer.detachSource(),
    lastImport: state.lastImport, lastImportWarnings: state.lastImportWarnings, lastSave,
    recoveryCurrent: recoveredEpoch === saveMutationEpoch,
  };
}
function restoreProject(saved) {
  state.view = saved.view;
  state.hidden = saved.hidden; state.locked = saved.locked;
  state.documentToken = saved.documentToken; state.sourceId = saved.sourceId;
  importer.attachSource(saved.sourceOwner);
  state.lastImport = saved.lastImport; state.lastImportWarnings = saved.lastImportWarnings; lastSave = saved.lastSave;
  // Saves follow the project in front. Sent now, in order, so no save can reach the desktop before it.
  if (saved.documentToken) void desktop?.selectDocument?.(saved.documentToken)?.catch(fail);
}
/** A project came to the front: `saved` is the state it rested with, absent for a new empty one. */
function projectShown(saved) {
  images.clear();
  recoveryDeadline.reset(); state.recoveryBackoff = 1; state.recoveryFailed = false;
  clearTimeout(state.recoveryTimer); state.recoveryTimer = null;
  // The editor published the project, which counts as a change: its recovery copy is as current as it was.
  recoveredEpoch = saved?.recoveryCurrent ? saveMutationEpoch : -1;
  // A view the person left fitted follows the window it comes back to; a zoomed or panned one returns as it was.
  if (!saved || saved.fitted) fit();
  else { fittedSnapshot = null; placeArtboard(); requestRender(); }
  queueUI();
  if (editor.dirty && recoveredEpoch !== saveMutationEpoch) scheduleRecovery();
  status({messageKey: "app.ready", messageParams: {}});
  warmPlayback({immediate: true});
  scheduleProjectPicture();
}
/** The last project closed: the window keeps a new, empty one in its place. */
function blankProject() {
  editor.newDocument();
  state.documentToken = null; state.sourceId = null; state.lastImport = null; state.lastImportWarnings = [];
  state.hidden.clear(); state.locked.clear();
  lastSave = null;
  if (desktop?.activateDocument) {
    projectTransitions++;
    documentActivation = documentActivation.then(() => desktop.activateDocument({}))
      .then((document) => { state.documentToken = document.documentToken; }).catch(fail).finally(() => { projectTransitions--; });
  }
}
/** A project closed: what it held outside the editor ends with it. Its recovery copy goes too, as closing decided its changes. */
function releaseProject(record) {
  const saved = record.state ?? {}, session = record.session;
  if (session) {
    drawingResourcesFor(session.report)?.dispose();
    for (const scope of session._movieclipScopes ?? []) drawingResourcesFor(scope.parent.report)?.dispose();
  }
  if (saved.sourceOwner) void importer.releaseSource(saved.sourceOwner);
  if (desktop) {
    if (saved.documentToken) void Promise.resolve(desktop.deleteRecovery?.({ documentToken: saved.documentToken })).catch(() => {})
      .then(() => desktop.releaseDocument?.(saved.documentToken)).catch(fail);
  } else void browserRecovery.clear(record.id).catch(() => {});
}
function projectRefused(reason) {
  if (reason === "limit") notify(interfaceText("app.closeAProjectToOpenAnother", {count: projects.tabs.limit}), "app.closeAProjectToOpenAnother", {count: projects.tabs.limit});
  else notify(interfaceText("app.waitForTheSaveOrTheOpeningFileToFinish"), "app.waitForTheSaveOrTheOpeningFileToFinish", {});
}
/**
 * The recovery copy of a project that rests with unsaved changes (project-tabs-host.mjs). It cannot change while it
 * rests, so the snapshot needs no revision checks and edits to the project in front do not interrupt it.
 */
async function writeRestingRecovery(record, signal) {
  const { report, name } = sessionProject(record.session), saved = record.state;
  const controller = new AbortController(), job = { controller, recovery: true, resting: true };
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  exportJobs.add(job);
  try {
    const blob = await documentExporter.export(report, { format: "styk", name, sourceId: saved.sourceId, signal: controller.signal });
    if (desktop) return await writeNativeBlob(desktop, blob, { recovery: true, name, signal: controller.signal, documentToken: saved.documentToken });
    return await browserRecovery.write(blob, name, controller.signal, record.id);
  } finally {
    exportJobs.delete(job);
    signal.removeEventListener("abort", abort);
  }
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
  overlay.style.cursor = "";
  viewport.classList.remove("sprite-placement");
  syncModeMessage();
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
    point: editor.geometry.objects.get(editor.object.object_slot)?.segments[editor.selectedJoint]?.start,
    preview: duplicatePreview(editor.geometry.objects.get(editor.object.object_slot),editor.selectedJoint,{branch,flip,scale:state.view.scale}),
    hover: null,
    previousHint: $("viewport-hint").textContent,
  };
  viewport.classList.add("sprite-placement");
  overlay.style.cursor = "copy";
  localizedText($("viewport-hint"), "app.chooseAParentJointForTheCopyEsc", {});
  syncModeMessage();
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
    localizedText($("viewport-hint"), "app.chooseAnAttachmentJointEscToCancel", {});
    syncModeMessage();
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
  status({messageKey: "app.importingImage", messageParams: {}}, false, true);
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
    if (background) editor.importSceneBackground(media);
    else editor.importFigure(media);
    notify(interfaceText("app.imported2", {name: file.name}), "app.imported2", {name: file.name});
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    throw error;
  } finally {
    editor.removeEventListener("change", changed);
  }
}
async function chooseSticknodesFile(file,isCurrent=()=>true) {
  const onProgress=p=>{if(isCurrent())status(`${p.phase || interfaceText("app.importing2")}…`,false,true);};
  const open={layerTimeline:editor.layerTimeline};
  let result=await importer.importFile(file,{onProgress,open,project:/\.piv$/i.test(file.name)});
  if(!isCurrent()){void importer.releaseSource(result);return null;}
  if(result.kind==='sticknodes-archive'){
    const index=await dialogs.chooseSticknodesEntry(result.entries);
    if(index===null||!isCurrent())return null;
    result=await importer.importFile(file,{entryIndex:index,onProgress,open});
  }
  if(!isCurrent()){void importer.releaseSource(result);return null;}
  return result;
}
async function importFiles(files) {
  telemetry.performance.resources('before_open');
  const started = performance.now(); telemetry.count('import_started');
  try {
    const result = await importFilesTracked(files);
    if(result!==false){telemetry.performance.closedAt=null;telemetry.performance.resources('opened');}
    telemetry.count(result === false ? 'import_cancelled' : 'import_succeeded');
    if (result !== false) telemetry.timing('import_ms', performance.now() - started);
    return result;
  } catch (error) { telemetry.count(error.name === 'AbortError' ? 'import_cancelled' : 'import_failed'); telemetry.error(error, 'import'); throw persistentFailure(error); }
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
  status({messageKey: "app.importing", messageParams: {}}, false, true);
  try {
    for (const file of files) {
      recordImportKind(file.name);
      const started = performance.now(), context = telemetry.consent.diagnostics ? workload({ format: file.name, bytes: file.size }) : {};
      let outcome = 'succeeded';
      try {
      if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name)) {
        if (
          !(await importMediaFile(file, {
            isCurrent: () => seq === importSequence,
          }))
        ) { outcome = 'cancelled'; return false; }
        continue;
      }
      const result = await chooseSticknodesFile(file,()=>seq===importSequence);
      if (!result || seq !== importSequence) { void importer.releaseSource(result); outcome = 'cancelled'; return false; }
      if (telemetry.consent.diagnostics) context.complexity = documentComplexity(result.document);
      telemetry.operation({ ...context, operation: 'import', stage: 'decode', outcome: 'succeeded' }, result.timings?.decode_ms);
      telemetry.performance.record('decode',result.timings?.decode_ms);
      if(await acceptImport(result, file.name)===false){outcome='cancelled';return false;}
      telemetry.timing('import_decode_ms', result.timings?.decode_ms);
      } catch (error) {
        outcome = error.name === 'AbortError' ? 'cancelled' : 'failed';
        if (outcome === 'failed') telemetry.error(error, 'import', { ...context, stage: 'decode' });
        throw error;
      } finally { telemetry.operation({ ...context, operation: 'import', stage: 'complete', outcome }, performance.now() - started); }
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
    status({messageKey: "app.openingFile", messageParams: {}}, false, true);
    const result = await desktop.openFile();
    if (result) await acceptNativeFile(result);
    else status({messageKey: "app.ready", messageParams: {}});
  } else {
    $("file-input").value = "";
    $("file-input").click();
  }
}
async function acceptNativeFile(result) {
  const started = performance.now(); telemetry.count('import_started'); recordImportKind(result.filename);
  const context = telemetry.consent.diagnostics ? workload({ format: result.filename, bytes: result.bytes?.byteLength }) : {};
  try {
    const accepted = await acceptNativeFileTracked(result);
    if (telemetry.consent.diagnostics && accepted !== false) context.complexity = documentComplexity(editor.report);
    telemetry.operation({ ...context, operation: 'import', stage: 'complete', outcome: accepted === false ? 'cancelled' : 'succeeded' }, performance.now() - started);
    telemetry.count(accepted === false ? 'import_cancelled' : 'import_succeeded');
    if (accepted !== false) telemetry.timing('import_ms', performance.now() - started);
    if (accepted !== false) {
      telemetry.timing('import_decode_ms', state.lastImport?.decode_ms);
      telemetry.operation({ ...context, operation: 'import', stage: 'decode', outcome: 'succeeded' }, state.lastImport?.decode_ms);
    }
    return accepted;
  } catch (error) {
    telemetry.count(error.name === 'AbortError' ? 'import_cancelled' : 'import_failed');
    telemetry.operation({ ...context, operation: 'import', stage: 'complete', outcome: error.name === 'AbortError' ? 'cancelled' : 'failed' }, performance.now() - started);
    if (error.name !== 'AbortError') telemetry.error(error, 'import', { ...context, stage: 'decode' }); throw persistentFailure(error);
  }
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
  status({messageKey: "app.decodingPivotFile", messageParams: {}}, false, true);
  try { await acceptImport(await importer.openSample(path,{open:{layerTimeline:editor.layerTimeline},project:/\.piv$/i.test(path)})); } catch (error) { throw persistentFailure(error); }
}
function saveNative({ saveAs = false } = {}) {
  if (!manualSave.active) finishCurrentEdit();
  return manualSave.run({...documentCheckpoint(editor, state.documentToken, saveMutationEpoch), saveAs}, async () => {
    savingDocument = true;
    updateTitle();
    try { return await performNativeSave({saveAs}); }
    finally {
      savingDocument = false;
      updateTitle();
      if (editor.dirty) scheduleRecovery();
    }
  });
}
async function performNativeSave({saveAs}) {
  const targetReport = editor.report, targetToken = state.documentToken;
  const targetName = editor._movieclipScopes?.[0]?.parent.name ?? editor.name;
  const controller = new AbortController();
  // Invoke the browser picker in the input task, before publication/serialization
  // can consume its transient user activation. Desktop keeps its native writer.
  const destination = !desktop ? exportFlow.openExportSink({
    filename: `${targetName || "Untitled"}.styk`, mimeType: "application/octet-stream", signal: controller.signal,
    fileSystem: navigator.userActivation?.isActive !== false,
  }) : null;
  let sink, downloaded = false;
  try {
    sink = await destination;
    if (!desktop && !sink) { status({messageKey: "app.saveCancelled", messageParams: {}}); return false; }
    if (targetReport !== editor.report || targetToken !== state.documentToken) { status({messageKey: "app.saveCancelledTheProjectChanged", messageParams: {}}); return false; }
    await drawingController?.barrier();
    if (targetReport !== editor.report || targetToken !== state.documentToken) { status({messageKey: "app.saveCancelledTheProjectChanged", messageParams: {}}); return false; }
    while (editor._movieclipScopes?.length) {
      const scopedReport = editor.report;
      await drawingBarrier(scopedReport, {signal: controller.signal});
      if (editor.report !== scopedReport || state.documentToken !== targetToken) {
        status({messageKey: "app.saveCancelledTheProjectChanged", messageParams: {}});
        return false;
      }
      editor.leaveMovieclip();
    }
    interruptRecovery();
    status({messageKey: "app.savingProject", messageParams: {}}, false, true);
    const revision = editor.revision,
      report = editor.report,
      documentToken = state.documentToken,
      name = editor.name;
    const checkpoint = documentCheckpoint(editor, documentToken, saveMutationEpoch);
    let saved;
    try {
      saved = await runDocumentExport("styk", async (blob, signal) => {
        if (desktop?.beginProjectWrite) return writeNativeBlob(desktop, blob, {
              signal,
              documentToken,
              saveAs,
              defaultPath: `${name || "Untitled"}.styk`,
              filters: [{ name: "StykAnimate project", extensions: ["styk"] }],
            });
        if (desktop) return exportFlow.saveBlob(blob, `${name || "Untitled"}.styk`, signal);
        if (sink.streamed) {
          await sink.write(blob);
          return Boolean((await sink.finish()).saved);
        }
        // An anchor download has no completion acknowledgement. Keep both the
        // unsaved state and a recovery copy, including when timed autosave is off.
        try { await browserRecovery.write(blob, name, signal, projects.tabs.activeId); }
        catch (error) { if (error.name === "AbortError") throw error; status({messageKey: "app.recoveryCopyCouldNotBeWritten", messageParams: {message: error.message}}, true); }
        if (signal.aborted) throw messageError(new DOMException('', "AbortError"), "errors.app.saveCancelled", {});
        await exportFlow.saveBlob(blob, `${name || "Untitled"}.styk`, signal);
        downloaded = true;
        return false;
      }, {controller});
    } catch (error) {
      if (error.name === "AbortError") {
        status({messageKey: "app.saveCancelled", messageParams: {}});
        return false;
      }
      throw error;
    }
    if (saved) {
      if (editor.report === report && state.documentToken === documentToken) {
        if (matchesDocumentCheckpoint(checkpoint, editor, state.documentToken, {epoch: saveMutationEpoch})) {
          editor.markSaved();
          lastSave = {...checkpoint, time: Date.now()};
          recoveryDeadline.reset();
          // The project file has committed. Optional recovery cleanup must not
          // turn that successful atomic save into a failed Save/Close result.
          try {
            recoveredEpoch = -1;
            if (desktop?.deleteRecovery) await desktop.deleteRecovery({documentToken});
            else if (!desktop) await browserRecovery.clear(projects.tabs.activeId);
          } catch (error) { fail(error); }
        }
      }
      updateTitle();
      if (editor.dirty) notify(interfaceText("app.savedACopyNewerChangesAreStillUnsaved"), "app.savedACopyNewerChangesAreStillUnsaved", {});
      else { status({messageKey: "app.projectSaved", messageParams: {}}); scheduleProjectPicture(0, 1); }
    } else status(downloaded ? {messageKey: "app.downloadStartedTheProjectStaysEditedUntilA", messageParams: {}} : {messageKey: "app.saveCancelled", messageParams: {}});
    return Boolean(
      saved &&
        editor.report === report &&
        state.documentToken === documentToken &&
        editor.revision === revision &&
        saveMutationEpoch === checkpoint.epoch &&
        !editor.dirty,
    );
  } finally {
    // Aborts swap files on snapshot failure/cancellation; a committed sink is inert.
    await sink?.abort();
  }
}
/**
 * What the desktop holds to guard closing the window: the project in front, and whether any open project has
 * unsaved changes (how many, and one of their names for the question it asks).
 */
function documentStateNow() {
  const open = projects.summary();
  return {name: editor.name || "Untitled", dirty: open.unsaved > 0, activeDirty: editor.dirty, unsaved: open.unsaved, unsavedName: open.unsavedName,
    revision: `${state.documentToken}:${editor.revision}:${saveMutationEpoch}:${open.stamp}`};
}
/** Close/restart only the saved revision, including changes arriving during IPC. */
async function finishDocumentAction(action, savedCheckpoint = null) {
  if (finalizingDocument) return false;
  finishCurrentEdit();
  const checkpoint = savedCheckpoint || documentCheckpoint(editor, state.documentToken, saveMutationEpoch);
  const current = () => matchesDocumentCheckpoint(checkpoint, editor, state.documentToken, {saved: Boolean(savedCheckpoint), epoch: saveMutationEpoch});
  if (!current()) return false;
  finalizingDocument = true;
  try {
    for (const flush of [() => workspaceLayout?.flushPreferences(), () => editorSettings?.flush()]) {
      await flush();
      if (!current()) return false;
    }
    await desktop?.setDocumentState(documentStateNow());
    if (!current()) {
      // Ensure the desktop retains the current dirty state if publication itself
      // yielded to a new edit; no close or restart follows this acknowledgement.
      await desktop?.setDocumentState(documentStateNow());
      return false;
    }
    const result = await desktop?.[action]({saved: Boolean(savedCheckpoint), revision: documentStateNow().revision});
    return result !== false;
  } finally { finalizingDocument = false; }
}
/** The window closes or restarts once every open project with changes is saved; a cancelled save keeps it open. */
async function saveEveryProjectThen(action) {
  if (!await projects.saveAll(() => saveNative())) return false;
  if (projects.summary().unsaved) return false;
  return finishDocumentAction(action, documentCheckpoint(editor, state.documentToken, saveMutationEpoch));
}
/**
 * Shows `body` (trusted markup built here) in the shared #dialog under a
 * `title` (text). The kit's compatibility instance keeps today's markup and
 * hooks inside a form: Enter in a field runs the body's primary button, and
 * focus starts on the first field or the primary, never on Close.
 */
function showDialog(title, body, {titleKey, titleParams} = {}) {
  showLegacyDialog(title, body, {
    titleKey, titleParams,
    dialog: $("dialog"),
    content: $("dialog-content"),
    overlays,
    icon: (name) => icon(name),
    t: (key, params) => appLocalization?.t(key, params),
  });
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
    editMode: state.handleEditHeld,
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
        throw messageError(new Error(''), "errors.app.theDocumentChangedOpenTheTextEditorAgain", {});
      if (editExisting)
        editor.replaceFigureDefinition(typeId, definition, {
          label: interfaceText("app.editText"), labelKey: "app.editText",
        });
      else editor.importFigure(definition);
      status(editExisting ? {messageKey: "app.textUpdated", messageParams: {}} : {messageKey: "app.textAdded", messageParams: {}});
    },
  });
}
let backgroundDialog;
function showBackgroundDialog() {
  pause();
  backgroundDialog ??= new BackgroundDialog({
    dialog: $("dialog"),
    content: $("dialog-content"),
    onError: fail,
  });
  const options = {
      indices: rangeFrames(),
    },
    report = editor.report;
  const apply = (operation) => {
    if (editor.report !== report)
      throw messageError(new Error(''), "errors.app.theDocumentChangedOpenBackgroundSettingsAgain", {});
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

function showHelp() { editorSettings?.open("shortcuts"); }
// Every menu renders into the #menu host through the overlay kit
// (src/ui/ui-menu.mjs): `hidden` mirrors the open state, rows keep their
// data-action for the click delegation below, and while a menu is open it takes
// every key, so letters typed into it never reach the tool hotkeys.
const menuHost = $("menu");
const menuTopInset = () => bandBottom(document) + 6;
let lastMenuAnchor = null;
/** The shortcut a menu row shows: the user's binding for commands with a hotkey, else the row's own text. */
/** A menu row's shortcut: the command's first key (a menu shows one; Settings and the tooltips list them all). */
const MENU_KEY_ALIASES = { "delete-single-segment": "delete", "duplicate-segment": "duplicate", "mirror-segment": "mirror", "mirror-segment-vertical": "mirror-vertical" };
function menuShortcut(command, text = "") {
  let id = MENU_KEY_ALIASES[command] ?? command;
  if (id === "play" && !hotkeys.label("play")) id = "play-pan";
  return HOTKEY_BY_ID.has(id) ? hotkeys.label(id).split(" / ")[0] : text;
}
/** Commands that remove something: their menu rows are red (and menus list them last). */
const DANGER_COMMANDS = new Set(["delete", "delete-segment", "delete-single-segment", "delete-frame", "clear-keys", "builder-context-delete-fill"]);
/** Today's menu rows ([action, icon, label, shortcut, disabled] or null) as menu items; a submenu's rows convert too. */
function menuItems(rows) {
  return rows.map((row) => {
    if (!Array.isArray(row)) return row && Array.isArray(row.submenu) ? { ...row, submenu: menuItems(row.submenu) } : row ?? null;
    const [command, glyph, label, shortcut = "", disabled = false] = row;
    return {
      command, icon: glyph, label, labelKey: menuLabelKey(command) ?? tupleMessages(row)[2]?.key, labelParams: tupleMessages(row)[2]?.params,
      shortcut: menuShortcut(command, shortcut), disabled: Boolean(disabled), danger: DANGER_COMMANDS.has(command),
    };
  });
}
const menuOptions = {
  host: menuHost,
  overlays,
  icon: (name) => icon(name),
  t: (key, params) => appLocalization?.t(key, params),
  topInset: menuTopInset,
};
/**
 * An application menu's rows. At the minimal tier the timeline header folds
 * Audio and Edit together (as it folds First frame and Loop), so the
 * Animation menu lists them there.
 */
function appMenuItems(name) {
  // A view toggle shows a check while it is on (the registry's toggle states).
  const items = menuItems(applicationMenuItems(name, editor, desktop)).map((item) =>
    item?.command && TOGGLE_STATES[item.command] ? { ...item, checked: TOGGLE_STATES[item.command]() } : item);
  if (name === "view" && shell) items.splice(items.findIndex((item) => item?.command === "layout-focus"), 0, panelsMenu());
  if (name !== "animation" || workspaceLayout?.tier !== "minimal") return items;
  const audio = $("timeline-audio"), range = $("range-edit");
  const folded = [
    { command: "toggle-audio", icon: "music", label: interfaceText("app.audio"), labelKey: "app.audio", checked: audio?.getAttribute("aria-expanded") === "true", hidden: !audio },
    { command: "toggle-range-edit", icon: "frame", label: interfaceText("app.editTogether"), labelKey: "app.editTogether", checked: range?.getAttribute("aria-pressed") === "true",
      disabled: Boolean(range?.disabled), hidden: !range || builderMode?.active || drawingController?.active },
  ];
  items.splice(items.findIndex((item) => item?.command === "toggle-loop") + 1, 0, ...folded);
  return items;
}
/** View › Panels: each panel checked while it shows; choosing it shows or folds it (the timeline: Full or Strip; Build: shown or hidden). */
function panelsMenu() {
  const row = (id, label, glyph) => {
    const shown = id === "timeline" ? shell.presentation(id) === "docked" : shell.registry.isVisible(id);
    return { label, icon: glyph, checked: shown, hidden: shell.presentation(id) === "unavailable", shortcut: menuShortcut(`panel-toggle-${id}`),
      run: () => (id === "timeline" ? shell.togglePanel(id) : shown ? shell.workspace.fold(id) : shell.showPanel(id)) };
  };
  return { label: interfaceText("app.panels"), labelKey: "app.panels", icon: "layout", submenu: [row("properties", interfaceText("app.properties"), "inspector"), row("vfx", "VFX", "fx"),
    row("library", interfaceText("app.library"), "library"), row("structure", interfaceText("app.structure"), "structure"), row("timeline", interfaceText("app.timeline"), "timeline")] };
}
installMenuBar(document.querySelector(".app-menubar"), {
  ...menuOptions,
  menus: Object.fromEntries(
    [...document.querySelectorAll("[data-app-menu]")].map((button) => [button.dataset.appMenu, () => appMenuItems(button.dataset.appMenu)]),
  ),
});
function closeMenu(reason = "close") {
  menuFor(menuHost)?.close(reason, { restore: false });
}
/** The menus live in the mark's menu (the band keeps its room for the open projects): they lead it as submenus. */
function foldedMenubarItems() {
  const menus = [...document.querySelectorAll(".titlebar .app-menubar [data-app-menu]")].map((button) => ({
    label: button.textContent.trim(),
    submenu: appMenuItems(button.dataset.appMenu),
  }));
  return [...menus, null];
}
/** The open projects as a submenu, for where the band has no room for their tabs and for the keyboard. */
function openProjectsMenu() {
  if (projects.tabs.size < 2) return [];
  return [{ label: interfaceText("projectTabs.openProjects"), labelKey: "projectTabs.openProjects", icon: "layers",
    submenu: projects.tabs.items.map((item) => ({ label: item.name || interfaceText("app.untitled"), checked: item.id === projects.tabs.activeId,
      run: guarded(() => projects.activate(item.id)) })) }, null];
}
/** A tab's menu: the project in front has its file commands; a resting one can come forward or close. */
function projectMenuItems(id) {
  const item = projects.tabs.get(id);
  if (!item) return [];
  if (id !== projects.tabs.activeId) return [
    { label: interfaceText("projectTabs.switchToThisProject"), labelKey: "projectTabs.switchToThisProject", icon: "layers", run: guarded(() => projects.activate(id)) },
    { label: interfaceText("commands.closeProject"), labelKey: "commands.closeProject", icon: "close", run: guarded(() => projects.close(id)) },
  ];
  return [
    messageTuple(["save", "save", interfaceText("common.save"), "Ctrl S"], {2: {key: "common.save", params: {}}}),
    messageTuple(["save-as", "save", interfaceText("common.saveAs"), "Ctrl Shift S"], {2: {key: "common.saveAs", params: {}}}),
    messageTuple(["rename", "file", interfaceText("commands.rename")], {2: {key: "commands.rename", params: {}}}),
    null,
    messageTuple(["close-project", "close", interfaceText("commands.closeProject"), "Ctrl W"], {2: {key: "commands.closeProject", params: {}}}),
    messageTuple(["close-saved-projects", "close", interfaceText("commands.closeSavedProjects"), "", projects.tabs.size < 2], {2: {key: "commands.closeSavedProjects", params: {}}}),
  ];
}
function showMenu(anchor) {
  const items = [
    ...foldedMenubarItems(),
    ...openProjectsMenu(),
    // The palette's row shows its first key only (Ctrl+P), from the registry.
    { command: "command-palette", icon: "search", label: commands.label("command-palette"), labelKey: "overlays.palette.open",
      shortcut: commands.shortcut("command-palette"), keyshortcuts: commands.keyShortcuts("command-palette") },
    null,
    messageTuple(["new", "plus", interfaceText("app.newAnimation"), "Ctrl N"], {2: {key: "app.newAnimation", params: {}}}),
    messageTuple(["open", "folder", interfaceText("app.openProject"), "Ctrl O"], {2: {key: "app.openProject", params: {}}}),
    messageTuple(["open-recent", "clock", interfaceText("app.openRecent"), "", !desktop?.listRecentFiles], {2: {key: "app.openRecent", params: {}}}),
    messageTuple(["save", "save", interfaceText("common.save"), "Ctrl S"], {2: {key: "common.save", params: {}}}),
    messageTuple(["save-as", "save", interfaceText("common.saveAs"), "Ctrl Shift S"], {2: {key: "common.saveAs", params: {}}}),
    null,
    messageTuple(["undo", "undo", interfaceText("common.undo"), "Ctrl Z"], {2: {key: "common.undo", params: {}}}),
    messageTuple(["redo", "redo", interfaceText("common.redo"), "Ctrl Shift Z"], {2: {key: "common.redo", params: {}}}),
    null,
    messageTuple(["import", "import", interfaceText("app.importFigures"), ""], {2: {key: "app.importFigures", params: {}}}),
    messageTuple(["import-sprite", "frame", interfaceText("app.importSpriteImage"), ""], {2: {key: "app.importSpriteImage", params: {}}}),
    messageTuple(["import-background", "frame", interfaceText("app.importBackgroundImage"), ""], {2: {key: "app.importBackgroundImage", params: {}}}),
    messageTuple(["add-text", "text", interfaceText("app.createText"), "T"], {2: {key: "app.createText", params: {}}}),
    messageTuple(["export", "export", interfaceText("common.export"), ""], {2: {key: "common.export", params: {}}}),
    null,
    messageTuple(["settings", "settings", interfaceText("app.settings"), "Ctrl ,"], {2: {key: "app.settings", params: {}}}),
    messageTuple(["help", "help", interfaceText("app.keyboardShortcuts"), "?"], {2: {key: "app.keyboardShortcuts", params: {}}}),
    messageTuple(["performance", "activity", interfaceText("app.performance"), ""], {2: {key: "app.performance", params: {}}}),
  ];
  showCommandMenu(items, anchor);
}
/**
 * Opens a command menu below `anchor` (an element, whose second press closes
 * it again) or at a point ({left, bottom}, a context menu; `invoker` is where
 * focus returns). Returns the menu, or null when the press closed it.
 */
function showCommandMenu(items, anchor, { label, labelKey, labelParams, placement } = {}) {
  const element = anchor?.nodeType === 1 ? anchor : null;
  const open = element && menuFor(element);
  if (open) {
    open.close("toggle", { restore: true });
    return null;
  }
  lastMenuAnchor = anchor;
  const invoker = element ?? anchor?.invoker ?? document.activeElement;
  // Opened from inside a kit popover (a saved layout's card), the menu mounts inside that popover
  // instead of the #menu host, so choosing a row does not light-dismiss the popover.
  const inPopover = Boolean(invoker?.closest?.(".ui-popover:popover-open"));
  return openMenu({
    ...menuOptions,
    ...(inPopover ? { host: undefined } : {}),
    items: menuItems(items),
    ...(element ? { anchor: element } : { point: { x: anchor.left ?? anchor.x ?? 0, y: anchor.bottom ?? anchor.y ?? 0 } }),
    ...(label ? { label, labelKey, labelParams } : {}),
    ...(placement ? { placement } : {}),
    invoker,
  });
}
/** Adds another copy of a figure or clip already in the project (the Add menu's In this project, the Insert dialog). */
function addProjectFigure(id) {
  pause();
  if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo2"), "app.finishTheFigureOrReturnToAnimateTo2", {});
  if (rangeFrames()) editor.addFigureInFrames(id, rangeFrames());
  else editor.addFigure(id);
  if ($("insert-dialog").open) $("insert-dialog").close();
  setTool("select");
}
// The Add menu lists at most this many of the project's figures; All in this project… shows every one, with search.
const ADD_MENU_PROJECT_ROWS = 10;
/**
 * The Add menu (experience.md §3.3): the rail's + in Animate, and in Draw the +'s corner tick, led there by New
 * drawing layer. What today's Insert dialog added, one list: a stick figure, text, an image, figures from a file,
 * a movieclip; another copy of a figure already in the project; the examples.
 */
function addMenuItems({ draw = false } = {}) {
  const figureIcon = (figure) => (isMovieclip(figure) ? "frame" : figure.text_assets?.length ? "text" : figure.image_assets?.length ? "image" : "person");
  const figures = editor.report.figure_types ?? [];
  const project = figures.slice(0, ADD_MENU_PROJECT_ROWS).map((figure) => ({
    label: String(figure.name || `Figure ${figure.figure_type_id}`), icon: figureIcon(figure), run: () => addProjectFigure(figure.figure_type_id),
  }));
  const samples = (state.samples ?? []).map((sample) => ({ label: sample.name, icon: sample.kind === "stk" ? "person" : "file",
    run: () => { if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo3"), "app.finishTheFigureOrReturnToAnimateTo3", {}); openSample(sample.path).catch(fail); } }));
  return [
    ...(draw ? [{ label: interfaceText("app.newDrawingLayer"), labelKey: "app.newDrawingLayer", icon: "brush", run: () => drawingController?.run(() => drawingController.action("new")) }, null] : []),
    messageTuple(["add-figure", "person", interfaceText("app.stickFigure")], {2: {key: "app.stickFigure", params: {}}}),
    // The Add menu's own short names (today's Insert dialog: Text, Image), not the File menu's longer ones.
    { command: "add-text", icon: "text", label: interfaceText("app.text"), labelKey: "app.text", shortcut: menuShortcut("add-text", "T") },
    { command: "import-sprite", icon: "image", label: interfaceText("app.image"), labelKey: "app.image", shortcut: "" },
    messageTuple(["import", "import", interfaceText("app.importFigures")], {2: {key: "app.importFigures", params: {}}}),
    messageTuple(["movieclip-new", "frame", interfaceText("app.movieclip")], {2: {key: "app.movieclip", params: {}}}),
    messageTuple(["movieclip-create", "frame", interfaceText("app.movieclipFromSelection"), "", !editor.object], {2: {key: "app.movieclipFromSelection", params: {}}}),
    messageTuple(["movieclip-range", "frame", interfaceText("app.movieclipFromFrames")], {2: {key: "app.movieclipFromFrames", params: {}}}),
    null,
    ...(project.length ? [{ label: interfaceText("app.inThisProject"), labelKey: "app.inThisProject" }, ...project] : []),
    { label: figures.length > ADD_MENU_PROJECT_ROWS ? interfaceText('app.allLengthInThisProject', {length: figures.length}) : interfaceText("app.allInThisProject"), labelKey: (figures.length > ADD_MENU_PROJECT_ROWS ? 'app.allLengthInThisProject' : "app.allInThisProject"), labelParams: (figures.length > ADD_MENU_PROJECT_ROWS ? {length: figures.length} : {}), icon: "layers",
      run: () => studioShell?.showInsertDialog() },
    null,
    { label: interfaceText("app.examples"), labelKey: "app.examples", icon: "layers", submenu: [{ command: "rig-examples", icon: "person", label: interfaceText("app.rigExamples2"), labelKey: "app.rigExamples2" }, ...(samples.length ? [{ label: interfaceText("app.animations"), labelKey: "app.animations" }, ...samples] : [])] },
  ];
}
/** Opens the Add menu beside the rail's +. */
function showAddMenu(anchor) {
  if (builderMode?.active) return;
  return showCommandMenu(addMenuItems({ draw: Boolean(drawingController?.active) }), anchor, { label: interfaceText("app.add"), labelKey: "app.add", placement: "right-start" });
}
/** The variants a rail tool's corner tick lists (experience.md §3.2): Select pixels' shapes, and Shapes' kinds. */
const RAIL_VARIANTS = {
  lasso: { tool: "drawing-lasso", setting: "selectShape", label: interfaceText("app.selectionShape"), labelKey: "app.selectionShape",
    items: [messageTuple(["lasso", "lasso", interfaceText("app.lasso")], {2: {key: "app.lasso", params: {}}}), messageTuple(["rect", "sel-rect", interfaceText("app.rectangle")], {2: {key: "app.rectangle", params: {}}}), messageTuple(["ellipse", "sel-ellipse", interfaceText("app.ellipse")], {2: {key: "app.ellipse", params: {}}}), messageTuple(["wand", "wand", interfaceText("app.wand")], {2: {key: "app.wand", params: {}}})] },
  shape: { tool: "drawing-shape", setting: "shapeKind", label: interfaceText("app.shape"), labelKey: "app.shape",
    items: [messageTuple(["line", "line", interfaceText("app.line")], {2: {key: "app.line", params: {}}}), messageTuple(["rect", "shape-rect", interfaceText("app.rectangle")], {2: {key: "app.rectangle", params: {}}}), messageTuple(["ellipse", "shape-ellipse", interfaceText("app.ellipse")], {2: {key: "app.ellipse", params: {}}})] },
};
/** Lists a rail tool's variants (or the Add menu for the +); choosing one switches to the tool with that variant. */
function showRailMenu(kind, anchor) {
  if (kind === "add") return showAddMenu(anchor);
  const variants = RAIL_VARIANTS[kind], drawing = drawingController;
  if (!variants || !drawing) return;
  const current = drawing.settings[variants.setting];
  return showCommandMenu(variants.items.map((_tuple) => {const [value, glyph, label] = _tuple; const _messages = tupleMessages(_tuple); return {
    label, ...(_messages[2] ? {labelKey: _messages[2].key, labelParams: _messages[2].params} : {}), icon: glyph, radio: true, checked: current === value,
    run: () => { drawing.settings[variants.setting] = value; setTool(variants.tool); drawing.onUI(); drawing.onRender(); },
  };}), anchor, { label: variants.label, placement: "right-start" });
}
function showZoomMenu(anchor) {
  showCommandMenu(
    [
      messageTuple(["zoom-in", "plus", interfaceText("app.zoomIn"), "+"], {2: {key: "app.zoomIn", params: {}}}),
      messageTuple(["zoom-out", "minus", interfaceText("app.zoomOut"), "−"], {2: {key: "app.zoomOut", params: {}}}),
      null,
      messageTuple(["zoom-reset", "frame", interfaceText("app.fitCanvas"), "Shift 1"], {2: {key: "app.fitCanvas", params: {}}}),
      messageTuple(["zoom-selection", "center", interfaceText("app.fitSelection"), "Shift 2", !editor.object], {2: {key: "app.fitSelection", params: {}}}),
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
    if (state.drag?.kind === 'tweener') {cancelDrag();state.suppressContext=false;return;}
    if (state.suppressContext) return;
    // Some platforms emit contextmenu on mouse-down. Wait until we know
    // whether this press is a click or a bend; never open a menu mid-gesture.
    if (state.drag?.kind === "maybe-bend") {
      state.drag.contextMenuOnPress = true;
      return;
    }
    if(construction?.active) {showCommandMenu([messageTuple(["chain-finish","check",interfaceText("app.finishChain"),"Enter"], {2: {key: "app.finishChain", params: {}}}),messageTuple(["chain-cancel","close",interfaceText("app.cancelChain"),interfaceText("app.esc")], {2: {key: "app.cancelChain", params: {}}, 3: {key: "app.esc", params: {}}})],{left:e.clientX,bottom:e.clientY});return;}
    pause();
    const hit = pick(worldPoint(e), {artwork: true});
    if (builderMode?.active) {
      const fill = !hit && pickFigureFill(editor.geometry.objects.get(editor.selectedSlot),worldPoint(e));
      if(fill)editor.selectPolygon(editor.selectedUid,fill.index);
      return builderMode.showContextMenu({hit,entry:fill?{kind:'polygon',index:fill.index}:undefined,x:e.clientX,y:e.clientY});
    }
    if (hit && !isSelected(hit.g.obj.unique_id))
      editor.select(hit.g.obj.unique_id, hit.joint);
    if (hit && selection().size <= 1)
      editor.select(hit.g.obj.unique_id, hit.joint);
    // The canvas's menus (revision 5): named groups, the rarer paste kinds in a submenu, and Delete last.
    const pasteKinds = [
      messageTuple(["paste-in-place", "clipboard", interfaceText("app.pasteInPlace"), "Ctrl Shift V"], {2: {key: "app.pasteInPlace", params: {}}}),
      messageTuple(["paste-instance", "clipboard", interfaceText("app.pasteInstance")], {2: {key: "app.pasteInstance", params: {}}}),
      messageTuple(["paste-unique", "duplicate", interfaceText("app.pasteUniqueCopy")], {2: {key: "app.pasteUniqueCopy", params: {}}}),
    ];
    const joint = hit && hit.joint >= 0 && !editor.figure?._styk?.movieclip && selection().size <= 1;
    const items = !hit ? [
      { label: interfaceText("common.paste"), labelKey: "common.paste" },
      messageTuple(["paste", "clipboard", interfaceText("common.paste"), "Ctrl V"], {2: {key: "common.paste", params: {}}}),
      ...pasteKinds,
      null,
      messageTuple(["select-all", "cursor", interfaceText("app.selectAll"), "Ctrl A"], {2: {key: "app.selectAll", params: {}}}),
      null,
      messageTuple(["scene-settings", "scene", interfaceText("app.sceneProperties")], {2: {key: "app.sceneProperties", params: {}}}),
      messageTuple(["zoom-reset", "fit", interfaceText("app.fitCanvas"), "Shift 1"], {2: {key: "app.fitCanvas", params: {}}}),
    ] : [
      { label: selection().size > 1 ? interfaceText('counts.figures', {count: selection().size}) : editor.figure?.name || interfaceText("app.figure") },
      messageTuple(["copy", "duplicate", interfaceText("common.copy"), "Ctrl C"], {2: {key: "common.copy", params: {}}}),
      messageTuple(["paste", "clipboard", interfaceText("common.paste"), "Ctrl V"], {2: {key: "common.paste", params: {}}}),
      { label: interfaceText("app.pasteAs"), labelKey: "app.pasteAs", icon: "clipboard", submenu: pasteKinds },
      messageTuple(["duplicate", "duplicate", interfaceText("common.duplicate"), "Ctrl D"], {2: {key: "common.duplicate", params: {}}}),
      null,
      messageTuple(["mirror", "flip", interfaceText("app.flipHorizontally"), "Shift H"], {2: {key: "app.flipHorizontally", params: {}}}),
      messageTuple(["mirror-vertical", "flip-vertical", interfaceText("app.flipVertically"), "Shift V"], {2: {key: "app.flipVertically", params: {}}}),
      joinMenuItem(),
      ...(joint ? [messageTuple(["disconnect-segment", "cut", interfaceText("app.disconnectSegment"), "", !canDisconnectSegment()], {2: {key: "app.disconnectSegment", params: {}}})] : []),
      messageTuple(["camera-follow", "camera", interfaceText("app.followWithCamera"), "", Boolean(builderMode?.active)], {2: {key: "app.followWithCamera", params: {}}}),
      ...(joint ? [messageTuple(["segment-values", "sliders", interfaceText("app.exactValues"), "I"], {2: {key: "app.exactValues", params: {}}})] : []),
      messageTuple(["selection-more", "more", interfaceText("app.moreFigureActions")], {2: {key: "app.moreFigureActions", params: {}}}),
      ...(!builderMode?.active && !editor.figure?._styk?.movieclip ? [
        null,
        messageTuple(["edit-in-build-mode", "nodes", interfaceText("app.editInBuild"), "", selection().size !== 1], {2: {key: "app.editInBuild", params: {}}}),
      ] : []),
      null,
      ["delete", "trash", "Delete", "Delete"],
    ];
    showCommandMenu(items, { left: e.clientX, bottom: e.clientY });
  }),
);
const spatialControls=installSpatialControls({editor,root:$("inspector"),refresh:()=>{queueUI();requestRender();},guard:guarded});
const rigHost=()=>({editor,showDialog,closeDialog,finish:()=>{pause();finishCurrentEdit();},builderActive:()=>Boolean(builderMode?.active),
  addToAnimate:document=>{
    pause();finishCurrentEdit();
    const layer=editor.getLayer(editor.activeLayerId);
    if(layer?.locked)throw messageError(new Error(''), "errors.app.unlockTheDestinationLayerBeforeAddingAnAsset", {});
    if(layer?.visible===false)throw messageError(new Error(''), "errors.app.chooseAVisibleDestinationLayerBeforeAddingAn", {});
    builderMode?.keepChangesAndLeave();
    const object=editor.importFigure(document),figure=editor.figure;
    const control=figure._styk?.rigExample?.control;
    setTool('select');state.inspectorContext='figure';
    editor.select(object.unique_id,figure.segments.findIndex(s=>s.segment_id===control));
    window.styk?.library?.showView('properties');
    fitSelection();queueUI();
    toast(interfaceText("app.addedToAnimate", {name: figure.name}), "app.addedToAnimate", {name: figure.name});
    return object;
  }});
const beginRigAnchorPick=key=>{
  const s=editor.figure?.segments[editor.selectedJoint];if(!editor.figure||(!s&&key))return toast(interfaceText("app.selectAJointFirst"), "app.selectAJointFirst", {});
  const ids=[...editor.selectedSegmentIds];
  if(!key&&ids.length===2){editor.addConnector(ids[0],ids[1]);toast(interfaceText("app.connectorAddedDragItsMiddleJointToSlide"), "app.connectorAddedDragItsMiddleJointToSlide", {});return;}
  setTool('rig');state.rigAnchorPick={key,start:s?.segment_id??0,uid:editor.selectedUid,token:editor._documentToken};
  syncModeMessage();
};
function pasteFigures(pasteMode = 'default', offset) {
  if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo4"), "app.finishTheFigureOrReturnToAnimateTo4", {});
  return sharedClipboard.paste('figures', () => {
    finishCurrentEdit();
    const options = {pasteMode, offset, pasteDepth: state.settings.pasteDepth};
    if (editor._selectionClipboard?.freshTypes?.size) return editor.pasteSelection(options);
    if (rangeFrames()) return editor.pasteFiguresInFrames(rangeFrames(), options);
    return editor.pasteSelection(options);
  });
}
function selectedFigureJoinAction() {
  const action = figureJoinAction(editor);
  return action && !builderMode?.active && !isHidden(action.uid) && !isLocked(action.uid) ? action : null;
}
function joinMenuItem() {
  const action = selectedFigureJoinAction();
  return ['join-figure', action?.kind === 'unjoin' ? 'detach' : 'link',
    state.figureJoin ? interfaceText("app.cancelJoining") : action?.kind === 'unjoin' ? interfaceText("app.unjoinFigure") : interfaceText("app.joinFigure"),
    '', !action];
}
/** Disconnect segment applies to the selected joint's branch of a visible, unlocked figure in Animate. */
function canDisconnectSegment() {
  return !builderMode?.active && Boolean(editor.object) && !isHidden(editor.selectedUid) && !isLocked(editor.selectedUid) && editor.canDisconnectSegment();
}
function disconnectSegment() {
  if (builderMode?.active || isHidden(editor.selectedUid)) return;
  if (isLocked(editor.selectedUid)) throw messageError(new Error(''), "errors.editorDisconnect.unlockTheFigureBeforeDisconnectingASegment", {});
  pause(); finishCurrentEdit();
  editor.disconnectSegment();
  status({messageKey: "app.segmentDisconnected", messageParams: {}});
}
function toggleFigureJoin() {
  if (state.figureJoin) {setTool('select'); return;}
  pause(); finishCurrentEdit();
  const action = selectedFigureJoinAction();
  if (!action) return;
  const indices = rangeFrames();
  if (action.kind === 'unjoin') {
    editor.detachFiguresInFrames(indices, {uids: [action.uid], atPlayhead: !indices});
    status({messageKey: "app.figureUnjoined", messageParams: {}});
    return;
  }
  const targets = joinTargetUids(editor.selectionFrame, action.uid);
  for (const uid of targets) if (isHidden(uid) || isLocked(uid)) targets.delete(uid);
  if (!targets.size) {toast(interfaceText("app.addOrUnlockAnotherFigureToJoinTo"), "app.addOrUnlockAnotherFigureToJoinTo", {}); return;}
  state.figureJoin = {uid: action.uid, token: editor._documentToken, tick: editor.tick,
    frameIndex: editor.frameIndex, revision: editor.revision, indices, targets};
  setTool('attach');
  viewport.focus({preventScroll: true});
}
const actions = {
  'join-figure': toggleFigureJoin,
  /** A follow clip for the selected figures from the playhead, opened in Camera → Motion. */
  'camera-follow': () => {
    if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo5"), "app.finishTheFigureOrReturnToAnimateTo5", {});
    if (!selection().size) return toast(interfaceText("app.selectTheFiguresTheCameraShouldFollow"), "app.selectTheFiguresTheCameraShouldFollow", {});
    pause(); finishCurrentEdit();
    editor._selectedCameraMotion = editor.addCameraMotion('follow');
    editor._cameraInspectorTab = 'motion'; editor._cameraMotionAdding = false;
    state.selectedTrackId = 'camera'; state.inspectorContext = 'camera'; state.inspectorTab = 'design';
    if (!state.settings.showCamera) editorSettings?.commit({ showCamera: true });
    status(selection().size > 1 ? {messageKey: "app.theCameraFollowsTheSelectedFigures", messageParams: {}} : {messageKey: "app.theCameraFollowsThisFigure", messageParams: {}});
    queueUI(); requestRender();
  },
  'rig-connect':()=>beginRigAnchorPick(),
  'rig-weighted':()=>{const s=editor.figure?.segments[editor.selectedJoint];if(s)editor.addWeightedJoint(s.parent_id,[{joint:s.segment_id,weight:.5}]);},
  'rig-pick-start':()=>beginRigAnchorPick('start'),
  'rig-pick-end':()=>beginRigAnchorPick('end'),
  'rig-pick-driver':()=>beginRigAnchorPick('driver'),
  'rig-bind-branch':()=>editor.bindStretchParts(editor.figure.segments[editor.selectedJoint].segment_id,{branch:true}),
  'rig-test':()=>openRigTest(rigHost()),
  'rig-examples':()=>openRigExamples(rigHost()),
  "edit-in-build-mode": () => {
    if (editor.object && selection().size === 1 && !editor.figure?._styk?.movieclip)
      studioShell?.changeMode('rig');
  },
  "selection-more": () => showCommandMenu([
    { label: interfaceText("app.select"), labelKey: "app.select" },
    messageTuple(["select-same", "person", interfaceText("app.selectSameFigure")], {2: {key: "app.selectSameFigure", params: {}}}),
    messageTuple(["select-invert", "cursor", interfaceText("app.invertSelection")], {2: {key: "app.invertSelection", params: {}}}),
    null,
    { label: interfaceText("app.pose"), labelKey: "app.pose" },
    messageTuple(["locate-previous", "match-prev", interfaceText("app.matchPreviousPose"), "L"], {2: {key: "app.matchPreviousPose", params: {}}}),
    messageTuple(["locate-next", "match-next", interfaceText("app.matchNextPose"), "Shift L"], {2: {key: "app.matchNextPose", params: {}}}),
    joinMenuItem(),
    null,
    messageTuple(["add-to-library", "plus", interfaceText("app.addToLibrary")], {2: {key: "app.addToLibrary", params: {}}}),
    messageTuple(["zoom-selection", "center", interfaceText("app.fitSelection"), "Shift 2"], {2: {key: "app.fitSelection", params: {}}}),
  ], lastMenuAnchor || viewport, { label: interfaceText("app.moreFigureActions2"), labelKey: "app.moreFigureActions2" }),
  "segment-values": () => showSegmentValues(),
  menu: (e) =>
    showMenu(e?.closest?.("button") || document.querySelector(".brand")),
  open: openFile,
  'new-window': () => desktop?.newWindow(),
  import: () => {
    if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo6"), "app.finishTheFigureOrReturnToAnimateTo6", {});
    $("file-input").value = "";
    $("file-input").click();
  },
  save: () => saveNative(),
  "save-as": () => saveNative({ saveAs: true }),
  'check-updates': () => updateNotice?.check(),
  'release-notes': () => releaseSplash.open(),
  donate: () => desktop?.openDonate(),
  'restart-update': () => finishDocumentAction('restartForUpdate'),
  'save-and-update': () => saveEveryProjectThen('restartForUpdate'),
  "save-and-close": () => saveEveryProjectThen('close'),
  new: async () => {
    pause();
    if (!await openProject((session) => editor.newDocument(session), { blank: true })) return;
    telemetry.performance.resources('closed');telemetry.performance.closedAt=performance.now();
    state.hidden.clear();
    state.locked.clear();
    images.clear();
    fit();
  },
  // Project tabs (project-tabs-host.mjs): Ctrl+W closes the one in front, Ctrl+Tab goes to the one used before it.
  "close-project": () => projects.close(),
  "close-saved-projects": () => projects.closeSaved(),
  "next-project": () => { const next = projects.tabs.neighbour(1); return next ? projects.activate(next.id) : false; },
  "previous-project": () => { const next = projects.tabs.neighbour(-1); return next ? projects.activate(next.id) : false; },
  "recent-project": () => projectSwitcher.open(),
  "save-all": () => projects.saveAll(() => saveNative()),
  undo: () => {
    pause();
    if (state.polygon) {
      state.polygon.draft.undo();
      refreshPolygonDraft();
      return;
    }
    if (cameraMotionControls?.active) propertyControls?.cancel();
    cameraMotionControls?.cancel();
    vfxInspector?.finishForHistory();
    vfxGizmos?.up();
    return drawingController?drawingController.history('undo'):editor.undo();
  },
  redo: () => {
    pause();
    if (state.polygon) {
      state.polygon.draft.redo();
      refreshPolygonDraft();
      return;
    }
    if (cameraMotionControls?.active) propertyControls?.cancel();
    cameraMotionControls?.cancel();
    vfxInspector?.finishForHistory();
    vfxGizmos?.up();
    return drawingController?drawingController.history('redo'):editor.redo();
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
  "previous-keyframe": () => { pause(); runTimelineHotkey(timelineUI, 'previous-keyframe'); },
  "next-keyframe": () => { pause(); runTimelineHotkey(timelineUI, 'next-keyframe'); },
  "add-frame": () => addFrameKeepingDrag(() => {
    if(editor.getLayer(editor.activeLayerId)?.drawing)return editor.addDrawingFrame();
    if(state.settings.timelineMode !== 'simple')
      return timelineUI.addFrameCell();
    const result=editor.sheetDuplicateFrameAfter(['scene','camera',...editor.report._styk.layers.order]);
    timelineUI.revealPlayhead();
    return result;
  }),
  "extend-keyframe": () => {
    pause();finishCurrentEdit();
    if(drawingController?.active)return editor.extendDrawing(timelineUI?.ids?.length?timelineUI.ids:[editor.activeLayerId],drawingController.settings.length);
    return timelineUI.extendKeyframe();
  },
  "delete-frame": () => {
    pause();
    return state.settings.timelineMode === "simple"?timelineUI.action("delete"):timelineUI.removeFrames();
  },
  "add-figure": () => {
    pause();
    if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo7"), "app.finishTheFigureOrReturnToAnimateTo7", {});
    if (rangeFrames()) editor.addFigureInFrames(undefined, rangeFrames());
    else editor.addFigure();
  },
  "add-text": () => {
    if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo8"), "app.finishTheFigureOrReturnToAnimateTo8", {});
    showTextDialog();
  },
  "edit-text": () => showTextDialog(true),
  "attach-figure": toggleFigureJoin,
  "detach-figure": () => {if (selectedFigureJoinAction()?.kind === 'unjoin') toggleFigureJoin();},
  "disconnect-segment": disconnectSegment,
  "combine-figures": () => {
    const roots = editor.resolveTranslationSelection().rootUids;
    if (roots.length !== 1)
      throw messageError(new Error(''), "errors.app.selectFiguresInOneConnectedGroup", {});
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
  "palette-previous": () => { state.palettePage=Math.max(0,(state.palettePage||0)-1);renderInspector(); },
  "palette-next": () => { state.palettePage=(state.palettePage||0)+1;renderInspector(); },
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
  "copy-builder-appearance": () => {
    if (!builderMode?.active) return;
    state.builderAppearance = copyBuilderAppearance(editor);
    builderMode.sync();
    if (state.builderAppearance) notify(interfaceText("app.appearanceCopied"), "app.appearanceCopied", {});
  },
  "paste-builder-appearance": (button, event) => {
    if (!builderMode?.active) return;
    if (pasteBuilderAppearance(editor, state.builderAppearance, {branch:usesBuilderBranch(event)})) notify(interfaceText("app.appearancePasted"), "app.appearancePasted", {});
  },
  "unsplit-segment": () => editor.unsplitSegment(),
  "delete-single-segment": () => editor.selectedSegmentIds.size > 1
    ? editor.deleteSegment({handleIds:editor.selectedSegmentIds,branch:false}) : editor.deleteSingleSegment(),
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
  "delete-segment": () => editor.deleteSegment({handleIds:editor.selectedSegmentIds}),
  duplicate: () => {
    pause();
    if (editor.branchSelected) return editor.duplicateSelection();
    if (rangeFrames()) editor.duplicateInFrames(rangeFrames());
    else if (selection().size > 1) editor.duplicateSelection();
    else editor.duplicateFigure();
  },
  delete: () => {
    pause();
    // Builder scope belongs to the workspace, including Select-tool posing.
    // Removing its instance would cause the session to recreate a default pose.
    if (builderMode?.active && editor.selectedPolygonIndex >= 0) return editor.removePolygon(editor.selectedPolygonIndex);
    if (builderMode?.active || state.tool === 'rig') {
      if (editor.selectedJoint >= 0)
        return usesBuilderBranch() ? actions['delete-segment']() : actions['delete-single-segment']();
      if (builderMode?.active) return toast(interfaceText("app.selectASegmentOrBranchToDelete"), "app.selectASegmentOrBranchToDelete", {});
    }
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
  "reset-color": () => editor.resetFigureColors({indices:rangeFrames()}),
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
    return sharedClipboard.copy('figures', () => { finishCurrentEdit(); return editor.copySelection(); });
  },
  cut: () => {
    if (document.activeElement?.closest("#timeline"))
      return timelineUI.cutSelection();
    return sharedClipboard.copy('figures', () => {
      finishCurrentEdit();
      if (editor.branchSelected) return editor.cutSelection();
      if (rangeFrames()) {
        const count = editor.copySelection({ inPlace: true });
        if (count) editor.deleteFiguresInFrames(rangeFrames());
        return count;
      }
      return editor.cutSelection();
    });
  },
  paste: () => {
    if (document.activeElement?.closest("#timeline"))
      return timelineUI.pasteSelection();
    return pasteFigures();
  },
  'paste-in-place': () => {
    if (document.activeElement?.closest("#timeline"))
      return timelineUI.pasteSelection();
    return pasteFigures('default', 0);
  },
  'paste-instance': () => pasteFigures('instance'),
  'paste-unique': () => pasteFigures('unique'),
  "select-all": () => {
    if (document.activeElement?.closest("#timeline")) timelineUI.selectAll?.();
    else
      editor.selectMany(
        editor.selectionFrame.objects
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
    onionController.sync();
    requestRender();
  },
  "toggle-isolate": () => {
    flushPoseMove(); state.isolateMode = !state.isolateMode;
    document.querySelectorAll('[data-action="toggle-isolate"]').forEach((button) => {
      button.setAttribute("aria-pressed", String(state.isolateMode));
      button.classList.toggle("active", state.isolateMode);
    });
  },
  "toggle-builder-branch": () => {
    state.builderBranch = !state.builderBranch;
    document.querySelectorAll('[data-action="toggle-builder-branch"]').forEach((button) => {
      button.setAttribute("aria-pressed", String(state.builderBranch));
      button.classList.toggle("active", state.builderBranch);
    });
    renderInspector();
  },
  "toggle-unselected-handles": () =>
    editorSettings.commit({
      showUnselectedHandles: !state.settings.showUnselectedHandles,
    }),
  "toggle-selection-origins": () => {
    if (builderMode?.active || drawingController?.active || state.drag) return;
    editorSettings.commit({marqueeSelection: state.settings.marqueeSelection === 'origins' ? 'bounds' : 'origins'});
  },
  "toggle-range-edit": () => {
    if (builderMode?.active || drawingController?.active || state.drag || !rangeFrames(true)) return;
    state.applyRange = !state.applyRange;
    queueUI();
  },
  "toggle-handles": () => {
    editorSettings.commit({ showHandles: !state.handles });
    requestRender();
  },
  // The stage header's Grid (the split button's toggle; its chevron opens Grid and guides).
  "toggle-grid": () => editorSettings.commit({ canvasGrid: !state.settings.canvasGrid }),
  "toggle-motion-paths": () => {
    editorSettings.commit({ motionPaths: !state.motionPaths });
    if (!state.motionPaths) { state.hoverPathPoint = null; syncPathTooltip(); }
    status(state.motionPaths ? {messageKey: "app.motionPathsOn", messageParams: {}} : {messageKey: "app.motionPathsOff", messageParams: {}});
    requestRender();
  },
  // The timeline header's Audio button (the Animation menu's row where the header folds it).
  "toggle-audio": () => $("timeline-audio")?.click(),
  "toggle-auto-key": () => {
    if (state.settings.timelineMode === "simple") return toast(interfaceText("app.autoKeyWorksInTheAdvancedTimeline"), "app.autoKeyWorksInTheAdvancedTimeline", {});
    editorSettings.commit({ autoKey: !state.settings.autoKey });
    status(state.settings.autoKey ? {messageKey: "app.autoKeyOnEditsAddKeyframesAtThe", messageParams: {}} : {messageKey: "app.autoKeyOff", messageParams: {}});
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
  "scene-settings": () => {
    selectTrack({ id: "scene", kind: "scene" });
    // Where the inspector is a sheet (a phone, an upright tablet), asking for the Scene's properties shows them.
    if (shell?.presentation("properties") === "sheet") shell.showPanel("properties", { focus: false });
  },
  settings: () => editorSettings?.open(),
  privacy: () => privacyUI.open(),
  feedback: () => feedbackUI.open(),
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
  // The band's Done in a camera session: back to the figure the camera session kept selected, or the Scene.
  "camera-done": () => {
    if (!cameraSelected()) return;
    finishCurrentEdit();
    const uid = editor.selectedUid;
    state.inspectorContext = uid == null ? "scene" : "figure";
    state.inspectorTab = "design";
    state.selectedTrackId = uid == null ? editor.activeLayerId : layerIdForUid(editor.report, uid);
    queueUI();
    requestRender();
  },
  "camera-paste": () => editor.pasteCamera(rangeFrames()),
  "camera-guides": () => {state.cameraGuides=!state.cameraGuides;$('inspector').querySelector('[data-action="camera-guides"]')?.setAttribute('aria-pressed',String(state.cameraGuides));requestRender();},
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
  "command-palette": () => palette.open(),
  help: showHelp,
  about: showHelp,
  minimize: () => desktop?.minimize(),
  maximize: () => desktop?.maximize(),
  close: async () => {
    await workspaceLayout?.flushPreferences?.();
    await editorSettings?.flush();
    await desktop?.close();
  },
};
// The export flow and the app's prompts add their commands (src/export-flow.mjs, src/app-dialogs.mjs).
const exportFlow = createExportFlow({
  editor, state, actions, desktop, telemetry, audioEngine, exportJobs, playback,
  fail, status, toast, persistentFailure, finishCurrentEdit, pause, interruptRecovery,
  runDocumentExport, writeNativeBlob, currentFrame, nameOf, simpleFrameCount,
  // The export dialog joins the overlay stack, uses the app's words and remembers its choices in the editor settings.
  overlays, localization: () => appLocalization, commitSettings: patch => editorSettings?.commit(patch),
});
const dialogs = createAppDialogs({
  editor, state, $, esc, actions, desktop, overlays, playbackMetrics, guarded, pause, finishCurrentEdit,
  showDialog, closeDialog, promptText, saveNative, acceptNativeFile, updateTitle, localization: () => appLocalization,
  activity: () => activityLog,
});
// The open projects in the band (shell/project-tabs-view.mjs) and Ctrl+Tab's board (shell/project-switcher.mjs).
const projectTabsView = installProjectTabs($("project-tabs"), {
  tabs: projects.tabs,
  icon: (name) => icon(name),
  activate: guarded((id) => projects.activate(id)),
  close: guarded((id) => projects.close(id)),
  rename: guarded(async (id) => { if (await projects.activate(id)) return actions.rename(); }),
  menu: (id, point) => showCommandMenu(projectMenuItems(id), point, { label: interfaceText("projectTabs.openProjects"), labelKey: "projectTabs.openProjects" }),
});
const projectSwitcher = createProjectSwitcher({
  tabs: projects.tabs, anchor: $("project-tabs"), overlays,
  activate: guarded((id) => projects.activate(id)),
  picture: (id) => projectTabsView.picture(id),
});
// Home (src/home/home.mjs, docs/HOME.md): the page with the projects and the tutorials, over the workspace.
const home = createHome({
  root: $("home"), editor, state, actions, desktop, overlays, guarded, fail, toast, fit, pause, acceptNativeFile,
  menu: (items, anchor, options) => showCommandMenu(items, anchor, options),
  prompt: (options) => promptText({ ...options, overlays, t: kitT }),
  // A listed project that is already open comes to the front as it was left.
  activateDocument: (token) => {
    if (state.documentToken === token) return true;
    const open = projects.tabs.items.find((item) => item.state?.documentToken === token);
    return open ? projects.activate(open.id) : false;
  },
  picture: () => projectTabsView.picture(projects.tabs.activeId),
  focusStage: () => viewport.focus({ preventScroll: true }),
  settings: () => editorSettings, tutorials: () => tutorials, studio: () => studioShell,
  startupView: desktop?.startupView ?? window.stykStartupView,
});
// The tutorials (src/tutorials/tutorials.mjs, docs/TUTORIALS.md): guided steps in the editor itself, on a practice animation.
const tutorials = createTutorials({
  editor, state, actions, overlays, stageHead, toasts, guarded, fail, toast, fit, setTool, viewport, updateTitle, ready: editorReady,
  commands: () => commands, settings: () => editorSettings, shell: () => shell, timeline: () => timelineUI, studio: () => studioShell,
  home: () => home, touch: () => Boolean(touchMode?.active), mode: () => commandContext().mode, fitted: () => isFittedView(),
});
const polygonSafeActions = new Set([
  "close-project", "close-saved-projects", "next-project", "previous-project", "recent-project", "save-all",
  "menu",
  "command-palette",
  "settings",
  "privacy",
  "feedback",
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
/** True while a drawing stroke, load, pixel selection or operation must finish before a command runs. */
const drawingBusy = () => Boolean(drawingController?.gesture?.kind==='stroke'||drawingController?.loading||drawingController?.selection||drawingController?.operation);
for (const [name, action] of Object.entries(actions)) {
  actions[name] = (...args) => {
    if(drawingBusy())
      return drawingController.afterGesture(()=>actions[name](...args));
    if (state.polygon) {
      if (["new", "open", "open-recent", "close", "close-project", "close-saved-projects", "next-project", "previous-project", "recent-project"].includes(name))
        cancelPolygonDraft();
      else if (
        !polygonSafeActions.has(name) &&
        !name.startsWith("zoom-") &&
        !name.startsWith("toggle-")
      ) {
        toast(interfaceText("app.finishOrCancelThePolygonFirst"), "app.finishOrCancelThePolygonFirst", {});
        return false;
      }
    }
    telemetry.action(name);
    // A command that works on the animation sends Home away first; a tutorial hears which command ran.
    home.before(name);
    const result = action(...args);
    tutorials.ran(name);
    return result;
  };
}
document.addEventListener(
  "click",
  guarded((e) => {
    // The menubar opens its own menus (installMenuBar). Menus close themselves
    // on a press outside them, so a click that opens one (the Properties ⋯)
    // leaves it open.
    if (e.target.closest('[data-app-menu]')) return;
    const action = e.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "play" && !state.polygon) {
        if (state.previewing) return pause();
        if (e.ctrlKey || e.metaKey) return previewFrame();
      }
      const name = e.shiftKey ? action.dataset.shiftAction ?? action.dataset.action : action.dataset.action;
      if (name.startsWith('builder-context-')) return builderMode?.runContextCommand(name);
      return actions[name]?.(action, e);
    }
    const tool = e.target.closest("[data-tool]");
    if (tool) setTool(tool.dataset.tool);
    const asset = e.target.closest("[data-figure]");
    if (asset) {
      if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo2"), "app.finishTheFigureOrReturnToAnimateTo2", {});
      if (rangeFrames())
        editor.addFigureInFrames(Number(asset.dataset.figure), rangeFrames());
      else editor.addFigure(Number(asset.dataset.figure));
    }
    const sample = e.target.closest("[data-sample]");
    if (sample) {
      if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo3"), "app.finishTheFigureOrReturnToAnimateTo3", {});
      openSample(sample.dataset.sample).catch(fail);
    }
    const joint = e.target.closest("[data-joint]");
    if (joint) editor.select(editor.selectedUid, Number(joint.dataset.joint));
    const polygon = e.target.closest("[data-delete-polygon]");
    const connectorPart=e.target.closest('[data-connector-part]');
    if(connectorPart){const segment=editor.figure?.segments[editor.selectedJoint];if(segment?._stykRig?.connector){editor._connectorInspector={uid:editor.selectedUid,id:segment.segment_id,part:connectorPart.dataset.connectorPart};renderInspector();}return;}
    if (polygon) editor.removePolygon(Number(polygon.dataset.deletePolygon));
    const reference=e.target.closest('[data-polygon-reference]');
    if(reference&&builderMode?.active)openSurfaceReference(editor,Number(reference.dataset.polygonReference),{showDialog,closeDialog});
    const flip=e.target.closest('[data-polygon-flip]');
    if(flip&&builderMode?.active){const index=Number(flip.dataset.polygonFlip),surface=editor.figure.polyfills[index]._stykSurface;if(surface)editor.updatePolygon(index,{surface:{...surface,flipped:!surface.flipped}});}
  }),
);

installInspectorBindings($("inspector"), {
  editor, state, telemetry, guarded, pause, finishCurrentEdit, queueUI, requestRender, fit, changeFigureLayer,
  timeline: () => timelineUI, builderActive: () => Boolean(builderMode?.active), usesBuilderBranch, updateBuilderStyle,
  rangeFrames, selectionBounds, moveSelected, updateSelection, showDialog, closeDialog,
  // The header's quick actions read the command registry (built below) when the inspector renders.
  commands: () => commands, commandContext: () => commandContext(), t: (key, params) => kitT(key, params),
});
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
  if (e.defaultPrevented) { $("canvas-empty").hidden = true; return; }
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
    const handled = e.defaultPrevented;
    e.preventDefault();
    $("canvas-empty").hidden = true;
    if (!handled && e.dataTransfer.files.length)
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
  spatialControls?.finish(true);
  drawingController?.finish();
  pause();
  finishKeyboardHandle();
  endDrag();
  propertyControls?.commit();
  vfxInspector?.commit();
  if(cameraMotionControls?.active)cameraMotionControls.commit(cameraMotionControls.active.input);
  vfxGizmos?.up();
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
      editor.beginCameraDrag({ indices: rangeFrames(), label: interfaceText("app.nudgeCamera"), labelKey: "app.nudgeCamera" });
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
  const editMode = state.handleEditHeld;
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
    editMode: state.handleEditHeld,
  });
}
function hotkeyScopes(event) {
  const scopes = [];
  if(drawingController?.active&&!event.target.closest?.('.layer-timeline,.sheet-filmstrip'))scopes.push('drawing');
  if (state.polygon) scopes.push('polygon');
  if (event.target.closest?.('#viewport')) {
    if (state.hoverHandle || state.hoverCameraHandle) scopes.push('hover');
    scopes.push('canvas');
  }
  if (isBuilderContext(state.tool) || builderMode?.active) scopes.push('builder');
  if (event.target.closest?.('.layer-timeline')) scopes.push('timeline');
  if (state.settings.timelineMode === 'simple') scopes.push('simple');
  return scopes;
}
function cancelKeyboardCommand() {
  if(drawingController?.active||drawingController?.operation){drawingController.cancel();drawingController.cancelSelection();}
  state.rigAnchorPick = null;
  syncModeMessage();
  if (keyboardHandleGesture) {
    if (keyboardHandleGesture.ownsDrag) editor.cancelDrag();
    keyboardHandleGesture = null; heldArrows.clear();
  }
  hotkeys.releaseAll();
  timelineUI?._cancelGesture?.();
  cancelDrag();
  // Pointer-up may already have cleared the UI gesture before its commit failed.
  if (editor._drag) editor.cancelDrag();
  if (state.tool === 'attach') setTool('select');
  closeMenu("cancel");
}
function runKeyboardCommand(id, event, modifiers = {shift: event.shiftKey}) {
  if(id!=='cancel'&&id!=='play-pan'&&(drawingController?.gesture?.kind==='stroke'||drawingController?.loading||drawingController?.selection?.committing||drawingController?.operation))
    return drawingController.afterGesture(()=>runKeyboardCommand(id,event,modifiers));
  if(drawingController?.active){
    if(id==='play-pan')drawingController.finish();
    if(id.startsWith('drawing-')){drawingController.finish();const tool=id.slice(8),actions={'select-all':'select-all',deselect:'deselect','invert-selection':'invert-selection','fill-selection':'fill-selection',mirror:'mirror-x','flip-view':'flip-view','swap-colors':'swap-colors'};if(['brush','eraser','fill','lasso','shape'].includes(tool))drawingController.tool=tool;else if(tool==='apply')drawingController.run(()=>drawingController.applySelection());else if(actions[tool])return drawingController.run(()=>drawingController.action(actions[tool]));else drawingController.hotkey(tool);drawingController.sync();return;}
    if(['copy','cut','paste'].includes(id)&&!event.target.closest?.('.layer-timeline,.sheet-filmstrip')&&(drawingController.selection||drawingController.marquee||id==='paste'&&drawingController.pixelClipboard))return drawingController.action(id+'-pixels');
    // Delete keeps its global binding: the drawing scope deliberately leaves it
    // unbound so the global command always dispatches; only a live pixel
    // selection reroutes it to delete-pixels. Timeline focus keeps frame edits.
    if(id==='delete'&&(drawingController.selection||drawingController.marquee)&&!event.target.closest?.('.layer-timeline,.sheet-filmstrip'))return drawingController.action('delete-pixels');
    if(id!=='cancel'&&id!=='play-pan')drawingController.finish();if(['previous-frame','next-frame','previous-keyframe','next-keyframe','first-frame','last-frame'].includes(id))drawingController.applySelection();
  }
  if(['insert-copied-key','insert-blank-key'].includes(id)){
    finishCurrentEdit();const ids=event.target.closest?.('.layer-timeline')?timelineUI.ids:[editor.activeLayerId];
    return editor.sheetInsertKey(ids,editor.tick,{blank:id==='insert-blank-key'});
  }
  if (builderMode?.active) {
    // Shortcut modifiers identify commands; only an extra Shift on Split
    // extends its scope. Ctrl+D must not create a mirrored copy, and the
    // Shift in Shift+H/V must not implicitly select descendants.
    const branch = Boolean(editor.branchSelected || state.builderBranch);
    if (id === 'duplicate') return beginDuplicatePlacement({branch});
    if (id === 'mirror' || id === 'mirror-vertical') {
      finishCurrentEdit();
      return editor.mirrorSegment(id === 'mirror' ? 'horizontal' : 'vertical', {branch});
    }
    if (id === 'split-segment') {
      finishCurrentEdit();
      return editor.splitBuilderSegments({branch: branch || modifiers.shift, fraction: .5});
    }
  }
  if (id === 'cancel') return cancelKeyboardCommand();
  // Held, Ctrl+Tab shows the open projects and switches on release (shell/project-switcher.mjs).
  if (id === 'recent-project') return projectSwitcher.open(event);
  if (id === 'handle-edit-hold') { state.handleEditHeld = true; requestRender(); return; }
  if (id === 'isolate-hold') { flushPoseMove(); state.isolateHeld = true; return; }
  if (id === 'depth-hold') { flushPoseMove(); state.depthHeld = true; return; }
  if (id === 'play-pan') {
    state.space = true; state.spacePanned = false; viewport.classList.add('panning'); return;
  }
  if (id.startsWith('handle-')) return keyboardHandle({shiftKey:modifiers.shift}, 'arrow' + id.slice(7));
  if (id.startsWith('move-')) {
    const direction = id.slice(5), step = modifiers.shift ? 10 : 1;
    return moveSelected(direction === 'left' ? -step : direction === 'right' ? step : 0,
      direction === 'up' ? -step : direction === 'down' ? step : 0);
  }
  if (id === 'previous-figure' || id === 'next-figure') {
    finishKeyboardHandle(); return cycleFigure(id === 'previous-figure' ? -1 : 1);
  }
  if (id.startsWith('tool-')) {
    return setTool(id.slice(5));
  }
  if (id === 'segment-values') return showSegmentValues({hover: true});
  if (id === 'previous-exposure' || id === 'next-exposure')
    return timelineUI.selectFrame(timelineUI.selectedIndex + (id === 'previous-exposure' ? -1 : 1), {extend: modifiers.shift});
  if (event.target.closest?.('.layer-timeline,.sheet-filmstrip') && runTimelineHotkey(timelineUI, id, {shiftKey:modifiers.shift})) return;
  return actions[id]?.();
}
function releaseKeyboardCommand(id, event) {
  if (id === 'handle-edit-hold') { state.handleEditHeld = false; requestRender(); }
  else if (id === 'isolate-hold') { flushPoseMove(); state.isolateHeld = false; }
  else if (id === 'depth-hold') { flushPoseMove(); state.depthHeld = false; }
  else if (id.startsWith('handle-')) {
    heldArrows.delete('arrow' + id.slice(7));
    if (!heldArrows.size) finishKeyboardHandle();
  } else if (id === 'play-pan') {
    const active = state.space;
    state.space = false; viewport.classList.toggle('panning', state.tool === 'hand');
    if (active && !event.cancelled && !state.spacePanned && !state.polygon && !overlays.blocksHotkeys() && !isHotkeyInput(event.target)) {
      play();
    }
    state.spacePanned = false;
  }
}
const hotkeys = new HotkeyManager({run: guarded(runKeyboardCommand), release: guarded(releaseKeyboardCommand)});
overlays.hotkeys = hotkeys;
// The timeline island: its mount, its header's controls and what the header shows (src/timeline-host.mjs).
timelineHost = createTimelineHost({
  editor, state, $, actions, guarded, audioEngine, onionController, hotkeys, overlays, play, pause, finishKeyboardHandle,
  cancelPolygonDraft, interruptRecovery, cancelWarmPlayback: () => clearTimeout(warmTimer), warmPlayback, scheduleRecovery,
  requestRender, queueUI, renderInspector, syncSelectionControls, rangeFrames, selectTrack, previewScrub, scrubAudio, stopAudioScrub,
  changeFigureLayer, confirmDiscardFrame: dialogs.confirmDiscardFrame, simpleFrameCount, fail,
  setTimelineMode: (mode) => editorSettings?.commit({ timelineMode: mode }),
  onMount: (timeline) => { timelineUI = timeline; window.styk.timeline = timeline; },
  propertyControls: () => propertyControls, cameraMotionControls: () => cameraMotionControls, drawing: () => drawingController,
  builder: () => builderMode, sharedClipboard: () => sharedClipboard, thumbnails: () => thumbnailRenderer, localization: () => appLocalization,
  touch: () => touchMode,
});
/** What the command registry reads about the editor: the workspace, which decides the scoped shortcuts. */
function commandContext() {
  return { mode: drawingController?.active ? "draw" : builderMode?.active ? "rig" : "animate" };
}
const kitT = (key, params) => appLocalization?.t(key, params);
const requirementReason = (key) => kitText(kitT, `overlays.requires.${key}`);
const onDesktop = (available) => Boolean(available) || requirementReason("desktop");
/** When each catalog `requires` name holds (CATALOG_REQUIREMENTS); a string is the reason it does not. */
const commandRequirements = {
  desktop: () => onDesktop(desktop),
  "desktop:newWindow": () => onDesktop(desktop?.newWindow),
  "desktop:recentFiles": () => onDesktop(desktop?.listRecentFiles),
  "desktop:updates": () => onDesktop(desktop?.getUpdateState),
  "desktop:feedback": () => onDesktop(desktop?.sendTelemetryFeedback),
  "desktop:telemetry": () => onDesktop(desktop?.getTelemetryState),
  "update-ready": () => updateNotice?.state?.status === "ready" || (desktop?.getUpdateState ? requirementReason("updateReady") : requirementReason("desktop")),
  figure: () => Boolean(editor.object) || requirementReason("figure"),
  figures: () => selection().size > 1 || requirementReason("figures"),
  joint: () => (Boolean(editor.object) && editor.selectedJoint >= 0 && selection().size <= 1 && !isMovieclip(editor.figure)) || requirementReason("joint"),
  text: () => (Boolean(editor.object) && Boolean(editor.figure?.segments?.length) && editor.figure.segments.every((segment) => segment.primitive_code === 5))
    || requirementReason("text"),
  movieclip: () => (Boolean(editor.object) && isMovieclip(editor.figure)) || requirementReason("movieclip"),
  "movieclip-session": () => Boolean(editor._movieclipScopes?.length) || requirementReason("movieclipSession"),
  "camera-session": () => cameraSelected() || requirementReason("cameraSession"),
  pixels: () => Boolean(drawingController?.selection || drawingController?.marquee) || requirementReason("pixels"),
  appearance: () => Boolean(state.builderAppearance) || interfaceText("app.copyAnAppearanceFirst"),
};
/** The on/off state of the toggle commands the stage header and the menus show as pressed or checked. */
const TOGGLE_STATES = {
  "toggle-handles": () => Boolean(state.handles),
  "toggle-motion-paths": () => Boolean(state.motionPaths),
  "toggle-grid": () => Boolean(state.settings.canvasGrid),
  "toggle-onion": () => Boolean(state.onion),
  "toggle-loop": () => Boolean(state.loop),
  "toggle-auto-key": () => Boolean(state.settings.autoKey),
  "toggle-builder-branch": () => Boolean(state.builderBranch || state.builderShiftHeld),
  "toggle-isolate": () => Boolean(state.isolateMode),
  "toggle-builder-snap": () => state.settings.builderSmartSnapping !== false,
  "builder-static-handles": () => state.settings.builderShowStaticHandles !== false,
  "builder-highlight": () => Boolean(state.settings.builderHighlightSegment),
};
// One view of every command (src/ui/command-registry.mjs): labels, glyphs,
// availability and the user's shortcuts as they resolve in the current workspace.
// It runs actions through the same wrapped `actions` map as a click, and
// hotkey-only commands (tools, drawing keys) the way their key would.
const commands = createCommandRegistry({
  actions,
  hotkeys,
  localization: { t: kitT },
  context: commandContext,
  requirements: commandRequirements,
  checked: (id) => TOGGLE_STATES[id]?.(),
  runHotkey: (id) => {
    if (state.polygon && !polygonCommands.has(id)) { toast(interfaceText("app.finishOrCancelThePolygonFirst"), "app.finishOrCancelThePolygonFirst", {}); return false; }
    return runKeyboardCommand(id, { target: viewport, shiftKey: false }, { shift: false });
  },
  onError: fail,
});
/** Goes to frame `number` (1-based) in the timeline's numbering: frames in Simple, the ruler's frames in Advanced. */
function goToFrame(number) {
  if (drawingBusy()) return drawingController.afterGesture(() => goToFrame(number));
  pause();
  return timelineHost.goToFrame(number);
}
const byScore = (a, b) => b.match.score - a.match.score;
/** The palette's "In this project" rows: the layers, and the figures on this frame (not in Draw). */
const projectProvider = {
  id: "project",
  get label() { return kitText(kitT, "overlays.palette.project"); },
  search(query, context) {
    const rows = [];
    for (const layer of editor.layers ?? []) {
      if (layer.kind !== "layer") continue;
      const match = fuzzyMatch(query, layer.name);
      if (match) rows.push({ id: `layer:${layer.id}`, label: layer.name, icon: "layers", meta: kitText(kitT, "overlays.palette.layer"), metaKey: "overlays.palette.layer", metaParams: {}, match,
        ranges: match.ranges, run: () => { selectTrack({ id: layer.id, target: { kind: "layer", id: layer.id } }); timelineUI?.selectTrack?.(layer.id); } });
    }
    if (context?.mode !== "draw") {
      const figures = new Map(editor.report.figure_types.map((figure) => [figure.figure_type_id, figure]));
      for (const object of editor.selectionFrame?.objects ?? []) {
        const figure = figures.get(object.figure_type_id), name = figure?.name;
        const match = name && fuzzyMatch(query, name);
        if (!match) continue;
        const layer = editor.getLayer(editor.layerForUid(object.unique_id))?.name ?? "";
        rows.push({ id: `figure:${object.unique_id}`, label: name, icon: isMovieclip(figure) ? "frame" : "person",
          meta: kitText(kitT, isMovieclip(figure) ? "overlays.palette.movieclipIn" : "overlays.palette.figureIn", { layer }), metaKey: isMovieclip(figure) ? "overlays.palette.movieclipIn" : "overlays.palette.figureIn", metaParams: { layer }, match, ranges: match.ranges,
          run: () => selectTrack({ uid: object.unique_id, target: { kind: "figure", uid: object.unique_id } }) });
      }
    }
    return rows.sort(byScore);
  },
};
let settingsIndex = null;
/** The palette's Settings rows: every setting by its name, opened on its tab with the field focused. */
const settingsProvider = {
  id: "settings",
  get label() { return kitText(kitT, "overlays.palette.settings"); },
  search(query) {
    if (!editorSettings) return [];
    const locale = appLocalization?.localization.locale;
    if (settingsIndex?.locale !== locale) settingsIndex = { locale, entries: editorSettings.searchIndex() };
    return settingsIndex.entries.map((entry) => ({ entry, match: fuzzyMatch(query, entry.label) })).filter((row) => row.match).sort(byScore)
      .map(({ entry, match }) => ({ id: entry.setting, label: entry.label, icon: "settings", meta: kitText(kitT, "overlays.palette.settingIn", { tab: entry.tabLabel }), metaKey: "overlays.palette.settingIn", metaParams: { tab: entry.tabLabel },
        ranges: match.ranges, run: () => editorSettings.open(entry.tab, { setting: entry.setting }) }));
  },
};
// The command palette (Ctrl+P, Ctrl+Shift+P, F1, or Search commands… in the
// StykAnimate menu): an index of the registry, never a home of its own.
const palette = createCommandPalette({
  commands,
  overlays,
  icon: (name) => icon(name),
  context: commandContext,
  topInset: menuTopInset,
  openKeys: (event) => hotkeys.resolve(event)?.id === "command-palette",
  frameJump: (frame) => goToFrame(frame),
  providers: [projectProvider, settingsProvider],
  t: kitT,
});
// The one tooltip: the control's name and, after a middle dot, its shortcut
// from the registry (so a rebinding or a workspace that claims the key shows).
const tooltips = installTooltips(document, {
  topInset: menuTopInset,
  // The chrome's remaining native titles show as the one ink tooltip.
  adopt: ".titlebar, .shell-rail, .stage-head, .timeline-toolbar, .shell-strip, .shell-tabs",
  shortcut: (element) => {
    const id = hotkeyCommandId(element, hotkeys);
    return withShiftHint(element, id ? commands.shortcut(id) : undefined);
  },
});
// Tablet navigation chords (Ctrl+Space zoom, Shift+Space rotate) are not
// hotkeys: track the Space key itself so a pen press can read it.
// It runs before any open menu or dialog sees the key, so it asks the overlay gate itself.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || isHotkeyInput(event.target) || overlays.blocksHotkeys()) return;
  state.spaceHeld = true;
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    event.preventDefault();
    state.spaceChord = true; state.space = true; viewport.classList.add('panning');
  }
}, true);
const releaseSpaceChord = () => {
  state.spaceHeld = false;
  if (!state.spaceChord) return;
  state.spaceChord = false; state.space = false; state.spacePanned = false;
  viewport.classList.toggle('panning', state.tool === 'hand');
};
window.addEventListener('keyup', (event) => { if (event.code === 'Space') releaseSpaceChord(); }, true);
window.addEventListener('blur', releaseSpaceChord);
installPenMenuGuard(window);
// The region and layout keys type nothing, and F6 is how a keyboard user leaves a field, so they work from
// fields too (in the browser F6 would otherwise go to the address bar). Captured, before fields that keep
// their own keys (the layer search) stop them.
const SHELL_FIELD_KEYS = new Set(['focus-next-region', 'focus-previous-region', 'layout-arrange', 'layout-menu']);
document.addEventListener('keydown', guarded(event => {
  if (overlays.blocksHotkeys() || state.home || !isHotkeyInput(event.target)) return;
  const command = hotkeys.resolve(event, hotkeyScopes(event));
  if (!SHELL_FIELD_KEYS.has(command?.id) || !actions[command.id]) return;
  event.preventDefault();
  event.stopPropagation();
  actions[command.id]();
}), true);
const polygonCommands = new Set(['undo','redo','open','new','save','save-as','settings','help','command-palette','cancel','finish-polygon','play-pan',
  'tool-select','tool-pose','tool-hand','tool-line','tool-circle','tool-polygon','zoom-in','zoom-out','zoom-reset','zoom-selection','toggle-onion','toggle-handles','isolate-hold']);
document.addEventListener('keydown', guarded(event => {
  state.builderShiftHeld = event.shiftKey;
  refreshOriginDragModifiers(event);
  const scopes = hotkeyScopes(event), command = hotkeys.resolve(event, scopes);
  const builderCheckbox = command?.scope === 'builder' && command.id.startsWith('builder-') && event.target.matches?.('input[type=checkbox],input[type=radio]');
  const effectHistory = ['undo','redo'].includes(command?.id) && vfxInspector?.ownsHistoryTarget(event.target);
  // On Home only its own shortcuts act; every other key is the page's (a button's Enter, the search field).
  if (home.blocksKey(command)) return;
  if (overlays.blocksHotkeys() || (isHotkeyInput(event.target) && !builderCheckbox && !effectHistory)) {
    // Where hotkeys are off, the palette's keys still never print (Ctrl+P) or open the browser's help (F1).
    if (command?.id === 'command-palette') event.preventDefault();
    return;
  }
  // Drag modifiers should not swallow the configured unmodified Cancel key.
  if (state.drag && !command && hotkeys.resolve({code: event.code, key: event.key}, scopes)?.id === 'cancel') {
    event.preventDefault(); cancelDrag(); return;
  }
  hotkeys.keydown(event, scopes, command => {
    if (state.polygon && !polygonCommands.has(command.id)) return false;
    if (!$('renderer-error').hidden && !['save','save-as','open','new','cancel','settings','help'].includes(command.id)) return false;
    return true;
  });
}));
// Release at capture phase: controls and dialogs can stop bubbling after a held
// key starts. Matching uses the pressed physical key, even if modifiers change.
document.addEventListener('keyup', guarded(event => {
  state.builderShiftHeld = event.shiftKey;
  refreshOriginDragModifiers(event);
  if(!event.shiftKey && state.tool==='polygon'){state.bucketPreview=null;overlay.style.cursor='';requestRender();}
  hotkeys.keyup(event);
}), true);
window.addEventListener('blur', () => {
  hotkeys.releaseAll(); finishKeyboardHandle();
  if (state.drag) cancelDrag();
  state.builderShiftHeld = false;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hotkeys.releaseAll();
    // A hidden tab may be frozen or discarded at any moment (always on a phone), so the recovery copy is not left to its timer.
    if (!desktop) {
      pause();
      if (editor.dirty) scheduleRecovery(0);
    }
    // A hidden page cannot present anything; park speculative preparation the
    // same way a long canvas drag does. Exports keep their own workers.
    thumbnailRenderer?.setPaused(true);
    timelineUI?.setPaused?.(true);
    return;
  }
  syncBackgroundInteraction(Boolean(viewGestureActive()));
  timelineUI?.setPaused?.(Boolean(state.playing));
  // A warm-up skipped while hidden still owes the playhead its neighbors.
  warmPlayback();
});
editor.addEventListener("change", (e) => {
  const kind = e.detail?.kind;
  // Some persisted metadata changes reuse the editor revision (selection and
  // already-dirty metadata included). Save snapshots require a monotonic token.
  if (kind !== 'saved' && kind !== 'seek') {
    saveMutationEpoch++;
    // Publish immediately during the final IPC handoff. Main-process guards
    // cannot rely on a title update deferred to the next animation frame.
    if (finalizingDocument) desktop?.setDocumentState?.(documentStateNow())?.catch(fail);
  }
  if ((['toggle-selection', 'duplicate-pending'].includes(state.drag?.kind) || state.drag?.kind === 'tweener' && state.drag.press) &&
      ['document', 'seek', 'history', 'selection', 'edit'].includes(kind)) cancelDrag();
  const joining = state.figureJoin;
  if (joining && (joining.token !== editor._documentToken || joining.uid !== editor.selectedUid ||
      joining.frameIndex !== editor.frameIndex || joining.tick !== editor.tick ||
      joining.revision !== editor.revision || !selectedFigureJoinAction() ||
      ['history', 'document', 'frame-draft'].includes(kind))) setTool('select');
  if (e.detail?.audio && !e.detail?.timing) {
    pause();
    for (const job of exportJobs) if (!job.resting) job.controller.abort();
    // Audio metadata cannot invalidate any prepared animation pixels.
    if (playback.report === editor.report) { playback.documentRevision = editor.revision; state.playbackRevision = editor.revision; }
    queueUI(); if (editor.dirty) scheduleRecovery(); return;
  }
  // Project colours are metadata too: they change no frame, pixel or sound,
  // so playback keeps its prepared frames and nothing pauses.
  if (e.detail?.palette) {
    if (playback.report === editor.report) { playback.documentRevision = editor.revision; state.playbackRevision = editor.revision; }
    queueUI(); if (editor.dirty) scheduleRecovery(); return;
  }
  if (['edit','history','document'].includes(kind) && !e.detail?.live) { audioPreparation?.abort(); audioScrubController?.abort(); audioEngine.stop(); }
  if (kind === 'document') void audioEngine.clear().catch(fail);
  if(kind==='seek'&&!state.playing&&telemetry.isForeground)telemetry.performance.action('seek');
  if (kind === 'edit' && !e.detail?.live) { telemetry.count('edits'); telemetry.milestone('first_edit'); }
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
  if (kind === "document" || kind === "seek") {
    keyboardHandleGesture = null;
    heldArrows.clear();
    state.hoverHandle = null;
    state.hoverCameraHandle = null;
  }
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
    state.applyRange = false;
    state.rangeIndices = [];
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
    canvasHandleOverlay.clear();
    assetLibrary?.invalidate();
  }
  if (["edit", "history", "document", "frame-draft"].includes(kind))
    for (const job of exportJobs) if (!job.resting) job.controller.abort();
  if (
    (kind === "edit" || kind === "frame-draft" || (kind === "history" && (e.detail.layerSheet || e.detail.figureIndices?.length || (e.detail.frameIndices || e.detail.animation) && !e.detail.structural))) &&
    !e.detail?.live &&
    playback.report === editor.report &&
    state.playbackRevision !== editor.revision
  ) {
    const metadataOnly = Boolean(
      kind === "frame-draft" || e.detail.animation || e.detail.cameraMotion || e.detail.layerMetadata || e.detail.layerSheet,
    );
    const frameIndices =
      e.detail.frameIndices ??
      e.detail.changedFrames ??
      (metadataOnly ? [] : [editor.frameIndex]);
    playback.updateDocument({
      revision: editor.revision,
      frameIndices,
      sourceIds: e.detail.sourceIds || [],
      figureIndices: e.detail.figureIndices || [],
      definition: Boolean(e.detail.definition),
      structural: Boolean(e.detail.structural && !metadataOnly),
    });
    state.playbackRevision = editor.revision;
    state.playbackPacket = null;
  }
  if (kind === "seek") interruptRecovery();
  if (kind === "seek") {
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
function scheduleRecovery(delay = state.settings.autosaveSeconds * 1000 * (state.recoveryBackoff || 1)) {
  clearTimeout(state.recoveryTimer);
  state.recoveryTimer = null;
  const interval = state.settings.autosaveSeconds * 1000;
  if (!interval || !editor.dirty) {
    recoveryDeadline.reset();
    return;
  }
  const project = editor._movieclipScopes?.[0]?.parent.report ?? editor.report;
  const wait = recoveryDeadline.delay(project, interval, delay);
  state.recoveryTimer = setTimeout(async () => {
    state.recoveryTimer = null;
    if (
      state.playing ||
      editingGestureActive() ||
      state.scrubbing ||
      manualSave.active ||
      exportJobs.size
    ) {
      // An overdue checkpoint waits for a stable boundary without polling in a
      // zero-delay loop or letting the next edit restart its entire deadline.
      recoveryDeadline.retryAfter(1000);
      scheduleRecovery();
      return;
    }
    if (!editor.dirty) return;
    const checkpoint = documentCheckpoint(editor, state.documentToken, saveMutationEpoch),
      name = editor._movieclipScopes?.[0]?.parent.name ?? editor.name;
    recoveryDeadline.retryAfter(Math.min(30000, Math.max(1000, interval * (state.recoveryBackoff || 1))));
    try {
      const saved = await runDocumentExport(
        "styk",
        async (blob, signal) => {
          if (
            !matchesDocumentCheckpoint(checkpoint, editor, state.documentToken, {epoch: saveMutationEpoch}) ||
            !editor.dirty ||
            state.drag ||
            state.playing ||
            signal.aborted
          )
            return;
          if (desktop) {
            return await writeNativeBlob(desktop, blob, {
              recovery: true,
              name,
              signal,
              documentToken: state.documentToken,
            });
          }
          return browserRecovery.write(blob, name, signal, projects.tabs.activeId);
        },
        { recovery: true },
      );
      if (saved && matchesDocumentCheckpoint(checkpoint, editor, state.documentToken, {epoch: saveMutationEpoch})) {
        recoveredEpoch = saveMutationEpoch;
        recoveryDeadline.reset();
        state.recoveryBackoff = 1;
        state.recoveryFailed = false;
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        // A full or blocked store fails on every edit: say so once, then retry less often.
        state.recoveryBackoff = Math.min(12, (state.recoveryBackoff || 1) * 2);
        recoveryDeadline.retryAfter(Math.min(60000, interval * state.recoveryBackoff));
        if (!state.recoveryFailed) status({messageKey: "app.recoveryCopyCouldNotBeWritten", messageParams: {message: error.message}}, true);
        state.recoveryFailed = true;
      }
    } finally {
      // A cancelled snapshot still owes a checkpoint. The live document remains
      // revision-checked and mutations continue to abort its current snapshot.
      if (editor.dirty) scheduleRecovery();
    }
  }, wait);
}
function offerRecovery() {
  // Every copy no open project owns: one per project that had unsaved changes when the app last stopped.
  const copies = desktop?.listRecoveries
    ? desktop.listRecoveries().then(records => records.map(record => ({...record, native: true, savedAt: Date.parse(record.savedAt)})))
    : desktop ? Promise.resolve([]) : browserRecovery.list();
  void copies.then(records => {
    if (records.length === 1) showRecovery(records[0]);
    else if (records.length > 1) showRecovery(null, records);
  }).catch(error => status({messageKey: "app.recoveryCouldNotBeRead", messageParams: {message: error.message}}, true));
}
/** The recovery offer: the stage header's recovery message (experience.md §4.3), with the snapshot's file name and time. */
function showRecovery(record, records = [record]) {
  if (!records.length || !records[0]) return;
  const time = Number.isFinite(record?.savedAt) ? {format: "date", value: record.savedAt, options: {hour: "2-digit", minute: "2-digit"}} : "";
  const messageKey = record ? "app.recoveryOffer" : "app.recoveryCopies";
  const messageParams = record ? {name: record.name || editor.name, time} : {count: records.length};
  const offer = toasts.show({
    slot: "recovery", icon: "clock", title: interfaceText("app.restoreUnsavedWork"), titleKey: "app.restoreUnsavedWork", key: "recovery",
    message: interfaceText(messageKey, messageParams), messageKey, messageParams,
    timeout: 0, dismissible: false,
    actions: [
      { label: interfaceText("app.notNow"), labelKey: "app.notNow", id: "dismiss-recovery" },
      ...(browserRecovery || records.length > 1 ? [{ label: interfaceText("app.manageCopies"), labelKey: "app.manageCopies", id: "manage-recovery", dismiss: false, run: guarded(() => restore({choose: true})) }] : []),
      { label: interfaceText("app.restore"), labelKey: "app.restore", id: "restore-recovery", variant: "outline", dismiss: false, run: guarded(() => restore()) },
    ],
  });
  const discard = copy => copy.native ? desktop.deleteRecovery({id: copy.id}).then(result => Boolean(result?.deleted)) : browserRecovery.discard(copy);
  // A copy opens as a project of its own, with unsaved changes; the projects already open stay as they are.
  const restore = async ({choose = false} = {}) => {
    let chosen = record;
    if (choose || records.length > 1) {
      chosen = await dialogs.chooseRecovery(records, discard);
      if (!records.length) offer.dismiss();
      if (!chosen) return;
    }
    const reservation = browserRecovery ? await browserRecovery.reserve(chosen) : null;
    if (browserRecovery && !reservation) throw messageError(new Error(''), "errors.app.thisRecoveryCopyIsOpenInAnotherTab", {});
    let adopted = false;
    try {
      let copy;
      if (chosen.native) {
        copy = await readNativeRecovery(desktop, {id: chosen.id});
        if (!copy) throw messageError(new Error(''), "errors.app.theRecoveryFileIsNoLongerAvailable", {});
      } else {
        copy = await readBrowserRecovery(undefined, {id: chosen.id});
        if (!copy || copy.savedAt !== chosen.savedAt || copy.token !== chosen.token) throw messageError(new Error(''), "errors.app.theRecoveryCopyChangedReopenStykanimateToSee", {});
      }
      const name = chosen.name || copy.name;
      const restored = await importer.importNative(new File([copy.blob], `${name}.styk`), {open: {layerTimeline: editor.layerTimeline}});
      // The restored project adopts the copy it came from: its next recovery write replaces it, saving removes it.
      if (!await acceptImport(restored, name, {recoveryId: chosen.native ? chosen.id : undefined})) return;
      editor.dirty = true;
      await reservation?.commit(projects.tabs.activeId);
      adopted = true;
      fit();
      updateUI();
      telemetry.count('recovery_restored');
      offer.dismiss();
      records.splice(records.indexOf(chosen), 1);
      if (records.length) showRecovery(records.length === 1 ? records[0] : null, records);
    } finally { if (!adopted) reservation?.release(); }
  };
}
if (desktop) {
  if (desktop.platform !== "darwin") $("window-controls").hidden = false;
  else document.querySelector(".titlebar").style.paddingLeft = "84px";
  desktop.onMenuAction?.(
    guarded((action) => {
      if (['undo','redo'].includes(action) && vfxInspector?.ownsHistoryTarget(document.activeElement) && !$("dialog").open) return actions[action]();
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
}
window.addEventListener("pagehide", event => { if (!event.persisted) importer.dispose(); });
window.addEventListener("pagehide", event => { if (!event.persisted) browserRecovery?.dispose(); });
window.addEventListener("pagehide", () => projects.dispose());
window.addEventListener("beforeunload", (e) => {
  if (projects.summary().unsaved && !desktop) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.styk = {
  recovery: browserRecovery,
  audioEngine,
  editor,
  projects,
  projectSwitcher,
  home,
  tutorials,
  state,
  actions,
  // The playback adapter: tools drive exports and playback through the app's own objects.
  playback,
  importFiles,
  acceptImport,
  fit,
  drawingResourcesFor,
  // The figure-bounds callback of alignment and camera centering: tools replay recorded calls through it.
  boundsOf,
  // The overlay kit: the open overlays and the hotkey gate, the message slot,
  // the command registry and the tooltip.
  ui: { overlays, toasts, commands, palette, tooltips, context: commandContext, stageHead },
  performance: () => ({
    editingPresentation:state.lastEditingPresentation,
    samples: [...state.renderSamples],
    renderer: state.renderer?.stats,
    import: state.lastImport,
    playback: { ...playback.stats },
    presentation: playbackMetrics.snapshot(performance.now()),
  }),
  ready: false,
};
let thumbnailRenderer, sharedClipboard;
// Poses of the open document drawn through a camera of their own (the parallax monitor).
const posePictures = new EnginePoses(editor, { stage: () => state.renderer });
async function changeFigureLayer(label, operation, {labelKey} = {}) {
  pause();
  finishKeyboardHandle();
  cancelDrag();
  interruptRecovery();
  const controller = new AbortController();
  let dialogShown = false,
    latest;
  // A dialog opened meanwhile (the export dialog is its own <dialog>) takes over: the layer change stops.
  const originalDialogContent = $("dialog-content").firstChild,
    originalDialogOpen = $("dialog").open,
    openDialogs = () => document.querySelectorAll("dialog[open]").length,
    originalOpenDialogs = openDialogs();
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
    localizedText($("layer-progress-label"), (latest.phase === "staging" ? "app.applyingLayerChanges" : "app.preservingAnimation"), (latest.phase === "staging" ? {} : {}));
    const progress = progressElement;
    if (Number.isFinite(latest.total) && latest.total > 0) {
      progress.max = latest.total;
      progress.value = latest.completed || 0;
    } else progress.removeAttribute("value");
  };
  const timer = setTimeout(() => {
    if (
      $("dialog-content").firstChild !== originalDialogContent ||
      $("dialog").open !== originalDialogOpen ||
      openDialogs() !== originalOpenDialogs
    ) {
      controller.abort();
      return;
    }
    dialogShown = true;
    showDialog(
      label,
      `<p id="layer-progress-label" data-i18n="app.preservingAnimation">${messageHTML("app.preservingAnimation", {})}</p><progress id="layer-progress" style="width:100%;accent-color:#0d99ff"></progress><div class="dialog-actions"><button class="button" id="cancel-layer-change" data-i18n="common.cancel">${messageHTML("app.cancel", {})}</button></div>`,
      {titleKey: labelKey},
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
    status({messageKey: "app.layerChangeCancelled", messageParams: {}});
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
/** The timeline's audio Scrub option: a short slice of the sound under the scrubbed frame. */
function scrubAudio(tick) {
  if (timelineUI?.audio?.scrub.checked && performance.now() - audioScrubAt > 100) {
    audioScrubAt = performance.now(); audioScrubController?.abort(); const controller = audioScrubController = new AbortController();
    const time = tick / audioFps(editor.report);
    void audioEngine.unlock().then(() => audioEngine.prepare(editor.report, {start:time, end:time+.08, signal:controller.signal}))
      .then(() => { if (!controller.signal.aborted) return audioEngine.start(time,time+.08); })
      .catch(error => { if (!controller.signal.aborted) fail(error); });
  }
}
function stopAudioScrub() {
  audioScrubController?.abort(); audioEngine.stop();
}
async function init() {
  if (desktop?.activateDocument) {
    const activation = desktop.activateDocument({});
    documentActivation = activation.catch(() => {});
    state.documentToken = (await activation).documentToken;
  }
  const settingsValue = window.stykInitialEditorSettings
    ? await window.stykInitialEditorSettings
    : desktop?.getEditorSettings
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
      try { if (previousMode !== next.timelineMode) timelineHost.mount(); }
      catch (error) { state.settings = previousSettings; throw error; }
      if (patch.touchInterface !== undefined) touchMode?.refresh();
      if (patch.playbackQuality !== undefined && state.playing) selectPlaybackQuality();
      if (patch.hotkeys) { hotkeys.setBindings(next.hotkeys); refreshHotkeyHints(hotkeys); }
      onionController.sync();
      syncAutoKey();
      if (patch.motionPathRange !== undefined || patch.motionPathAllTargets !== undefined) trails.clear();
      state.handles = drawingController?.active ? false : next.showHandles;
      state.loop = next.loopPlayback;
      state.motionPaths = next.motionPaths;
      pathControls?.sync();
      canvasGuides?.sync();
      if (!state.motionPaths) { state.hoverPathPoint = null; syncPathTooltip(); trails.clear(); }
      if (patch.motionPathFalloffRadius !== undefined || patch.motionPathFalloffShape !== undefined || patch.motionPaths !== undefined) syncPathFalloff();
      appLocalization.setLocale(next.locale);
      canvasHandleOverlay.clear();
      scheduleRecovery();
      requestRender();
      queueUI();
      // The view toggles show their state at once, during playback too (the stage header's surface waits).
      syncStageHead();
    },
    onPersist: desktop?.setEditorSettings
      ? (value) => desktop.setEditorSettings(value)
      : undefined,
    onResetWorkspace: () => workspaceLayout?.reset(),
    onPrivacy: desktop?.getTelemetryState ? () => privacyUI.open() : undefined,
    onFeedback: desktop?.sendTelemetryFeedback ? options => feedbackUI.open(options) : undefined,
    onDonate: desktop?.openDonate ? () => desktop.openDonate() : undefined,
  });
  state.settings = editorSettings.value;
  // Home shows first, over the editor that goes on starting behind it, unless the launch or the person's setting says otherwise.
  home.start();
  // The touch interface (docs/TOUCH.md): decided before the shell lays out, kept current as the window turns.
  touchMode = installTouchMode({ getSetting: () => state.settings.touchInterface });
  window.styk.touch = touchMode;
  // The timeline has a presentation for each interface (touch/timeline-scrubber.mjs): switching mounts it again.
  touchMode.on((next, previous) => { if (Boolean(next.active) !== Boolean(previous?.active)) timelineHost.mount(); });
  // The inspector's titled sections remember being open across sessions.
  configureInspectorSections(state.settings.inspectorSections, {onChange: (sections) => editorSettings.commit({ inspectorSections: sections })});
  hotkeys.setBindings(state.settings.hotkeys);
  window.styk.hotkeys = hotkeys;
  appLocalization.bindChrome();
  refreshHotkeyHints(hotkeys);
  appLocalization.updatePlayback($("play-button"), state);
  window.styk.localization = appLocalization;
  state.handles = state.settings.showHandles;
  state.loop = state.settings.loopPlayback;
  state.motionPaths = state.settings.motionPaths;
  syncAutoKey();
  window.styk.settingsUI = editorSettings;
  onionControls = new OnionControls({button: $("onion-settings-button"), toggleButton: $("onion-button"), controller: onionController});
  window.styk.onionController = onionController;
  pathControls = new MotionPathControls({button: $("paths-button"),
    getSettings: () => state.settings, getEnabled: () => state.motionPaths,
    onChange: patch => editorSettings.commit(patch), onToggle: () => actions["toggle-motion-paths"]()});
  window.styk.tweener = tweenerControls = new TweenerControls({button: $('tweener-button'), editor, viewport,
    getTool: () => state.tool, onSelect: () => setTool('tweener'),
    beforeEdit: () => propertyControls?.commit(), onError: fail});
  canvasGuides = new CanvasGuides({button: $('canvas-guides-button'), trigger: $('guides-options-button'), viewport,
    getState: () => ({settings: state.settings, view: state.view, report: editor.report,
      hidden: state.playing || state.previewing}),
    onChange: patch => editorSettings.commit(patch)});
  window.styk.onionSkins = () => onionSkins() && editor._shown.skins(onionController.request({selected: selection(), hidden: state.hidden}));
  // The shell: the stored layout loads before its first commit, then the dock
  // host lays the panels out and owns which one shows where.
  shell = await installShell({
    desktop,
    legacy: { builderOutlinerWidth: state.settings.builderOutlinerWidth },
    platform: desktop ? "desktop" : "web",
    onError: (error) => status(error, true),
    onBeforeChange: () => finishCurrentEdit(),
    // The painter's rows until M5 draws 24px Camera and Scene rows (dock-host.mjs).
    timelineRows: { ruler: TIMELINE_RULER, pinnedRow: TIMELINE_ROW, row: TIMELINE_ROW },
    // The band's first measurement waits for the editor to be ready where it can (topbar.mjs).
    ready: editorReady,
    touch: touchMode,
  });
  workspaceLayout = shell.workspace;
  window.styk.workspace = workspaceLayout;
  window.styk.shell = shell;
  window.styk.touchShell = installTouchShell({ touch: touchMode, stageHead, shell });
  // Press and hold: the right-click menus and the controls' names, for fingers (docs/TOUCH.md).
  installLongPress({ touch: touchMode, tooltips });
  // The stage's own: two fingers tap to undo, three to redo, a hold opens the menu of what is under the finger.
  installCanvasTouch({
    viewport, overlay, touch: touchMode,
    holdable: () => !drawingController?.active && !state.playing && !state.previewing && !state.polygon,
    onHold: ({ x, y }) => {
      if (state.drag) cancelDrag();
      releaseCanvasPointer();
      state.suppressContext = false;
      overlay.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    },
    onUndo: () => { if (state.drag) cancelDrag(); actions.undo(); },
    onRedo: () => { if (state.drag) cancelDrag(); actions.redo(); },
  });
  // The right button and the modifier keys for fingers: the stage's modifier buttons (docs/TOUCH.md).
  const workspaceElement = document.querySelector(".workspace");
  window.styk.touchModifiers = touchModifiers = installModifierDock({
    touch: touchMode, host: workspaceElement, viewport,
    context: () => ({ workspace: workspaceElement.dataset.mode, tool: workspaceElement.querySelector(".shell-rail .tool-dock [data-tool].active")?.dataset.tool ?? state.tool,
      spatial: Boolean(editor.figure?.segments?.some((segment) => segment._stykRig?.spatial)) }),
    // The held keys the modifiers stand in for (hotkeys.mjs: hold R, hold D).
    setHeld: (command, down) => {
      if (command === "handle-edit-hold") { state.handleEditHeld = down; requestRender(); }
      else if (command === "depth-hold") { flushPoseMove(); state.depthHeld = down; }
    },
  });
  const shellAnnouncer = document.createElement("div");
  shellAnnouncer.className = "ui-visually-hidden";
  shellAnnouncer.setAttribute("role", "status");
  appendLocalized(document.body, shellAnnouncer);
  const announceShell = (text) => { shellAnnouncer.textContent = text; };
  const shellKeyboard = createDockKeyboard({ host: shell, announce: announceShell });
  installDockTabs({ host: shell, openMenu: (items, at, options) => showCommandMenu(items, at, options), announce: announceShell });
  // View › Layout… and Ctrl+Alt+L: under the View menu, or the mark where the menubar folds into it.
  const layoutPopover = createLayoutPopover({
    host: shell, overlays, icon: (name) => icon(name), t: kitT,
    prompt: (options) => promptText({ ...options, overlays, t: kitT }),
    openMenu: (items, at) => showCommandMenu(items, at),
    anchor: () => [document.querySelector('.app-menubar [data-app-menu="view"]'), document.querySelector('.titlebar .brand')].find((element) => element?.getClientRects().length),
    notify: (text) => toast(text),
    isToggleKey: (event) => hotkeys.resolve(event, [])?.id === 'layout-menu',
  });
  installShellCommands(actions, { shell, keyboard: shellKeyboard, layout: layoutPopover });
  timelineHost.attach(shell);
  cameraMotionControls = new CameraMotionControls($('inspector'),editor,{onError:fail,onRender:()=>{queueUI();requestRender();},beforeEdit:()=>{pause();interruptRecovery();propertyControls?.commit();},onPreview:clip=>{pause();editor.seek(clip.start);state.motionPreviewRange={start:clip.start,end:Math.min(editor.totalTicks,clip.start+clip.duration)};play();},posePicture:(pose,options)=>posePictures.picture(pose,options)});
  propertyControls = new PropertyControls($("inspector"), {
    canHandle: (key, input) =>
      (drawingController?.active&&key.startsWith('draw:')) || cameraMotionControls.handlesProperty(input) || Boolean(propertyChannel(key)) || canEditNativeProperty(editor, key),
    getValue: (key, input) => {
      if(key.startsWith('draw:'))return drawingController.propertyValue(key);
      if (cameraMotionControls.handlesProperty(input)) return cameraMotionControls.propertyValue(input);
      const value = propertyState(key).value;
      return (
        value ??
        getNativePropertyValue(editor, key, { bounds: selectionBounds })
      );
    },
    begin: ({ key, element }) => {
      if(key.startsWith('draw:')){drawingController.finish();return {drawing:key,initial:drawingController.propertyValue(key)};}
      pause();
      interruptRecovery();
      if (cameraMotionControls.handlesProperty(element)) return { cameraMotion: cameraMotionControls.beginProperty(element) };
      const branch = usesBuilderBranch() || editor.selectedSegmentIds.size > 1;
      const binding =
        branch && ["thickness", "segment_opacity", "segment_gradient_opacity"].includes(key)
          ? null
          : propertyChannel(key);
      if (binding && (editor.propertyChannels || binding.property === 'zIndex')) {
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
      if(token.drawing)return drawingController.propertySet(token.drawing,value);
      if (token.cameraMotion) return cameraMotionControls.previewProperty(token.cameraMotion, value);
      if (token.binding)
        editor.previewAnimationEdit(token.binding.fromUI(value));
      else previewNativePropertyEdit(token.native, value);
      requestRender();
    },
    commit: ({ token, value }) => {
      if(token.drawing){drawingController.propertySet(token.drawing,value);queueUI();return;}
      if (token.cameraMotion) return cameraMotionControls.commitProperty(token.cameraMotion, value);
      if(token.binding&&token.ticks){editor.cancelAnimationEdit();editor.addAnimationKeys(token.ticks.map(tick=>({target:token.binding.target,property:token.binding.property,tick,value:token.binding.fromUI(value),...token.binding.options})));
      } else if (token.binding && token.indices?.length > 1) {
        editor.cancelAnimationEdit();editor.addAnimationKeys(token.indices.map(index=>({target:token.binding.target,property:token.binding.property,
          tick:editor.timeline[index].start,value:token.binding.fromUI(value),...token.binding.options})));
      } else if (token.binding) editor.commitAnimationEdit();
      else commitNativePropertyEdit(token.native);
      queueUI();
    },
    cancel: ({ token }) => {
      if(token?.drawing){drawingController.propertySet(token.drawing,token.initial);queueUI();return;}
      if (token?.cameraMotion) cameraMotionControls.cancelProperty(token.cameraMotion);
      else if (token?.binding) editor.cancelAnimationEdit();
      else if (token?.native) cancelNativePropertyEdit(token.native);
      queueUI();
      requestRender();
    },
    onError: fail,
  });
  window.styk.properties = propertyControls;
  vfxInspector=new VfxInspector({editor,root:$('vfx-panel'),context:()=>state.inspectorContext,beforeEdit:()=>{pause();interruptRecovery();propertyControls?.commit();},onChange:()=>{queueUI();requestRender();},onError:fail,
    requestVisible:visible=>shell.showPanel(visible?'vfx':'properties',{focus:false})});
  window.styk.vfx=vfxInspector;
  // The timeline's VFX rows follow the VFX panel's visibility, which the shell owns.
  shell.define({id:'vfx',root:()=>$('vfx-panel'),onVisibility:visible=>{editor._vfxTimelineVisible=visible;editor._emit('vfx-selection');vfxInspector.panelVisible(visible);}});
  vfxGizmos=new VfxGizmos({canvas:overlay,inspector:vfxInspector,editor,pickNativeHandle:event=>pick(worldPoint(event)),getOptions:()=>({report:editor.report,frame:currentFrame({shot:true}),geometry:state.playing?null:editor.geometry,view:state.view,cameraEnabled:state.playing||state.previewing,playing:state.playing,vfxEnabled:state.vfxEnabled,resources}),onChange:()=>{queueUI();requestRender();},onError:fail});
  window.styk.vfxGizmos=vfxGizmos;
  $('vfx-preview').addEventListener('click',()=>{finishCurrentEdit();pause();state.vfxEnabled=!state.vfxEnabled;playback.setVfxEnabled(state.vfxEnabled);state.playbackPacket=null;syncStageHead();requestRender();queueUI();});
  assetLibrary = new AssetLibrary($("asset-list"), {
    onAdd: (id) => {
      pause();
      if (builderMode?.active) return toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo2"), "app.finishTheFigureOrReturnToAnimateTo2", {});
      if (rangeFrames()) editor.addFigureInFrames(id, rangeFrames());
      else editor.addFigure(id);
      $("insert-dialog").close();
      setTool("select");
    },
    onError: fail,
  });
  window.styk.assets = assetLibrary;
  // The desktop app keeps the library in its Documents folder; in a browser it lives in that browser's own storage.
  window.styk.library = new UserLibrary({editor, desktop: desktop ?? createBrowserLibraryApi({library: new LocalLibrary(),
    community: new CommunityLibrary({downloads: new DownloadLedger(localStorageLedgerStorage())})}), exporter:documentExporter, importer, pause, finishEdit:finishCurrentEdit, setTool, vfxInspector, hotkeys,
    activate: id => shell.showPanel(id, {focus: false})});
  shell.define({id: 'library', root: () => $('user-library'), onVisibility: visible => window.styk.library.panelVisible(visible)});
  const libraryInsert = (asset, point) =>
    builderMode?.active ? toast(interfaceText("app.finishTheFigureOrReturnToAnimateTo2"), "app.finishTheFigureOrReturnToAnimateTo2", {}) : window.styk.library.insert(asset, point);
  installLibraryDrop(viewport, {position: worldPoint, insert: libraryInsert, onError: fail});
  installLibraryDrag(window.styk.library.grid, viewport, {
    getAsset: card => window.styk.library.assetFor(card),
    onStart: asset => window.styk.library.dragStarted(asset),
    getDestination: (hit, asset) => window.styk.library.dragDestination(hit, asset),
    moveItem: (asset, folder) => window.styk.library.moveItem(asset, folder),
    position: worldPoint, insert: libraryInsert, onError: fail,
  });
  $('library-tab')?.addEventListener('click', () => telemetry.count('library'));
  actions['add-to-library'] = () => { telemetry.count('library'); return window.styk.library.run(() => window.styk.library.save()); };
  window.styk.movieclips = installMovieclipUI({editor,actions,pause,finishEdit:finishCurrentEdit,
    getTimeline:()=>timelineUI,setTool,onError:fail,queueUI,exportClip:()=>exportFlow.exportPivot('stykmov'),
    // The session breadcrumb sits above the stage until the inspector names the scope (M4).
    mountBreadcrumb:element=>document.querySelector('.context-strip').before(element)});
  for (const [name, action] of Object.entries(actions)) if (name.startsWith('movieclip-')) actions[name] = (...args) => { telemetry.count('movieclip'); return action(...args); };
  editor.addEventListener('change',event=>{
    if(event.detail?.kind==='movieclip-scope' || event.detail?.movieclipScope) {
      timelineHost.mount(); state.inspectorContext=editor.object?'figure':'scene';state.inspectorTab='design';queueUI();
    }
  });
  builderMode = initBuilderMode({
    editor, state,
    host: {
      setTool, pause, finishCurrentEdit, cancelDrag, cancelPolygonDraft,
      cancelConstruction: () => construction?.cancel(),
      showDialog, closeDialog, toast, status, fail, queueUI, requestRender,
      showCommandMenu,
      commitSettings: patch => editorSettings.commit(patch),
      onModeChange: () => syncShell(),
      toggleTimeline: () => shell.togglePanel('timeline'),
    },
  });
  construction = createConstruction({editor,state,active:()=>Boolean(builderMode?.active),render:requestOverlayRender,project:screenPoint,onError:fail,commitSettings:patch=>editorSettings.commit(patch)});
  actions['chain-finish'] = () => construction.commit();
  actions['chain-cancel'] = () => construction.cancel();
  actions['toggle-builder-snap'] = () => construction.toggleSnap();
  window.styk.builder = builderMode;
  drawingController=new DrawingController({editor,state,overlay,viewport,onRender:()=>{if(!state.playing&&!state.previewing)syncBackgroundInteraction(Boolean(viewGestureActive()));requestRender();},onOverlayRender:requestOverlayRender,onView:placeArtboard,onUI:queueUI,onError:fail,onStatus:toast,beforeEdit:()=>{finishCurrentEdit();interruptRecovery();},artwork:({bounds,matrix,signal})=>engineComposite({document:(report,revision,check)=>engineDocument({stage:state.renderer,report,revision,check}),engine:()=>state.renderer?.engineSide?.engine,current:()=>({report:editor.report,revision:editor.revision,tick:editor.tick}),bounds,matrix,signal}),sampleColor:(x,y,signal)=>sampleCanvasColor(x,y,signal),getTimeline:()=>timelineUI,getClipboard:()=>sharedClipboard,
    // A finger draws in the touch interface (Settings › Draw with a finger); elsewhere it pans, as before.
    // Automatic draws with a finger only in the touch interface; Always also does on a desktop layout.
    fingerDrawing:()=>{const mode=state.settings.fingerDraw;return mode==='auto'&&!touchMode?.active?'never':mode;}});
  window.styk.drawing=drawingController;
  // Draw's quick bar is the stage header's tool options until Draw declares option descriptors (M7b): the same
  // element, re-parented once out of #viewport with its handlers and sliders.
  stageHead.adopt(drawingController.quickBar);
  studioShell = initStudioShell({editor, state, setTool, renderAssets, renderInspector, showCommandMenu,
    actions, getTimeline: () => timelineUI,
    builder: builderMode, drawing:drawingController, toast});
  window.styk.studio = studioShell;
  // The rail's + adds (Animate: the Add menu; Draw: a new drawing layer, its corner tick the Add menu), and a tool with
  // variants lists them from its corner tick, a right-click or a long press (src/shell/rail.mjs).
  installRail(document.querySelector(".studio-rail"), { openMenu: (kind, anchor) => showRailMenu(kind, anchor) });
  $("open-insert").addEventListener("click", guarded((event) => {
    if (drawingController?.active) return drawingController.run(() => drawingController.action("new"));
    showAddMenu(event.currentTarget);
  }));
  // Frame thumbnails: the engine draws them (src/engine/engine-thumbnails.mjs).
  thumbnailRenderer = createThumbnailRenderer(editor, { stage: () => state.renderer });
  sharedClipboard = new SharedClipboard(editor, desktop);
  window.styk.clipboard = sharedClipboard;
  window.styk.thumbnails = thumbnailRenderer;
  timelineHost.mount();
  status({messageKey: "app.preparingCanvasAndEffects", messageParams: {}}, false, true);
  // A stage that cannot start is reported by the catch of init() below: nothing else draws the scene.
  state.renderer = await createRenderer(canvas, rendererOptions());
  // The document was loaded into playback before the stage existed: the engine takes it now.
  state.playbackRevision = null;
  new ResizeObserver(resize).observe(viewport);
  resize();
  fit();
  updateUI();
  status({messageKey: "app.ready", messageParams: {}});
  window.styk.ready = true;
  markEditorReady();
  window.styk.telemetry = telemetry;
  window.styk.privacyUI = privacyUI;
  updateNotice = new UpdateUI(desktop, { onRestart: () => actions['restart-update']() });
  queueStartupPrompts();
  void telemetryInit.then(() => telemetry.timing('startup_ms', performance.now()));
  // Prompts wait for the first rendered frame.
  requestAnimationFrame(() => overlays.markReady());
  warmPlayback();
  offerRecovery();
  // The first Pivot import or export in the browser downloads the converter;
  // say so instead of leaving the operation looking stuck. A failure is
  // reported by the import or export that hit it.
  if (codecProfile() === "web") {
    browserCodecHost().subscribe(({ state, stage }) => {
      if (state === "loading") status(stage === "runtime" ? {messageKey: "app.loadingThePivotConverterFirstUseOnly", messageParams: {}} : {messageKey: "app.startingThePivotConverter", messageParams: {}}, false, true);
    });
  }
  try {
    // Only the desktop app has a sample list (desktop/samples.cjs); in a browser people open the files they pick.
    const data = desktop?.listSamples ? await desktop.listSamples() : {samples: []};
    state.samples = data.samples || [];
    renderAssets();
  } catch (error) {
    status({messageKey: "app.editorReadyFileServiceUnavailable", messageParams: {}}, true);
    console.warn(error);
  }
}
/**
 * Startup prompts open one at a time through the overlay manager's queue,
 * after the first rendered frame and never over a dialog or a menu: the notes
 * of a new version, then the privacy choice on first run (today's order; the
 * choice waits until the notes are known). The recovery offer and the update
 * notice are not prompts: they show at once without taking focus.
 */
function queueStartupPrompts() {
  let release;   // undefined while the notes load, then the notes or null
  const whenClosed = (dialog) => new Promise((resolve) => {
    if (!dialog?.open) { resolve(); return; }
    dialog.addEventListener("close", () => resolve(), { once: true });
  });
  overlays.enqueuePrompt({
    id: "release-notes", priority: 2, ready: () => release !== undefined,
    open: async () => {
      if (!release) return;
      try { await releaseSplash.open({ info: release }); } catch (error) { console.warn(error); return; }
      await whenClosed(releaseSplash.dialog);
    },
  });
  releaseSplash.startupInfo()
    .then((info) => { release = info ?? null; }, (error) => { console.warn(error); release = null; })
    .finally(() => { if (!release) overlays.cancelPrompt("release-notes"); overlays.pumpPrompts(); });
  void telemetryInit.then((info) => {
    if (!info || info.decided) return;
    overlays.enqueuePrompt({
      id: "privacy-first-run", priority: 1, ready: () => release !== undefined,
      open: async () => {
        try { await privacyUI.open({ firstRun: true }); } catch { return; }
        await whenClosed(privacyUI.dialog);
      },
    });
  });
}
function scheduleGpuRecovery() {
  if (gpuRecoveryTimer !== undefined) return;
  // Two attempts, each later than the last: a lost device usually returns once the browser's GPU process settles.
  const delay = GPU_RECOVERY_DELAYS[gpuRecoveryAttempts++] ?? 0;
  gpuRecoveryTimer = setTimeout(() => {
    gpuRecoveryTimer = undefined;
    recoverCanvas().catch(error => {
      localizedText($("renderer-error").querySelector('p'), "app.theCanvasCouldNotReconnectYourAnimationIs", {});
      status(error, true);
      if (gpuRecoveryAttempts < GPU_RECOVERY_DELAYS.length) scheduleGpuRecovery();
    });
  }, delay);
}
function recoverCanvas(refreshGpuBudget) {
  // Queue behind an in-flight recovery so a device lost mid-reconnect retries.
  if (rendererRecovery) return rendererRecovery.finally(() => recoverCanvas(refreshGpuBudget));
  clearTimeout(gpuRecoveryTimer); gpuRecoveryTimer = undefined;
  if (refreshGpuBudget) gpuRecoveryAttempts = 0;
  rendererRecovery = (async () => {
    // A canvas cannot switch context types. Replace only the scene surface;
    // document/history and pointer handlers on the overlay remain available.
    playback.invalidate();
    state.renderer?.destroy();
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement); canvas = replacement;
    state.renderer = await createRenderer(canvas, rendererOptions());
    clearTimeout(gpuStableTimer);
    telemetry.performance.recovery('gpu','recovered');
    gpuStableTimer = setTimeout(() => { gpuRecoveryAttempts = 0; }, GPU_STABLE_MS);
    $("renderer-error").hidden = true;
    resize(); requestRender();
  })().finally(() => {rendererRecovery = null;});
  return rendererRecovery;
}
function rendererOptions() {
  return {
    onInvalidate: requestRender,
    onMonitorPicture: requestMonitorRender,
    // A frame the engine refused: the previous picture stays and the document's next revision is tried again.
    onError: error => { telemetry.error(error, 'renderer'); status(error, true); },
    onStatus: (message) => {
      if (message.backend !== "WebGPU device lost") return;
      localizedText($("renderer-label"), "rendererStatus.deviceLost");
      status({messageKey: message.messageKey, messageParams: message.messageParams});
      telemetry.performance.recovery('gpu','started');telemetry.performance.incident('gpu');
      telemetry.count('gpu_errors');
      telemetry.error(Object.assign(messageError(new Error(''), "errors.app.theGraphicsDeviceWasLost", {}), { name: 'GPUError', telemetryCode: 'device_lost' }), 'gpu');
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
      state.depthHeld = false;
      state.hoverHandle = null;
      state.hoverCameraHandle = null;
      viewport.classList.toggle("panning", state.tool === "hand");
      $("renderer-error").hidden = false;
      localizedMarkup($("renderer-error"), `<p data-i18n="app.theGraphicsDeviceWasResetReconnectingYourCanvas">${messageHTML("app.theGraphicsDeviceWasResetReconnectingYourCanvas", {})}</p><button class="button" id="retry-renderer" data-i18n="app.reconnectCanvas">${messageHTML("app.reconnectCanvas", {})}</button>`);
      $("retry-renderer").onclick = guarded(() => recoverCanvas(true));
      scheduleGpuRecovery();
    },
  };
}
init().catch((error) => {
  $("renderer-error").hidden = false;
  presentError($("renderer-error"), error);
  fail(error);
});

// Every colour picker offers the project's colours, edited as undoable commands.
bindProjectPalette({colors:()=>projectColors(editor.report),add:color=>editor.addPaletteColor(color),addMany:colors=>editor.addPaletteColors(colors),
  remove:color=>editor.removePaletteColor(color),move:(color,index)=>editor.movePaletteColor(color,index),
  subscribe:listener=>{const changed=event=>{if(event.detail?.palette||event.detail?.kind==='document')listener();};editor.addEventListener('change',changed);return()=>editor.removeEventListener('change',changed);}});
installColorPickers((input, event) => {
  if(input.dataset.drawSetting==='color'||input.dataset.drawSetting==='color2')return drawingController?.colorPicker(input);
  if(input.dataset.paletteColor!==undefined){
    const uid=editor.selectedUid,figure=editor.figure,report=editor.report,tick=editor.tick;
    const entry=editor.figurePalette().find(entry=>entry.color===input.dataset.paletteColor);
    if(!entry)return false;
    return {anchor:input,paint:{type:'solid',stops:[{offset:0,color:parseColor(entry.color).color,opacity:1}]},gradients:false,alpha:false,onChange:paint=>{
      if(editor.report!==report||editor.selectedUid!==uid||editor.figure!==figure||editor.tick!==tick)throw messageError(new Error(''), "errors.app.selectionChangedReopenThePalette", {});
      pause();editor.replaceFigureColor(entry.color,paint.stops[0].color,{targets:entry,indices:rangeFrames()});
    }};
  }
  if(input.id==='figure-color'){
    const report=editor.report,tick=editor.tick,uids=[...editor.selectedUids].join(',');let previous=input.value,previousOpacity=1-(editor.object.field28??0)/255;
    return {anchor:input,paint:{type:'solid',stops:[{offset:0,color:parseColor(input.value).color,opacity:1-(editor.object.field28??0)/255}]},gradients:false,onChange:paint=>{
      if(editor.report!==report||editor.tick!==tick||[...editor.selectedUids].join(',')!==uids)throw messageError(new Error(''), "errors.app.selectionChangedReopenTheColorPicker", {});
      const value=hexColor(paint.stops[0].color),opacity=paint.stops[0].opacity;pause();editor.setFigureColor(value===previous&&opacity!==previousOpacity?undefined:value,{indices:rangeFrames(),opacity});previous=value;previousOpacity=opacity;
    }};
  }
  if (input.id === 'segment-color') {
    const uid=editor.selectedUid, joint=editor.selectedJoint, figure=editor.figure;
    return {anchor:input, paint:displayedSegmentPaint(editor.report,figure,editor.object,resolveInstanceFigure(figure,editor.object).segments[joint]), onChange:paint=>{
      if(editor.selectedUid!==uid || editor.selectedJoint!==joint || editor.figure!==figure) throw messageError(new Error(''), "errors.app.selectionChangedReopenTheColorPicker", {});
      pause(); updateBuilderStyle({paint},event);
    }};
  }
  if(input.id==='background-color'||input.id==='crumb-background'){
    const bg=editor.report.backgrounds?.find(b=>b.background_id===editor.frame.background_id),override=editor.frame._stykBackgroundColor;
    return {anchor:input,paint:backgroundPaint(override===undefined?bg:{kind:2,color:override}),onChange:paint=>{
      if(paint.type==='solid')editor.setSceneColor(paintBackground(paint).color,{indices:rangeFrames()});
      else editor.importSceneBackground({...paintBackground(paint),name:paint.type+' gradient'},{indices:rangeFrames()});
    }};
  }
  if(input.dataset.polygonColor!==undefined){const index=Number(input.dataset.polygonColor),p=resolveInstanceFigure(editor.figure,editor.object).polyfills[index];return {anchor:input,gradients:false,paint:{type:'solid',stops:[{offset:0,color:displayedColor(editor.report,editor.figure,editor.object,p.color_rgb),opacity:p.alpha_raw!==undefined?1-p.alpha_raw/255:p.color_alpha??1}]},onChange:paint=>editor.updatePolygon(index,{color:paint.stops[0].color,opacity:paint.stops[0].opacity})};}
  const pairs = {'background-first':'background-alpha','background-second':'background-alpha-b','text-color':'text-opacity','figure-color':'figure-opacity'};
  const opacityId=pairs[input.id], opacity=opacityId && document.getElementById(opacityId);
  if(opacity) return {anchor:input,paint:{type:'solid',stops:[{offset:0,color:parseColor(input.value).color,opacity:Number(opacity.value)/100}]},gradients:false,onChange:paint=>{
    const current=document.getElementById(input.id); if(!current)return;
    current.value=hexColor(paint.stops[0].color); current.dispatchEvent(new Event('input',{bubbles:true}));current.dispatchEvent(new Event('change',{bubbles:true}));
    const field=document.getElementById(opacityId);if(field){field.value=paint.stops[0].opacity*100;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
  }};
}, {surface:()=>overlay,sample:sampleCanvasColor});
