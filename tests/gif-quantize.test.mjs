import test from "node:test";
import assert from "node:assert/strict";
import {
  GIFPaletteBuilder,
  mapGIFPixels,
  quantizeGIF,
} from "../src/gif-quantize.mjs";
import { defaultGIFDither, normalizeGIFDither } from "../src/gif-options.mjs";
import { gifFixture } from "./gif-fixtures.mjs";
test("native automatic dither defaults distinguish solid drawings and image/gradient assets", () => {
  assert.equal(
    defaultGIFDither({
      backgrounds: [{ kind: 2, color: 0xffffffff }],
      figure_types: [{ segments: [{ primitive_code: 0 }] }],
    }),
    false,
  );
  for (const background of [
    { kind: 1, color: 0xffffffff },
    { kind: 3 },
    { kind: 4 },
    { kind: 1, data_url: "data:image/png;base64,x" },
  ])
    assert.equal(defaultGIFDither({ backgrounds: [background] }), true);
  assert.equal(
    defaultGIFDither({ figure_types: [{ image_assets: [{}] }] }),
    true,
  );
  assert.equal(
    defaultGIFDither({ figure_types: [{ segments: [{ primitive_code: 2 }] }] }),
    true,
  );
  assert.equal(normalizeGIFDither(), false);
  assert.throws(() => normalizeGIFDither("yes"));
});
test("animation palette preserves all exact colors and binary alpha across frames", () => {
  const a = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]),
    b = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 0, 0]);
  const build = new GIFPaletteBuilder();
  build.add(a, 2);
  build.add(b, 2);
  const plan = build.finish();
  assert.equal(plan.colors.length, 2);
  for (const dither of [false, true])
    for (const source of [a, b]) {
      const output = mapGIFPixels(source, 2, plan, { dither });
      assert.equal(output.pixels[1], 0);
      assert.deepEqual(
        [
          ...output.palette.slice(
            output.pixels[0] * 3,
            output.pixels[0] * 3 + 3,
          ),
        ],
        [...source.slice(0, 3)],
      );
    }
});
test("full-precision adaptive palette uses255 grayscale colors instead of RGB555 bands", () => {
  const source = gifFixture("grayscale", 256, 4),
    builder = new GIFPaletteBuilder();
  builder.add(source, 256);
  const plan = builder.finish();
  assert.equal(plan.colors.length, 255);
  assert.equal(plan.stats.histogram, "rgb24");
  const output = mapGIFPixels(source, 256, plan);
  let error = 0;
  for (let i = 0; i < output.pixels.length; i++)
    error += Math.abs(output.palette[output.pixels[i] * 3] - source[i * 4]);
  assert.ok(error / output.pixels.length < 0.01);
});
test("Sierra Lite changes rich quantization without mutating input or alpha mask", () => {
  const source = gifFixture("sprite", 160, 128),
    before = source.slice();
  const builder = new GIFPaletteBuilder();
  builder.add(source, 160);
  const plan = builder.finish();
  const off = mapGIFPixels(source, 160, plan, { dither: false }),
    on = mapGIFPixels(source, 160, plan, { dither: true });
  assert.deepEqual(source, before);
  assert.ok(on.pixels.some((n, i) => n !== off.pixels[i]));
  for (let i = 0; i < on.pixels.length; i++)
    assert.equal(on.pixels[i] === 0, source[i * 4 + 3] < 128);
  assert.deepEqual(
    mapGIFPixels(source, 160, plan, { dither: true }).pixels,
    on.pixels,
  );
});
test("changed rectangle keeps every unchanged exterior index stable and clears new holes", () => {
  const first = gifFixture("gradient", 192, 96),
    second = gifFixture("gradient", 192, 96, 1);
  second.fill(0, (42 * 192 + 105) * 4, (42 * 192 + 109) * 4);
  const builder = new GIFPaletteBuilder();
  builder.add(first, 192);
  builder.add(second, 192);
  const plan = builder.finish();
  const previous = mapGIFPixels(first, 192, plan, { dither: true }).pixels,
    snapshot = previous.slice();
  const output = mapGIFPixels(second, 192, plan, {
    dither: true,
    previous: { data: first, pixels: previous },
  });
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 192; x++)
      if (x < 101 || x >= 115 || y < 37 || y >= 49)
        assert.equal(output.pixels[y * 192 + x], snapshot[y * 192 + x]);
  assert.equal(output.pixels[42 * 192 + 106], 0);
});
test("palette histogram and nearest mapping bounds reject malformed frame shapes", () => {
  assert.throws(() => quantizeGIF(new Uint8ClampedArray(7), 2));
  assert.throws(() => quantizeGIF(new Uint8ClampedArray(0), 1));
  const source = new Uint8ClampedArray(66000 * 4);
  for (let i = 0; i < 66000; i++)
    source.set([i >>> 16, (i >>> 8) & 255, i & 255, 255], i * 4);
  const builder = new GIFPaletteBuilder();
  builder.add(source, 1000);
  const plan = builder.finish();
  assert.equal(plan.stats.histogram, "rgb555");
  assert.ok(plan.stats.histogramEntries <= 32768);
  assert.equal(plan.colors.length, 255);
});

test("the existing alpha128 cutoff and white matte remain independent of dithering", () => {
  const source = new Uint8ClampedArray([
    100, 50, 20, 0, 100, 50, 20, 127, 100, 50, 20, 128, 100, 50, 20, 255,
  ]);
  for (const dither of [false, true]) {
    const output = quantizeGIF(source, 4, { dither });
    assert.deepEqual([...output.pixels.slice(0, 2)], [0, 0]);
    assert.deepEqual(
      [...output.palette.slice(output.pixels[2] * 3, output.pixels[2] * 3 + 3)],
      [177, 152, 137],
    );
    assert.deepEqual(
      [...output.palette.slice(output.pixels[3] * 3, output.pixels[3] * 3 + 3)],
      [100, 50, 20],
    );
  }
});

test("the encoder writes the bytes of the per-pixel reference for every kind of frame", async () => {
  const { GIFEncoder } = await import("../src/image-codecs.mjs");
  const { referenceAnimatedGIF, referenceStillGIF } = await import("./fixtures/gif-reference.mjs");
  // Frames that move (a changed rectangle), stand still, lose pixels to transparency and carry partial alpha.
  const animation = (kind, width, height) => {
    const frames = [gifFixture(kind, width, height), gifFixture(kind, width, height, 1), gifFixture(kind, width, height, 1)];
    const last = gifFixture(kind, width, height, 1);
    last.fill(0, (5 * width + 3) * 4, (9 * width + 40) * 4);
    for (let i = 3; i < last.length; i += 4 * 7) last[i] = 140 + (i % 97);
    frames.push(last);
    return frames;
  };
  // More than 65,536 colours: the histogram folds into RGB555 bins part of the way through.
  const rich = [0, 1].map((frame) => {
    const data = new Uint8ClampedArray(320 * 240 * 4);
    for (let i = 0; i < 320 * 240; i++) data.set([(i * 7 + frame) & 255, (i >>> 3) & 255, (i * 13) >>> 8 & 255, 255], i * 4);
    return data;
  });
  const cases = [
    ["gradient", animation("gradient", 128, 56), 128, 56],
    ["sprite", animation("sprite", 160, 64), 160, 64],
    ["grayscale", animation("grayscale", 256, 52), 256, 52],
    ["rich", rich, 320, 240],
  ];
  for (const [name, frames, width, height] of cases)
    for (const dither of [false, true]) {
      const builder = new GIFPaletteBuilder();
      for (const frame of frames) builder.add(frame, width);
      const gif = new GIFEncoder({ width, height, fps: 24, totalFrames: frames.length, loop: true, dither, maxBytes: 64 << 20, palette: builder.finish() });
      for (const frame of frames) gif.add(frame);
      const bytes = new Uint8Array(await gif.finish().arrayBuffer());
      assert.deepEqual(bytes, referenceAnimatedGIF(frames, { width, height, fps: 24, dither }), `${name}, dither ${dither}`);
      const still = new GIFEncoder({ width, height, fps: 24, totalFrames: 1, loop: false, dither, maxBytes: 64 << 20 });
      still.add(frames[3] ?? frames[1]);
      assert.deepEqual(new Uint8Array(await still.finish().arrayBuffer()), referenceStillGIF(frames[3] ?? frames[1], { width, height, fps: 24, dither }), `${name} still, dither ${dither}`);
    }
});

test("frames encoded on helpers, answering out of order, give the bytes of the encoder going frame by frame", async () => {
  const { GIFEncoder } = await import("../src/image-codecs.mjs");
  const { GIFFrames, helperFrame } = await import("../src/gif-frames.mjs");
  // A helper that answers after a delay of its own, so later frames often come back first.
  class Helper {
    constructor(delay) { this.delay = delay; }
    postMessage(message) {
      if (message.operation === "plan") { this.plan = structuredClone(message.plan); this.dither = message.dither; return; }
      const answer = helperFrame(this.plan, this.dither, structuredClone(message));
      setTimeout(() => this.onmessage({ data: { id: message.id, ok: true, ...answer } }), this.delay);
    }
    terminate() { this.ended = true; }
  }
  const width = 160, height = 64, still = gifFixture("sprite", width, height, 1);
  const frames = [gifFixture("sprite", width, height), still, still.slice(), gifFixture("sprite", width, height), still.slice()];
  frames[4].fill(0, (10 * width + 3) * 4, (12 * width + 90) * 4);
  for (const dither of [false, true]) {
    const builder = new GIFPaletteBuilder();
    for (const frame of frames) builder.add(frame, width);
    const plan = builder.finish(), options = { width, height, fps: 24, totalFrames: frames.length, loop: true, dither, maxBytes: 64 << 20 };
    const serial = new GIFEncoder({ ...options, palette: plan });
    for (const frame of frames) serial.add(frame);
    const parallel = new GIFEncoder({ ...options, palette: plan }), helpers = [new Helper(12), new Helper(1)];
    const queue = new GIFFrames(parallel, plan, { width, height, dither, helpers });
    for (const frame of frames) await queue.push(frame.slice());
    await queue.flush();
    queue.close();
    assert.ok(helpers.every((helper) => helper.ended));
    assert.deepEqual(new Uint8Array(await parallel.finish().arrayBuffer()), new Uint8Array(await serial.finish().arrayBuffer()), `dither ${dither}`);
  }
});
