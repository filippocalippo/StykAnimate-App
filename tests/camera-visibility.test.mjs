import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveCamera} from '../src/pivot/background.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';
import {emptyDocument} from '../src/demo.mjs';

test('Camera visibility switches the frame camera on and off', () => {
  const report = emptyDocument(), frame = report.keyframes[0];
  frame._stykBackgroundColor = 0xffabcdef; frame.camera = {is_default: false, x: 50, y: 20, scale: 0.5, angle_rad: 0.4};
  report._styk.layers = {fixed: {scene: {visible: false}, camera: {visible: false}}};
  assert.equal(effectiveCamera(report, frame), null);
  assert.deepEqual(cameraMatrix({report, frame, view: {x: 10, y: 20, scale: 2}}), [2, 0, 0, 2, 10, 20]);
  report._styk.layers.fixed.camera.visible = true; assert.equal(effectiveCamera(report, frame), frame.camera);
  assert.equal(effectiveCamera(report, frame, false), null);
});
