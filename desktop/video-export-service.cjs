"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const MAX_CHUNK_BYTES = 256 * 1024,
  MAX_FRAME_BYTES = 64 * 1024 * 1024,
  MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const FORMATS = Object.freeze({
  webm: {defaultCodec:"vp9",codecs:["vp9"],muxer:"webm",mimeType:"video/webm",extension:"webm"},
  mp4: {
    defaultCodec: "h264",
    codecs: ["h264", "mpeg4"],
    muxer: "mp4",
    mimeType: "video/mp4",
    extension: "mp4",
  },
  avi: {
    defaultCodec: "mpeg4",
    codecs: ["mpeg4", "ffv1", "rawvideo"],
    muxer: "avi",
    mimeType: "video/x-msvideo",
    extension: "avi",
  },
  wmv: {
    defaultCodec: "wmv2",
    codecs: ["wmv2"],
    muxer: "asf",
    mimeType: "video/x-ms-wmv",
    extension: "wmv",
  },
});
const CODECS = Object.freeze({
  vp9: {encoder:"libvpx-vp9",label:"VP9 with transparency",pixelFormat:"yuva420p",quality:true,lossless:false,alpha:true},
  h264: {
    encoder: "libx264",
    label: "H.264",
    pixelFormat: "yuv420p",
    quality: true,
    lossless: false,
  },
  mpeg4: {
    encoder: "mpeg4",
    label: "MPEG-4 Part 2",
    pixelFormat: "yuv420p",
    quality: true,
    lossless: false,
  },
  wmv2: {
    encoder: "wmv2",
    label: "Windows Media Video 8",
    pixelFormat: "yuv420p",
    quality: true,
    lossless: false,
  },
  ffv1: {
    encoder: "ffv1",
    label: "FFV1 (lossless)",
    pixelFormat: "bgr0",
    quality: false,
    lossless: true,
  },
  rawvideo: {
    encoder: "rawvideo",
    label: "Uncompressed RGB",
    pixelFormat: "bgr24",
    quality: false,
    lossless: true,
  },
});

function codecDimensions(codec, width, height) {
  const pad = CODECS[codec].pixelFormat === "yuv420p";
  const padRight = pad && width % 2,
    padBottom = pad && height % 2;
  return {
    encodedWidth: width + Number(padRight),
    encodedHeight: height + Number(padBottom),
    notice:
      padRight || padBottom
        ? `Video will include a one-pixel black edge on the ${padRight && padBottom ? "right and bottom" : padRight ? "right" : "bottom"} (${width + Number(padRight)}×${height + Number(padBottom)}).`
        : null,
  };
}
const aborted = () =>
  Object.assign(new Error("Video export cancelled."), { name: "AbortError" });
const integer = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
};
const finite = (value, min, max, name) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
};
const binary = (value) =>
  value instanceof ArrayBuffer
    ? Buffer.from(value)
    : ArrayBuffer.isView(value) && !(value instanceof DataView)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;
const removeFile = (filename) =>
  fs.unlink(filename).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc = (value, bytes) => {
  for (const byte of bytes)
    value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return value >>> 0;
};

/** Validates exactly one bounded, non-animated PNG without buffering its pixels. */
class PNGFrameValidator {
  constructor({ width, height, size }) {
    Object.assign(this, {
      width,
      height,
      size,
      position: 0,
      stage: "signature",
      buffer: Buffer.alloc(8),
      filled: 0,
      remaining: 0,
      chunkIndex: 0,
      sawData: false,
      ended: false,
    });
  }
  push(bytes) {
    if (
      this.position + bytes.length > this.size ||
      (this.ended && bytes.length)
    )
      throw new Error("PNG frame contains trailing data.");
    this.position += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      if (this.ended) throw new Error("PNG frame contains trailing data.");
      if (this.stage === "body") {
        const count = Math.min(this.remaining, bytes.length - offset),
          part = bytes.subarray(offset, offset + count);
        this.checksum = crc(this.checksum, part);
        if (this.type === "IHDR")
          part.copy(this.ihdr, this.length - this.remaining);
        this.remaining -= count;
        offset += count;
        if (!this.remaining) {
          this.stage = "crc";
          this.buffer = Buffer.alloc(4);
          this.filled = 0;
        }
        continue;
      }
      const count = Math.min(
        this.buffer.length - this.filled,
        bytes.length - offset,
      );
      bytes.copy(this.buffer, this.filled, offset, offset + count);
      this.filled += count;
      offset += count;
      if (this.filled < this.buffer.length) continue;
      if (this.stage === "signature") {
        if (!this.buffer.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          throw new Error("Video frame must be a PNG image.");
        this.stage = "header";
        this.buffer = Buffer.alloc(8);
        this.filled = 0;
      } else if (this.stage === "header") {
        this.length = this.buffer.readUInt32BE(0);
        this.type = this.buffer.toString("latin1", 4, 8);
        if (
          !/^[A-Za-z]{4}$/.test(this.type) ||
          this.length > this.size - 12 ||
          (this.chunkIndex === 0 &&
            (this.type !== "IHDR" || this.length !== 13))
        )
          throw new Error("Invalid PNG frame chunk.");
        if (["acTL", "fcTL", "fdAT"].includes(this.type))
          throw new Error("Video frames must be still PNG images.");
        if (
          !["IHDR", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs"].includes(
            this.type,
          ) ||
          (!["IHDR", "IDAT"].includes(this.type) && this.length > 64)
        )
          throw new Error("PNG frame contains unsupported metadata.");
        if (this.chunkIndex && this.type === "IHDR")
          throw new Error("PNG frame has a repeated header.");
        if (this.type === "IEND" && (this.length || !this.sawData))
          throw new Error("PNG frame is incomplete.");
        if (this.type === "IDAT") this.sawData = true;
        this.chunkIndex++;
        this.checksum = crc(0xffffffff, this.buffer.subarray(4));
        this.remaining = this.length;
        if (this.type === "IHDR") this.ihdr = Buffer.alloc(13);
        this.stage = this.remaining ? "body" : "crc";
        this.buffer = this.remaining ? null : Buffer.alloc(4);
        this.filled = 0;
      } else {
        if ((this.checksum ^ 0xffffffff) >>> 0 !== this.buffer.readUInt32BE(0))
          throw new Error("PNG frame checksum is invalid.");
        if (this.type === "IHDR") {
          if (
            this.ihdr.readUInt32BE(0) !== this.width ||
            this.ihdr.readUInt32BE(4) !== this.height
          )
            throw new Error("PNG frame dimensions do not match the export.");
          if (
            this.ihdr[8] !== 8 ||
            ![2, 6].includes(this.ihdr[9]) ||
            this.ihdr[10] ||
            this.ihdr[11] ||
            this.ihdr[12] > 1
          )
            throw new Error(
              "Video frames require standard 8-bit RGB or RGBA PNG images.",
            );
        }
        this.ended = this.type === "IEND";
        this.stage = "header";
        this.buffer = Buffer.alloc(8);
        this.filled = 0;
      }
    }
  }
  finish() {
    if (!this.ended || this.position !== this.size)
      throw new Error("PNG frame is incomplete.");
  }
}

function validateConfig(value = {}) {
  if (!Object.hasOwn(FORMATS, value.format))
    throw new Error("Choose WebM, MP4, AVI, or WMV video.");
  const codec =
    value.codec === undefined
      ? FORMATS[value.format].defaultCodec
      : value.codec;
  if (!FORMATS[value.format].codecs.includes(codec))
    throw new Error("Choose a supported codec for the selected video format.");
  const width = integer(value.width, 1, 16384, "Video width"),
    height = integer(value.height, 1, 16384, "Video height");
  if (width * height > 16 * 1024 * 1024)
    throw new Error(
      "Native video export supports up to 16 million pixels per frame.",
    );
  return {
    format: value.format,
    codec,
    width,
    height,
    ...codecDimensions(codec, width, height),
    fps: finite(value.fps, 1, 1000, "Video frame rate"),
    totalFrames: integer(value.totalFrames, 1, 1000000, "Video frame count"),
    quality: finite(value.quality ?? 0.8, 0, 1, "Video quality"),
    maxBytes: integer(
      value.maxBytes ?? MAX_OUTPUT_BYTES,
      1024,
      MAX_OUTPUT_BYTES,
      "Video size limit",
    ),
    ...(value.bitrate === undefined
      ? {}
      : { bitrate: finite(value.bitrate, 1000, 200000000, "Video bitrate") }),
  };
}

function encoderArguments(config, output) {
  const format = FORMATS[config.format];
  const codec = CODECS[config.codec];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-threads",
    "1",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "-framerate",
    String(config.fps),
    "-i",
    "pipe:0",
    "-an",
    "-sn",
    "-dn",
    "-map",
    "0:v:0",
  ];
  if (
    config.encodedWidth !== config.width ||
    config.encodedHeight !== config.height
  )
    args.push(
      "-vf",
      `pad=${config.encodedWidth}:${config.encodedHeight}:0:0:color=black`,
    );
  // Packed RGB-to-YUVA conversion rounds alpha 128..254 up by one.
  // Keep the original 8-bit alpha plane separate from chroma conversion.
  if (config.codec === "vp9") args.push("-filter_threads", "1", "-vf", "format=rgba,split[c][a];[a]alphaextract[mask];[c]format=yuv420p[color];[color][mask]alphamerge");
  args.push(
    "-c:v",
    codec.encoder,
    "-threads",
    "2",
    "-pix_fmt",
    codec.pixelFormat,
  );
  if (config.codec === "h264")
    args.push(
      "-preset",
      "veryfast",
      ...(config.bitrate
        ? ["-b:v", String(Math.round(config.bitrate))]
        : ["-crf", String(Math.round(38 - config.quality * 20))]),
    );
  else if (config.codec === "vp9")
    args.push("-deadline","good","-cpu-used","4","-row-mt","1","-auto-alt-ref","0","-lag-in-frames","0",
      "-b:v",String(Math.round(config.bitrate || Math.max(1000000,Math.min(50000000,config.width*config.height*config.fps*.18)))),
      "-crf",String(Math.round((1-config.quality)*48)));
  else if (codec.quality)
    args.push(
      ...(config.bitrate
        ? ["-b:v", String(Math.round(config.bitrate))]
        : ["-q:v", String(Math.round(31 - config.quality * 29))]),
    );
  if (config.codec === "vp9" && config.quality === 1) args.push("-lossless", "1");
  if (config.format === "mp4") args.push("-movflags", "+faststart");
  if (config.format === "avi" && config.codec === "mpeg4")
    args.push("-vtag", "XVID");
  // RGB FFV1 and rawvideo avoid chroma subsampling and dimension padding.
  if (config.codec === "ffv1") {
    // FFV1 v3's slice grid loses pixels on tiny dimensions in FFmpeg 7.1.
    // Its v1 single-slice format preserves those RGB frames exactly.
    const tiny = config.width < 4 || config.height < 4;
    args.push(
      "-level",
      tiny ? "1" : "3",
      "-coder",
      "1",
      "-slices",
      tiny ? "1" : "4",
    );
  }
  args.push(
    "-fps_mode",
    "cfr",
    "-fs",
    String(config.maxBytes),
    "-progress",
    "pipe:1",
    "-f",
    format.muxer,
    output,
  );
  return args;
}

function probe(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Native encoder did not respond."));
    }, 10000);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        text += chunk.toString();
        if (text.length > 256 * 1024) {
          child.kill("SIGKILL");
          reject(
            new Error("Native encoder returned an invalid capability list."),
          );
        }
      });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(text)
        : reject(new Error("Native encoder is unavailable."));
    });
  });
}

class VideoExportService {
  constructor({
    encoderPath,
    tempRoot = os.tmpdir(),
    ttlMs = 120000,
    operationTimeoutMs = 120000,
  } = {}) {
    if (
      encoderPath !== undefined &&
      (typeof encoderPath !== "string" || !path.isAbsolute(encoderPath))
    )
      throw new Error("A native-approved encoder is required.");
    if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot))
      throw new Error("A native-approved temporary folder is required.");
    Object.assign(this, { encoderPath, tempRoot, ttlMs, operationTimeoutMs });
    this.jobs = new Map();
    this.starting = false;
    this.capabilityPromise = null;
  }
  async capabilities(options = {}) {
    if (!this.capabilityPromise)
      this.capabilityPromise = (async () => {
        let version = "",
          encoders = "",
          muxers = "",
          reason = "";
        try {
          if (
            !this.encoderPath ||
            (await fs.stat(this.encoderPath)).isFile() !== true
          )
            throw new Error("missing");
          [version, encoders, muxers] = await Promise.all([
            probe(this.encoderPath, ["-version"]),
            probe(this.encoderPath, ["-hide_banner", "-encoders"]),
            probe(this.encoderPath, ["-hide_banner", "-muxers"]),
          ]);
        } catch {
          reason =
            "This desktop build does not include a working native video encoder. Export WebM or use a build with native video support.";
        }
        const formats = Object.entries(FORMATS).map(([id, format]) => {
          const codecs = format.codecs.map((id) => {
            const codec = CODECS[id];
            const supported =
              !reason &&
              new RegExp(`\\b${codec.encoder}\\b`).test(encoders) &&
              new RegExp(`\\b${format.muxer}\\b`).test(muxers);
            return {
              id,
              label: codec.label,
              supported,
              quality: codec.quality,
              lossless: codec.lossless,
              alpha: Boolean(codec.alpha),
              matte: codec.alpha ? null : "black",
              reason: supported
                ? null
                : reason ||
                  `The native encoder does not support ${codec.label} in this format.`,
            };
          });
          const supported = codecs.some((codec) => codec.supported);
          return {
            id,
            codec: CODECS[format.defaultCodec].label,
            defaultCodec: format.defaultCodec,
            alpha: Boolean(CODECS[format.defaultCodec].alpha),
            matte: CODECS[format.defaultCodec].alpha ? null : "black",
            codecs,
            mimeType: format.mimeType,
            supported,
            reason: supported
              ? null
              : reason ||
                `The native encoder does not support ${id.toUpperCase()}.`,
          };
        });
        return {
          available: formats.some((format) => format.supported),
          reason: reason || null,
          version: version.split(/\r?\n/)[0],
          formats,
          maxChunkBytes: MAX_CHUNK_BYTES,
          maxFrameBytes: MAX_FRAME_BYTES,
          maxBytes: MAX_OUTPUT_BYTES,
        };
      })();
    const value = await this.capabilityPromise;
    const width =
        Number.isInteger(options.width) && options.width > 0
          ? options.width
          : null,
      height =
        Number.isInteger(options.height) && options.height > 0
          ? options.height
          : null;
    return {
      ...value,
      formats: value.formats.map((format) => ({
        ...format,
        ...(width && height
          ? codecDimensions(format.defaultCodec, width, height)
          : { notice: null }),
        codecs: format.codecs.map((codec) => ({
          ...codec,
          ...(width && height
            ? codecDimensions(codec.id, width, height)
            : { notice: null }),
        })),
      })),
    };
  }
  touch(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(
      () => void this.cancel(job.token).catch(() => {}),
      this.ttlMs,
    );
    job.timer.unref?.();
  }
  async begin(value) {
    const config = validateConfig(value);
    if (this.starting || this.jobs.size)
      throw new Error("Finish or cancel the current video export first.");
    this.starting = true;
    let directory;
    try {
      const capabilities = await this.capabilities(config),
        available = capabilities.formats.find(
          (format) => format.id === config.format,
        ),
        selectedCodec = available?.codecs.find(
          (codec) => codec.id === config.codec,
        );
      if (!selectedCodec?.supported)
        throw new Error(
          selectedCodec?.reason || available?.reason || capabilities.reason,
        );
      await fs.mkdir(this.tempRoot, { recursive: true });
      directory = await fs.mkdtemp(
        path.join(this.tempRoot, "stykanimate-video-"),
      );
      const output = path.join(
        directory,
        `output.${FORMATS[config.format].extension}`,
      );
      const child = spawn(this.encoderPath, encoderArguments(config, output), {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const job = {
        token: randomUUID(),
        phase: "writing",
        config,
        directory,
        output,
        child,
        frames: 0,
        encodedFrames: 0,
        stderr: "",
        progress: "",
        busy: false,
        cancelled: false,
        exit: null,
      };
      job.closed = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          job.exit = { code, signal };
          resolve(job.exit);
        }),
      );
      child.on("error", (error) => {
        job.failure = new Error(
          `Native video encoder could not start: ${error.message}`,
        );
      });
      child.stdin.on("error", (error) => {
        if (!job.cancelled)
          job.failure ||= new Error(
            `Native video encoder stopped accepting frames: ${error.message}`,
          );
      });
      child.stderr.on("data", (chunk) => {
        job.stderr = (job.stderr + chunk.toString()).slice(-8192);
      });
      child.stdout.on("data", (chunk) => {
        job.progress += chunk.toString();
        let newline;
        while ((newline = job.progress.indexOf("\n")) >= 0) {
          const line = job.progress.slice(0, newline).trim();
          job.progress = job.progress.slice(newline + 1);
          if (line.startsWith("frame="))
            job.encodedFrames = Number(line.slice(6));
        }
        if (job.progress.length > 4096)
          job.progress = job.progress.slice(-4096);
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      this.jobs.set(job.token, job);
      this.touch(job);
      return {
        token: job.token,
        maxChunkBytes: MAX_CHUNK_BYTES,
        maxFrameBytes: MAX_FRAME_BYTES,
        inputWidth: config.width,
        inputHeight: config.height,
        width: config.encodedWidth,
        height: config.encodedHeight,
        codec: config.codec,
        notice: selectedCodec.notice,
      };
    } catch (error) {
      if (directory) await fs.rmdir(directory).catch(() => {});
      throw error;
    } finally {
      this.starting = false;
    }
  }
  async use(token, phase, operation) {
    const job = this.jobs.get(token);
    if (!job || job.phase !== phase || job.cancelled)
      throw new Error("This video export is no longer active.");
    if (job.busy)
      throw new Error("Wait for the previous video chunk to finish.");
    job.busy = true;
    clearTimeout(job.timer);
    job.idle = new Promise((resolve) => (job.resolveIdle = resolve));
    let result, failure;
    try {
      if (job.failure) throw job.failure;
      result = await operation(job);
      if (job.cancelled) throw aborted();
    } catch (error) {
      failure = error;
    } finally {
      job.busy = false;
      job.resolveIdle();
      job.idle = null;
      if (this.jobs.has(token) && !job.cancelled) this.touch(job);
    }
    if (failure) {
      await this.cancel(token);
      throw failure;
    }
    return result;
  }
  beginFrame(token, { index, size } = {}) {
    return this.use(token, "writing", async (job) => {
      if (job.frame) throw new Error("Finish the previous PNG frame first.");
      if (index !== job.frames || index >= job.config.totalFrames)
        throw new Error("Video frames must arrive in sequence.");
      integer(size, 45, MAX_FRAME_BYTES, "PNG frame size");
      job.frame = {
        index,
        size,
        written: 0,
        validator: new PNGFrameValidator({ ...job.config, size }),
      };
      return { index, maxChunkBytes: MAX_CHUNK_BYTES };
    });
  }
  writeFrameChunk(token, value) {
    return this.use(token, "writing", async (job) => {
      const bytes = binary(value);
      if (!bytes?.length || bytes.length > MAX_CHUNK_BYTES)
        throw new Error("Video chunks must contain 1 byte to 256 KiB.");
      if (!job.frame)
        throw new Error("Begin a PNG frame before sending pixels.");
      job.frame.validator.push(bytes);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("Native video encoder stopped accepting pixels.")),
          this.operationTimeoutMs,
        );
        const closed = () =>
          done(
            job.cancelled
              ? aborted()
              : new Error(`Native video encoder stopped. ${job.stderr}`),
          );
        const done = (error) => {
          clearTimeout(timer);
          job.child.removeListener("close", closed);
          error ? reject(error) : resolve();
        };
        job.child.once("close", closed);
        job.child.stdin.write(bytes, done);
      });
      job.frame.written += bytes.length;
      return {
        written: job.frame.written,
        total: job.frame.size,
        frame: job.frame.index,
      };
    });
  }
  endFrame(token) {
    return this.use(token, "writing", async (job) => {
      if (!job.frame) throw new Error("There is no PNG frame to finish.");
      job.frame.validator.finish();
      job.frames++;
      job.frame = null;
      return { completed: job.frames, total: job.config.totalFrames };
    });
  }
  finish(token) {
    return this.use(token, "writing", async (job) => {
      if (job.frame || job.frames !== job.config.totalFrames)
        throw new Error("Send every video frame before finishing the export.");
      job.child.stdin.end();
      let timer;
      try {
        await Promise.race([
          job.closed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Native video encoder did not finish.")),
              this.operationTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (job.cancelled) throw aborted();
      if (job.failure || job.exit.code !== 0)
        throw new Error(
          `Native video encoding failed. ${job.stderr || job.failure?.message || ""}`.trim(),
        );
      if (job.encodedFrames !== job.config.totalFrames)
        throw new Error(
          `Native video encoded ${job.encodedFrames} of ${job.config.totalFrames} frames. The video may exceed its size limit.`,
        );
      const stat = await fs.stat(job.output);
      if (!stat.isFile() || !stat.size || stat.size > job.config.maxBytes)
        throw new Error("Encoded video exceeds its size limit.");
      job.handle = await fs.open(job.output, "r");
      job.size = stat.size;
      job.position = 0;
      job.phase = "reading";
      const format = FORMATS[job.config.format];
      return {
        token: job.token,
        size: job.size,
        maxChunkBytes: MAX_CHUNK_BYTES,
        mimeType: format.mimeType,
        extension: format.extension,
        frames: job.frames,
        width: job.config.encodedWidth,
        height: job.config.encodedHeight,
        codec: job.config.codec,
      };
    });
  }
  read(token) {
    return this.use(token, "reading", async (job) => {
      const count = Math.min(MAX_CHUNK_BYTES, job.size - job.position),
        bytes = Buffer.alloc(count);
      let filled = 0;
      while (filled < count) {
        const { bytesRead } = await job.handle.read(
          bytes,
          filled,
          count - filled,
          job.position + filled,
        );
        if (!bytesRead) throw new Error("Encoded video changed while reading.");
        filled += bytesRead;
      }
      job.position += count;
      const done = job.position === job.size,
        result = {
          bytes: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
          done,
          read: job.position,
          total: job.size,
        };
      if (done) await this.release(job);
      return result;
    });
  }
  async release(job) {
    this.jobs.delete(job.token);
    clearTimeout(job.timer);
    if (job.handle) {
      await job.handle.close();
      job.handle = null;
    }
    await removeFile(job.output);
    await fs.rmdir(job.directory).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async cancel(token) {
    const job = this.jobs.get(token);
    if (!job) return { cancelled: false };
    if (job.cancellation) return job.cancellation;
    job.cancelled = true;
    clearTimeout(job.timer);
    job.cancellation = (async () => {
      job.child.stdin.destroy();
      if (!job.exit) job.child.kill("SIGKILL");
      await job.closed;
      if (job.busy) await job.idle;
      await this.release(job);
      return { cancelled: true };
    })();
    return job.cancellation;
  }
  async dispose() {
    for (const token of this.jobs.keys())
      await this.cancel(token).catch(() => {});
  }
}

module.exports = {
  VideoExportService,
  PNGFrameValidator,
  validateConfig,
  encoderArguments,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  MAX_OUTPUT_BYTES,
};
