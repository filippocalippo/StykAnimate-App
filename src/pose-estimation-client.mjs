import { messageError, restoreMessageError } from './localized-error.mjs';

/**
 * Sniffs common image headers to detect MIME type from binary buffers.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string|null}
 */
export function detectMimeTypeFromBuffer(buffer) {
  if (!buffer || buffer.byteLength < 4) return null;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 128));

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }

  // WebP: RIFF .... WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes.length >= 12 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }

  // SVG: textual XML tag
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  if (text.startsWith('<svg') || text.startsWith('<?xml') || text.includes('<svg')) {
    return 'image/svg+xml';
  }

  return null;
}

/**
 * Client interface for off-thread pose estimation.
 * Dispatches requests to the Web Worker via structured cloning, manages request timeouts,
 * and provides transparent headless fallback for Node.js environments.
 */
export class PoseEstimationClient {
  #worker = null;
  #pending = new Map();
  #sequence = 0;
  #disposed = false;

  constructor({
    workerURL = new URL('./workers/pose-estimation-worker.mjs', import.meta.url),
    timeoutMs = 30000,
    workerFactory = null
  } = {}) {
    this.workerURL = workerURL;
    this.timeoutMs = timeoutMs;
    this.workerFactory = workerFactory;
  }

  /**
   * Lazily initializes the Web Worker. Returns null in headless Node.js environments.
   */
  ensureWorker() {
    if (this.#disposed) {
      throw messageError(new Error('PoseEstimationClient has been disposed'), 'errors.poseEstimationWorker.inferenceFailed');
    }

    if (typeof globalThis.Worker === 'undefined') {
      return null;
    }

    if (!this.#worker) {
      try {
        this.#worker = this.workerFactory
          ? this.workerFactory(this.workerURL)
          : new Worker(this.workerURL, {
              type: 'module',
              name: 'StykAnimate pose estimation'
            });

        this.#worker.onmessage = ({ data }) => {
          if (!data || typeof data.id === 'undefined') return;
          const entry = this.#pending.get(String(data.id));
          if (!entry) return;

          clearTimeout(entry.timeoutId);
          this.#pending.delete(String(data.id));

          if (data.ok) {
            const result = this.#createResultObject(data.id, data.landmarks);
            entry.resolve(result);
          } else {
            const err = restoreMessageError(new Error(data.error || 'Pose estimation failed'), data);
            if (data.messageKey) err.messageKey = data.messageKey;
            if (data.messageParams) err.messageParams = data.messageParams;
            entry.reject(err);
          }
        };

        this.#worker.onerror = (event) => {
          this.#terminateAndRejectAll(
            messageError(new Error(event?.message || 'Pose estimation worker error'), 'errors.poseEstimationWorker.inferenceFailed')
          );
        };

        this.#worker.onmessageerror = () => {
          this.#terminateAndRejectAll(
            messageError(new Error('Pose estimation worker message transfer error'), 'errors.poseEstimationWorker.inferenceFailed')
          );
        };
      } catch {
        this.#worker = null;
        return null;
      }
    }

    return this.#worker;
  }

  #createResultObject(id, landmarks) {
    const result = {
      id: String(id),
      ok: true,
      landmarks
    };

    // Provide array-like indexing and iteration so result can be used either as
    // an object ({ id, ok, landmarks }) or directly as a landmark collection (result[0], [...result])
    Object.defineProperty(result, 'length', { value: landmarks.length, enumerable: false });
    result[Symbol.iterator] = function*() { yield* landmarks; };
    for (let i = 0; i < landmarks.length; i++) {
      Object.defineProperty(result, i, { value: landmarks[i], enumerable: false });
    }

    return result;
  }

  #terminateAndRejectAll(error) {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }

    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  /**
   * Estimates 33 pose landmarks from image buffer, file, or SVG string.
   * @param {ArrayBuffer|Uint8Array|Blob|File|string|Object} input
   * @param {Object} [options]
   * @param {string} [options.mimeType]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ id: string, ok: true, landmarks: Array<{x: number, y: number, z: number, visibility: number}> }>}
   */
  async estimatePose(input, options = {}) {
    if (this.#disposed) {
      throw messageError(new Error('PoseEstimationClient has been disposed'), 'errors.poseEstimationWorker.inferenceFailed');
    }

    // Support (buffer, mimeType, options) positional calling signature
    if (typeof options === 'string') {
      options = { mimeType: options };
    }

    let buffer;
    let mimeType;

    if (input && typeof input === 'object' && input.buffer instanceof ArrayBuffer && input.mimeType) {
      buffer = input.buffer;
      mimeType = input.mimeType;
    } else if (input instanceof ArrayBuffer) {
      buffer = input;
      mimeType = options.mimeType;
    } else if (ArrayBuffer.isView(input)) {
      buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
      mimeType = options.mimeType;
    } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
      mimeType = input.type || options.mimeType;
      buffer = await input.arrayBuffer();
    } else if (typeof input === 'string') {
      mimeType = 'image/svg+xml';
      buffer = new TextEncoder().encode(input).buffer;
    } else if (input && typeof input === 'object' && (input.file || input.image)) {
      const file = input.file || input.image;
      if (typeof Blob !== 'undefined' && file instanceof Blob) {
        mimeType = file.type || options.mimeType;
        buffer = await file.arrayBuffer();
      }
    }

    // Attempt format sniffing if MIME type is missing or generic
    if ((!mimeType || mimeType === 'application/octet-stream') && buffer) {
      mimeType = detectMimeTypeFromBuffer(buffer) || mimeType;
    }

    // Validation
    if (!buffer || buffer.byteLength === 0) {
      throw messageError(new Error('Invalid image buffer'), 'errors.poseEstimationWorker.invalidImageFormat');
    }

    const validMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
    if (!mimeType || !validMimes.includes(mimeType.toLowerCase())) {
      throw messageError(new Error('Unsupported image format: ' + mimeType), 'errors.poseEstimationWorker.invalidImageFormat');
    }

    const worker = this.ensureWorker();
    if (!worker) {
      // Headless Node.js fallback
      return this.#estimatePoseHeadless(buffer, mimeType, options);
    }

    const id = String(++this.#sequence);
    const timeoutMs = options.timeoutMs || this.timeoutMs;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#pending.delete(id);
        reject(messageError(new Error('Pose estimation timed out'), 'errors.poseEstimationWorker.inferenceFailed'));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timeoutId });

      try {
        const transfer = (buffer instanceof ArrayBuffer && buffer.byteLength > 0) ? [buffer] : [];
        worker.postMessage({ id, type: 'estimatePose', buffer, mimeType }, transfer);
      } catch (err) {
        // Fallback without transfer list if detachment fails
        try {
          worker.postMessage({ id, type: 'estimatePose', buffer, mimeType });
        } catch {
          clearTimeout(timeoutId);
          this.#pending.delete(id);
          reject(restoreMessageError(err, { messageKey: 'errors.poseEstimationWorker.inferenceFailed' }));
        }
      }
    });
  }

  async #estimatePoseHeadless(buffer, mimeType, options = {}) {
    const { processPoseEstimation } = await import('./workers/pose-estimation-worker.mjs');
    const id = String(++this.#sequence);
    try {
      const landmarks = await processPoseEstimation({ id, type: 'estimatePose', buffer, mimeType });
      return this.#createResultObject(id, landmarks);
    } catch (err) {
      const messageKey = err?.messageKey || 'errors.poseEstimationWorker.inferenceFailed';
      const messageParams = err?.messageParams || {};
      throw restoreMessageError(err, { messageKey, messageParams });
    }
  }

  /**
   * Disposes the client, terminates active worker, and rejects all pending promises.
   */
  dispose() {
    this.#disposed = true;
    this.#terminateAndRejectAll(
      messageError(new Error('PoseEstimationClient disposed'), 'errors.poseEstimationWorker.inferenceFailed')
    );
  }
}

/** Default singleton instance */
export const poseEstimationClient = new PoseEstimationClient();

/**
 * Convenience function to estimate pose and return full response object.
 */
export async function estimatePose(input, options) {
  return poseEstimationClient.estimatePose(input, options);
}

/**
 * Convenience function returning just the 33 landmarks array.
 */
export async function estimatePoseLandmarks(input, options) {
  const result = await poseEstimationClient.estimatePose(input, options);
  return result.landmarks;
}
