import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {geometryDefinition} from '../src/pivot/geometry-definition.mjs';
import {geometryFixture} from './geometry-cooperative-fixture.mjs';

test('definition plans traverse out-of-order parents and retain forward/reverse curved polygon edges', () => {
  const r = geometryFixture(), fig = r.figure_types[0];
  const plan = geometryDefinition(fig);
  assert.deepEqual(plan.order, [2, 0, 3, 1]);
  fig.polyfills[0].segment_ids = [7, 0, 2];
  const reversed = geometryDefinition(fig);
  assert.equal(reversed.polygons[0].edges[0].index, 2);
  assert.equal(reversed.polygons[0].edges[0].reverse, true);
  const geometry = buildGeometry(r, r.keyframes[0]), object = geometry.objects.get(0), curved = object.segments[2].points;
  assert.deepEqual(object.polys[0].points.slice(0, curved.length), [...curved].reverse());
});

test('shared mutable definitions rebuild on the next request and instance styles remain isolated', () => {
  const r = geometryFixture(), frame = r.keyframes[0], fig = r.figure_types[0];
  const original = buildGeometry(r, frame);
  fig.segments[2].parent_id = 999; fig.segments[2].length = 80;
  const changed = buildGeometry(r, frame);
  assert.notDeepEqual(changed.objects.get(0).segments[2].end, original.objects.get(0).segments[2].end);
  frame.objects[0]._stykStyle = {segments: {'7': {opacity: .25}}};
  const styled = buildGeometry(r, frame);
  assert.equal(styled.objects.get(0).segments[2].alpha, 1 - 191 / 255, 'Native opacity preserves byte quantization.');
  assert.equal(styled.objects.get(3).segments[2].alpha, 1 - 12 / 255);
  assert.equal(fig.segments[2].transparency, 12);
});

test('unreachable cyclic segments remain excluded with per-instance warnings', () => {
  const r = geometryFixture(), fig = r.figure_types[0];
  fig.segments[2].parent_id = 2;
  const geometry = buildGeometry(r, r.keyframes[0]);
  assert.equal(geometry.objects.get(0).segments.length, 0);
  assert.ok(geometry.warnings.includes('Cyclic segment hierarchy in object 0'));
  assert.ok(geometry.warnings.includes('Cyclic segment hierarchy in object 3'));
});
