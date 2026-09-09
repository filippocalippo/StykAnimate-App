import test from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/editor.mjs";
import { cameraIsIdentity } from "../src/pivot/background.mjs";
import { sampleAnimationChannel } from "../src/animation-channels.mjs";
import {
  cameraBakeFixture,
  sampleCameraBake,
  projectedCameraBake,
  channel,
} from "./camera-bake-fixture.mjs";

function near(a, b, message = "", epsilon = 0.002) {
  assert.ok(Math.abs(a - b) < epsilon, `${message}: ${a} != ${b}`);
}
function point(a, b, message) {
  near(a.x, b.x, message + " X");
  near(a.y, b.y, message + " Y");
}
function equivalent(a, b, tick) {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const [uid, before] of a) {
    const after = b.get(uid);
    point(before.root, after.root, `${tick} / ${uid} root`);
    for (const [i, [id, value]] of before.joints.entries()) {
      assert.equal(after.joints[i][0], id);
      point(value, after.joints[i][1], `${tick} / ${uid} joint ${id}`);
    }
    for (const [i, segment] of before.segments.entries()) {
      const saved = after.segments[i];
      point(segment.start, saved.start, `${tick} / ${uid} segment ${i} start`);
      point(segment.end, saved.end, `${tick} / ${uid} segment ${i} end`);
      near(segment.thickness, saved.thickness);
      assert.equal(segment.opacity, saved.opacity);
      assert.deepEqual(segment.rgb, saved.rgb);
      // Curves may use a different adaptive tessellation after uniform scaling;
      // exact native bend/length validation below also protects their shape.
    }
  }
}

test("independent layer, camera and scalar tracks retain all 24 projected frames; joined rigs are transformed once", () => {
  const editor = new Editor({ demo: false }).load(cameraBakeFixture());
  editor.seek(5);
  editor.select(2, 3);
  const report = editor.report,
    native = report.keyframes,
    sources = report._styk.frameSources,
    definitions = report.figure_types,
    background = report.backgrounds;
  const before = editor.serialize(),
    rawFrames = structuredClone(native),
    rawSources = structuredClone(sources),
    history = editor._undo.length,
    projected = Array.from({ length: editor.totalTicks }, (_, tick) =>
      projectedCameraBake(report, tick),
    );
  const allFrames = Array.from({ length: editor.totalTicks }, (_, tick) =>
    sampleCameraBake(report, tick),
  );
  const preserved = report._styk.animation.channels.filter(
    (value) =>
      value.property === "pose" ||
      ["opacity", "color"].includes(value.property),
  );
  const ticks = [0, 5, 6, 11, 12, 17, 23];
  assert.equal(editor.applyCameraToFigures(undefined, { ticks }), ticks.length);
  assert.equal(editor.tick, 5);
  assert.equal(editor.selectedUid, 2);
  assert.equal(editor.selectedJoint, 3);
  assert.equal(editor.totalTicks, 24);
  assert.equal(editor._undo.length, history + 1);
  assert.equal(editor._undo.at(-1).kind, "animation");
  assert.equal(report.keyframes, native);
  assert.equal(report._styk.frameSources, sources);
  assert.equal(report.figure_types, definitions);
  assert.equal(report.backgrounds, background);
  assert.deepEqual(report.keyframes, rawFrames);
  assert.deepEqual(report._styk.frameSources, rawSources);
  for (const value of preserved)
    assert.equal(
      report._styk.animation.channels.find((entry) => entry.id === value.id),
      value,
    );
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    equivalent(projected[tick], projectedCameraBake(report, tick), tick);
    const frame = sampleCameraBake(report, tick);
    if (ticks.includes(tick))
      assert.ok(cameraIsIdentity(frame.camera), `Camera ${tick} must reset`);
    else {
      for (const field of ["x", "y", "scale", "angle_rad"])
        near(
          frame.camera[field],
          allFrames[tick].camera[field],
          `unchanged camera ${tick} ${field}`,
          1e-9,
        );
      for (const object of frame.objects) {
        const original = allFrames[tick].objects.find(
          (value) => value.unique_id === object.unique_id,
        );
        for (const field of ["root_x", "root_y", "scale", "field28"])
          near(
            object[field],
            original[field],
            `unchanged ${tick} / ${object.unique_id} ${field}`,
            1e-9,
          );
        for (const key of ["angles", "lengths", "bends"])
          object[key].forEach((value, i) =>
            near(value, original[key][i], `unchanged ${tick} ${key}`, 1e-9),
          );
      }
    }
  }
  const after = editor.serialize();
  editor.undo();
  assert.deepEqual(editor.serialize(), before);
  editor.redo();
  assert.deepEqual(editor.serialize(), after);
});

test("native eased motion without scalar overrides resumes through passthrough guards instead of flattening poses", () => {
  const editor = new Editor({ demo: false }).load(
    cameraBakeFixture({ scalar: false, poses: false }),
  );
  const before = Array.from({ length: editor.totalTicks }, (_, tick) =>
    projectedCameraBake(editor.report, tick),
  );
  editor.seek(5);
  assert.equal(editor.applyCameraToFigures(undefined, { ticks: [5, 15] }), 2);
  const x = editor.animationChannel({ kind: "figure", uid: 1 }, "x");
  assert.equal(x.keys.find((key) => key.tick === 4).passthrough, true);
  assert.equal(x.keys.find((key) => key.tick === 6).passthrough, true);
  assert.equal(sampleAnimationChannel(x, 0), undefined);
  assert.equal(sampleAnimationChannel(x, 7), undefined);
  for (let tick = 0; tick < editor.totalTicks; tick++)
    equivalent(before[tick], projectedCameraBake(editor.report, tick), tick);
});

test("single inbetween conversion uses current displayed tick; range indices use selected native starts", () => {
  const editor = new Editor({ demo: false }).load(cameraBakeFixture());
  editor.seek(5);
  editor.applyCameraToFigures();
  assert.equal(editor.tick, 5);
  assert.deepEqual(
    editor
      .animationChannel({ kind: "figure", uid: 1 }, "scale")
      .keys.filter((key) => !key.passthrough)
      .map((key) => key.tick),
    [5],
  );
  editor.undo();
  editor.applyCameraToFigures([0, 2]);
  assert.deepEqual(
    editor
      .animationChannel({ kind: "figure", uid: 1 }, "scale")
      .keys.filter((key) => !key.passthrough)
      .map((key) => key.tick),
    [0, 16],
  );
});

test("sequential bakes retain prior guards and camera identity bakes create no history", () => {
  const editor = new Editor({ demo: false }).load(cameraBakeFixture()),
    before = Array.from({ length: 24 }, (_, tick) =>
      projectedCameraBake(editor.report, tick),
    );
  editor.applyCameraToFigures(undefined, { ticks: [5, 6] });
  editor.applyCameraToFigures(undefined, { ticks: [4, 7] });
  const count = editor._undo.length,
    after = editor.serialize();
  assert.equal(
    editor.applyCameraToFigures(undefined, { ticks: [4, 5, 6, 7] }),
    0,
  );
  assert.equal(editor._undo.length, count);
  assert.deepEqual(editor.serialize(), after);
  for (let tick = 0; tick < 24; tick++)
    equivalent(before[tick], projectedCameraBake(editor.report, tick), tick);
});

test("authored camera baking validates the full plan before publishing changes", () => {
  const editor = new Editor({ demo: false }).load(cameraBakeFixture()),
    before = editor.serialize(),
    count = editor._undo.length;
  for (const ticks of [[-1], [24], [1.5], [NaN]])
    assert.throws(
      () => editor.applyCameraToFigures(undefined, { ticks }),
      /whole display frames/,
    );
  assert.deepEqual(editor.serialize(), before);
  assert.equal(editor._undo.length, count);
  editor.report._styk.animation.channels.push(
    channel({ kind: "camera" }, "scale", [
      [0, 1],
      [23, 0.000001],
    ]),
  );
  editor._invalidate();
  editor.report.keyframes[2].objects.find(
    (object) => object.unique_id === 4,
  ).scale = 10;
  // An authored scale overrides any pose and becomes unsupported after the tiny camera's inverse.
  editor.report._styk.animation.channels.push(
    channel({ kind: "figure", uid: 4 }, "scale", [[0, 2]]),
  );
  editor._invalidate();
  const invalidPlan = editor.serialize(),
    undo = editor._undo.length;
  assert.throws(
    () => editor.applyCameraToFigures(undefined, { ticks: [0, 23] }),
    /scale.*range/i,
  );
  assert.deepEqual(editor.serialize(), invalidPlan);
  assert.equal(editor._undo.length, undo);
});

test("zero-scale figures and appearing/disappearing independent layers remain valid and sparse", () => {
  const report = cameraBakeFixture();
  report._styk.animation.channels.push(
    channel({ kind: "figure", uid: 4 }, "scale", [[0, 0]]),
  );
  const layer = report._styk.animation.channels.find(
    (value) => value.target.id === "layer-3",
  );
  layer.keys = channel(layer.target, "pose", [
    [0, "frame-1"],
    [8, null],
    [16, "frame-3"],
  ]).keys;
  const editor = new Editor({ demo: false }).load(report),
    before = Array.from({ length: 24 }, (_, tick) =>
      projectedCameraBake(editor.report, tick),
    );
  editor.applyCameraToFigures(undefined, { ticks: [3, 11, 19] });
  assert.equal(
    editor
      .animationChannel({ kind: "figure", uid: 3 }, "x")
      .keys.some((key) => key.tick === 11),
    false,
  );
  for (let tick = 0; tick < 24; tick++)
    equivalent(before[tick], projectedCameraBake(editor.report, tick), tick);
});

test("hidden camera is not transferred and does not change artwork or history", () => {
  const editor = new Editor({ demo: false }).load(cameraBakeFixture());
  editor.report._styk.layers.fixed.camera.visible = false;
  const before = editor.serialize(),
    count = editor._undo.length;
  assert.equal(editor.applyCameraToFigures(undefined, { ticks: [0, 5] }), 0);
  assert.deepEqual(editor.serialize(), before);
  assert.equal(editor._undo.length, count);
});
