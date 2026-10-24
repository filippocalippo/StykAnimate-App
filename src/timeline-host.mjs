import {messageTuple, localizedText} from './localization-bindings.mjs';
import {t as interfaceText, messageText as sayTimeline} from './localization.mjs';

/**
 * The timeline island's host (architecture.md §3.14): mounts the Simple or
 * Advanced timeline into #timeline with the app's callbacks and the shared
 * header (timeline-header.mjs: its three clusters, Timeline ⋯, Go to frame
 * and the ruler's tools), wires the header's own controls (the mode switch
 * #timeline-workflow, the frame rate #fps and the zoom #timeline-zoom), and
 * writes what the header shows: the transport's readouts (#time-display, the
 * hidden #timeline-summary and #frame-badge, #fps), the play button's state,
 * Loop, Edit together (#range-edit) and which mode is pressed. Those writes
 * go through ui/dom-write.mjs: during playback the readout changes (5 Hz,
 * through the app's transport surface) and nothing else in the header does.
 *
 * The timeline components (layer-timeline.mjs, sheet-filmstrip.mjs) stay the
 * engines; this module is the one place that constructs them. DOM-free at
 * import: createTimelineHost() wires the header when it is called.
 *
 * ctx (from app.mjs): {editor, state, $, actions, guarded, audioEngine,
 * onionController, hotkeys, play, pause, finishKeyboardHandle, cancelDrag,
 * cancelPolygonDraft, interruptRecovery, cancelWarmPlayback, warmPlayback,
 * scheduleRecovery, requestRender, queueUI, renderInspector,
 * syncSelectionControls, rangeFrames(all), selectTrack, previewScrub,
 * scrubAudio(tick), stopAudioScrub(), changeFigureLayer,
 * runClipboardOperation, confirmDiscardFrame, simpleFrameCount, fail,
 * setTimelineMode(mode), onMount(timeline), and getters for what app.mjs
 * creates later: propertyControls(), cameraMotionControls(), drawing(),
 * builder(), sharedClipboard(), thumbnails(), localization(), touch()}; optionally
 * `overlays` (menus and Go to frame then block the editor's hotkeys).
 */
import {Timeline} from './layer-timeline.mjs';
import {SheetFilmstrip as SimpleTimeline} from './sheet-filmstrip.mjs';
import {InsertInbetweenDialog} from './insert-inbetween-dialog.mjs';
import {drawingResourcesFor} from './drawing-resources.mjs';
import {refreshHotkeyHints} from './hotkey-hints.mjs';
import {icon} from './icons.mjs';
import {setAttr, setMarkup, setProp, setText} from './ui/dom-write.mjs';
import {createTimelineHeader} from './timeline-header.mjs';
import {normalizePlaybackRange} from './playback-window.mjs';
import {TimelineLayerView} from './timeline-layer-view.mjs';

export function createTimelineHost(ctx) {
  const {editor, state, $, actions} = ctx;
  const layerView = new TimelineLayerView(editor);
  let timeline = null, inbetweenDialog, shownPlayback = null;
  const header = createTimelineHeader(ctx, {
    get timeline() { return timeline; },
    goToFrame: (number) => goToFrame(number),
    setPlaybackRange,
  });

  // Playback limits belong to the document's timeline session, independently
  // of the editing selection. A replacement document starts with its full span.
  editor.addEventListener('change', event => {
    const detail = event.detail ?? {};
    if (detail.kind === 'document') {
      state.loopRange = null;
      header.closePlaybackRange();
    } else if (state.loopRange && (detail.timing || detail.structural || detail.kind === 'history')) {
      const {start, end} = normalizePlaybackRange(state.loopRange, editor.totalTicks);
      state.loopRange = end > start ? {startTick: start, endTick: end} : null;
    } else return;
    header.sync();
  });

  function setPlaybackRange(range) {
    ctx.pause();
    ctx.cancelWarmPlayback();
    const {start, end} = normalizePlaybackRange(range, editor.totalTicks);
    state.loopRange = range && end > start ? {startTick: start, endTick: end} : null;
    header.sync();
    ctx.warmPlayback();
  }

  // The header's own controls.
  $("fps").addEventListener(
    "change",
    ctx.guarded((e) => editor.setFPS(Number(e.target.value))),
  );
  $("timeline-zoom").addEventListener("input", (e) =>
    timeline?.setZoom?.(Number(e.target.value), undefined, true),
  );
  // Typing a frame rate or working in the timeline ends a polygon being drawn.
  for (const id of ["timeline", "fps"]) {
    $(id).addEventListener("focusin", ctx.cancelPolygonDraft);
    $(id).addEventListener("pointerdown", ctx.cancelPolygonDraft, true);
  }
  $("timeline-workflow").addEventListener("click", (event) => {
    const button = event.target.closest("[data-timeline-mode]");
    if (button) ctx.setTimelineMode(button.dataset.timelineMode);
  });

  const renderThumbnail = (index, canvas, options) =>
    ctx.thumbnails().renderThumbnail(index, canvas, {
      ...options,
      storedFrames: !editor.report._styk?.layerSheet && state.settings.timelineMode === "simple",
    });

  /** Replaces the timeline with a new one for the current mode; returns it. */
  function mount() {
    ctx.pause();
    ctx.finishKeyboardHandle();
    ctx.propertyControls()?.commit();
    if (editor._animationEdit) editor.commitAnimationEdit();
    if (editor.dragging) editor.commitDrag();
    if (state.settings.timelineMode === "advanced") editor.disableFrameDrafts();
    state.rangeIndices = [];
    state.applyRange = false;
    state.loopRange = null;
    header.closePlaybackRange();
    timeline?.destroy();
    $("timeline").replaceChildren();
    const TimelineClass =
      state.settings.timelineMode === "simple" ? SimpleTimeline : Timeline;
    timeline = new TimelineClass($("timeline"), editor, {
      layerView,
      header,
      overlays: ctx.overlays ?? null,
      // The touch interface's state (docs/TOUCH.md): the grid takes a finger's swipes, taps and holds.
      touch: {get active() { return Boolean(ctx.touch?.()?.active); }},
      getSettings: () => state.settings,
      audioEngine: ctx.audioEngine,
      onCameraMotionPreview: clip => ctx.cameraMotionControls()?.previewTimeline(clip),
      onTogglePlay: ctx.play,
      onHistory: direction => actions[direction](),
      onCancel: () => ctx.drawing()?.cancel(),
      onionController: ctx.onionController,
      onAddFrame: () => actions["add-frame"](),
      // The Simple frame bar's Edit together switch runs the header's command; syncRangeEdit writes its state.
      onToggleRangeEdit: () => actions["toggle-range-edit"](),
      localizationText: (key, params) => ctx.localization?.()?.t?.(key, params) ?? key,
      onDeleteLayer: id => ctx.changeFigureLayer(interfaceText("timelineHost.deleteLayer"),options=>editor.deleteLayerAsync(id,options), {labelKey:"timelineHost.deleteLayer"}),
      hotkeys: ctx.hotkeys,
      runClipboardOperation: ctx.runClipboardOperation,
      sharedClipboard: ctx.sharedClipboard(),
      confirmDiscardFrame: ctx.confirmDiscardFrame,
      onTrackSelect: ctx.selectTrack,
      onKeysChange: () => {
        state.inspectorTab = "animation";
        if (!["camera", "scene"].includes(state.inspectorContext))
          state.inspectorContext = "frame";
        ctx.queueUI();
      },
      renderThumbnail,
      onInsertInbetween: (indices) => {
        ctx.finishKeyboardHandle();
        ctx.pause();
        ctx.cancelDrag();
        ctx.propertyControls()?.cancel();
        inbetweenDialog ??= new InsertInbetweenDialog({
          editor,
          getSettings: () => state.settings,
          renderThumbnail,
          onApply: ctx.queueUI,
          onClose: ctx.queueUI,
          onError: ctx.fail,
        });
        inbetweenDialog.open(indices);
      },
      onUpdateFrame: () => {
        if (editor.dragging) editor.commitDrag();
        ctx.queueUI();
      },
      onSeek: () => ctx.pause(),
      beforeCommand: () => ctx.drawing()?.settle({selection:true}),
      // Wait for both preparation and its canvas submission before another seek.
      // The timeline retains only the latest pointer target during this interval.
      canScrub: () => !state.dirtyRender,
      onScrubStart: () => {
        ctx.pause();
        ctx.interruptRecovery();
        ctx.cancelWarmPlayback();
        state.scrubbing = true;
        const drawing=drawingResourcesFor(editor.report);if(drawing)drawing.busy=true;
        ctx.requestRender();
      },
      onScrub: tick => {
        ctx.previewScrub(tick);
        ctx.scrubAudio(tick);
      },
      onScrubEnd: () => {
        ctx.stopAudioScrub();
        state.scrubbing = false;
        const drawing=drawingResourcesFor(editor.report);if(drawing)drawing.busy=false;
        ctx.queueUI();
        ctx.requestRender();
        ctx.warmPlayback();
        if (editor.dirty) ctx.scheduleRecovery();
      },
      onError: ctx.fail,
      onRangeChange: (indices) => {
        state.rangeIndices = indices;
        if (!ctx.rangeFrames(true)) state.applyRange = false;
        ctx.syncSelectionControls();
        if (!state.scrubbing) ctx.renderInspector();
        localizedText($("selection-summary"), "timelineHost.keyframeSelected", {count: indices.length});
      },
    });
    header.mount(timeline);
    ctx.onMount?.(timeline);
    $("timeline")
      .closest(".timeline-panel")
      .classList.toggle("simple-mode", state.settings.timelineMode === "simple");
    syncMode();
    refreshHotkeyHints(ctx.hotkeys);
    return timeline;
  }

  /** The timeline island in the shell: a shown timeline refits its body. */
  function attach(shell) {
    header.attach(shell);
    shell.define({
      id: "timeline",
      root: () => $("animation-timeline"),
      onVisibility: (visible) => { if (visible) timeline?.resize(); },
    });
  }

  /** The transport's readouts and the frame rate; the timeline updates its playhead. */
  function updateTransport() {
    const fps = editor.report.fps,
      tick = editor.tick;
    setText($("time-display"),
      `${String(Math.floor(tick / fps / 60)).padStart(2, "0")}:${String(Math.floor(tick / fps) % 60).padStart(2, "0")}:${String(tick % fps).padStart(2, "0")}`);
    localizedText($("frame-badge"), "timelineHost.frame", {value: String(tick + 1).padStart(2, "0")});
    // Simple mode counts Pivot-style timeline frames; playback, the ruler and
    // export count every frame including inbetweens. Name both explicitly.
    const stored = ctx.simpleFrameCount(), total = editor.totalTicks,
      seconds = `${(total / fps).toFixed(2)}s`;
    setText($("timeline-summary"), stored !== null && stored !== total
      ? `${stored} ${stored === 1 ? "frame" : "frames"} · plays as ${total} with inbetweens · ${seconds}`
      : `${total} ${total === 1 ? "frame" : "frames"} · ${seconds}`);
    setProp($("fps"), "value", String(fps));
    header.sync();
    timeline?.update(state.settings.timelineMode !== 'advanced');
  }

  /** Play, Pause while playing, Stop while previewing one frame; written only when that changes (playback starts or stops).
   * The Simple timeline hears it too: it stays still while playing and catches up at the stop. */
  function syncPlayButton() {
    timeline?.setPlaying?.(state.playing);
    const [glyph, label] = state.previewing ? messageTuple(["stop", interfaceText("timelineHost.stopPreview")], {1: {key: "timelineHost.stopPreview", params: {}}}) : state.playing ? messageTuple(["pause", interfaceText("timelineHost.pause")], {1: {key: "timelineHost.pause", params: {}}}) : messageTuple(["play", interfaceText("timelineHost.play")], {1: {key: "timelineHost.play", params: {}}});
    if (glyph === shownPlayback) return;
    shownPlayback = glyph;
    setMarkup($("play-button"), icon(glyph));
    setAttr($("play-button"), "aria-label", label);
    ctx.localization()?.updatePlayback($("play-button"), state);
  }

  /** Edit together (today's Edit selected frames): available while two or more frames are selected, outside
   * Build and Draw; its word shows only then (a quiet glyph otherwise), and a one-frame file never shows it. */
  function syncRangeEdit() {
    const indices = ctx.rangeFrames(true), count = indices?.sheetTicks?.length ?? indices?.length ?? 0;
    const range = $('range-edit');
    if (count < 2) state.applyRange = false;
    setProp(range, 'disabled', count < 2 || Boolean(ctx.builder()?.active || ctx.drawing()?.active));
    setAttr(range, 'aria-pressed', String(!range.disabled && state.applyRange));
    setText(range.querySelector('.range-edit-count'), count > 1 ? String(count) : '');
    setAttr(range, 'data-hotkey-title', sayTimeline(null, count > 1 ? 'timeline.editTogetherReady' : 'timeline.editTogetherIdle', {count}));
    header.setEditTogether({oneFrame: editor.totalTicks < 2, ready: !range.disabled});
    timeline?.setEditTogether?.({ready: !range.disabled, on: !range.disabled && state.applyRange});
    refreshHotkeyHints(ctx.hotkeys, range.closest('.timeline-toolbar') ?? range.parentElement);
  }

  /** Go to frame (the readout's popover; the palette's frame jump): a card in Simple, a frame of the ruler in Advanced. */
  function goToFrame(number) {
    if (!timeline) return;
    const clamp = (value, max) => Math.min(Math.max(1, Math.round(value) || 1), Math.max(1, max));
    if (timeline.strip) return timeline.selectFrame(clamp(number, timeline.frameCount) - 1);
    const tick = clamp(number, editor.totalTicks) - 1;
    return timeline._run(() => { timeline.seek(tick); timeline.revealPlayhead(); });
  }

  /** Which of Simple and Advanced is pressed. */
  function syncMode() {
    document.querySelectorAll('[data-timeline-mode]').forEach(button=>setAttr(button,'aria-pressed',String(button.dataset.timelineMode===state.settings.timelineMode)));
  }

  return {
    get timeline() { return timeline; },
    header,
    mount, attach, updateTransport, syncPlayButton, syncRangeEdit, syncMode, goToFrame,
  };
}
