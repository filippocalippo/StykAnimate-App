import test from "node:test";
import assert from "node:assert/strict";
import {
  exportSamplingSize,
  normalizeExportSmoothing,
  EXPORT_SMOOTHING,
} from "../src/export-sampling.mjs";

test("pixel sampling preserves requested output dimensions with bounded 2× sprites", () => {
  assert.deepEqual(
    EXPORT_SMOOTHING.map((item) => item.value),
    ["edges", "none", "sprites"],
  );
  for (const mode of ["edges", "none", "sprites"]) {
    const spec = exportSamplingSize(600, 340, mode);
    assert.deepEqual([spec.width, spec.height], [600, 340]);
    assert.deepEqual(
      [spec.renderWidth, spec.renderHeight],
      mode === "sprites" ? [1200, 680] : [600, 340],
    );
  }
  assert.equal(exportSamplingSize(8192, 1024, "sprites").renderWidth, 16384);
  assert.equal(exportSamplingSize(16384, 1, "edges").renderWidth, 16384);
});
test("invalid modes and unsafe output/intermediate surfaces reject before allocation", () => {
  for (const mode of ["high", "", null, 2])
    assert.throws(() => normalizeExportSmoothing(mode));
  for (const [w, h] of [
    [0, 1],
    [1, -1],
    [1.1, 1],
    [Infinity, 2],
    [16385, 1],
    [8192, 8192],
  ])
    assert.throws(() => exportSamplingSize(w, h));
  assert.throws(() => exportSamplingSize(8193, 1, "sprites"), /8,192/);
});
