import {messageError} from './localized-error.mjs';
/** Export output sinks: stream encoded bytes to a file while the export runs.
 * Desktop writes go through the chunked IPC file transfer (temporary file +
 * atomic rename on finish). Browsers with the File System Access API write into
 * the picked file's swap file, which is only committed by close(). Everywhere
 * else falls back to an in-memory Blob that callers save through saveBlob.
 */
const text = new TextEncoder();
const DEFAULT_CHUNK = 256 * 1024;

const checkAbort = (signal) => {
  if (signal?.aborted) throw signal.reason || messageError(new DOMException('', "AbortError"), "errors.exportSink.theExportWasCancelled", {});
};

const byteLength = (part) =>
  part instanceof Blob ? part.size : typeof part === "string" ? text.encode(part).byteLength : part.byteLength;

/** Chunks written through the desktop file transfer (bounded IPC frames). */
class DesktopSink {
  constructor(desktop, transfer, signal) {
    this.desktop = desktop;
    this.token = transfer.token;
    this.signal = signal;
    this.chunkSize = Math.min(DEFAULT_CHUNK, transfer.maxChunkBytes || DEFAULT_CHUNK);
    this.streamed = true;
    this.position = 0;
    this.finished = this.aborted = false;
  }
  async write(part) {
    if (this.finished || this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationIsClosed", {});
    checkAbort(this.signal);
    if (part instanceof Blob) {
      for await (const chunk of part.stream()) await this.writeBytes(chunk);
    } else await this.writeBytes(part);
  }
  async writeBytes(view) {
    const bytes =
      typeof view === "string"
        ? text.encode(view)
        : view instanceof Uint8Array
          ? view
          : view instanceof ArrayBuffer
            ? new Uint8Array(view)
            : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += this.chunkSize) {
      checkAbort(this.signal);
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + this.chunkSize));
      await this.desktop.writeFileChunk(this.token, chunk);
      this.position += chunk.byteLength;
    }
  }
  async patch(offset, bytes) {
    if (this.finished || this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationIsClosed", {});
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.byteLength > this.chunkSize) throw messageError(new Error(''), "errors.exportSink.theExportPatchIsTooLarge", {});
    checkAbort(this.signal);
    await this.desktop.patchFileWrite(this.token, offset, data);
  }
  async finish() {
    if (this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationWasCancelled", {});
    checkAbort(this.signal);
    const result = await this.desktop.finishFileWrite(this.token);
    this.finished = true;
    return { saved: Boolean(result?.saved), path: result?.path, size: result?.size ?? this.position };
  }
  async abort() {
    if (this.finished || this.aborted) return;
    this.aborted = true;
    await this.desktop.cancelFileWrite(this.token).catch(() => {});
  }
}

/** File System Access API: writes land in a swap file until close() commits. */
class FileSystemSink {
  constructor(handle, writable, signal) {
    this.handle = handle;
    this.writable = writable;
    this.signal = signal;
    this.streamed = true;
    this.position = 0;
    this.finished = this.aborted = false;
  }
  async write(part) {
    if (this.finished || this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationIsClosed", {});
    checkAbort(this.signal);
    await this.writable.write(part instanceof ArrayBuffer ? new Uint8Array(part) : part);
    this.position += byteLength(part);
  }
  async patch(offset, bytes) {
    if (this.finished || this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationIsClosed", {});
    checkAbort(this.signal);
    await this.writable.write({ type: "write", position: offset, data: bytes });
    await this.writable.write({ type: "seek", position: this.position });
  }
  async finish() {
    if (this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationWasCancelled", {});
    checkAbort(this.signal);
    await this.writable.close();
    this.finished = true;
    return { saved: true, path: this.handle.name, size: this.position };
  }
  async abort() {
    if (this.finished || this.aborted) return;
    this.aborted = true;
    await this.writable.abort().catch(() => {});
  }
}

/** In-memory fallback: identical bytes to the pre-sink output path. */
export class MemorySink {
  constructor(mimeType, signal) {
    this.mimeType = mimeType;
    this.signal = signal;
    this.streamed = false;
    this.parts = [];
    this.offsets = [];
    this.position = 0;
    this.finished = this.aborted = false;
  }
  async write(part) {
    if (this.finished || this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationIsClosed", {});
    checkAbort(this.signal);
    this.offsets.push(this.position);
    this.parts.push(part);
    this.position += byteLength(part);
  }
  async patch(offset, bytes) {
    if (this.finished || this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationIsClosed", {});
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const index = this.offsets.findIndex((start, i) => {
      const end = start + byteLength(this.parts[i]);
      return offset >= start && offset + data.byteLength <= end;
    });
    const part = index < 0 ? null : this.parts[index];
    if (!(part instanceof Uint8Array)) throw messageError(new Error(''), "errors.exportSink.theExportOutputCannotBePatchedInMemory", {});
    part.set(data, offset - this.offsets[index]);
  }
  async finish() {
    if (this.aborted) throw messageError(new Error(''), "errors.exportSink.theExportDestinationWasCancelled", {});
    checkAbort(this.signal);
    this.finished = true;
    const blob = new Blob(this.parts, { type: this.mimeType });
    this.parts = this.offsets = null;
    return { blob, size: blob.size };
  }
  async abort() {
    this.aborted = true;
    this.parts = this.offsets = null;
  }
}

/**
 * Pick the strongest available destination for an export. Shows the save
 * destination picker up front where a streamed backend exists.
 * @returns {Promise<DesktopSink|FileSystemSink|MemorySink|null>} null when the
 * user cancels the destination picker.
 */
export async function openExportSink({ filename, mimeType, desktop = globalThis.stykDesktop, signal, fileSystem = true } = {}) {
  const extension = filename.includes(".") ? filename.split(".").at(-1) : "bin";
  if (typeof desktop?.beginFileWrite === "function" && desktop.streamingFileWrite === true) {
    const transfer = await desktop.beginFileWrite({
      stream: true,
      name: filename,
      defaultPath: filename,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (!transfer) return null;
    return new DesktopSink(desktop, transfer, signal);
  }
  if (fileSystem && typeof globalThis.showSaveFilePicker === "function") {
    let handle;
    try {
      handle = await globalThis.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: filename, accept: { [mimeType || "application/octet-stream"]: [`.${extension}`] } }],
      });
    } catch (error) {
      if (error?.name === "AbortError") return null;
      throw error;
    }
    return new FileSystemSink(handle, await handle.createWritable(), signal);
  }
  return new MemorySink(mimeType, signal);
}
