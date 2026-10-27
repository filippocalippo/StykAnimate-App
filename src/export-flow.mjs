import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';
import {localizedMarkup} from './localization-bindings.mjs';
/**
 * Exporting (architecture.md §3.15): the export dialog (showExport opens
 * export-sheet.mjs), every export command, the export renderer's job with its
 * progress, and writing the result (saveBlob, finishExport).
 *
 * The export commands register themselves in the app's `actions` map, before
 * app.mjs wraps every action (drawing barrier, polygon guard, telemetry).
 * Every export runs from an explicit ExportRequest (export-request.mjs): the
 * request holds the choices, and exportJob() derives the options, file name
 * and encoder arguments from it and the editor's state. The export dialog
 * holds the request and runs the chosen type's command, which exports the
 * dialog's request; a command run without the dialog (the command palette)
 * exports today's defaults: the artboard size, the whole animation, 94%.
 * tests/export-request.test.mjs proves the derivation equals the dialog-field
 * code it replaced (tests/fixtures/export-legacy.mjs).
 *
 * While an export renders, its progress shows in the export dialog, or in a
 * dialog of its own when the export was not started from it.
 *
 * DOM-free at import. ctx (from app.mjs): {editor, state, actions, desktop,
 * telemetry, audioEngine, exportJobs, playback, fail, status, toast, persistentFailure,
 * finishCurrentEdit, pause, interruptRecovery, runDocumentExport,
 * writeNativeBlob, currentFrame, nameOf, simpleFrameCount}; optionally
 * overlays (the overlay stack), localization() and commitSettings(patch),
 * which keeps the dialog's choices in the editor setting exportPreferences
 * (without it they last for the session).
 */
import { encodeMP4, encodeWebM } from "./video-export.mjs";
import { encodeNativeVideo } from "./native-video-export.mjs";
import { encodeVfwVideo } from "./vfw-video-export.mjs";
import { VfwExportControls } from "./vfw-export-controls.mjs";
import { getExportCapabilities, exportFormat } from "./export-capabilities.mjs";
import { audioState, audibleClips } from "./audio-model.mjs";
import { workload } from "./telemetry-workload.mjs";
import { sizeBucket } from "./telemetry-schema.mjs";
import { openExportSink as openExportSinkRaw } from "./export-sink.mjs";
import { materializeSimpleFrameDraftForPivot } from "./pivot-frame-draft.mjs";
import { exportAnimation } from "./image-export.mjs";
import { defaultGIFDither } from "./gif-options.mjs";
import { createExportFrameRenderer, prewarmExportRenderer } from "./engine/engine-export.mjs";
import { exportProgressMarkup, mountExportProgress } from "./export-progress.mjs";
import { checkExportContext } from "./export-canvas.mjs";
import { buildExportRequest, exportFormatInfo, exportJob } from "./export-request.mjs";
import { openExportSheet, openExportProgress } from "./export-sheet.mjs";
import { createThumbnailRenderer } from "./engine/engine-thumbnails.mjs";
import { isMovieclip } from "./movieclips.mjs";
import { icon } from "./icons.mjs";

export function createExportFlow(ctx) {
  const {
    editor, state, actions, desktop, telemetry, audioEngine, exportJobs, playback,
    fail, status, toast, persistentFailure, finishCurrentEdit, pause, interruptRecovery,
    runDocumentExport, writeNativeBlob, currentFrame, nameOf, simpleFrameCount,
  } = ctx;
  const exportTelemetry = new WeakMap();
  const t = (key, params) => ctx.localization?.()?.t(key, params);
  const glyph = name => icon(name);
  /** The open export dialog (export-sheet.mjs), or null. */
  let sheet = null;
  /** The dialog's remembered choices when the editor settings cannot hold them. */
  let sessionPreferences = null;
  const exportPreferences = () => state.settings?.exportPreferences ?? sessionPreferences;
  function rememberPreferences(preferences) {
    sessionPreferences = preferences;
    ctx.commitSettings?.({ exportPreferences: preferences });
  }
  async function openExportSink(options){
    const enabled=telemetry.consent.diagnostics,context=enabled?telemetry.performance.context():null,epoch=telemetry.epoch,started=enabled?performance.now():0;
    const onTiming=(metric,ms)=>{if(epoch===telemetry.epoch)telemetry.performance.record(metric,ms,context);};
    const sink=await openExportSinkRaw({...options,...(enabled?{onTiming}:{})});
    if(enabled)onTiming('dialog',performance.now()-started);
    return sink;
  }
  /** Says an export finished and where: the file's name as saved (the save dialog may rename it). */
  function exported(saved, filename) {
    const path = typeof saved === "string" ? saved : typeof saved?.path === "string" ? saved.path : "";
    const name = path ? path.split(/[\/]/).at(-1) : filename;
    status(interfaceText("exportFlow.exported", {name: name}));
    toast(interfaceText("exportFlow.exported", {name: name}));
  }
  async function saveBlob(blob, filename, signal) {
    const measurement = signal && exportTelemetry.get(signal), writeStarted = performance.now();
    measurement?.onProgress?.({phase: 'saving'});
    measurement?.releaseRenderer?.();
    if (measurement) {
      measurement.context.size = sizeBucket(blob.size);
      telemetry.timing('export_ms', writeStarted - measurement.started);
      telemetry.operation({ ...measurement.context, operation: 'export', stage: 'encode', outcome: 'succeeded' }, writeStarted - measurement.started);
      measurement.stage = 'write';
    }
    let saved;
    if (desktop) {
      saved = await writeNativeBlob(desktop, blob, {
        signal,
        defaultPath: filename,
        filters: [
          {
            name: filename.split(".").at(-1).toUpperCase(),
            extensions: [filename.split(".").at(-1)],
          },
        ],
      });
    } else {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
      saved = true;
    }
    if (measurement) telemetry.operation({ ...measurement.context, operation: 'export', stage: 'write', outcome: saved ? 'succeeded' : 'cancelled' }, performance.now() - writeStarted);
    return saved;
  }
  /** Route an encoder result to its saved state: a Blob goes through the
   * classic save path; a sink finish() result is already on disk. */
  async function finishExport(output, filename, signal) {
    const blob = output instanceof Blob ? output : output?.blob;
    if (blob) return saveBlob(blob, filename, signal);
    const measurement = signal && exportTelemetry.get(signal), finished = performance.now();
    if (measurement) {
      measurement.context.size = sizeBucket(output?.size ?? 0);
      telemetry.timing('export_ms', finished - measurement.started);
      telemetry.performance.record('encode',finished-measurement.started);
      telemetry.operation({ ...measurement.context, operation: 'export', stage: 'encode', outcome: 'succeeded' }, finished - measurement.started);
      measurement.stage = 'write';
      measurement.releaseRenderer?.();
      telemetry.operation({ ...measurement.context, operation: 'export', stage: 'write', outcome: output?.saved ? 'succeeded' : 'cancelled' }, 0);
    }
    return Boolean(output?.saved);
  }
  /**
   * The choices of an export of `format` (an EXPORT_FORMATS id) as an
   * ExportRequest: the open export dialog's, when it is exporting this type;
   * otherwise today's defaults (the artboard size, the whole animation, 94%
   * quality), as a palette command exports.
   */
  function currentRequest(format) {
    if (sheet?.open && sheet.request.format === format) return sheet.request;
    return buildExportRequest({ format }, {
      canvasWidth: editor.report.canvas_width,
      canvasHeight: editor.report.canvas_height,
      totalFrames: editor.totalTicks,
    });
  }
  /** What exportJob() reads from the editor. `report` is the one played: in Simple mode, with its working frame materialized. */
  function jobContext(request, report = editor.report) {
    return {
      totalFrames: editor.totalTicks,
      fps: report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps,
      defaultDither: defaultGIFDither(editor.report),
      // Browser video uses WebCodecs: WebM unless the export dialog's capability probe chose FFmpeg for it,
      // and MP4 wherever there is no desktop encoder.
      provider: sheet?.open ? sheet.states.get(request.format)?.provider : desktop?.getVideoCapabilities ? undefined : "WebCodecs",
      // Whether the browser's encoder can take the soundtrack. Without the dialog's probe, the encoder itself refuses if it cannot.
      browserAudio: sheet?.open ? sheet.states.get(request.format)?.audio === true : typeof globalThis.AudioEncoder === "function",
      audioClips: audibleClips(audioState(report)),
      loop: state.loop,
      name: editor.name,
      objectName: nameOf(editor.object),
      tick: editor.tick,
      movieclip: isMovieclip(editor.figure),
      vfw: request.format === "vfw" ? (sheet?.open ? sheet.vfwContext() : { available: false }) : undefined,
    };
  }
  const playedReport = () =>
    state.settings.timelineMode === "simple"
      ? materializeSimpleFrameDraftForPivot(editor.report)
      : editor.report;
  /** An editable file: .piv, .stk, .stkz, or .stykmov (the figure type of a selected movieclip). */
  async function exportPivot(type = "piv") {
    finishCurrentEdit();
    interruptRecovery();
    const request = currentRequest(type),
      { format, filename } = exportJob(request, jobContext(request));
    status(interfaceText("exportFlow.writing", {format: format}), false, true);
    let saved;
    try {
      saved = await runDocumentExport(format, (blob, signal) =>
        saveBlob(blob, filename, signal),
      );
    } catch (error) {
      if (error.name === "AbortError") {
        status(interfaceText("exportFlow.exportCancelled"));
        return;
      }
      throw error;
    }
    if (saved) {
      status(interfaceText("exportFlow.exported2", {format: format}));
      toast(
        interfaceText(["stk", "stkz", "stykmov"].includes(format) ? "exportFlow.figureExportedAs" : "exportFlow.animationExportedAs", {format}),
      );
    }
    sheet?.close();
  }
  /** Where an export's progress shows: the export dialog it was started from, else a dialog of its own. */
  const progressHost = (title) =>
    sheet?.open ? sheet.showProgress(title) : openExportProgress({ title, overlays: ctx.overlays, icon: glyph, t });
  /** Keep rendering off the UI thread and cancel the whole job if its document changes. */
  async function withExportRenderer(
    options,
    report,
    render,
    { frames = 1, title = interfaceText("exportFlow.exportingAnimation"), format = 'unknown', fps, passes = 1, start = options.start ?? editor.tick } = {},
  ) {
    if ([...exportJobs].some(job => job.raster)) throw messageError(new Error(''), "errors.exportFlow.anExportIsAlreadyRunningWaitForIt", {});
    pause();
    interruptRecovery();
    // Drop speculative playback frames while keeping the editable document and
    // active scene. The engine prepares them again when playback resumes.
    playback.invalidate();
    const controller = new AbortController(),
      job = { controller, recovery: false, raster: true },
      source = editor.report;
    exportJobs.add(job);
    const measurement = { started: performance.now(), stage: 'prepare', context: telemetry.consent.diagnostics ? workload({ format, report, fps }) : {} };
    telemetry.count('export_started'); exportTelemetry.set(controller.signal, measurement);
    let frameRenderer;
    const host = progressHost(title),
      cancel = () => controller.abort();
    localizedMarkup(host.content, exportProgressMarkup);
    // Closing the dialog while the export runs cancels it.
    host.onClose(cancel);
    const progressUI = mountExportProgress(host.content, {frames, passes, start}, cancel);
    measurement.onProgress = value => progressUI.update(value);
    measurement.releaseRenderer = () => frameRenderer?.dispose();
    try {
      // The engine draws the frames (src/engine/engine-export.mjs); an SVG is the engine's vector output.
      frameRenderer = createExportFrameRenderer({
        width: options.width,
        height: options.height,
        smoothing: options.smoothing,
        signal: controller.signal,
        onFrame: ({stage, tick}) => stage === 'rendering' ? progressUI.frameStarted(tick) : progressUI.frameRendered(),
        getRevision: () =>
          editor.report === source
            ? `${editor.revision}`
            : "replaced",
      }, {stage: state.renderer, revision: editor.revision, range: [start, start + frames - 1], vector: format === 'svg'});
      await frameRenderer.load(report);
      measurement.stage = 'encode';
      const saved = await render(
        frameRenderer,
        controller.signal,
        value => {
          progressUI.update(value);
          // Every consumer has acknowledged the last frame. Release raster pixels
          // and the worker's document before container assembly and file writing.
          if (value.completed === frames * passes) frameRenderer.dispose();
        },
      );
      telemetry.count(saved ? 'export_succeeded' : 'export_cancelled');
      telemetry.operation({ ...measurement.context, operation: 'export', stage: 'complete', outcome: saved ? 'succeeded' : 'cancelled' }, performance.now() - measurement.started);
      if (saved) telemetry.milestone('first_export');
      return saved;
    } catch (error) {
      telemetry.count(error.name === 'AbortError' ? 'export_cancelled' : 'export_failed');
      telemetry.operation({ ...measurement.context, operation: 'export', stage: 'complete', outcome: error.name === 'AbortError' ? 'cancelled' : 'failed' }, performance.now() - measurement.started);
      if (error.name !== 'AbortError') telemetry.error(error, 'export', { ...measurement.context, stage: measurement.stage });
      if (error.name === "AbortError") {
        status(interfaceText("exportFlow.exportCancelled"));
        return false;
      }
      throw persistentFailure(error);
    } finally {
      frameRenderer?.dispose();
      progressUI.dispose();
      exportTelemetry.delete(controller.signal);
      exportJobs.delete(job);
      host.onClose(null);
      host.close();
    }
  }
  async function exportPNG() {
    telemetry.count('export_png');
    finishCurrentEdit();
    const request = currentRequest("png"),
      { options, filename } = exportJob(request, jobContext(request)),
      frame = currentFrame();
    await withExportRenderer(
      options,
      editor.report,
      async (renderer, signal) => {
        const canvas = await renderer.renderFrame(frame);
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        checkExportContext(renderer.context);
        if (!blob) throw messageError(new Error(''), "errors.exportFlow.pngExportFailed", {});
        if (signal.aborted)
          throw messageError(new DOMException('', "AbortError"), "errors.exportFlow.exportCancelled", {});
        const saved = await saveBlob(blob, filename, signal);
        if (saved) exported(saved, filename);
        return saved;
      },
      { title: interfaceText("exportFlow.exportingFrame"), titleKey: "exportFlow.exportingFrame", format: 'png', start: editor.tick },
    );
  }
  async function exportSVGFrame() {
    telemetry.count('export_svg');
    finishCurrentEdit();
    // SVG keeps vector paths: its options say "edges" whatever the request's smoothing.
    const request = currentRequest("svg"),
      { options, filename } = exportJob(request, jobContext(request)),
      frame = currentFrame();
    await withExportRenderer(
      options,
      editor.report,
      async (renderer, signal) => {
        const blob = await renderer.renderSVGFrame(frame);
        const saved = await saveBlob(blob, filename, signal);
        if (saved) exported(saved, filename);
        return saved;
      },
      { title: interfaceText("exportFlow.exportingVectorFrame"), titleKey: "exportFlow.exportingVectorFrame", format: 'svg', start: editor.tick },
    );
  }
  async function exportImages(format) {
    telemetry.count(format.startsWith('svg') ? 'export_svg' : format.startsWith('gif') ? 'export_gif' : format.startsWith('jpeg') ? 'export_jpeg' : 'export_png');
    finishCurrentEdit();
    // The options, frame count, rate, name and GIF repeat (the Loop setting) come from the request.
    const request = currentRequest(format),
      report = playedReport(),
      { options, ticks, fps, filename, animation } = exportJob(request, jobContext(request, report));
    if ([...exportJobs].some(job => job.raster)) throw messageError(new Error(''), "errors.exportFlow.anExportIsAlreadyRunningWaitForIt", {});
    // Streamed exports pick their destination up front, then write while encoding.
    const sink = await openExportSink({
      filename,
      mimeType: exportFormat(format)?.mimeType,
      desktop,
    });
    if (!sink) {
      telemetry.count('export_cancelled');
      return false;
    }
    try {
      return await withExportRenderer(
        options,
        report,
        async (renderer, signal, onProgress) => {
          sink.signal = signal;
          const output = await exportAnimation({
            ...animation,
            signal,
            onProgress,
            sink,
            renderFrame: (index) => renderer.renderTick(index + options.start),
            renderPNGFrame: (index) => renderer.renderNativeTick(index + options.start, {preserveAlpha: true}),
            renderSVGFrame: (index) =>
              renderer.renderSVGTick(index + options.start),
          });
          const saved = await finishExport(output, filename, signal);
          if (saved) exported(saved, filename);
          return saved;
        },
        { frames: ticks, format: format === 'apng' ? 'png' : format.split('-')[0], fps, passes: format === 'gif' ? 2 : 1 },
      );
    } catch (error) {
      await sink.abort().catch(() => {});
      throw error;
    }
  }
  async function exportVideo(format = "webm") {
    telemetry.count('export_video');
    finishCurrentEdit();
    // The request gives the encoder, codec, quality or bitrate, Windows codec
    // options, size, range and whether sound goes in; a request that cannot be
    // encoded (sound with a browser encoder, a VFW codec still being checked)
    // throws here with the reason, before a file is chosen.
    const request = currentRequest(format),
      report = playedReport(),
      plan = exportJob(request, jobContext(request, report)),
      { options, ticks, fps, extension, filename, includeAudio } = plan;
    const encode = { vfw: encodeVfwVideo, webcodecs: format === "mp4" ? encodeMP4 : encodeWebM, native: encodeNativeVideo }[plan.encoder];
    // Native exports keep the encoded file on disk in the desktop process; a
    // direct save moves it without piping bytes through the renderer. Every
    // other path streams encoder output into the chosen file as it is produced.
    const saveMethod =
      encode === encodeNativeVideo
        ? "saveVideoExport"
        : encode === encodeVfwVideo
          ? "saveVfwExport"
          : null;
    const directSave =
      saveMethod && typeof desktop?.[saveMethod] === "function";
    if ([...exportJobs].some(job => job.raster)) throw messageError(new Error(''), "errors.exportFlow.anExportIsAlreadyRunningWaitForIt", {});
    const sink = directSave
      ? null
      : await openExportSink({
          filename,
          mimeType: exportFormat(format === "vfw" ? "avi" : format)?.mimeType,
          desktop,
        });
    if (!directSave && !sink) {
      telemetry.count('export_cancelled');
      return false;
    }
    try {
      return await withExportRenderer(
        options,
        report,
        async (renderer, signal, onProgress) => {
          if (sink) sink.signal = signal;
          const output = await encode({
            audioChunks: includeAudio ? audioEngine.exportChunks(report, {start:options.start / fps,duration:ticks / fps,signal}) : undefined,
            ...plan.encode,
            desktop,
            signal,
            onProgress,
            sink,
            save: directSave
              ? {
                  defaultPath: filename,
                  filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
                }
              : undefined,
            renderFrame: (index) => renderer.renderTick(index + options.start),
            ...(encode === encodeNativeVideo ? {renderNativeFrame: index => renderer.renderNativeTick(index + options.start, {preserveAlpha: format === 'webm'})} : {}),
          });
          const saved = await finishExport(output, filename, signal);
          if (saved) exported(saved, filename);
          return saved;
        },
        { frames: ticks, format: 'video', fps },
      );
    } catch (error) {
      await sink?.abort().catch(() => {});
      throw error;
    }
  }
  /** The export dialog's frame previews: thumbnails (the engine's for documents it draws), only while the dialog shows them. */
  function previewFrames() {
    let renderer = null;
    return {
      render(tick, canvas, { signal } = {}) {
        if (!editor.totalTicks || signal?.aborted) return Promise.resolve(false);
        renderer ??= createThumbnailRenderer(editor, { stage: () => state.renderer });
        const rows = editor.timeline, index = Math.max(0, rows.findLastIndex((row) => row.start <= tick));
        return renderer.renderThumbnail(index, canvas, { tick, storedFrames: false, signal });
      },
      dispose() {
        renderer?.destroy();
        renderer = null;
      },
    };
  }
  function showExport() {
    finishCurrentEdit();
    sheet?.close();
    // The engine's export worker and its GPU device start while the choices are made.
    prewarmExportRenderer({ stage: state.renderer });
    const report = editor.report, audio = audioState(report), clips = audibleClips(audio);
    const fps = report.frame_delay_ms ? 1000 / report.frame_delay_ms : report.fps;
    const opened = sheet = openExportSheet({
      context: {
        canvasWidth: report.canvas_width, canvasHeight: report.canvas_height, totalFrames: editor.totalTicks, fps,
        currentFrame: editor.tick + 1, storedFrames: simpleFrameCount(), frameDraft: editor.frameDraft,
        audioClips: clips, audioSupported: typeof desktop?.writeVideoAudioChunk === "function",
        soundNames: [...new Set(clips.map((clip) => audio.assets[clip.assetId]?.name).filter(Boolean))],
        hasObject: Boolean(editor.object), movieclip: isMovieclip(editor.figure),
        name: editor.name, objectName: nameOf(editor.object), tick: editor.tick,
      },
      preferences: exportPreferences(),
      defaultDither: defaultGIFDither(report),
      probe: ({ width, height }) => getExportCapabilities({ width, height, fps, desktop }),
      createVfw: ({ container, dialog, getDimensions, onChange }) =>
        new VfwExportControls({ container, dialog, getDimensions, onChange, canExport: () => editor.totalTicks > 0, onError: fail }),
      preview: previewFrames(),
      // The chosen type's command exports the dialog's request (currentRequest).
      onExport: async (request) => {
        try {
          await actions[exportFormatInfo(request.format).action]();
        } catch (error) {
          fail(error);
        }
      },
      onPreferences: rememberPreferences,
      overlays: ctx.overlays, icon: glyph, t,
    });
    opened.closed.then(() => { if (sheet === opened) sheet = null; });
  }
  Object.assign(actions, {
    export: showExport,
    "export-piv": () => exportPivot(),
    "export-stk": () => exportPivot("stk"),
    // A selected movieclip writes .stykmov (exportJob decides, as the figure type says).
    "export-stkz": () => exportPivot("stkz"),
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
  });
  return { showExport, exportPivot, saveBlob, finishExport, openExportSink };
}
