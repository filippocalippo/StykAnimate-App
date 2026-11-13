/**
 * The GIF encoder as it was before its pixels were read a word at a time (src/gif-quantize.mjs and the `lzw` and
 * GIFEncoder of src/image-codecs.mjs at perf/speed ef1840cf), verbatim but for imports and the writer's container,
 * which is reduced to the bytes it appended. tests/gif-quantize.test.mjs proves the encoder today writes the same
 * bytes from the same frames. Not used by the app.
 */
const messageError = (error) => error;
const normalizeGIFDither = (dither = false) => {
  if (typeof dither !== "boolean") throw new TypeError("GIF dither must be true or false.");
  return dither;
};
const EXPORT_MAX_PIXELS = 67108864;
const MAX_COLORS = 65536,
  MAX_PIXELS = EXPORT_MAX_PIXELS;
const colorOf = (data, i) => {
  const a = data[i + 3] / 255;
  return (
    (Math.round(data[i] * a + 255 * (1 - a)) << 16) |
    (Math.round(data[i + 1] * a + 255 * (1 - a)) << 8) |
    Math.round(data[i + 2] * a + 255 * (1 - a))
  );
};
function validate(data, width) {
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    width > 16384 ||
    !data.length ||
    data.length % (width * 4) ||
    data.length > MAX_PIXELS * 4
  )
    throw messageError(new RangeError(''), "errors.gifQuantize.gifQuantizationRequiresABoundedRectangularRgbaFrame", {});
}
const rgb = (color) => [color >>> 16, (color >>> 8) & 255, color & 255];
function box(values) {
  const sums = [0, 0, 0],
    squares = [0, 0, 0],
    min = [255, 255, 255],
    max = [0, 0, 0];
  let weight = 0;
  for (const value of values) {
    weight += value.n;
    for (let c = 0; c < 3; c++) {
      const n = value.rgb[c];
      sums[c] += n * value.n;
      squares[c] += n * n * value.n;
      min[c] = Math.min(min[c], n);
      max[c] = Math.max(max[c], n);
    }
  }
  const means = sums.map((sum) => Math.floor(sum / weight + 1e-10)),
    ranges = max.map((n, c) => n - min[c]);
  const score = sums.reduce(
    (n, sum, c) =>
      n +
      Math.max(
        0,
        squares[c] - 2 * means[c] * sum + means[c] * means[c] * weight,
      ),
    0,
  );
  return {
    values,
    weight,
    sums,
    means,
    axis: ranges.indexOf(Math.max(...ranges)),
    score,
  };
}

/** Retain full 24-bit precision until 65,536 distinct colors, then fold once
 * into a fixed RGB555 histogram. Every frame contributes without bitmap retention. */
class GIFPaletteBuilder {
  constructor() {
    this.exact = new Map();
    this.frames = 0;
    this.pixels = 0;
  }
  _bin(color, weight) {
    const r = color >>> 16,
      g = (color >>> 8) & 255,
      b = color & 255,
      key = ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3);
    this.weights[key] += weight;
    this.red[key] += r * weight;
    this.green[key] += g * weight;
    this.blue[key] += b * weight;
  }
  add(data, width) {
    validate(data, width);
    this.frames++;
    this.pixels += data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const color = colorOf(data, i);
      if (this.exact) {
        const old = this.exact.get(color);
        if (old !== undefined) this.exact.set(color, old + 1);
        else if (this.exact.size < MAX_COLORS) this.exact.set(color, 1);
        else {
          this.weights = new Float64Array(32768);
          this.red = new Float64Array(32768);
          this.green = new Float64Array(32768);
          this.blue = new Float64Array(32768);
          for (const [value, n] of this.exact) this._bin(value, n);
          this.exact = null;
          this._bin(color, 1);
        }
      } else this._bin(color, 1);
    }
  }
  finish() {
    let colors, exact;
    if (this.exact && this.exact.size <= 255) {
      colors = [...this.exact.keys()].map(rgb);
      exact = new Map([...this.exact.keys()].map((color, i) => [color, i + 1]));
    } else {
      const values = [];
      if (this.exact)
        for (const [color, n] of this.exact)
          values.push({ rgb: rgb(color), n });
      else
        for (let i = 0; i < 32768; i++)
          if (this.weights[i])
            values.push({
              rgb: [
                this.red[i] / this.weights[i],
                this.green[i] / this.weights[i],
                this.blue[i] / this.weights[i],
              ],
              n: this.weights[i],
            });
      const boxes = [box(values)];
      while (boxes.length < 255) {
        let at = -1,
          score = -1;
        for (let i = 0; i < boxes.length; i++)
          if (boxes[i].values.length > 1 && boxes[i].score > score) {
            at = i;
            score = boxes[i].score;
          }
        if (at < 0) break;
        const current = boxes[at],
          axis = current.axis;
        current.values.sort((a, b) => a.rgb[axis] - b.rgb[axis]);
        let cut = 0,
          n = 0;
        while (
          cut < current.values.length - 1 &&
          n <= Math.floor(current.weight / 2)
        )
          n += current.values[cut++].n;
        cut = Math.max(1, cut);
        boxes[at] = box(current.values.slice(0, cut));
        boxes.push(box(current.values.slice(cut)));
      }
      colors = boxes.map((value) => value.means);
    }
    const palette = new Uint8Array(768);
    colors.forEach((value, i) => palette.set(value, (i + 1) * 3));
    return {
      palette,
      colors,
      exact,
      stats: {
        frames: this.frames,
        pixels: this.pixels,
        colors: colors.length,
        histogram: this.exact ? "rgb24" : "rgb555",
        histogramEntries:
          this.exact?.size ??
          this.weights.reduce((n, w) => n + Number(w > 0), 0),
      },
    };
  }
}
function nearestLookup(colors) {
  const build = (indices) => {
    if (!indices.length) return null;
    const ranges = [0, 1, 2].map(
        (axis) =>
          Math.max(...indices.map((i) => colors[i][axis])) -
          Math.min(...indices.map((i) => colors[i][axis])),
      ),
      axis = ranges.indexOf(Math.max(...ranges));
    indices.sort((a, b) => colors[a][axis] - colors[b][axis]);
    const middle = indices.length >> 1,
      index = indices[middle];
    return {
      index,
      axis,
      color: colors[index],
      left: build(indices.slice(0, middle)),
      right: build(indices.slice(middle + 1)),
    };
  };
  const tree = build(colors.map((_, i) => i)),
    cache = new Map();
  let r, g, b, best, distance;
  const search = (node) => {
    if (!node) return;
    const c = node.color,
      d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < distance || (d === distance && node.index < best)) {
      distance = d;
      best = node.index;
    }
    const delta =
        (node.axis === 0 ? r : node.axis === 1 ? g : b) - c[node.axis],
      near = delta < 0 ? node.left : node.right,
      far = delta < 0 ? node.right : node.left;
    search(near);
    if (delta * delta <= distance) search(far);
  };
  return (red, green, blue) => {
    const key = (red << 16) | (green << 8) | blue,
      found = cache.get(key);
    if (found !== undefined) return found;
    r = red;
    g = green;
    b = blue;
    best = 0;
    distance = Infinity;
    search(tree);
    const value = best + 1;
    if (cache.size < MAX_COLORS) cache.set(key, value);
    return value;
  };
}
/** Sierra2 Lite follows Pivot's FFmpeg default scan and integer kernel. Color
 * errors stop at transparent pixels; binary alpha and existing white matte stay. */
function mapGIFPixels(
  data,
  width,
  plan,
  { dither = false, previous } = {},
) {
  validate(data, width);
  dither = normalizeGIFDither(dither);
  const count = data.length / 4,
    height = count / width,
    pixels = previous?.pixels ?? new Uint8Array(count);
  let left = 0,
    top = 0,
    right = width - 1,
    bottom = height - 1;
  if (previous) {
    if (previous.data.length !== data.length || pixels.length !== count)
      throw messageError(new Error(''), "errors.gifQuantize.previousGifFrameDimensionsChanged", {});
    left = width;
    top = height;
    right = bottom = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (
          data[i] === previous.data[i] &&
          data[i + 1] === previous.data[i + 1] &&
          data[i + 2] === previous.data[i + 2] &&
          data[i + 3] === previous.data[i + 3]
        )
          continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    if (right < 0) return { pixels, palette: plan.palette };
  }
  if (plan.exact) {
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const i = y * width + x;
        if (data[i * 4 + 3] < 128) {
          pixels[i] = 0;
          continue;
        }
        const index = plan.exact.get(colorOf(data, i * 4));
        if (index === undefined)
          throw messageError(new Error(''), "errors.gifQuantize.renderedGifColorsChangedBetweenPaletteAndEncoding", {});
        pixels[i] = index;
      }
    return { pixels, palette: plan.palette };
  }
  const nearest = (plan.nearest ??= nearestLookup(plan.colors));
  if (!dither) {
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const i = y * width + x;
        if (data[i * 4 + 3] < 128) {
          pixels[i] = 0;
          continue;
        }
        const color = colorOf(data, i * 4);
        pixels[i] = nearest(color >>> 16, (color >>> 8) & 255, color & 255);
      }
    return { pixels, palette: plan.palette };
  }
  let current = new Uint8ClampedArray(width * 3),
    next = new Uint8ClampedArray(width * 3);
  const fill = (row, y) => {
    if (y > bottom) return;
    for (let x = left; x <= right; x++) {
      const color = colorOf(data, (y * width + x) * 4),
        at = x * 3;
      row[at] = color >>> 16;
      row[at + 1] = (color >>> 8) & 255;
      row[at + 2] = color & 255;
    }
  };
  const spread = (row, x, y, er, eg, eb, divisor) => {
    if (
      x < left ||
      x > right ||
      y > bottom ||
      data[(y * width + x) * 4 + 3] < 128
    )
      return;
    const at = x * 3;
    row[at] += Math.trunc(er / divisor);
    row[at + 1] += Math.trunc(eg / divisor);
    row[at + 2] += Math.trunc(eb / divisor);
  };
  fill(current, top);
  fill(next, top + 1);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const pixel = y * width + x;
      if (data[pixel * 4 + 3] < 128) {
        pixels[pixel] = 0;
        continue;
      }
      const at = x * 3,
        r = current[at],
        g = current[at + 1],
        b = current[at + 2],
        index = nearest(r, g, b);
      pixels[pixel] = index;
      const target = plan.colors[index - 1],
        er = r - target[0],
        eg = g - target[1],
        eb = b - target[2];
      spread(current, x + 1, y, er, eg, eb, 2);
      spread(next, x - 1, y + 1, er, eg, eb, 4);
      spread(next, x, y + 1, er, eg, eb, 4);
    }
    [current, next] = [next, current];
    fill(next, y + 2);
  }
  return { pixels, palette: plan.palette };
}
function quantizeGIF(data, width, options = {}) {
  const builder = new GIFPaletteBuilder();
  builder.add(data, width);
  return mapGIFPixels(data, width, builder.finish(), options);
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
    throw messageError(new Error(''), "errors.imageCodecs.gifCompressionExceededItsBoundedOutputBuffer", {});
  const parts = [new Uint8Array([8])];
  for (let i = 0; i < position; i += 255) {
    const size = Math.min(255, position - i);
    parts.push(new Uint8Array([size]), out.subarray(i, i + size));
  }
  parts.push(new Uint8Array([0]));
  return parts;
}

const u16 = (n) => new Uint8Array([n & 255, n >>> 8]);
const text = new TextEncoder();
/** The bytes of an animated GIF of `frames` (RGBA, in order) with one palette built from all of them, as GIFEncoder wrote it. */
export function referenceAnimatedGIF(frames, {width, height, fps, loop = true, dither = false}) {
  const builder = new GIFPaletteBuilder();
  for (const frame of frames) builder.add(frame, width);
  const globalPalette = builder.finish(), parts = [];
  parts.push(text.encode("GIF89a"), u16(width), u16(height), new Uint8Array([0xf7, 0, 0]), globalPalette.palette);
  if (loop !== false) parts.push(new Uint8Array([0x21, 0xff, 11]), text.encode("NETSCAPE2.0"), new Uint8Array([3, 1, 0, 0, 0]));
  let previous;
  frames.forEach((rgba, index) => {
    const {pixels} = mapGIFPixels(rgba, width, globalPalette, {dither, previous});
    previous ??= {data: new Uint8ClampedArray(rgba.length)};
    previous.data.set(rgba);
    previous.pixels = pixels;
    const delay = Math.max(1, Math.round(((index + 1) * 100) / fps) - Math.round((index * 100) / fps));
    parts.push(new Uint8Array([0x21, 0xf9, 4, 9]), u16(delay), new Uint8Array([0, 0]), new Uint8Array([0x2c, 0, 0, 0, 0]), u16(width), u16(height), new Uint8Array([0]), ...lzw(pixels));
  });
  parts.push(new Uint8Array([0x3b]));
  return concat(parts);
}
/** One still GIF with its own palette, as a GIF sequence's frame was written. */
export function referenceStillGIF(rgba, {width, height, fps, dither = false}) {
  const {pixels, palette} = quantizeGIF(rgba, width, {dither});
  return concat([text.encode("GIF89a"), u16(width), u16(height), new Uint8Array([0xf0, 0, 0, 0, 0, 0, 255, 255, 255]),
    new Uint8Array([0x21, 0xf9, 4, 9]), u16(Math.max(1, Math.round(100 / fps))), new Uint8Array([0, 0]), new Uint8Array([0x2c, 0, 0, 0, 0]), u16(width), u16(height),
    new Uint8Array([0x87]), palette, ...lzw(pixels), new Uint8Array([0x3b])]);
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
