import {messageError} from './localized-error.mjs';
const CHUNK_BYTES = 256 * 1024;

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || messageError(new DOMException('', 'AbortError'), "errors.nativeFiles.theFileTransferWasCancelled", {});
}

/** Write a worker-produced Blob without whole-file ArrayBuffer/base64 conversion. */
export async function writeNativeBlob(desktop, blob, options = {}) {
  if (!(blob instanceof Blob)) throw messageError(new TypeError(''), "errors.nativeFiles.aBlobIsRequiredForNativeFileWriting", {});
  const { recovery = false, signal, onProgress, onSaved, name, defaultPath, filters, documentToken, saveAs = false } = options;
  checkAbort(signal);
  const start = recovery ? desktop.beginRecoveryWrite : documentToken ? desktop.beginProjectWrite : desktop.beginFileWrite;
  if (typeof start !== 'function') throw messageError(new Error(''), "errors.nativeFiles.restartTheLatestDesktopAppToEnableStreaming", {});
  const started=options.onTiming?performance.now():0;
  const transfer = await start({ size: blob.size, name, defaultPath, filters, documentToken, saveAs });
  const writeStarted=options.onTiming?performance.now():0;
  try{options.onTiming?.('dialog',writeStarted-started);}catch{/* Diagnostics cannot change file outcomes. */}
  if (!transfer) return false;
  const chunkSize = Math.min(CHUNK_BYTES, transfer.maxChunkBytes || CHUNK_BYTES);
  try {
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      checkAbort(signal);
      const bytes = await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer();
      checkAbort(signal);
      await desktop.writeFileChunk(transfer.token, bytes);
      onProgress?.({ written: Math.min(blob.size, offset + chunkSize), total: blob.size });
    }
    checkAbort(signal);
    const result = await desktop.finishFileWrite(transfer.token);
    try{options.onTiming?.('write',performance.now()-writeStarted);}catch{/* Diagnostics cannot change file outcomes. */}
    if (result?.saved) onSaved?.(result);
    return Boolean(result?.saved);
  } catch (error) {
    await desktop.cancelFileWrite(transfer.token).catch(() => {});
    throw error;
  }
}

/** Read the fixed recovery file as bounded IPC chunks; no base64 is produced. */
export async function readNativeRecovery(desktop, { signal, onProgress, id } = {}) {
  if (typeof desktop.beginRecoveryRead !== 'function') throw messageError(new Error(''), "errors.nativeFiles.restartTheLatestDesktopAppToEnableStreaming2", {});
  // `id` names one of the listed copies; without it the newest is read.
  return readNativeStoredFile(desktop, () => desktop.beginRecoveryRead(id), {signal, onProgress});
}

async function readNativeStoredFile(desktop, beginRead, {signal, onProgress} = {}) {
  checkAbort(signal);
  const transfer = await beginRead();
  if (!transfer) return null;
  const parts = [];
  let received = 0;
  try {
    while (true) {
      checkAbort(signal);
      const chunk = await desktop.readFileChunk(transfer.token);
      if (!(chunk.bytes instanceof ArrayBuffer)) throw messageError(new Error(''), "errors.nativeFiles.theRecoveryTransferReturnedInvalidBytes", {});
      received += chunk.bytes.byteLength;
      if (received > transfer.size) throw messageError(new Error(''), "errors.nativeFiles.theRecoveryTransferExceededItsDeclaredSize", {});
      parts.push(chunk.bytes);
      onProgress?.({ read: received, total: transfer.size });
      if (chunk.done) break;
    }
    if (received !== transfer.size) throw messageError(new Error(''), "errors.nativeFiles.theRecoveryFileTransferWasIncomplete", {});
    return { blob: new Blob(parts, { type: 'application/octet-stream' }), name: transfer.name || 'Recovered animation', savedAt: transfer.savedAt, size: received };
  } finally {
    await desktop.closeFileRead(transfer.token).catch(() => {});
  }
}
