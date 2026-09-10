/** Canvas -> worker PNG -> bounded native FFmpeg stream. No lossy intermediate. */
import {exportFormat} from './export-capabilities.mjs';
const MAX_BYTES = 256 * 1024 * 1024;
const cancelled = () => new DOMException('Video export cancelled.', 'AbortError');

export async function encodeNativeVideo({format, codec, width, height, fps, totalFrames, renderFrame, quality = 0.9,
  bitrate, signal, onProgress, maxBytes = MAX_BYTES, desktop = globalThis.stykDesktop}) {
  if (!['webm', 'mp4', 'avi', 'wmv'].includes(format)) throw new Error('Choose WebM, MP4, AVI or WMV for native video export.');
  if (codec !== undefined && !{webm:['vp9'],mp4:['h264','mpeg4'],avi:['mpeg4','ffv1','rawvideo'],wmv:['wmv2']}[format].includes(codec)) throw new Error('Choose a supported codec for this video format.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 16777216) throw new Error('Native video supports up to 16 million pixels per frame.');
  if (!Number.isFinite(fps) || fps < 1 || fps > 1000 || !Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 1000000) throw new Error('Choose a valid video frame rate and frame count.');
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('Video quality must be between zero and one.');
  if (bitrate !== undefined && (!Number.isFinite(bitrate) || bitrate < 1000 || bitrate > 200e6)) throw new Error('Video bitrate must be between 1 kbit/s and 200 Mbit/s.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) throw new Error('Native video size must be limited to between 1 KiB and 256 MiB.');
  if (typeof renderFrame !== 'function') throw new Error('Native video export needs a frame renderer.');
  for (const method of ['beginVideoExport', 'beginVideoFrame', 'writeVideoChunk', 'endVideoFrame', 'finishVideoExport', 'readVideoChunk', 'cancelVideoExport'])
    if (typeof desktop?.[method] !== 'function') throw new Error('This video format requires the StykAnimate desktop app and its native encoder.');
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('Native video export needs worker canvas support.');
  if (signal?.aborted) throw cancelled();
  const worker = new Worker(new URL('./native-video-frame-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate native video frames'});
  let pending, sequence = 0, failure, transfer, cancellation;
  const check = () => { if (signal?.aborted) throw cancelled(); if (failure) throw failure; };
  const fail = error => { failure = error; pending?.reject(error); pending = null; worker.terminate(); };
  worker.addEventListener('error', event => { event.preventDefault(); fail(new Error(event.message || 'The video frame worker stopped.')); });
  worker.addEventListener('messageerror', () => fail(new Error('A video frame could not be transferred.')));
  worker.addEventListener('message', ({data}) => {
    if (data?.id !== pending?.id) return;
    const request = pending; pending = null;
    data.ok ? request.resolve(data.blob) : request.reject(new Error(data.error || 'Video frame encoding failed.'));
  });
  const request = (operation, fields = {}, transfers = []) => {
    check(); return new Promise((resolve, reject) => {
      const id = ++sequence; pending = {id, resolve, reject};
      try { worker.postMessage({id, operation, ...fields}, transfers); } catch (error) { pending = null; reject(error); }
    });
  };
  const abort = () => {
    fail(cancelled());
    if (transfer) cancellation = desktop.cancelVideoExport(transfer.token).catch(() => {});
  };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    transfer = await desktop.beginVideoExport({format, codec, width, height, fps, totalFrames, quality, bitrate, maxBytes});
    check();
    if (!transfer?.token) throw new Error('The native video encoder did not start.');
    const chunkSize = Math.min(256 * 1024, transfer.maxChunkBytes || 256 * 1024);
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('The native video transfer size is invalid.');
    await request('start', {width, height,preserveAlpha:format==='webm'});
    for (let index = 0; index < totalFrames; index++) {
      check(); const canvas = await renderFrame(index); check();
      if (!canvas || canvas.width !== width || canvas.height !== height) throw new Error(`Rendered video frame ${index + 1} has the wrong dimensions.`);
      const bitmap = await createImageBitmap(canvas); let png;
      try { png = await request('frame', {bitmap}, [bitmap]); } finally { bitmap.close(); }
      check(); await desktop.beginVideoFrame(transfer.token, {index, size: png.size});
      for (let offset = 0; offset < png.size; offset += chunkSize) {
        check(); const bytes = await png.slice(offset, offset + chunkSize).arrayBuffer(); check();
        await desktop.writeVideoChunk(transfer.token, bytes);
      }
      check(); await desktop.endVideoFrame(transfer.token);
      check(); onProgress?.({completed: index + 1, total: totalFrames, progress: (index + 1) / totalFrames, phase: 'rendering'});
    }
    onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'encoding'});
    const encoded = await desktop.finishVideoExport(transfer.token); check();
    if (!Number.isSafeInteger(encoded?.size) || encoded.size < 1 || encoded.size > maxBytes) throw new Error('The native video file has an invalid size.');
    const parts = []; let size = 0, done = false;
    while (!done) {
      check(); const chunk = await desktop.readVideoChunk(transfer.token); check();
      const bytes = chunk?.bytes;
      if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new Error('The native encoder returned an invalid output chunk.');
      if (!bytes.byteLength && !chunk.done) throw new Error('The native video output stopped before completion.');
      size += bytes.byteLength;
      if (size > encoded.size || size > maxBytes) throw new Error('The native video exceeds its declared file size.');
      parts.push(bytes); done = Boolean(chunk.done);
    }
    if (size !== encoded.size) throw new Error('The native video output is incomplete.');
    const description = exportFormat(format), blob = new Blob(parts, {type: description.mimeType});
    transfer = null;
    onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'complete'});
    return blob;
  } finally {
    signal?.removeEventListener('abort', abort); worker.terminate();
    if (transfer) await desktop.cancelVideoExport(transfer.token).catch(() => {});
    await cancellation;
  }
}
