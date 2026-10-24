import test from 'node:test';
import assert from 'node:assert/strict';
import {drawBackground, sceneBackgroundColor, effectiveCamera, backgroundBounds} from '../src/pivot/background.mjs';
import {cameraMatrix} from '../src/renderer-geometry.mjs';
import {emptyDocument} from '../src/demo.mjs';

test('Canvas scene color replaces the native background/crossfade, retaining ARGB alpha and numeric zero', () => {
  const report = emptyDocument(), frame = report.keyframes[0], calls = [];
  report.backgrounds = [{background_id: 1, kind: 1, data_url: 'broken-image'}]; frame.background_id = 1; frame.background_mix = 200;
  const context = {save() {}, restore() {}, fillRect(...args) { calls.push({style: this.fillStyle, args}); }};
  for (const [color, style] of [[0xff123456, 'rgba(18,52,86,1)'], [0x80123456, 'rgba(18,52,86,0.5019607843137255)'], [0, 'rgba(0,0,0,0)']]) {
    frame._stykBackgroundColor = color; calls.length = 0;
    drawBackground(context, report, frame, 20, 10, {image() { throw new Error('Overridden image must not be requested.'); }});
    assert.deepEqual(calls, [{style, args: [0, 0, 20, 10]}]);
  }
});
test('Scene visibility and Camera visibility use separate fixed-layer semantics', () => {
  const report = emptyDocument(), frame = report.keyframes[0];
  frame._stykBackgroundColor = 0xffabcdef; frame.camera = {is_default: false, x: 50, y: 20, scale: 0.5, angle_rad: 0.4};
  report._styk.layers = {fixed: {scene: {visible: false}, camera: {visible: false}}};
  assert.equal(sceneBackgroundColor(report, frame), 0); assert.equal(effectiveCamera(report, frame), null);
  assert.deepEqual(cameraMatrix({report, frame, view: {x: 10, y: 20, scale: 2}}), [2, 0, 0, 2, 10, 20]);
  assert.deepEqual(backgroundBounds(frame, 960, 540, true, report), {x: 0, y: 0, width: 960, height: 540, clearRaster: false});
  report._styk.layers.fixed.scene.visible = true; assert.equal(sceneBackgroundColor(report, frame), 0xffabcdef);
  report._styk.layers.fixed.camera.visible = true; assert.equal(effectiveCamera(report, frame), frame.camera);
  assert.equal(effectiveCamera(report, frame, false), null);
});
