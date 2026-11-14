import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultKnee, positionPercent, positionToValue, scaleOf, valueToPosition} from '../src/ui/value-scale.mjs';

// The value field's travel (src/ui/value-scale.mjs): where a value sits and back, on every scale.
const RANGES = [
  {name: 'a particle count', scale: 'log', min: 1, max: 5000, step: 1},
  {name: 'an emitter size', scale: 'log', min: 0, max: 4000, step: 1},
  {name: 'a particle size', scale: 'log', min: 0.5, max: 400, step: 0.5},
  {name: 'a start delay', scale: 'pow', min: 0, max: 600, step: 1},
  {name: 'a radius', scale: 'linear', min: 0, max: 128, step: 1},
  {name: 'an offset', scale: 'linear', min: -256, max: 256, step: 1},
];

test('every scale gives a value back from its position (round trip)', () => {
  for (const range of RANGES) {
    for (let i = 0; i <= 64; i++) {
      const value = range.min + (range.max - range.min) * (i / 64) ** 3;
      const back = positionToValue(valueToPosition(value, range), range);
      assert.ok(Math.abs(back - value) <= 1e-9 * Math.max(1, Math.abs(value)), `${range.name}: ${value} came back as ${back}`);
    }
  }
});

test('positions run from 0 at the minimum to 1 at the maximum, always increasing', () => {
  for (const range of RANGES) {
    assert.equal(valueToPosition(range.min, range), 0, range.name);
    assert.equal(valueToPosition(range.max, range), 1, range.name);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const position = valueToPosition(range.min + (range.max - range.min) * i / 100, range);
      assert.ok(position > previous, `${range.name} at ${i}%`);
      previous = position;
    }
    assert.equal(positionToValue(0, range), range.min);
    assert.equal(positionToValue(1, range), range.max);
  }
});

test('values and positions outside the range are held at its ends', () => {
  const range = RANGES[0];
  assert.equal(valueToPosition(-10, range), 0);
  assert.equal(valueToPosition(1e9, range), 1);
  assert.equal(positionToValue(-0.5, range), range.min);
  assert.equal(positionToValue(3, range), range.max);
  assert.equal(valueToPosition(Number.NaN, range), 0);
  assert.equal(valueToPosition(5, {min: 2, max: 2}), 0, 'an empty range has no travel');
});

test('a non-linear scale gives the useful part of a wide range most of the travel', () => {
  // Today's linear sliders put a count of 40 at 0.8% of the travel and a 6 px particle at 1.4%.
  assert.ok(valueToPosition(40, RANGES[0]) > 0.3, 'a count of 40 sits well into the travel');
  assert.ok(valueToPosition(6, RANGES[2]) > 0.3, 'a 6 px particle sits well into the travel');
  assert.ok(valueToPosition(100, RANGES[1]) > 0.3, 'a 100 px emitter sits well into the travel');
  assert.ok(valueToPosition(24, RANGES[3]) > 0.15, 'a one-second delay is not squeezed against zero');
  // The bottom stays reachable: the first pixel of a 200 px field moves a log count by less than one.
  assert.ok(positionToValue(1 / 200, RANGES[0]) - RANGES[0].min < 1);
});

test('scales are made whole: unknown kinds are linear, knees and exponents have defaults', () => {
  assert.equal(scaleOf({scale: 'cubic', min: 0, max: 1}).scale, 'linear');
  assert.equal(scaleOf({scale: 'log', min: 0, max: 4000}).knee, 4);
  assert.equal(scaleOf({scale: 'log', min: 0, max: 10, step: 0.5}).knee, 0.5);
  assert.equal(scaleOf({scale: 'pow', min: 0, max: 1}).exponent, 2);
  assert.equal(defaultKnee(0, 2000), 2);
  assert.equal(positionPercent(0.375), '37.5%');
  assert.equal(positionPercent(2), '100%');
});
