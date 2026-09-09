import test from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/editor.mjs";
import {
  propertyStep,
  formatPropertyValue,
} from "../src/property-controls.mjs";
import { inspectorView } from "../src/inspector-view.mjs";

test("scrub modifiers preserve useful fractional units", () => {
  assert.equal(propertyStep(1), 1);
  assert.equal(propertyStep(1, { shiftKey: true }), 0.1);
  assert.equal(propertyStep(1, { altKey: true }), 0.01);
  assert.equal(propertyStep(1, { shiftKey: true, altKey: true }), 0.001);
  assert.equal(formatPropertyValue(23.10000001, 3), "23.1");
  assert.equal(formatPropertyValue(0.0004, 3), "0");
  assert.equal(formatPropertyValue(-0, 3), "0");
  assert.equal(formatPropertyValue(Infinity), "");
});

test("explicit inspector contexts isolate camera, scene, frame and layer controls", () => {
  const editor = new Editor();
  const camera = inspectorView({ editor, context: "camera" });
  for (const key of ["camera_x", "camera_y", "camera_scale", "camera_angle"])
    assert.ok(camera.includes(`data-property="${key}"`));
  for (const key of ["canvas_width", "duration", "root_x", "figure-color"])
    assert.ok(!camera.includes(key));
  const scene = inspectorView({ editor, context: "scene" });
  for (const key of [
    "canvas_width",
    "canvas_height",
    "background-color",
    "fps",
  ])
    assert.ok(scene.includes(key));
  for (const key of ["camera_x", "duration", "root_x"])
    assert.ok(!scene.includes(key));
  const frame = inspectorView({ editor, context: "frame" });
  assert.ok(frame.includes('data-property="duration"'));
  for (const key of ["camera_x", "canvas_width", "root_x", 'data-field="fps"'])
    assert.ok(!frame.includes(key));
  const layer = inspectorView({ editor, context: "layer" });
  for (const key of [
    "inspector-layer-name",
    "inspector-layer-visible",
    "inspector-layer-locked",
  ])
    assert.ok(layer.includes(key));
  assert.ok(!layer.includes("camera_x"));
  assert.ok(!layer.includes("canvas_width"));
  assert.ok(!layer.includes("root_x"));
});

test("composed property values preserve exact baselines and accessible key states", () => {
  const editor = new Editor();
  const html = inspectorView({
    editor,
    context: "camera",
    propertyState: (key) =>
      key === "camera_x"
        ? {
            value: 12.123456789,
            keyed: true,
            animated: true,
            previous: { tick: 0 },
            next: { tick: 20 },
          }
        : {},
  });
  assert.ok(html.includes('data-property-value="12.123456789"'));
  assert.ok(html.includes('value="12.123"'));
  assert.ok(html.includes('aria-pressed="true"'));
  assert.match(
    html,
    /data-property-nav="camera_x" data-direction="-1"[^>]*(?<!disabled)>/,
  );
  assert.ok(html.includes('aria-label="Remove X (px) keyframe"'));
});
