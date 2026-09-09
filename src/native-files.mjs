const CHUNK_BYTES = 256 * 1024;

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('The file transfer was cancelled.', 'AbortError');
}

/** Write a worker-produced Blob without whole-file ArrayBuffer/base64 conversion. */
export async function writeNativeBlob(desktop, blob, options = {}) {
  if (!(blob instanceof Blob)) throw new TypeError('A Blob is required for native file writing.');
  const { recovery = false, clipboard = false, signal, onProgress, onSaved, name, defaultPath, filters, documentToken, saveAs = false } = options;
  checkAbort(signal);
  const start = clipboard ? desktop.beginClipboardWrite : recovery ? desktop.beginRecoveryWrite : documentToken ? desktop.beginProjectWrite : desktop.beginFileWrite;
  if (typeof start !== 'function') throw new Error('Restart the latest desktop app to enable streaming file saves.');
  const transfer = await start({ size: blob.size, name, defaultPath, filters, documentToken, saveAs });
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
    if (result?.saved) onSaved?.(result);
    return Boolean(result?.saved);
  } catch (error) {
    await desktop.cancelFileWrite(transfer.token).catch(() => {});
    throw error;
  }
}

/** Read the fixed recovery file as bounded IPC chunks; no base64 is produced. */
export async function readNativeRecovery(desktop, { signal, onProgress } = {}) {
  if (typeof desktop.beginRecoveryRead !== 'function') throw new Error('Restart the latest desktop app to enable streaming recovery.');
  return readNativeStoredFile(desktop, desktop.beginRecoveryRead, {signal, onProgress});
}

export async function readNativeClipboard(desktop, options = {}) {
  if (typeof desktop.beginClipboardRead !== 'function') throw new Error('Restart the latest desktop app to enable the saved frame clipboard.');
  return readNativeStoredFile(desktop, desktop.beginClipboardRead, options);
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
      if (!(chunk.bytes instanceof ArrayBuffer)) throw new Error('The recovery transfer returned invalid bytes.');
      received += chunk.bytes.byteLength;
      if (received > transfer.size) throw new Error('The recovery transfer exceeded its declared size.');
      parts.push(chunk.bytes);
      onProgress?.({ read: received, total: transfer.size });
      if (chunk.done) break;
    }
    if (received !== transfer.size) throw new Error('The recovery file transfer was incomplete.');
    return { blob: new Blob(parts, { type: 'application/octet-stream' }), name: transfer.name || 'Recovered animation', savedAt: transfer.savedAt, size: received };
  } finally {
    await desktop.closeFileRead(transfer.token).catch(() => {});
  }
}
