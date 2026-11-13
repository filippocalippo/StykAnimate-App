import { CanvasHandleOverlay } from './canvas-handle-overlay.mjs';
import { getPivotHandles, rescalePivotHandles, frameHandleCount, denseHandles, definitionHandleCount, selectedOriginsOnly } from './canvas-interactions.mjs';
import { findFigureType } from './figure-types.mjs';
import { spatialControlMode } from './spatial-controls.mjs';
import { rigDetailsShown } from './rig-control-details.mjs';
import { affineProjection } from './motion-path.mjs';
import { isBuilderContext } from './builder-aids.mjs';

/** How long the view's scale stays still before a zoom has rested and the joints are painted at their exact sizes. */
const ZOOM_REST_MS = 150;
const emptyFrame = () => ({frame: null, key: '', bound: null, dense: false, announced: false, hidden: null, locked: null, jointsOf: null});

/**
 * The joints shown on the canvas: which figures show them in the frame on show, their descriptors (shared by drawing and
 * picking, cached per geometry and view) and the overlay that paints them. `app` supplies the editor's state:
 * `{editor, state, builderMode(), isHidden, isLocked, selection, currentFrame, showStaticHandles, usesBuilderBranch,
 * status, project, ctx, overlay, requestOverlayRender}`.
 */
export function createCanvasHandles(app) {
  const {editor, state} = app;
  // Keep one surface alive to avoid deferred GPU-context destruction on input.
  // A pan moves the painted joints once there are enough of them that repainting costs more than moving (measured: a few hundred).
  const overlay = new CanvasHandleOverlay(new OffscreenCanvas(1, 1), {panShiftFrom: 500});
  let handleCache = null;
  const handleDescriptors = {};
  const selectionHandleCache = new WeakMap();
  const selectionHandleDescriptors = {};
  /** What the joints of the frame on show depend on besides the view, worked out once per frame and per change of what hides or
   * locks a figure: whether the frame is dense (docs/SCENE-EDITING.md, "Joints in dense frames"; counted from the figures'
   * definitions and announced once a document) and which of its figures are hidden or locked. */
  let handleFrame = emptyFrame();
  /** Whether each figure is hidden (1) or locked (2), and the figure types by id, kept while nothing that hides or locks a
   * figure changes: a gesture shows a new frame each step, with the same figures. */
  let handleFigures = {key: null, bound: null, types: null, flags: new Map(), figures: new Map()};
  let handleSettleTimer = 0, handlesResting = false;
  /** The view's scale at the last draw and when it last changed: a zoom is in progress, and the joints are painted at quantised
   * sizes, until the scale has not changed for `ZOOM_REST_MS` (a frame between two notches of a wheel is still the zoom). */
  let drawnScale = null, scaleChanged = -Infinity;

  function frameHandles(frame) {
    const key = `${editor.layerViewKey}|${[...state.hidden].join(',')}|${[...state.locked].join(',')}`, bound = app.builderMode()?.boundUids ?? null;
    if (handleFrame.frame === frame && handleFrame.key === key && handleFrame.bound === bound) return handleFrame;
    const types = editor.report.figure_types;
    if (handleFigures.key !== key || handleFigures.bound !== bound || handleFigures.types !== types) handleFigures = {key, bound, types, flags: new Map(), figures: new Map()};
    const {flags, figures} = handleFigures;
    const flagsOf = uid => {
      let value = flags.get(uid);
      if (value === undefined) flags.set(uid, value = (app.isHidden(uid) ? 1 : 0) | (app.isLocked(uid) ? 2 : 0));
      return value;
    };
    const known = new Set();
    for (const object of frame.objects) known.add(object.unique_id);
    // A figure the frame does not hold (a drawing's first stroke previews one) is hidden as it says, locked only by hand.
    const hidden = {has: uid => (flagsOf(uid) & 1) !== 0}, locked = {has: uid => known.has(uid) ? (flagsOf(uid) & 2) !== 0 : state.locked.has(uid)};
    const figureOf = object => {
      let figure = figures.get(object.figure_type_id);
      if (figure === undefined) figures.set(object.figure_type_id, figure = findFigureType(types, object.figure_type_id) ?? null);
      return figure;
    };
    const count = frameHandleCount(frame, figureOf, {hiddenUids: hidden, lockedUids: locked});
    const dense = denseHandles(count, handleFrame.dense), announce = dense && !handleFrame.announced && state.settings.showUnselectedHandles;
    if (announce) app.status({messageKey: "app.denseFrameShowsOrigins", messageParams: {}});
    // The joints each figure shows whole, by its id, for the budget of a large selection (worked out when asked).
    let joints = null;
    const jointsOf = uid => {
      if (!joints) {
        joints = new Map();
        for (const object of frame.objects)
          if (object && !hidden.has(object.unique_id) && !locked.has(object.unique_id))
            joints.set(object.unique_id, (object.join ? 0 : 1) + definitionHandleCount(figureOf(object)));
      }
      return joints.get(uid) ?? 0;
    };
    handleFrame = {frame, key, bound, dense, announced: handleFrame.announced || announce, hidden, locked, jointsOf};
    return handleFrame;
  }

  function handles(geometry, {selectStatic = false} = {}) {
    const frame = app.currentFrame(),
      settings = state.settings,
      builderMode = app.builderMode();
    // In a dense frame the figures not selected show their origin only, as with the setting off: drawing and picking share these descriptors.
    const shown = frameHandles(frame), showUnselected = settings.showUnselectedHandles && !shown.dense;
    const unscaled = [
      builderMode?.active ? [...editor.selectedSegmentIds].join(',') : '',
      editor.layerViewKey,
      app.showStaticHandles(),
      state.tool,
      state.figureJoin?.uid,
      state.handleEditHeld,
      app.usesBuilderBranch(),
      editor.selectedJoint,
      spatialControlMode(editor),
      rigDetailsShown(editor),
      showUnselected,
      settings.handleSize,
      settings.autoSizeHandles,
      settings.outlineHandles,
      frame.camera?.scale,
      builderMode?.session?.typeId ?? "none",
      // The primary figure keeps its joints first when the selection is too large for all of theirs.
      editor.selectedUid,
      ...app.selection(),
      ...state.hidden,
      ...state.locked,
    ].join("|"), key = `${unscaled}|${state.view.scale}`;
    const cached = selectStatic ? selectionHandleCache.get(geometry) : handleCache;
    if (cached?.key === key && (selectStatic || cached.geometry === geometry)) return cached.handles;
    // A zoom changes the joints' sizes alone: the descriptors are resized, not built again.
    if (!selectStatic && cached?.unscaled === unscaled && cached.geometry === geometry) {
      const resized = rescalePivotHandles(cached.handles, {viewScale: state.view.scale, autoSize: settings.autoSizeHandles, minDiameter: 4, maxDiameter: settings.handleSize * 2});
      handleCache = {geometry, key, unscaled, handles: resized};
      return resized;
    }
    const {hidden, locked} = shown;
    // A selection whose own joints exceed the budget shows them for the figures selected last only (docs/SCENE-EDITING.md).
    const originsOnlyUids = shown.dense ? selectedOriginsOnly(app.selection(), editor.selectedUid, shown.jointsOf) : null;
    const built = getPivotHandles(geometry, {
      showDetailed: rigDetailsShown(editor),
      spatialMode: builderMode?.active || !['select','pose'].includes(state.tool) ? 'pose' : spatialControlMode(editor),
      descriptorCache: selectStatic ? selectionHandleDescriptors : handleDescriptors,
      selectStatic,
      joinTargetUids: state.figureJoin?.targets,
      frame,
      selectedUid: editor.selectedUid,
      selectedUids: app.selection(),
      originsOnlyUids,
      hiddenUids: hidden,
      lockedUids: locked,
      showUnselected,
      showStatic: app.showStaticHandles(),
      selectedJoint: editor.selectedJoint,
      selectedHandleIds: builderMode?.active ? editor.selectedSegmentIds : undefined,
      selectedBranch: app.usesBuilderBranch(),
      builder: isBuilderContext(state.tool),
      attaching: state.tool === "attach",
      allowStaticManipulation:
        state.tool === "rig" ||
        state.handleEditHeld,
      viewScale: state.view.scale,
      autoSize: settings.autoSizeHandles,
      maxDiameter: settings.handleSize * 2,
    });
    if (selectStatic) selectionHandleCache.set(geometry, {key, handles: built});
    else handleCache = { geometry, key, unscaled, handles: built };
    return built;
  }

  function draw(geometry) {
    const shown = handles(geometry),
      translations = state.drag?.translations;
    const d = window.devicePixelRatio || 1, now = performance.now();
    if (drawnScale !== null && drawnScale !== state.view.scale) scaleChanged = now;
    drawnScale = state.view.scale;
    const zooming = now - scaleChanged < ZOOM_REST_MS;
    // The view and the camera are affine: the matrix carries the projection, and its translation alone changing is a pan.
    const drawn = overlay.draw(app.ctx, shown, {matrix: affineProjection(app.project), projectionKey: handleCache.key,
      width: app.overlay.width / d, height: app.overlay.height / d, dpr: d, translations,
      outline: state.settings.outlineHandles, rest: handlesResting, zooming});
    // A pan or a moving selection moves the joints' pixels, and a zoom paints them at sizes near theirs: once the view has rested
    // a moment, they are painted afresh (see CanvasHandleOverlay).
    handlesResting = false;
    clearTimeout(handleSettleTimer);
    if (drawn.settle) handleSettleTimer = setTimeout(() => { handlesResting = true; app.requestOverlayRender(); }, zooming ? Math.max(0, ZOOM_REST_MS - (now - scaleChanged)) + 1 : 150);
  }

  return {
    handles,
    draw,
    /** Forgets the painted joints, so the next draw paints them afresh. */
    repaint: () => overlay.clear(),
    /** Forgets the joints' descriptors after a change to figures' definitions or structure; a new document also forgets
     * whether its frames were dense and the announcement made. */
    invalidate({document = false} = {}) {
      handleCache = null;
      overlay.clear();
      if (document) handleFrame = emptyFrame();
    },
  };
}
