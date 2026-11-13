import {restoreMessageError, messageError} from './localized-error.mjs';

import { normalizeGIFDither } from "./gif-options.mjs";
import { EXPORT_MAX_PIXELS } from "./export-sampling.mjs";
import { deviceMemoryHint } from "./playback-budget.mjs";
/** Offline animated image and numbered image-sequence exports.
 * Canvas frames are snapshotted into a transferable ImageBitmap; palette creation,
 * LZW, PNG/JPEG compression, checksums, APNG and ZIP writing stay in a worker.
 * GIF frames can come as RGBA pixels instead (`renderPixels`), transferred to the
 * worker without a canvas; the next frame is then drawn while one is encoded.
 * Animated GIF needs every frame twice: first to collect one animation palette,
 * then to encode. The worker keeps the frames of the first pass for the second
 * when they fit in gifRetainedBytes(); otherwise each index is rendered twice, and
 * renderFrame must return the same committed image in both passes.
 */
const MAX_BYTES = 512 * 1024 * 1024;
// Streamed exports are bounded by the destination disk, not renderer memory.
// ZIP32 stores 32-bit offsets, so sequences must stay under 4 GiB.
const STREAM_MAX_BYTES = 16 * 1024 * 1024 * 1024;
const ZIP_STREAM_MAX_BYTES = 0xfff00000;
const MiB = 1024 * 1024;
/** The frames an animated GIF's worker may keep between its two passes: 256 MiB, less on a machine of under 8 GiB. */
export const gifRetainedBytes = (deviceMemory = deviceMemoryHint()) =>
  Math.min(256 * MiB, Math.floor(((Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory : 4) * 1024 * MiB) / 32));
/** How long a worker started ahead of an export waits for one. */
const WARM_MS = 60000;
/** An image export worker started ahead of an export, and when it is given up. */
let warm = null;
const createWorker = () => new Worker(new URL("./image-export-worker.mjs", import.meta.url), { type: "module", name: "StykAnimate image export" });
/**
 * Starts an image export worker ahead of an export (the export dialog opens), so the export does not wait for its
 * modules to load. Given up after a minute without an export; one at a time.
 */
export function prewarmImageExport() {
  if (warm || typeof Worker === "undefined") return;
  const entry = (warm = { worker: createWorker(), timer: setTimeout(() => { if (warm === entry) { warm = null; entry.worker.terminate(); } }, WARM_MS) });
}
/** The warmed worker, or a new one. */
function takeWorker() {
  const entry = warm;
  warm = null;
  if (entry) clearTimeout(entry.timer);
  return entry?.worker ?? createWorker();
}
const formats = new Set([
  "gif",
  "apng",
  "png-sequence",
  "jpeg-sequence",
  "gif-sequence",
  "svg-sequence",
]);
const abortError = () =>
  messageError(new DOMException('', "AbortError"), "errors.imageExport.imageExportCancelled", {});

/**
 * @param {{format:'gif'|'apng'|'png-sequence'|'jpeg-sequence'|'gif-sequence'|'svg-sequence',width:number,height:number,
 * fps:number,totalFrames:number,renderFrame?:(index:number)=>Promise<HTMLCanvasElement|OffscreenCanvas>|HTMLCanvasElement|OffscreenCanvas,
 * renderSVGFrame?:(index:number)=>Promise<Blob|string>|Blob|string,
 * renderPNGFrame?:(index:number)=>Promise<{blob:Blob,width:number,height:number}>|{blob:Blob,width:number,height:number},
 * renderPixels?:(index:number)=>Promise<{data:Uint8ClampedArray,width:number,height:number}>, GIF and GIF sequences: the frame's
 *   RGBA pixels, which the export then owns (transferred to its worker),
 * onProgress?:(value:{phase:"palette"|"encode",completed:number,total:number,progress:number})=>void,
 * signal?:AbortSignal,loop?:boolean,quality?:number,dither?:boolean,maxBytes?:number,
 * sink?:{streamed:boolean,write(part:Blob)=>Promise<void>,finish()=>Promise<object>,abort()=>Promise<void>}}} options
 * @returns {Promise<Blob|{saved:boolean,path?:string,size?:number,blob?:Blob}>} GIF, APNG, or ZIP
 * containing numbered PNG/JPEG frames — a Blob, or the sink's finish() result.
 */
export async function exportAnimation({
  format,
  width,
  height,
  fps,
  totalFrames,
  renderFrame,
  renderSVGFrame,
  renderPNGFrame,
  renderPixels,
  onProgress,
  signal,
  loop = true,
  quality = 0.94,
  dither = false,
  maxBytes,
  timeoutMs = 120000,
  sink,
  retainedBytes = gifRetainedBytes(),
}) {
  format =
    {
      "jpg-sequence": "jpeg-sequence",
      "png-zip": "png-sequence",
      "jpeg-zip": "jpeg-sequence",
      "jpg-zip": "jpeg-sequence",
    }[format] || format;
  if (!formats.has(format))
    throw messageError(new Error(''), "errors.imageExport.chooseGifApngOrAPngJpegGif", {});
  const vector = format === "svg-sequence";
  const encodedPNG = (format === "apng" || format === "png-sequence") &&
    typeof renderPNGFrame === "function";
  const pixelFrames = (format === "gif" || format === "gif-sequence") &&
    typeof renderPixels === "function";
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 16384 ||
    height > 16384 ||
    (!vector && width * height > EXPORT_MAX_PIXELS)
  ) {
    throw messageError(new Error(''), "errors.imageExport.imageExportsSupportDimensionsUpTo16384", {value: Math.round(EXPORT_MAX_PIXELS / 1e6)});
  }
  const maxFrames = format.endsWith("sequence") ? 65534 : 100000;
  if (
    !Number.isInteger(totalFrames) ||
    totalFrames < 1 ||
    totalFrames > maxFrames
  )
    throw messageError(new Error(''), "errors.imageExport.chooseBetween1AndExportFrames", {value: maxFrames.toLocaleString()});
  if (
    !Number.isFinite(fps) ||
    fps < 1 ||
    fps > (format === "gif" ? 50 : 1000)
  ) {
    throw new Error(
      format === "gif"
        ? "GIF export supports 1–50 fps; choose APNG or video for higher frame rates."
        : "Choose an image frame rate between 1 and 1,000 fps.",
    );
  }
  if (typeof (vector ? renderSVGFrame : encodedPNG ? renderPNGFrame : pixelFrames ? renderPixels : renderFrame) !== "function")
    throw new TypeError(
      vector
        ? "SVG sequence export needs a vector frame renderer."
        : "Image export needs a frame renderer.",
    );
  if (!Number.isFinite(quality) || quality < 0 || quality > 1)
    throw messageError(new Error(''), "errors.imageExport.jpegQualityMustBeBetweenZeroAndOne", {});
  const streamed = sink?.streamed === true;
  const maxBytesCap = streamed
    ? format.endsWith("sequence")
      ? ZIP_STREAM_MAX_BYTES
      : STREAM_MAX_BYTES
    : MAX_BYTES;
  maxBytes ??= maxBytesCap;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > maxBytesCap)
    throw new Error(
      streamed
        ? "The streamed export size limit is invalid."
        : "Choose an export size limit between 1 KiB and 512 MiB.",
    );
  dither = normalizeGIFDither(dither);
  if (signal?.aborted) throw abortError();
  if (
    typeof Worker === "undefined" ||
    (!vector && !encodedPNG && !pixelFrames &&
      (typeof createImageBitmap === "undefined" ||
        typeof OffscreenCanvas === "undefined"))
  ) {
    throw messageError(new Error(''), "errors.imageExport.thisBrowserCannotExportImagesInAWorker", {});
  }
  const worker = takeWorker();
  let sequence = 0,
    pending = null,
    failure;
  const fail = (error) => {
    failure = error;
    clearTimeout(pending?.timer);
    pending?.reject(error);
    pending = null;
    worker.terminate();
  };
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    fail((event.message ? new Error(event.message) : messageError(new Error(''), "errors.imageExport.theImageExportWorkerStopped")));
  });
  worker.addEventListener("messageerror", () =>
    fail(messageError(new Error(''), "errors.imageExport.anImageFrameCouldNotBeTransferred", {})),
  );
  worker.addEventListener("message", (event) => {
    if (!pending || pending.id !== event.data?.id) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    event.data.ok
      ? request.resolve(event.data)
      : request.reject(restoreMessageError((event.data.error ? new Error(event.data.error) : messageError(new Error(''), "errors.imageExport.imageEncodingFailed")), event.data));
  });
  const check = () => {
    if (signal?.aborted) throw abortError();
    if (failure) throw failure;
  };
  const request = (operation, data = {}, transfer = []) => {
    check();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail(messageError(new Error(''), "errors.imageExport.imageEncodingTimedOutExportStoppedTryAgain", {})), timeoutMs);
      pending = { id, resolve, reject, timer };
      try {
        worker.postMessage({ id, operation, ...data }, transfer);
      } catch (error) {
        clearTimeout(timer);
        pending = null;
        reject(error);
      }
    });
  };
  const abort = () => fail(abortError());
  signal?.addEventListener("abort", abort, { once: true });
  let completed = false;
  // An animated GIF of pixel frames that fit keeps the first pass's frames in its worker for the second.
  const retain = format === "gif" && pixelFrames && totalFrames * width * height * 4 <= retainedBytes;
  // Helper workers for the GIF's second pass: half the processor's threads but one, at most four, none below two.
  const threads = Math.min(4, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 2) - 1);
  const helpers = format === "gif" && totalFrames >= 3 && width * height >= 65536 && threads >= 2 ? threads : 0;
  // The next pixel frame, drawn while the worker encodes this one.
  let ahead = null;
  const renderAhead = (index) => {
    const frame = (async () => renderPixels(index))();
    frame.catch(() => {});
    return frame;
  };
  const forward = async (response) => {
    if (sink && response?.output instanceof Blob) await sink.write(response.output);
  };
  try {
    await forward(
      await request("start", {
        config: {
          format,
          width,
          height,
          fps,
          totalFrames,
          loop,
          quality,
          dither,
          maxBytes,
          stream: Boolean(sink),
          encodedPNG,
          pixels: pixelFrames,
          retain,
          helpers,
        },
      }),
    );
    const passes = format === "gif" ? 2 : 1,
      totalWork = totalFrames * passes;
    for (let pass = 0; pass < passes; pass++) {
      if (pass === 1) await forward(await request("encode"));
      for (let index = 0; index < totalFrames; index++) {
        check();
        if (vector) {
          const svg = await renderSVGFrame(index);
          check();
          if (!(svg instanceof Blob) && typeof svg !== "string")
            throw messageError(new Error(''), "errors.imageExport.renderedSvgFrameMustContainSvgTextOr", {value: index + 1});
          await forward(await request("frame", { svg }));
          check();
          onProgress?.({
            phase: passes === 2 && pass === 0 ? "palette" : "encode",
            completed: pass * totalFrames + index + 1,
            total: totalWork,
            progress: (pass * totalFrames + index + 1) / totalWork,
          });
          continue;
        }
        if (pixelFrames && pass === 1 && retain) {
          await forward(await request("frame", { retained: true }));
        } else if (pixelFrames) {
          const frame = await (ahead ?? renderAhead(index));
          ahead = null;
          check();
          if (!(frame?.data instanceof Uint8ClampedArray) || frame.width !== width || frame.height !== height ||
              frame.data.length !== width * height * 4)
            throw messageError(new Error(''), "errors.imageExport.renderedImageFrameHasTheWrongDimensions", {value: index + 1});
          if (index + 1 < totalFrames) ahead = renderAhead(index + 1);
          await forward(await request("frame", { pixels: frame.data }, [frame.data.buffer]));
        } else if (encodedPNG) {
          const frame = await renderPNGFrame(index);
          check();
          if (!(frame?.blob instanceof Blob) || frame.blob.type !== "image/png" ||
              !frame.blob.size || frame.width !== width || frame.height !== height)
            throw messageError(new Error(''), "errors.imageExport.renderedImageFrameHasTheWrongDimensions", {value: index + 1});
          // The renderer already encoded this immutable frame off-thread. Keep
          // the same one-frame backpressure without creating pixel surfaces.
          await forward(await request("frame", {png: frame.blob}));
        } else {
          const canvas = await renderFrame(index);
          check();
          if (!canvas || canvas.width !== width || canvas.height !== height)
            throw messageError(new Error(''), "errors.imageExport.renderedImageFrameHasTheWrongDimensions", {value: index + 1});
          const bitmap = await createImageBitmap(canvas);
          try {
            check();
            // Backpressure: only one full-resolution frame is in flight at a time.
            await forward(await request("frame", { bitmap }, [bitmap]));
          } finally {
            bitmap.close();
          }
        }
        check();
        onProgress?.({
          phase: passes === 2 && pass === 0 ? "palette" : "encode",
          completed: pass * totalFrames + index + 1,
          total: totalWork,
          progress: (pass * totalFrames + index + 1) / totalWork,
        });
      }
    }
    const response = await request("finish");
    check();
    if (sink) {
      await forward(response);
      const result = await sink.finish();
      completed = true;
      return result;
    }
    completed = true;
    return response.blob;
  } finally {
    clearTimeout(pending?.timer);
    signal?.removeEventListener("abort", abort);
    worker.terminate();
    if (sink && !completed) await sink.abort();
  }
}
