import test from 'node:test';
import assert from 'node:assert/strict';
import {gradientAngleFromBackground} from '../src/pivot/background.mjs';

test('gradient editor restores normalized linear angle without modifying endpoints', () => {
  for (const angle of [0, 30, 90, 180, 225, 270, 359]) {
    const radians = angle * Math.PI / 180, background = {kind: 3, x1: 0.5 - Math.cos(radians) / 2, y1: 0.5 - Math.sin(radians) / 2,
      x2: 0.5 + Math.cos(radians) / 2, y2: 0.5 + Math.sin(radians) / 2};
    const before = structuredClone(background);
    assert.ok(Math.abs(gradientAngleFromBackground(background) - angle) < 1e-9);
    assert.deepEqual(background, before);
  }
});

test('radial, missing, malformed or zero-length gradients use the documented UI default', () => {
  for (const background of [null, {kind: 4}, {kind: 3}, {kind: 3, x1: 1, y1: 1, x2: 1, y2: 1}, {kind: 3, x1: NaN, y1: 0, x2: 1, y2: 1}])
    assert.equal(gradientAngleFromBackground(background), 90);
  assert.equal(gradientAngleFromBackground(null, 45), 45);
});
