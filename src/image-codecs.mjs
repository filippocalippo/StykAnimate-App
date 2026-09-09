import { quantizeGIF, mapGIFPixels } from "./gif-quantize.mjs";
import { normalizeGIFDither } from "./gif-options.mjs";
/** Small image container codecs. All compression/quantization runs in a worker.
 * PNG/APNG: https://www.w3.org/TR/png-3/
 * GIF89a: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
 * ZIP: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
const encoder = new TextEncoder();
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++)
    n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data, seed = 0) {
  let crc = seed ^ 0xffffffff;
  for (let i = 0; i < data.length; i++)
    crc = crcTable[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const u16 = (n) => new Uint8Array([n & 255, n >>> 8]);
const u32be = (n) => new Uint8Array([n >>> 24, n >>> 16, n >>> 8, n]);
function pngChunk(type, data) {
  const name = encoder.encode(type);
  return new Blob([
    u32be(data.length),
    name,
    data,
    u32be(crc32(data, crc32(name))),
  ]);
}
class BoundedOutput {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.size = 0;
    this.parts = [];
  }
  append(...parts) {
    for (const part of parts) {
      this.size += part.size ?? part.byteLength;
      if (this.size > this.maxBytes)
        throw new Error("The image export exceeds the configured size limit.");
      this.parts.push(part);
    }
  }
  blob(type) {
    return new Blob(this.parts, { type });
  }
}

function delayFraction(fps) {
  // Continued fractions preserve integer and common fractional rates while
  // respecting APNG's uint16 numerator/denominator fields.
  let value = 1 / fps,
    h0 = 0,
    h1 = 1,
    k0 = 1,
    k1 = 0;
  for (let i = 0; i < 20; i++) {
    const a = Math.floor(value),
      h = a * h1 + h0,
      k = a * k1 + k0;
    if (h > 65535 || k > 65535) break;
    h0 = h1;
    h1 = h;
    k0 = k1;
    k1 = k;
    const remainder = value - a;
    if (remainder < 1e-12) break;
    value = 1 / remainder;
  }
  return [Math.max(1, h1), Math.max(1, k1)];
}

function readPNG(data) {
  if (data.length < 33 || signature.some((n, i) => data[i] !== n))
    throw new Error("The browser did not produce a PNG frame.");
  const chunks = [],
    view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset),
      end = offset + length + 12;
    if (end > data.length)
      throw new Error("The encoded PNG frame is truncated.");
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: data.subarray(offset + 8, offset + 8 + length) });
    offset = end;
    if (type === "IEND") break;
  }
  if (!chunks.some((c) => c.type === "IDAT"))
    throw new Error("The PNG frame contains no pixels.");
  return chunks;
}

export class APNGEncoder extends BoundedOutput {
  constructor(options) {
    super(options.maxBytes);
    Object.assign(this, options);
    this.sequence = 0;
    this.frames = 0;
    [this.delayNum, this.delayDen] = delayFraction(this.fps);
  }
  add(data) {
    const chunks = readPNG(data),
      header = chunks.find((c) => c.type === "IHDR")?.data;
    if (!header || header.length !== 13)
      throw new Error("The PNG frame header is missing.");
    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    if (view.getUint32(0) !== this.width || view.getUint32(4) !== this.height)
      throw new Error("PNG frame dimensions changed during export.");
    if (this.frames === 0) {
      this.header = new Uint8Array(header);
      this.append(signature, pngChunk("IHDR", header));
      for (const chunk of chunks)
        if (["sRGB", "gAMA", "cHRM", "iCCP", "pHYs"].includes(chunk.type))
          this.append(pngChunk(chunk.type, chunk.data));
      const control = new Uint8Array(8),
        controlView = new DataView(control.buffer);
      controlView.setUint32(0, this.totalFrames);
      controlView.setUint32(4, this.loop === false ? 1 : 0);
      this.append(pngChunk("acTL", control));
    } else if (header.some((n, i) => n !== this.header[i]))
      throw new Error("PNG pixel format changed during animation export.");
    const control = new Uint8Array(26),
      controlView = new DataView(control.buffer);
    controlView.setUint32(0, this.sequence++);
    controlView.setUint32(4, this.width);
    controlView.setUint32(8, this.height);
    controlView.setUint16(20, this.delayNum);
    controlView.setUint16(22, this.delayDen);
    // Full-frame SOURCE blending replaces alpha as well as RGB; no stale pixels.
    control[24] = 0;
    control[25] = 0;
    this.append(pngChunk("fcTL", control));
    for (const chunk of chunks)
      if (chunk.type === "IDAT") {
        if (this.frames === 0) this.append(pngChunk("IDAT", chunk.data));
        else {
          const content = new Uint8Array(chunk.data.length + 4);
          content.set(u32be(this.sequence++));
          content.set(chunk.data, 4);
          this.append(pngChunk("fdAT", content));
        }
      }
    this.frames++;
  }
  finish() {
    if (this.frames !== this.totalFrames)
      throw new Error("The APNG export is missing frames.");
    this.append(pngChunk("IEND", new Uint8Array()));
    return this.blob("image/apng");
  }
}

function lzw(pixels) {
  const out = new Uint8Array(Math.ceil(pixels.length * 1.6) + 1024);
  let position = 0,
    accumulator = 0,
    bitCount = 0,
    bits = 9,
    nextCode = 258;
  const dictionary = new Map();
  const write = (code) => {
    accumulator |= code << bitCount;
    bitCount += bits;
    while (bitCount >= 8) {
      out[position++] = accumulator & 255;
      accumulator >>>= 8;
      bitCount -= 8;
    }
    // Encoder dictionary is one entry ahead of the decoder. Grow *after* the
    // code using the old width, including before the final end-of-information.
    if (nextCode === 1 << bits && bits < 12) bits++;
  };
  write(256);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const suffix = pixels[i],
      key = (prefix << 8) | suffix,
      existing = dictionary.get(key);
    if (existing !== undefined) prefix = existing;
    else {
      write(prefix);
      if (nextCode < 4096) dictionary.set(key, nextCode++);
      else {
        write(256);
        dictionary.clear();
        bits = 9;
        nextCode = 258;
      }
      prefix = suffix;
    }
  }
  write(prefix);
  write(257);
  if (bitCount) out[position++] = accumulator & 255;
  if (position > out.length)
    throw new Error("GIF compression exceeded its bounded output buffer.");
  const parts = [new Uint8Array([8])];
  for (let i = 0; i < position; i += 255) {
    const size = Math.min(255, position - i);
    parts.push(new Uint8Array([size]), out.subarray(i, i + size));
  }
  parts.push(new Uint8Array([0]));
  return new Blob(parts);
}

export class GIFEncoder extends BoundedOutput {
  constructor(options) {
    super(options.maxBytes);
    Object.assign(this, options);
    this.frames = 0;
    this.dither = normalizeGIFDither(options.dither);
    // Animation exports share a palette across both rendering passes. A still
    // GIF instead carries its own local table; index zero stays transparent.
    this.globalPalette = options.palette;
    this.append(
      encoder.encode("GIF89a"),
      u16(this.width),
      u16(this.height),
      ...(this.globalPalette
        ? [new Uint8Array([0xf7, 0, 0]), this.globalPalette.palette]
        : [new Uint8Array([0xf0, 0, 0, 0, 0, 0, 255, 255, 255])]),
    );
    if (this.loop !== false)
      this.append(
        new Uint8Array([0x21, 0xff, 11]),
        encoder.encode("NETSCAPE2.0"),
        new Uint8Array([3, 1, 0, 0, 0]),
      );
  }
  add(rgba) {
    if (rgba.length !== this.width * this.height * 4)
      throw new Error("GIF frame dimensions are invalid.");
    const { pixels, palette } = this.globalPalette
      ? mapGIFPixels(rgba, this.width, this.globalPalette, {
          dither: this.dither,
          previous: this.previous,
        })
      : quantizeGIF(rgba, this.width, { dither: this.dither });
    if (this.globalPalette) {
      this.previous ??= { data: new Uint8ClampedArray(rgba.length) };
      this.previous.data.set(rgba);
      this.previous.pixels = pixels;
    }
    // GIF stores hundredths of a second. Cumulative rounding prevents timing
    // drift at e.g. 24 fps while respecting the format's quantization.
    const delay = Math.max(
      1,
      Math.round(((this.frames + 1) * 100) / this.fps) -
        Math.round((this.frames * 100) / this.fps),
    );
    this.append(
      new Uint8Array([0x21, 0xf9, 4, 9]),
      u16(delay),
      new Uint8Array([0, 0]),
      new Uint8Array([0x2c, 0, 0, 0, 0]),
      u16(this.width),
      u16(this.height),
      ...(this.globalPalette
        ? [new Uint8Array([0])]
        : [new Uint8Array([0x87]), palette]),
      lzw(pixels),
    );
    this.frames++;
  }
  finish() {
    if (this.frames !== this.totalFrames)
      throw new Error("The GIF export is missing frames.");
    this.append(new Uint8Array([0x3b]));
    return this.blob("image/gif");
  }
}

export class SequenceZIP extends BoundedOutput {
  constructor(options) {
    super(options.maxBytes);
    Object.assign(this, options);
    this.central = [];
    this.frames = 0;
    this.entries = 0;
    this.extension = {
      "png-sequence": "png",
      "jpeg-sequence": "jpg",
      "gif-sequence": "gif",
      "svg-sequence": "svg",
    }[this.format];
    if (!this.extension)
      throw new Error("Choose a supported numbered image sequence.");
  }
  addFile(filename, content) {
    const name = encoder.encode(filename),
      offset = this.size,
      checksum = crc32(content);
    const local = new Uint8Array(30 + name.length),
      lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(12, 33, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, content.length, true);
    lv.setUint32(22, content.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length),
      cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, content.length, true);
    cv.setUint32(24, content.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    this.append(local, content);
    this.central.push(central);
    this.entries++;
  }
  add(data) {
    this.addFile(
      `frame-${String(++this.frames).padStart(6, "0")}.${this.extension}`,
      data,
    );
  }
  finish() {
    if (this.frames !== this.totalFrames)
      throw new Error("The image sequence is missing frames.");
    this.addFile(
      "animation.json",
      encoder.encode(
        JSON.stringify(
          {
            format: "StykAnimate image sequence",
            version: 1,
            width: this.width,
            height: this.height,
            fps: this.fps,
            totalFrames: this.totalFrames,
            durationSeconds: this.totalFrames / this.fps,
            firstFrame: 1,
            filenamePattern: `frame-%06d.${this.extension}`,
          },
          null,
          2,
        ),
      ),
    );
    const start = this.size;
    for (const entry of this.central) this.append(entry);
    const end = new Uint8Array(22),
      view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, this.entries, true);
    view.setUint16(10, this.entries, true);
    view.setUint32(12, this.size - start, true);
    view.setUint32(16, start, true);
    this.append(end);
    return this.blob("application/zip");
  }
}
