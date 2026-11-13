import {messageError} from './localized-error.mjs';
/**
 * Whole-animation adaptive GIF palette and bounded Sierra Lite diffusion (docs/gif-export.md).
 *
 * The pixels are read as 32-bit words (`pixelWords`): a run of equal pixels, which is most of a stick-figure frame,
 * costs one histogram update or one palette lookup, and two frames compare a word at a time. The histogram is an
 * insertion-ordered hash of its own instead of a Map. None of this changes a result: the palette, the indices and the
 * order of the colours are those of the per-pixel algorithm, which tests/fixtures/gif-reference.mjs keeps verbatim and
 * tests/gif-quantize.test.mjs compares with.
 */
import { normalizeGIFDither } from "./gif-options.mjs";
import { EXPORT_MAX_PIXELS } from "./export-sampling.mjs";
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
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/**
 * The RGBA bytes `data` as one word a pixel, red in the low byte and alpha in the high one: a view where the bytes
 * allow it, else a copy.
 */
export function pixelWords(data) {
  if (LITTLE_ENDIAN && data.byteOffset % 4 === 0)
    return new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  const words = new Uint32Array(data.length >> 2);
  for (let i = 0; i < words.length; i++)
    words[i] = (data[i * 4] | (data[i * 4 + 1] << 8) | (data[i * 4 + 2] << 16) | (data[i * 4 + 3] << 24)) >>> 0;
  return words;
}
/** The colour of the pixel word `word` at `i` (bytes `data`) over the white matte, as 0xRRGGBB; alpha is at least 128. */
const matteOf = (word, data, i) =>
  word >>> 24 === 255 ? ((word & 255) << 16) | (word & 0xff00) | ((word >>> 16) & 255) : colorOf(data, i * 4);
const rgb = (color) => [color >>> 16, (color >>> 8) & 255, color & 255];
const hash = (key, bits) => Math.imul(key, 0x9e3779b1) >>> (32 - bits);
/**
 * Median cut over `count` histogram entries (channels `red`, `green`, `blue` and weights `weight`, in histogram
 * order): up to 255 boxes, the box of the largest weighted variance split next (the first of equals), along its widest
 * channel (the first of equals), at its weighted median; a box is the mean of its entries. Each box is a range of one
 * order of the entries, sorted stably by the channel it is split on, and its sums are taken in that order, so the
 * means are exactly those of sorting and slicing arrays of entries. `integer`: every channel value is a whole number
 * from 0 to 255 (an exact histogram).
 */
function medianCut(red, green, blue, weight, count, integer) {
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  const channels = [red, green, blue];
  const measure = (start, end) => {
    let total = 0,
      s0 = 0, s1 = 0, s2 = 0,
      q0 = 0, q1 = 0, q2 = 0,
      min0 = 255, min1 = 255, min2 = 255,
      max0 = 0, max1 = 0, max2 = 0;
    for (let k = start; k < end; k++) {
      const id = order[k],
        n = weight[id],
        r = red[id],
        g = green[id],
        b = blue[id];
      total += n;
      s0 += r * n;
      q0 += r * r * n;
      min0 = Math.min(min0, r);
      max0 = Math.max(max0, r);
      s1 += g * n;
      q1 += g * g * n;
      min1 = Math.min(min1, g);
      max1 = Math.max(max1, g);
      s2 += b * n;
      q2 += b * b * n;
      min2 = Math.min(min2, b);
      max2 = Math.max(max2, b);
    }
    const m0 = Math.floor(s0 / total + 1e-10),
      m1 = Math.floor(s1 / total + 1e-10),
      m2 = Math.floor(s2 / total + 1e-10),
      r0 = max0 - min0,
      r1 = max1 - min1,
      r2 = max2 - min2,
      widest = Math.max(r0, r1, r2);
    const score =
      0 +
      Math.max(0, q0 - 2 * m0 * s0 + m0 * m0 * total) +
      Math.max(0, q1 - 2 * m1 * s1 + m1 * m1 * total) +
      Math.max(0, q2 - 2 * m2 * s2 + m2 * m2 * total);
    return { start, end, weight: total, means: [m0, m1, m2], axis: r0 === widest ? 0 : r1 === widest ? 1 : 2, score };
  };
  // Each channel's values as ranks among its distinct values: whole numbers in the same order, so a stable counting
  // sort orders a box as a stable comparison of the values would.
  const keys = channels.map((values) => {
    if (integer) return { rank: values, size: 256 };
    const ids = Array.from(order).sort((a, b) => values[a] - values[b]),
      rank = new Int32Array(count);
    let size = 0;
    ids.forEach((id, i) => { if (i && values[id] !== values[ids[i - 1]]) size++; rank[id] = size; });
    return { rank, size: size + 1 };
  });
  const tally = new Int32Array(Math.max(...keys.map((key) => key.size)) + 1),
    scratch = new Int32Array(count);
  const sortRange = (start, end, { rank, size }) => {
    if ((end - start) * 4 < size) {
      const ids = Array.from(order.subarray(start, end));
      ids.sort((a, b) => rank[a] - rank[b]);
      order.set(ids, start);
      return;
    }
    tally.fill(0, 0, size + 1);
    for (let k = start; k < end; k++) tally[rank[order[k]] + 1]++;
    for (let v = 1; v <= size; v++) tally[v] += tally[v - 1];
    for (let k = start; k < end; k++) scratch[start + tally[rank[order[k]]]++] = order[k];
    order.set(scratch.subarray(start, end), start);
  };
  const boxes = [measure(0, count)];
  while (boxes.length < 255) {
    let at = -1,
      score = -1;
    for (let i = 0; i < boxes.length; i++)
      if (boxes[i].end - boxes[i].start > 1 && boxes[i].score > score) {
        at = i;
        score = boxes[i].score;
      }
    if (at < 0) break;
    const { start, end, axis, weight: total } = boxes[at];
    sortRange(start, end, keys[axis]);
    const half = Math.floor(total / 2);
    let cut = 0,
      n = 0;
    while (cut < end - start - 1 && n <= half) n += weight[order[start + cut++]];
    cut = Math.max(1, cut);
    boxes[at] = measure(start, start + cut);
    boxes.push(measure(start + cut, end));
  }
  return boxes.map((value) => value.means);
}

/** Exact colour counts in the order each colour was first seen, at most MAX_COLORS of them. */
class ColorCounts {
  constructor() {
    this.slots = new Int32Array(MAX_COLORS * 2).fill(-1);
    this.colors = new Int32Array(MAX_COLORS);
    this.counts = new Float64Array(MAX_COLORS);
    this.size = 0;
  }
  /** Adds `n` to `color`'s count; false when the colour is new and the table is full. */
  add(color, n) {
    const mask = this.slots.length - 1;
    for (let slot = hash(color, 17); ; slot = (slot + 1) & mask) {
      const at = this.slots[slot];
      if (at < 0) {
        if (this.size === MAX_COLORS) return false;
        this.slots[slot] = this.size;
        this.colors[this.size] = color;
        this.counts[this.size++] = n;
        return true;
      }
      if (this.colors[at] === color) {
        this.counts[at] += n;
        return true;
      }
    }
  }
}

/** Retain full 24-bit precision until 65,536 distinct colors, then fold once
 * into a fixed RGB555 histogram. Every frame contributes without bitmap retention. */
export class GIFPaletteBuilder {
  constructor() {
    this.exact = new ColorCounts();
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
  /** Counts `n` pixels of `color`. Counts are whole numbers, so adding a run at once sums what pixel by pixel would. */
  _count(color, n) {
    if (!this.exact) return this._bin(color, n);
    if (this.exact.add(color, n)) return;
    this.weights = new Float64Array(32768);
    this.red = new Float64Array(32768);
    this.green = new Float64Array(32768);
    this.blue = new Float64Array(32768);
    const {colors, counts, size} = this.exact;
    for (let i = 0; i < size; i++) this._bin(colors[i], counts[i]);
    this.exact = null;
    this._bin(color, n);
  }
  add(data, width) {
    validate(data, width);
    this.frames++;
    this.pixels += data.length / 4;
    const words = pixelWords(data), count = words.length;
    for (let i = 0; i < count; ) {
      const word = words[i];
      let end = i + 1;
      while (end < count && words[end] === word) end++;
      if (word >>> 24 >= 128) this._count(matteOf(word, data, i), end - i);
      i = end;
    }
  }
  finish() {
    let colors, exact;
    if (this.exact && this.exact.size <= 255) {
      const keys = [...this.exact.colors.subarray(0, this.exact.size)];
      colors = keys.map(rgb);
      exact = new Map(keys.map((color, i) => [color, i + 1]));
    } else {
      let red, green, blue, weight, count;
      if (this.exact) {
        ({ size: count } = this.exact);
        red = new Float64Array(count);
        green = new Float64Array(count);
        blue = new Float64Array(count);
        weight = this.exact.counts.subarray(0, count);
        for (let i = 0; i < count; i++) {
          const color = this.exact.colors[i];
          red[i] = color >>> 16;
          green[i] = (color >>> 8) & 255;
          blue[i] = color & 255;
        }
      } else {
        const bins = [];
        for (let i = 0; i < 32768; i++) if (this.weights[i]) bins.push(i);
        count = bins.length;
        red = new Float64Array(count);
        green = new Float64Array(count);
        blue = new Float64Array(count);
        weight = new Float64Array(count);
        bins.forEach((bin, i) => {
          red[i] = this.red[bin] / this.weights[bin];
          green[i] = this.green[bin] / this.weights[bin];
          blue[i] = this.blue[bin] / this.weights[bin];
          weight[i] = this.weights[bin];
        });
      }
      colors = medianCut(red, green, blue, weight, count, Boolean(this.exact));
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
/**
 * The palette index (1-based) nearest to a colour: the least squared RGB distance, the lowest index among equals,
 * found in a k-d tree whose search visits every subtree that could hold an equal distance. Answers are kept for up
 * to MAX_COLORS colours.
 */
function nearestLookup(colors) {
  const count = colors.length,
    nodeIndex = new Int32Array(count),
    nodeAxis = new Uint8Array(count),
    nodeColor = new Int32Array(count * 3),
    nodeLeft = new Int32Array(count),
    nodeRight = new Int32Array(count);
  let nodes = 0;
  const build = (indices) => {
    if (!indices.length) return -1;
    const ranges = [0, 1, 2].map(
        (axis) =>
          Math.max(...indices.map((i) => colors[i][axis])) -
          Math.min(...indices.map((i) => colors[i][axis])),
      ),
      axis = ranges.indexOf(Math.max(...ranges));
    indices.sort((a, b) => colors[a][axis] - colors[b][axis]);
    const middle = indices.length >> 1,
      index = indices[middle],
      node = nodes++;
    nodeIndex[node] = index;
    nodeAxis[node] = axis;
    nodeColor.set(colors[index], node * 3);
    nodeLeft[node] = build(indices.slice(0, middle));
    nodeRight[node] = build(indices.slice(middle + 1));
    return node;
  };
  const tree = build(colors.map((_, i) => i)),
    cacheBits = 17,
    cacheMask = (1 << cacheBits) - 1,
    cacheKeys = new Int32Array(1 << cacheBits).fill(-1),
    cacheValues = new Uint8Array(1 << cacheBits);
  let cached = 0;
  let r, g, b, best, distance;
  const search = (node) => {
    const at = node * 3,
      cr = nodeColor[at],
      cg = nodeColor[at + 1],
      cb = nodeColor[at + 2],
      d = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb),
      index = nodeIndex[node];
    if (d < distance || (d === distance && index < best)) {
      distance = d;
      best = index;
    }
    const axis = nodeAxis[node],
      delta = axis === 0 ? r - cr : axis === 1 ? g - cg : b - cb,
      near = delta < 0 ? nodeLeft[node] : nodeRight[node],
      far = delta < 0 ? nodeRight[node] : nodeLeft[node];
    if (near >= 0) search(near);
    if (far >= 0 && delta * delta <= distance) search(far);
  };
  return (red, green, blue) => {
    const key = (red << 16) | (green << 8) | blue;
    let slot = hash(key, cacheBits);
    for (; cacheKeys[slot] >= 0; slot = (slot + 1) & cacheMask)
      if (cacheKeys[slot] === key) return cacheValues[slot];
    r = red;
    g = green;
    b = blue;
    best = 0;
    distance = Infinity;
    search(tree);
    const value = best + 1;
    if (cached < MAX_COLORS) {
      cacheKeys[slot] = key;
      cacheValues[slot] = value;
      cached++;
    }
    return value;
  };
}
/** The rectangle of pixels that differ between two frames of `width` (pixel words), or null when none does. */
export function changedRect(words, before, width, height) {
  let left = width,
    top = -1,
    right = -1,
    bottom = -1;
  for (let y = 0, row = 0; y < height; y++, row += width) {
    let x = 0;
    while (x < width && words[row + x] === before[row + x]) x++;
    if (x === width) continue;
    if (top < 0) top = y;
    bottom = y;
    if (x < left) left = x;
    let end = width - 1;
    while (end > right && words[row + end] === before[row + end]) end--;
    if (end > right) right = end;
  }
  return top < 0 ? null : { left, top, right, bottom };
}
/** Sierra2 Lite follows Pivot's FFmpeg default scan and integer kernel. Color
 * errors stop at transparent pixels; binary alpha and existing white matte stay. */
export function mapGIFPixels(
  data,
  width,
  plan,
  { dither = false, previous } = {},
) {
  validate(data, width);
  dither = normalizeGIFDither(dither);
  const count = data.length / 4,
    height = count / width,
    pixels = previous?.pixels ?? new Uint8Array(count),
    words = pixelWords(data);
  let left = 0,
    top = 0,
    right = width - 1,
    bottom = height - 1;
  if (previous) {
    if (previous.data.length !== data.length || pixels.length !== count)
      throw messageError(new Error(''), "errors.gifQuantize.previousGifFrameDimensionsChanged", {});
    const changed = changedRect(words, previous.words ?? pixelWords(previous.data), width, height);
    if (!changed) return { pixels, palette: plan.palette };
    ({ left, top, right, bottom } = changed);
  }
  if (plan.exact || !dither) {
    // One lookup a run of equal pixels: the index is a function of the pixel alone.
    const lookup = plan.exact
      ? (word, i) => {
          const index = plan.exact.get(matteOf(word, data, i));
          if (index === undefined)
            throw messageError(new Error(''), "errors.gifQuantize.renderedGifColorsChangedBetweenPaletteAndEncoding", {});
          return index;
        }
      : ((nearest) => (word, i) => {
          const color = matteOf(word, data, i);
          return nearest(color >>> 16, (color >>> 8) & 255, color & 255);
        })((plan.nearest ??= nearestLookup(plan.colors)));
    let last = -1,
      index = 0;
    for (let y = top; y <= bottom; y++)
      for (let x = left, i = y * width + left; x <= right; x++, i++) {
        const word = words[i];
        if (word !== last) {
          last = word;
          index = word >>> 24 < 128 ? 0 : lookup(word, i);
        }
        pixels[i] = index;
      }
    return { pixels, palette: plan.palette };
  }
  const nearest = (plan.nearest ??= nearestLookup(plan.colors)),
    colors = plan.colors;
  let current = new Uint8ClampedArray(width * 3),
    next = new Uint8ClampedArray(width * 3);
  const fill = (row, y) => {
    if (y > bottom) return;
    for (let x = left, i = y * width + left; x <= right; x++, i++) {
      const color = matteOf(words[i], data, i),
        at = x * 3;
      row[at] = color >>> 16;
      row[at + 1] = (color >>> 8) & 255;
      row[at + 2] = color & 255;
    }
  };
  fill(current, top);
  fill(next, top + 1);
  for (let y = top; y <= bottom; y++) {
    const below = y + 1 <= bottom ? (y + 1) * width : -1;
    for (let x = left; x <= right; x++) {
      const pixel = y * width + x;
      if (words[pixel] >>> 24 < 128) {
        pixels[pixel] = 0;
        continue;
      }
      const at = x * 3,
        r = current[at],
        g = current[at + 1],
        b = current[at + 2],
        index = nearest(r, g, b);
      pixels[pixel] = index;
      const target = colors[index - 1],
        er = r - target[0],
        eg = g - target[1],
        eb = b - target[2];
      if (er === 0 && eg === 0 && eb === 0) continue;
      // Errors spread right (half) and to the two pixels below (a quarter each), never past the rectangle
      // or into a transparent pixel; each share is truncated toward zero.
      if (x + 1 <= right && words[pixel + 1] >>> 24 >= 128) {
        current[at + 3] += Math.trunc(er / 2);
        current[at + 4] += Math.trunc(eg / 2);
        current[at + 5] += Math.trunc(eb / 2);
      }
      if (below >= 0) {
        if (x - 1 >= left && words[below + x - 1] >>> 24 >= 128) {
          next[at - 3] += Math.trunc(er / 4);
          next[at - 2] += Math.trunc(eg / 4);
          next[at - 1] += Math.trunc(eb / 4);
        }
        if (words[below + x] >>> 24 >= 128) {
          next[at] += Math.trunc(er / 4);
          next[at + 1] += Math.trunc(eg / 4);
          next[at + 2] += Math.trunc(eb / 4);
        }
      }
    }
    [current, next] = [next, current];
    fill(next, y + 2);
  }
  return { pixels, palette: plan.palette };
}
export function quantizeGIF(data, width, options = {}) {
  const builder = new GIFPaletteBuilder();
  builder.add(data, width);
  return mapGIFPixels(data, width, builder.finish(), options);
}
