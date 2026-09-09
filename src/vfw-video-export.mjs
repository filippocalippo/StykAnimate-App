/** Genuine installed Windows codecs, distinct from bundled FFmpeg encoders. */
const MAX_BYTES = 256 * 1024 * 1024;
const cancelled = () => new DOMException('Windows video export cancelled.', 'AbortError');
export async function getVfwCapabilities(options = {}, desktop = globalThis.stykDesktop) {
  if (typeof desktop?.getVfwCapabilities !== 'function') return {available: false, codecs: [], reason: 'Installed Video for Windows codecs require the Windows desktop app.'};
  return desktop.getVfwCapabilities(options);
}
export async function configureVfwCodec(options, desktop = globalThis.stykDesktop) {
  if (typeof desktop?.configureVfwCodec !== 'function') throw new Error('Codec configuration requires the Windows desktop app.');
  return desktop.configureVfwCodec(options);
}
export async function encodeVfwVideo({codecId, width, height, fps, totalFrames, renderFrame, quality = .9, keyframeEvery = 0, bitrate = 0, configurationId,
  signal, onProgress, maxBytes = MAX_BYTES, desktop = globalThis.stykDesktop}) {
  if (!/^vfw:(x86|x64):[0-9a-f]{8}$/i.test(codecId ?? '')) throw new Error('Choose an installed Windows video codec.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 16777216) throw new Error('Windows video supports up to 16 million pixels per frame.');
  if (!Number.isFinite(fps) || fps < 1 || fps > 1000 || !Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 1000000) throw new Error('Choose a valid video frame rate and frame count.');
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('Video quality must be between zero and one.');
  if (!Number.isInteger(keyframeEvery) || keyframeEvery < 0 || keyframeEvery > 1000000 || !Number.isInteger(bitrate) || bitrate < 0 || bitrate > 200000000) throw new Error('Choose a valid codec keyframe interval and bitrate.');
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES) throw new Error('Windows video must be limited to between 1 KiB and 256 MiB.');
  if (typeof renderFrame !== 'function') throw new Error('Windows video export needs a frame renderer.');
  for (const method of ['beginVfwExport', 'beginVfwFrame', 'writeVfwChunk', 'endVfwFrame', 'finishVfwExport', 'readVfwChunk', 'cancelVfwExport']) if (typeof desktop?.[method] !== 'function') throw new Error('Installed Windows codecs require the StykAnimate Windows desktop app.');
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('Windows video export needs worker canvas support.');
  if (signal?.aborted) throw cancelled();
  const worker = new Worker(new URL('./vfw-frame-worker.mjs', import.meta.url), {type: 'module', name: 'StykAnimate Windows video frames'});
  let pending, sequence = 0, failure, transfer, cancellation;
  const check = () => { if (signal?.aborted) throw cancelled(); if (failure) throw failure; };
  const fail = error => { failure = error; pending?.reject(error); pending = null; worker.terminate(); };
  worker.addEventListener('error', event => { event.preventDefault(); fail(new Error(event.message || 'The Windows video worker stopped.')); });
  worker.addEventListener('messageerror', () => fail(new Error('A Windows video frame could not be transferred.')));
  worker.addEventListener('message', ({data}) => { if (data?.id !== pending?.id) return; const request = pending; pending = null; data.ok ? request.resolve(data.blob) : request.reject(new Error(data.error || 'Windows video conversion failed.')); });
  const request = (operation, fields = {}, transfers = []) => { check(); return new Promise((resolve, reject) => { const id = ++sequence; pending = {id, resolve, reject}; try { worker.postMessage({id, operation, ...fields}, transfers); } catch (error) { pending = null; reject(error); } }); };
  const abort = () => { fail(cancelled()); if (transfer) cancellation = desktop.cancelVfwExport(transfer.token).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    transfer = await desktop.beginVfwExport({codecId, width, height, fps, totalFrames, quality, keyframeEvery, bitrate, configurationId}); check();
    if (!transfer?.token || transfer.frameBytes !== Math.ceil(width * 3 / 4) * 4 * height) throw new Error('The Windows codec returned invalid frame dimensions.');
    const chunkSize = Math.min(256 * 1024, transfer.maxChunkBytes || 256 * 1024);
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid Windows video transfer size.');
    await request('start', {width, height});
    for (let index = 0; index < totalFrames; index++) {
      check(); const canvas = await renderFrame(index); check();
      if (!canvas || canvas.width !== width || canvas.height !== height) throw new Error(`Rendered Windows video frame ${index + 1} has the wrong dimensions.`);
      const bitmap = await createImageBitmap(canvas); let frame;
      try { frame = await request('frame', {bitmap}, [bitmap]); } finally { bitmap.close(); }
      check(); if (frame.size !== transfer.frameBytes) throw new Error('The converted Windows video frame has the wrong byte size.');
      await desktop.beginVfwFrame(transfer.token, {index, size: frame.size});
      for (let offset = 0; offset < frame.size; offset += chunkSize) { check(); const bytes = await frame.slice(offset, offset + chunkSize).arrayBuffer(); check(); await desktop.writeVfwChunk(transfer.token, bytes); }
      check(); await desktop.endVfwFrame(transfer.token); check(); onProgress?.({completed: index + 1, total: totalFrames, progress: (index + 1) / totalFrames, phase: 'rendering'});
    }
    onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'encoding'});
    const encoded = await desktop.finishVfwExport(transfer.token); check();
    if (!Number.isSafeInteger(encoded?.size) || encoded.size < 256 || encoded.size > maxBytes) throw new Error('The Windows codec returned an empty or oversized AVI.');
    const parts = []; let size = 0, done = false;
    while (!done) {
      check(); const chunk = await desktop.readVfwChunk(transfer.token); check(); const bytes = chunk?.bytes;
      if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new Error('The Windows codec returned an invalid output chunk.');
      if ((!bytes.byteLength && !chunk.done) || bytes.byteLength > 256 * 1024) throw new Error('The Windows video output chunk is invalid.');
      size += bytes.byteLength; if (size > encoded.size || size > maxBytes) throw new Error('The Windows video exceeds its declared size.');
      parts.push(bytes); done = Boolean(chunk.done);
    }
    if (size !== encoded.size) throw new Error('The Windows video output is incomplete.');
    const blob = new Blob(parts, {type: 'video/x-msvideo'}); onProgress?.({completed: totalFrames, total: totalFrames, progress: 1, phase: 'complete'}); return blob;
  } finally {
    signal?.removeEventListener('abort', abort); worker.terminate();
    if (transfer) await desktop.cancelVfwExport(transfer.token).catch(() => {}); await cancellation;
  }
}
