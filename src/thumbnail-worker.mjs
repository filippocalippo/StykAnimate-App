import { applyDocumentChunk } from "./document-transport.mjs";
import { PlaybackResources } from "./playback-resources.mjs";
import {
  evaluatedFrame,
  timeline,
  buildGeometry,
  drawGeometry,
  invalidateEvaluationCaches,
  releaseGeometryResources,
} from "./pivot/geometry.mjs";
import {
  drawBackground,
  backgroundBounds,
  cameraIsIdentity,
  inverseCameraScale,
  effectiveCamera,
  sceneBackgroundColor,
} from "./pivot/background.mjs";
import { layerVisible } from "./layers.mjs";
import {sampleInbetweenPreview} from './editor-inbetween.mjs';
import {storedFrameReport} from './pivot-frame-draft.mjs';

let report,
  storedReport,
  storedEntries,
  incoming,
  resources,
  entries,
  canvas,
  context,
  revision = 0;
let rendering = false,
  activeRequest = null;
const cancelled = new Set();
const abortError = () =>
  new DOMException("Thumbnail superseded.", "AbortError");
const respond = (id, value = {}, transfer = []) =>
  self.postMessage({ id, ok: true, ...value }, transfer);

async function receive(message) {
  const { id, operation } = message;
  try {
    if (operation === "cancel") {
      if (activeRequest === message.request) cancelled.add(message.request);
      return;
    }
    if (operation === "snapshot-chunk") {
      if (message.chunk.header)
        incoming = {
          revision: message.revision,
          mode: message.mode,
          value: applyDocumentChunk(null, message.chunk),
        };
      else {
        if (incoming?.revision !== message.revision) throw abortError();
        applyDocumentChunk(incoming.value, message.chunk);
      }
      respond(id);
      return;
    }
    if (operation === "snapshot-complete") {
      if (incoming?.revision !== message.revision) throw abortError();
      if (incoming.mode === "document") {
        report = incoming.value;
        resources?.dispose();
        resources = new PlaybackResources({
          ...message.options,
          maxBytes: 24 * 1024 * 1024,
        });
      } else {
        if (!report) throw new Error("Thumbnail document is unavailable.");
        for (const [key, value] of Object.entries(incoming.value.properties))
          report[key] = value;
        for (const entry of incoming.value.frames)
          report.keyframes[entry.index] = entry.frame;
        if (incoming.value.figure_types)
          report.figure_types = incoming.value.figure_types;
        invalidateEvaluationCaches(report);
      }
      revision = message.revision;
      incoming = null;
      entries = timeline(report);
      storedReport = storedEntries = null;
      respond(id);
      return;
    }
    if (operation !== "render") throw new Error("Unknown thumbnail operation.");
    if (rendering)
      throw new Error("Thumbnail worker already has a pending frame.");
    if (message.revision !== revision || !report) throw abortError();
    if (message.storedFrames !== undefined && typeof message.storedFrames !== 'boolean') throw new Error('Invalid stored-frame preview mode.');
    if (!Number.isInteger(message.index) || !report.keyframes[message.index])
      throw new RangeError("Thumbnail frame is unavailable.");
    if (
      !Number.isInteger(message.width) ||
      !Number.isInteger(message.height) ||
      message.width < 1 ||
      message.height < 1 ||
      message.width > 512 ||
      message.height > 512
    )
      throw new RangeError("Thumbnail dimensions exceed 512 pixels.");
    rendering = true;
    activeRequest = id;
    try {
      const generation = revision,
        started = performance.now();
      const check = () => {
        if (cancelled.has(id) || revision !== generation) throw abortError();
      };
      check();
      const frameReport = message.storedFrames ? (storedReport ??= storedFrameReport(report)) : report;
      const frameEntries = message.storedFrames ? (storedEntries ??= timeline(frameReport)) : entries;
      const preview = message.inbetween;
      if (preview && (!['adjacent', 'settings', 'none'].includes(preview.onionMode) ||
          !Number.isInteger(preview.onionCount) || preview.onionCount < 0 || preview.onionCount > 9 ||
          !Number.isFinite(preview.onionOpacity) || preview.onionOpacity < 0 || preview.onionOpacity > 1))
        throw new Error('Invalid inbetween preview options.');
      const frame = preview ? sampleInbetweenPreview(frameReport, preview.ratio, message.index).frame : evaluatedFrame(
        frameReport,
        message.index,
        0,
        frameEntries[message.index]?.start,
      );
      const geometry = buildGeometry(frameReport, frame);
      const drawables = geometry.drawables.filter((item) =>
        layerVisible(frameReport, item.obj.unique_id),
      );
      const onions = [];
      if (preview && preview.onionMode !== 'none') {
        const count = preview.onionMode === 'adjacent' ? 1 : preview.onionCount;
        for (let distance = count; distance > 0; distance--) for (const direction of [-1, 1]) {
          if (preview.onionMode === 'settings' && direction > 0 && !preview.onionAhead) continue;
          const index = message.index + (direction < 0 ? -distance : distance - 1);
          if (!frameReport.keyframes[index]) continue;
          const source = evaluatedFrame(frameReport, index, 0, frameEntries[index]?.start);
          const ghost = buildGeometry(frameReport, source).drawables.filter(item => layerVisible(frameReport, item.obj.unique_id));
          onions.push({drawables: ghost.map(item => ({...item, opacity: item.opacity * preview.onionOpacity / distance}))});
        }
      }
      const backgrounds =
        sceneBackgroundColor(frameReport, frame) === undefined
          ? (frameReport.backgrounds || []).filter(
              (bg) =>
                Number(bg.background_id) === Number(frame.background_id) ||
                Number(bg.background_id) === Number(frame.background_id_b),
            )
          : [];
      await resources.preload([
        ...drawables,
        ...onions.flatMap(geometry => geometry.drawables),
        ...backgrounds
          .filter((bg) => resources.url(bg))
          .map((asset) => ({ type: "image", asset })),
      ]);
      check();
      if (!canvas) {
        canvas = new OffscreenCanvas(message.width, message.height);
        context = canvas.getContext("2d");
      }
      canvas.width = message.width;
      canvas.height = message.height;
      const width = frameReport.canvas_width,
        height = frameReport.canvas_height;
      // Uniform framing preserves artboard proportions in the fixed filmstrip cell.
      const scale = Math.min(message.width / width, message.height / height);
      context.fillStyle = "#f5f5f5";
      context.fillRect(0, 0, message.width, message.height);
      context.save();
      context.translate(
        (message.width - width * scale) / 2,
        (message.height - height * scale) / 2,
      );
      context.scale(scale, scale);
      context.beginPath();
      context.rect(0, 0, width, height);
      context.clip();
      const camera = effectiveCamera(frameReport, frame);
      if (!cameraIsIdentity(camera)) {
        context.translate(width / 2, height / 2);
        context.scale(inverseCameraScale(camera), inverseCameraScale(camera));
        context.rotate(-Number(camera.angle_rad || 0));
        context.translate(
          -width / 2 - Number(camera.x || 0),
          -height / 2 - Number(camera.y || 0),
        );
      }
      drawBackground(context, frameReport, frame, width, height, {
        ...resources,
        bounds: backgroundBounds(frame, width, height, true, frameReport),
      });
      for (const onion of onions) drawGeometry(context, onion, resources);
      drawGeometry(context, { drawables }, resources);
      context.restore();
      check();
      const bitmap = canvas.transferToImageBitmap();
      releaseGeometryResources(context, { retainCanvases: true });
      respond(
        id,
        {
          bitmap,
          renderMs: performance.now() - started,
          mediaBytes: resources.bytes,
        },
        [bitmap],
      );
    } finally {
      rendering = false;
      activeRequest = null;
      cancelled.delete(id);
    }
  } catch (error) {
    cancelled.delete(id);
    self.postMessage({
      id,
      ok: false,
      error: error?.message || String(error),
      name: error?.name,
    });
  }
}
self.addEventListener("message", (event) => void receive(event.data));
