import {messageError} from './localized-error.mjs';
/** Deterministic canvas -> WebCodecs -> WebM or MP4 export, without captureStream.
 * Sources: https://www.w3.org/TR/webcodecs/
 *          https://www.webmproject.org/docs/container/
 * Video only. WebM prefers VP8 with VP9 as the fallback; MP4 carries H.264
 * (see mp4-muxer.mjs). No real-time/compositor dependency.
 */
import {videoQualityOptions} from './export-video-quality.mjs';
import {Mp4Muxer, avcCodecStrings} from './mp4-muxer.mjs';
import {encodeAudio} from './audio-encode.mjs';
const text = new TextEncoder();
const LIMIT = 512 * 1024 * 1024;
// A streamed file is bounded by the destination disk, not renderer memory.
const STREAM_LIMIT = 16 * 1024 * 1024 * 1024;
// Include submitted but not yet output frames, not just encodeQueueSize: codecs
// can dequeue a frame while retaining its pixels internally. At 4K allow one.
export const videoFrameWindow = (width, height) => Math.max(1, Math.min(4, Math.floor(32 * 1024 * 1024 / (width * height * 4))));

function bytes(value) {
  const result = [];
  do { result.unshift(value % 256); value = Math.floor(value / 256); } while (value);
  return new Uint8Array(result);
}

function sizeVint(value) {
  let length = 1;
  // The all-ones payload is reserved for unknown-length EBML elements.
  while (value >= 2 ** (7 * length) - 1) length++;
  if (length > 8 || !Number.isSafeInteger(value) || value < 0) throw messageError(new Error(''), "errors.videoExport.theVideoContainerExceedsTheSizeLimit", {});
  const result = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { result[i] = value % 256; value = Math.floor(value / 256); }
  result[0] |= 1 << (8 - length);
  return result;
}

// Fixed-width 8-byte VINT used for the streamed Segment size field: written as
// a placeholder up front and patched once the segment body size is known.
function sizeVint8(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 56) throw messageError(new Error(''), "errors.videoExport.theVideoContainerExceedsTheSizeLimit", {});
  const result = new Uint8Array(8);
  result[0] = 0x01;
  for (let i = 7; i >= 1; i--) { result[i] = value % 256; value = Math.floor(value / 256); }
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

// A soundtrack (`audio`, from audio-encode.mjs) is written as clusters of its own,
// merged with the video clusters in time order, as WebM requires.
class WebMMuxer {
  constructor({width, height, fps, totalFrames, codec, maxBytes, streamed = false, audio = null}) {
    this.audio = audio?.packets?.length ? audio : null;
    this.audioIndex = 0;
    this.maxBytes = maxBytes;
    this.streamed = streamed;
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
    const video = element(0xae, [
      uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), uint(0x9c, 0),
      string(0x86, codec === 'vp8' ? 'V_VP8' : 'V_VP9'),
      uint(0x23e383, Math.round(1e9 / fps)),
      element(0xe0, [uint(0xb0, width), uint(0xba, height), uint(0x54b0, width), uint(0x54ba, height)]),
    ]);
    // Opus needs its identification header, the pre-skip as CodecDelay and an 80 ms seek pre-roll (RFC 7845, Matroska codec mapping).
    const sound = this.audio && element(0xae, [
      uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 2), uint(0x9c, 0), string(0x86, 'A_OPUS'),
      uint(0x56aa, Math.round(this.audio.preSkip * 1e9 / this.audio.sampleRate)), uint(0x56bb, 80000000),
      element(0x63a2, this.audio.description),
      element(0xe1, [float(0xb5, this.audio.sampleRate), uint(0x9f, this.audio.channels)]),
    ]);
    this.tracks = element(0x1654ae6b, sound ? [video, sound] : [video]);
    this.position = this.info.size + this.tracks.size;
    this.encodedBytes = this.header.size + this.position;
    if (streamed) {
      // Segment ID + a reserved 8-byte size field, patched at finish. The
      // Segment body (info, tracks, clusters, cues) then appends in order.
      this.segmentSizeOffset = this.header.size + 4;
      this.reservedSize = new Uint8Array(8);
      this.pending = [this.header, new Uint8Array([0x18, 0x53, 0x80, 0x67]), this.reservedSize, this.info, this.tracks];
      this.encodedBytes += 12;
    }
  }

  /** Parts produced since the last drain, in output order. */
  drain() {
    if (!this.pending?.length) return null;
    const parts = this.pending;
    this.pending = [];
    return parts;
  }

  /** Writes the sound packets up to `limit` (microseconds), each in a cluster of its own. */
  flushAudio(limit) {
    const packets = this.audio?.packets;
    while (packets && this.audioIndex < packets.length && packets[this.audioIndex].timestamp <= limit) {
      const packet = packets[this.audioIndex++];
      // Track 2, a zero timecode inside the cluster, and the keyframe flag Opus packets always carry.
      const cluster = element(0x1f43b675, [uint(0xe7, packet.timestamp), element(0xa3, [new Uint8Array([0x82, 0, 0, 0x80]), packet.data])]);
      if (this.encodedBytes + cluster.size + 64 > this.maxBytes) throw messageError(new Error(''), "errors.mp4Muxer.theEncodedVideoExceedsTheConfiguredExportSize", {});
      if (this.streamed) this.pending.push(cluster); else this.clusters.push(cluster);
      this.position += cluster.size;
      this.encodedBytes += cluster.size;
    }
  }

  add(chunk) {
    if (!Number.isSafeInteger(chunk.timestamp) || chunk.timestamp < 0 || chunk.timestamp < this.lastTimestamp) {
      throw messageError(new Error(''), "errors.mp4Muxer.theEncoderReturnedOutOfOrderVideoTimestamps", {});
    }
    if (this.frames === 0 && chunk.type !== 'key') throw messageError(new Error(''), "errors.mp4Muxer.theVideoEncoderDidNotProduceAnInitial", {});
    this.flushAudio(chunk.timestamp);
    if (this.encodedBytes + chunk.byteLength + 64 > this.maxBytes) throw messageError(new Error(''), "errors.mp4Muxer.theEncodedVideoExceedsTheConfiguredExportSize", {});
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const block = element(0xa3, [new Uint8Array([0x81, 0, 0, chunk.type === 'key' ? 0x80 : 0]), data]);
    const cluster = element(0x1f43b675, [uint(0xe7, chunk.timestamp), block]);
    if (chunk.type === 'key') this.cues.push(element(0xbb, [uint(0xb3, chunk.timestamp),
      element(0xb7, [uint(0xf7, 1), uint(0xf1, this.position)])]));
    if (this.streamed) this.pending.push(cluster);
    else this.clusters.push(cluster);
    this.position += cluster.size;
    this.encodedBytes += cluster.size;
    this.lastTimestamp = chunk.timestamp;
    this.frames++;
  }

  finish(expectedFrames) {
    if (this.frames !== expectedFrames) throw messageError(new Error(''), "errors.mp4Muxer.videoExportProducedOfFrames", {frames: this.frames, expectedFrames: expectedFrames});
    this.flushAudio(Infinity);
    const cues = element(0x1c53bb6b, this.cues);
    if (this.streamed) {
      const bodySize = this.position + cues.size;
      if (bodySize + this.header.size + 12 > this.maxBytes) throw messageError(new Error(''), "errors.mp4Muxer.theEncodedVideoExceedsTheExportSizeLimit", {});
      this.pending.push(cues);
      return { patch: { offset: this.segmentSizeOffset, bytes: sizeVint8(bodySize) } };
    }
    const segment = element(0x18538067, [this.info, this.tracks, ...this.clusters, cues]);
    if (segment.size + this.header.size > this.maxBytes) throw messageError(new Error(''), "errors.mp4Muxer.theEncodedVideoExceedsTheExportSizeLimit", {});
    return new Blob([this.header, segment], {type: 'video/webm'});
  }
}

function cancelled() { return messageError(new DOMException('', 'AbortError'), "errors.audioEncode.videoExportCancelled", {}); }

/** H.264 encodes even dimensions; an odd width or height gains one black pixel row or column. */
export const avcCodedSize = (width, height) => ({width: width + (width & 1), height: height + (height & 1)});

/** What differs between the containers: the codecs to try, their configuration and the muxer. */
const CONTAINERS = {
  webm: {
    unsupportedKey: 'errors.videoExport.unsupportedWebm',
    candidates: ({width, height, fps, bitrate}) => ['vp8', 'vp09.00.51.08'].map(codec => ({codec, width, height, framerate: fps, bitrate: Math.round(bitrate),
      latencyMode: 'quality', hardwareAcceleration: 'prefer-software', alpha: 'discard'})),
    audio: 'opus',
    muxer: options => new WebMMuxer(options),
  },
  mp4: {
    unsupportedKey: 'errors.videoExport.unsupportedMp4',
    candidates: ({width, height, fps, bitrate}) => {
      const coded = avcCodedSize(width, height);
      return avcCodecStrings(coded.width, coded.height, fps).map(codec => ({codec, ...coded, framerate: fps, bitrate: Math.round(bitrate),
        latencyMode: 'quality', avc: {format: 'avc'}}));
    },
    audio: 'aac',
    muxer: options => new Mp4Muxer(options),
  },
};

function scratchCanvas(width, height) {
  return typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), {width, height});
}

/**
 * WebM (VP8/VP9) or MP4 (H.264) from rendered canvases; see encodeWebM and encodeMP4.
 * @param {{width:number,height:number,fps:number,totalFrames:number,
 * renderFrame:(index:number)=>Promise<HTMLCanvasElement|OffscreenCanvas>|HTMLCanvasElement|OffscreenCanvas,
 * onProgress?:(value:{completed:number,total:number,progress:number})=>void,
 * signal?:AbortSignal,bitrate?:number,maxBytes?:number,
 * audioChunks?:AsyncIterable<Float32Array>,  the soundtrack: interleaved stereo at 48 kHz (AAC in MP4, Opus in WebM)
 * sink?:{write(part)=>Promise<void>,patch(offset:number,bytes:Uint8Array)=>Promise<void>,finish()=>Promise<object>,abort()=>Promise<void>}}} options
 * @returns {Promise<Blob|object>} A seekable, video-only file — a Blob, or
 * the sink's finish() result when a sink is provided.
 */
async function encodeVideo(container, {width, height, fps, totalFrames, renderFrame, onProgress,
  signal, bitrate = videoQualityOptions({width, height, fps, provider: 'WebCodecs'}).bitrate, maxBytes, sink, audioChunks}) {
  const format = CONTAINERS[container];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw messageError(new Error(''), "errors.videoExport.videoDimensionsMustBeWholePixelsBetween1", {});
  }
  if (!Number.isFinite(fps) || fps < 1 || fps > 1000) throw messageError(new Error(''), "errors.videoExport.chooseAVideoFrameRateBetween1And", {});
  if (!Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 1000000) throw messageError(new Error(''), "errors.videoExport.chooseBetween1And1000000Video", {});
  if (typeof renderFrame !== 'function') throw messageError(new TypeError(''), "errors.videoExport.videoExportNeedsAFrameRenderer", {});
  if (!Number.isFinite(bitrate) || bitrate < 1 || bitrate > 200e6) throw messageError(new Error(''), "errors.videoExport.theRequestedVideoBitrateIsInvalid", {});
  const streamed = Boolean(sink);
  // The 16 GiB bound is only honest while bytes leave memory; an in-memory
  // sink keeps the same 512 MiB cap as the Blob path.
  const limit = sink?.streamed === true ? STREAM_LIMIT : LIMIT;
  maxBytes ??= limit;
  if (!Number.isFinite(maxBytes) || maxBytes < 1024 || maxBytes > limit) throw messageError(new Error(''), sink?.streamed === true ? 'errors.videoExport.streamSizeLimit' : 'errors.videoExport.memorySizeLimit');
  if (signal?.aborted) throw cancelled();
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw messageError(new Error(''), "errors.videoExport.thisBrowserDoesNotSupportWebcodecsVideoExport", {});
  }
  let config;
  for (const candidate of format.candidates({width, height, fps, bitrate})) {
    try { if ((await VideoEncoder.isConfigSupported(candidate)).supported) { config = candidate; break; } }
    catch { /* Try the next codec before reporting unavailable support. */ }
  }
  if (signal?.aborted) throw cancelled();
  if (!config) throw messageError(new Error(''), format.unsupportedKey);
  // The encoder's own picture size: H.264 pads an odd edge, so its frames are copied onto a black canvas that size.
  const coded = {width: config.width, height: config.height}, padded = coded.width !== width || coded.height !== height;
  // The soundtrack is encoded first, then placed by the muxer: after the video in MP4, interleaved with it in WebM.
  let soundtrack = null;
  if (audioChunks) {
    onProgress?.({completed: 0, total: totalFrames, progress: 0, phase: 'mixing audio'});
    soundtrack = await encodeAudio({codec: format.audio, chunks: audioChunks, signal, maxBytes, seconds: totalFrames / fps});
    if (signal?.aborted) throw cancelled();
  }
  const muxer = format.muxer({width: coded.width, height: coded.height, fps, totalFrames, codec: config.codec, maxBytes, streamed, audio: soundtrack});
  let padCanvas, padContext;
  let failure, wake, completed = false;
  const frameWindow = videoFrameWindow(width, height);
  let submitted = 0;
  /** Whether the encoder kept frames back until it was flushed: then every full window is flushed. */
  let holdsFrames = false;
  // The next frame, drawn while this one is encoded: a VideoFrame holds its own copy of the canvas it is made from.
  let ahead = null;
  const renderAhead = index => {
    const next = (async () => renderFrame(index))();
    next.catch(() => {});
    return next;
  };
  const encoder = new VideoEncoder({
    output(chunk, metadata) { try { muxer.add(chunk, metadata); wake?.(); } catch (error) { failure ||= error; wake?.(error); } },
    error(error) { failure ||= error; wake?.(error); },
  });
  const check = () => { if (signal?.aborted) throw cancelled(); if (failure) throw failure; };
  const abort = () => { wake?.(cancelled()); if (encoder.state !== 'closed') encoder.close(); };
  signal?.addEventListener('abort', abort, {once: true});
  // Muxed bytes leave through the sink in order; draining is serialized with
  // the frame loop so pending output stays bounded by the encoder window.
  const flush = async () => {
    const parts = muxer.drain();
    if (parts) for (const part of parts) { check(); await sink.write(part); }
  };
  try {
    encoder.configure(config);
    // A full window waits until the encoder has given out a frame: a frame with output is no longer held, while
    // its leaving the queue (dequeue) says nothing about pixels kept inside. Quality mode must not drop frames.
    // The encoder keeps working meanwhile; an encoder that gives out nothing until it is flushed is flushed.
    const drain = () => new Promise((resolve, reject) => {
      let timer = null;
      const done = error => {
        clearTimeout(timer);
        wake = null;
        error ? reject(error) : resolve();
      };
      const flushAll = () => {
        holdsFrames = true;
        wake = error => { if (error) done(error); };
        timer = setTimeout(() => done(messageError(new Error(''), "errors.videoExport.theVideoEncoderStoppedAcceptingFrames", {})), 30000);
        try {encoder.flush().then(() => done(failure), done);} catch (error) {done(error);}
      };
      if (holdsFrames) return flushAll();
      wake = error => { if (error) done(error); else if (submitted - muxer.frames < frameWindow) done(failure); };
      timer = setTimeout(() => { clearTimeout(timer); flushAll(); }, 1000);
    });
    for (let index = 0; index < totalFrames; index++) {
      check();
      const canvas = await (ahead ?? renderAhead(index));
      ahead = null;
      check();
      if (!canvas || canvas.width !== width || canvas.height !== height) throw messageError(new Error(''), "errors.nativeVideoExport.renderedVideoFrameHasTheWrongDimensions", {value: index + 1});
      const timestamp = Math.round(index * 1e6 / fps);
      const duration = Math.round((index + 1) * 1e6 / fps) - timestamp;
      let source = canvas;
      if (padded) {
        padCanvas ??= scratchCanvas(coded.width, coded.height);
        padContext ??= padCanvas.getContext('2d');
        padContext.fillStyle = '#000';
        padContext.fillRect(0, 0, coded.width, coded.height);
        padContext.drawImage(canvas, 0, 0);
        source = padCanvas;
      }
      const frame = new VideoFrame(source, {timestamp, duration, alpha: 'discard'});
      if (index + 1 < totalFrames) ahead = renderAhead(index + 1);
      try { submitted++; encoder.encode(frame, {keyFrame: index % Math.max(1, Math.round(fps * 2)) === 0}); }
      finally { frame.close(); }
      if (submitted - muxer.frames >= frameWindow) await drain();
      if (streamed) await flush();
      check();
      onProgress?.({completed: index + 1, total: totalFrames, progress: (index + 1) / totalFrames});
      // Cooperatively yield so progress/cancellation still works when the frame
      // renderer returns synchronously and hardware accepts frames immediately.
      if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
    }
    let flushTimer;
    try {
      await Promise.race([encoder.flush(), new Promise((_, reject) => {
        flushTimer = setTimeout(() => reject(messageError(new Error(''), "errors.videoExport.theVideoEncoderDidNotFinishItsPending", {})), 30000);
      })]);
    } finally { clearTimeout(flushTimer); }
    check();
    const tail = muxer.finish(totalFrames);
    if (streamed) {
      await flush();
      await sink.patch(tail.patch.offset, tail.patch.bytes);
      const result = await sink.finish();
      completed = true;
      return result;
    }
    completed = true;
    return tail;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (encoder.state !== 'closed') encoder.close();
    if (streamed && !completed) await sink.abort();
  }
}

/** A seekable, video-only WebM file (VP8, else VP9). */
export const encodeWebM = options => encodeVideo('webm', options);
/** A video-only MP4 file (H.264). An odd width or height is padded by one black pixel. */
export const encodeMP4 = options => encodeVideo('mp4', options);
