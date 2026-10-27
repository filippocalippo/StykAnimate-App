import {messageError} from './localized-error.mjs';
/** A lost 2D context may accept no-op draws; never encode those as valid frames. */
const lostCanvases = new WeakSet(), watched = new WeakSet();
export function checkExportContext(context) {
  if (!context || lostCanvases.has(context.canvas) || context.isContextLost?.()) {
    const error = messageError(new Error(''), "errors.exportCanvas.theExportCanvasBecameUnavailableExportStoppedBefore", {});
    error.code = 'export_canvas_lost'; throw error;
  }
  return context;
}
export function exportContext(canvas) {
  if (!watched.has(canvas)) {
    watched.add(canvas);
    canvas.addEventListener?.('contextlost', () => lostCanvases.add(canvas));
  }
  return checkExportContext(canvas.getContext('2d', {willReadFrequently: true}));
}

/**
 * Hands a finished export frame from its worker's canvas to the interface: an
 * ImageBitmap for canvas consumers, or a lossless PNG for native video, APNG and
 * PNG sequences. Used by the engine's export worker
 * (engine/engine-export-worker.mjs).
 *
 * `native` frames are composited over black in place unless `preserveAlpha`: no
 * second full-size canvas or renderer-thread bitmap round trip is needed for opaque
 * native video.
 */
export async function deliverExportFrame(canvas, {native = false, preserveAlpha = false} = {}, stats = {}) {
  if (!native) return {bitmap: canvas.transferToImageBitmap(), stats};
  const started = performance.now(), context = exportContext(canvas);
  if (!preserveAlpha) {
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
    } finally {context.restore();}
  }
  const blob = await canvas.convertToBlob({type: 'image/png'});
  checkExportContext(context);
  if (blob.type !== 'image/png' || !blob.size) throw messageError(new Error(''), "errors.exportFrameWorker.losslessVideoFrameEncodingIsUnavailable", {});
  return {nativeFrame: {blob, width: canvas.width, height: canvas.height}, stats: {...stats, pngMs: performance.now() - started}};
}
