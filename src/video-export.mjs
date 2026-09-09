/** Deterministic canvas -> WebCodecs -> WebM export, without captureStream.
 * Sources: https://www.w3.org/TR/webcodecs/
 *          https://www.webmproject.org/docs/container/
 * Video only; VP8 preferred, VP9 fallback. No real-time/compositor dependency.
 */
const text = new TextEncoder();
const LIMIT = 512 * 1024 * 1024;

function bytes(value) {
  const result = [];
  do { result.unshift(value % 256); value = Math.floor(value / 256); } while (value);
  return new Uint8Array(result);
}

function sizeVint(value) {
  let length = 1;
  // The all-ones payload is reserved for unknown-length EBML elements.
  while (value >= 2 ** (7 * length) - 1) length++;
  if (length > 8 || !Number.isSafeInteger(value) || value < 0) throw new Error('The video container exceeds the size limit.');
  const result = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { result[i] = value % 256; value = Math.floor(value / 256); }
  result[0] |= 1 << (8 - length);
  return result;
}

function element(id, payload) {
  const body = payload instanceof Blob ? payload : new Blob(Array.isArray(payload) ? payload : [payload]);
  return new Blob([bytes(id), sizeVint(body.size), body]);
}
const uint = (id, value) => element(id, bytes(value));
const string = (id, value) => element(id, text.encode(value));
function float(id, value) {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setFloat64(0, value, false);
  return element(id, result);
}

class WebMMuxer {
  constructor({width, height, fps, totalFrames, codec, maxBytes}) {
    this.maxBytes = maxBytes;
    this.frames = 0;
    this.lastTimestamp = -1;
    this.clusters = [];
    this.cues = [];
    this.header = element(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1),
      uint(0x42f2, 4), uint(0x42f3, 8), string(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)]);
    // TimestampScale is nanoseconds per tick. 1000 gives exact microseconds,
    // matching WebCodecs. Per-frame clusters keep signed block timecode zero.
    this.info = element(0x1549a966, [uint(0x2ad7b1, 1000),
      float(0x4489, Math.round(totalFrames * 1e6 / fps)),
      string(0x4d80, 'StykAnimate'), string(0x5741, 'StykAnimate')]);
    this.tracks = element(0x1654ae6b, [element(0xae, [
      uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), uint(0x9c, 0),
      string(0x86, codec === 'vp8' ? 'V_VP8' : 'V_VP9'),
      uint(0x23e383, Math.round(1e9 / fps)),
      element(0xe0, [uint(0xb0, width), uint(0xba, height), uint(0x54b0, width), uint(0x54ba, height)]),
    ])]);
    this.position = this.info.size + this.tracks.size;
    this.encodedBytes = this.header.size + this.position;
  }

  add(chunk) {
    if (!Number.isSafeInteger(chunk.timestamp) || chunk.timestamp < 0 || chunk.timestamp < this.lastTimestamp) {
      throw new Error('The encoder returned out-of-order video timestamps.');
    }
    if (this.frames === 0 && chunk.type !== 'key') throw new Error('The video encoder did not produce an initial keyframe.');
    if (this.encodedBytes + chunk.byteLength + 64 > this.maxBytes) throw new Error('The encoded video exceeds the configured export size limit.');
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const block = element(0xa3, [new Uint8Array([0x81, 0, 0, chunk.type === 'key' ? 0x80 : 0]), data]);
    const cluster = element(0x1f43b675, [uint(0xe7, chunk.timestamp), block]);
    if (chunk.type === 'key') this.cues.push(element(0xbb, [uint(0xb3, chunk.timestamp),
      element(0xb7, [uint(0xf7, 1), uint(0xf1, this.position)])]));
    this.clusters.push(cluster);
    this.position += cluster.size;
    this.encodedBytes += cluster.size;
    this.lastTimestamp = chunk.timestamp;
    this.frames++;
  }

  finish(expectedFrames) {
    if (this.frames !== expectedFrames) throw new Error(`Video export produced ${this.frames} of ${expectedFrames} frames.`);
    const cues = element(0x1c53bb6b, this.cues);
    const segment = element(0x18538067, [this.info, this.tracks, ...this.clusters, cues]);
    if (segment.size + this.header.size > this.maxBytes) throw new Error('The encoded video exceeds the export size limit.');
    return new Blob([this.header, segment], {type: 'video/webm'});
  }
}

function cancelled() { return new DOMException('Video export cancelled.', 'AbortError'); }

/**
 * @param {{width:number,height:number,fps:number,totalFrames:number,
 * renderFrame:(index:number)=>Promise<HTMLCanvasElement|OffscreenCanvas>|HTMLCanvasElement|OffscreenCanvas,
 * onProgress?:(value:{completed:number,total:number,progress:number})=>void,
 * signal?:AbortSignal,bitrate?:number,maxBytes?:number}} options
 * @returns {Promise<Blob>} A seekable, video-only WebM file.
 */
export async function encodeWebM({width, height, fps, totalFrames, renderFrame, onProgress,
  signal, bitrate = Math.max(1e6, Math.min(50e6, width * height * fps * 0.18)), maxBytes = LIMIT}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw new Error('Video dimensions must be whole pixels between 1 and 16,384.');
  }
  if (!Number.isFinite(fps) || fps < 1 || fps > 1000) throw new Error('Choose a video frame rate between 1 and 1,000 fps.');
  if (!Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 1000000) throw new Error('Choose between 1 and 1,000,000 video frames.');
  if (typeof renderFrame !== 'function') throw new TypeError('Video export needs a frame renderer.');
  if (!Number.isFinite(bitrate) || bitrate < 1 || bitrate > 200e6) throw new Error('The requested video bitrate is invalid.');
  if (!Number.isFinite(maxBytes) || maxBytes < 1024 || maxBytes > LIMIT) throw new Error('The video size limit must be between 1 KiB and 512 MiB.');
  if (signal?.aborted) throw cancelled();
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('This browser does not support WebCodecs video export. Open StykAnimate in its desktop app or a current Chromium browser.');
  }
  let config;
  for (const codec of ['vp8', 'vp09.00.51.08']) {
    const candidate = {codec, width, height, framerate: fps, bitrate: Math.round(bitrate),
      latencyMode: 'quality', hardwareAcceleration: 'no-preference', alpha: 'discard'};
    try { if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; } }
    catch { /* Try the other WebM codec before reporting unavailable support. */ }
  }
  if (signal?.aborted) throw cancelled();
  if (!config) throw new Error('No VP8 or VP9 video encoder supports this canvas size. Try a smaller export resolution.');
  const muxer = new WebMMuxer({width, height, fps, totalFrames, codec: config.codec, maxBytes});
  let failure, wake;
  const encoder = new VideoEncoder({
    output(chunk) { try { muxer.add(chunk); } catch (error) { failure ||= error; wake?.(error); } },
    error(error) { failure ||= error; wake?.(error); },
  });
  const check = () => { if (signal?.aborted) throw cancelled(); if (failure) throw failure; };
  const abort = () => { wake?.(cancelled()); if (encoder.state !== 'closed') encoder.close(); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    encoder.configure(config);
    const drain = () => new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer);
        encoder.removeEventListener('dequeue', dequeue);
        wake = null;
        error ? reject(error) : resolve();
      };
      const dequeue = () => { if (failure) done(failure); else if (encoder.encodeQueueSize < 4) done(); };
      const timer = setTimeout(() => done(new Error('The video encoder stopped accepting frames.')), 30000);
      wake = done;
      encoder.addEventListener('dequeue', dequeue);
      dequeue();
    });
    for (let index = 0; index < totalFrames; index++) {
      check();
      const canvas = await renderFrame(index);
      check();
      if (!canvas || canvas.width !== width || canvas.height !== height) throw new Error(`Rendered video frame ${index + 1} has the wrong dimensions.`);
      const timestamp = Math.round(index * 1e6 / fps);
      const duration = Math.round((index + 1) * 1e6 / fps) - timestamp;
      const frame = new VideoFrame(canvas, {timestamp, duration, alpha: 'discard'});
      try { encoder.encode(frame, {keyFrame: index % Math.max(1, Math.round(fps * 2)) === 0}); }
      finally { frame.close(); }
      if (encoder.encodeQueueSize >= 4) await drain();
      check();
      onProgress?.({completed: index + 1, total: totalFrames, progress: (index + 1) / totalFrames});
      // Cooperatively yield so progress/cancellation still works when the frame
      // renderer returns synchronously and hardware accepts frames immediately.
      if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
    }
    let flushTimer;
    try {
      await Promise.race([encoder.flush(), new Promise((_, reject) => {
        flushTimer = setTimeout(() => reject(new Error('The video encoder did not finish its pending frames.')), 30000);
      })]);
    } finally { clearTimeout(flushTimer); }
    check();
    return muxer.finish(totalFrames);
  } finally {
    signal?.removeEventListener('abort', abort);
    if (encoder.state !== 'closed') encoder.close();
  }
}
