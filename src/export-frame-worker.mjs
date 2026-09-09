import { applyDocumentChunk } from "./document-transport.mjs";
import { timeline, evaluatedFrame } from "./pivot/geometry.mjs";
import { PlaybackResources } from "./playback-resources.mjs";
import { exportFrameGeometry, drawExportScene } from "./export-frame-core.mjs";
import { exportSamplingSize } from "./export-sampling.mjs";
import { exportSVG } from "./svg-export.mjs";
import { rasterizeCrispSVG } from "./export-crisp.mjs";

let report,
  rows,
  frameDocument,
  resources,
  options,
  canvas,
  enlarged,
  running = false;
function tickFrame(tick) {
  const end = rows.at(-1)?.start + rows.at(-1)?.count;
  if (!Number.isInteger(tick) || tick < 0 || tick >= end)
    throw new Error("Choose an export frame inside this animation.");
  let low = 0,
    high = rows.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rows[middle].start <= tick) low = middle;
    else high = middle - 1;
  }
  const row = rows[low];
  return {
    frame: evaluatedFrame(
      report,
      low,
      row.count ? (tick - row.start) / row.count : 0,
      tick,
    ),
    index: low,
  };
}
async function render(message) {
  if (!report || !rows)
    throw new Error("Load the animation before rendering export frames.");
  const started = performance.now(),
    { frame, index } = message.override
      ? { frame: frameDocument?.keyframes?.[0], index: 0 }
      : tickFrame(message.tick);
  if (!frame) throw new Error("The current export frame was not transferred.");
  const geometry = exportFrameGeometry(report, frame),
    backgroundIds = new Set([
      frame.background_id,
      ...(frame.background_mix ? [frame.background_id_b] : []),
    ]);
  await resources.preload([
    ...geometry.drawables,
    ...(report.backgrounds || [])
      .filter(
        (asset) =>
          backgroundIds.has(asset.background_id) &&
          ![2, 3, 4].includes(asset.kind) &&
          asset.color === undefined,
      )
      .map((asset) => ({ type: "image", asset })),
  ]);
  // Keep embedded SVG strings only for this frame's decoded assets.
  for (const url of resources.svgBitmaps.keys())
    if (!resources.images.has(url)) resources.svgBitmaps.delete(url);
  if (message.svg || options.smoothing === "none") {
    const svg = await exportSVG({
      report,
      frame,
      frameIndex: message.tick ?? index,
      geometry,
      width: options.width,
      height: options.height,
      resources,
      smoothing: message.svg ? "edges" : options.smoothing,
    });
    if (!message.svg) await rasterizeCrispSVG(svg, canvas);
    return {
      ...(message.svg ? { svg } : { bitmap: canvas.transferToImageBitmap() }),
      stats: {
        workerMs: performance.now() - started,
        smoothing: options.smoothing,
        renderWidth: options.width,
        renderHeight: options.height,
      },
    };
  }
  const target = options.factor > 1 ? enlarged : canvas;
  drawExportScene(target.getContext("2d"), report, frame, geometry, resources);
  if (target !== canvas) {
    const context = canvas.getContext("2d");
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    // At exactly 2:1 bilinear sampling averages each 2×2 premultiplied block,
    // matching Pivot's specialized two-times downsampler without a CPU readback.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "low";
    context.drawImage(target, 0, 0, canvas.width, canvas.height);
  }
  return {
    bitmap: canvas.transferToImageBitmap(),
    stats: {
      workerMs: performance.now() - started,
      smoothing: options.smoothing,
      renderWidth: target.width,
      renderHeight: target.height,
    },
  };
}
self.addEventListener("message", async ({ data: message }) => {
  if (running) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: "An export frame is already being rendered.",
    });
    return;
  }
  running = true;
  try {
    let result = {};
    if (message.operation === "start") {
      options = {
        ...message.options,
        ...exportSamplingSize(
          message.options.width,
          message.options.height,
          message.options.smoothing,
        ),
      };
      resources?.dispose();
      resources = new PlaybackResources({
        baseURL: options.baseURL,
        token: options.token,
        maxBytes: 128 * 1024 * 1024,
      });
      resources.svgBitmaps = new Map();
      resources.fetch = (url) => {
        const resolved = new URL(url, options.baseURL),
          headers = {};
        if (
          options.token &&
          resolved.origin === new URL(options.baseURL).origin
        )
          headers.Authorization = `Bearer ${options.token}`;
        return fetch(resolved, { headers });
      };
      report = rows = frameDocument = undefined;
      canvas = new OffscreenCanvas(options.width, options.height);
      enlarged =
        options.factor > 1
          ? new OffscreenCanvas(options.renderWidth, options.renderHeight)
          : null;
    } else if (message.operation === "chunk")
      report = applyDocumentChunk(report, message.chunk);
    else if (message.operation === "loaded") {
      if (!report?.keyframes?.length || !report?.figure_types)
        throw new Error("Export needs a decoded animation document.");
      rows = timeline(report);
    } else if (message.operation === "frame-start") frameDocument = undefined;
    else if (message.operation === "frame-chunk")
      frameDocument = applyDocumentChunk(frameDocument, message.chunk);
    else if (message.operation === "render") result = await render(message);
    else throw new Error("Unknown export renderer operation.");
    self.postMessage(
      { id: message.id, ok: true, ...result },
      result.bitmap ? [result.bitmap] : [],
    );
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      error: error?.message || String(error),
    });
  } finally {
    running = false;
  }
});
