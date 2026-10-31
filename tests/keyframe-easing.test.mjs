import test from 'node:test';
import assert from 'node:assert/strict';
import {easedProgress, cubicBezierProgress, keyEasing} from '../src/keyframe-easing.mjs';

const near = (actual, expected, epsilon = 1e-7) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);
const modes = ['auto', 'bezier', 'ease-in', 'ease-out', 'linear', 'constant'];
test('Bezier inverts time, presets are distinct, constant switches only at the next key', () => {
  // x(u)=u^3, y(u)=3u-3u²+u³: at x=.125, u=.5 and y=.875.
  near(cubicBezierProgress(.125, [0,1,0,1]), .875);
  near(easedProgress({interpolation:'ease-in'}, .5), .3153568125725393);
  near(easedProgress({interpolation:'ease-out'}, .5), .6846431874274608);
  near(easedProgress({interpolation:'bezier'}, .25), .1291619310473198);
  for (const interpolation of modes) {
    const key = {interpolation};
    assert.equal(easedProgress(key, -1), 0); assert.equal(easedProgress(key, 2), 1);
    let previous = 0;
    for (let i = 0; i <= 100; i++) { const value = easedProgress(key, i / 100); assert.ok(value >= previous && value <= 1); previous = value; }
  }
  assert.equal(easedProgress({interpolation:'constant'}, .999999), 0);
  assert.deepEqual(keyEasing({interpolation:'hold'}), {interpolation:'constant'});
});
