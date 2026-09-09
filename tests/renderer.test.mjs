import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileVectorObject, adoptPreparedVectors, shapeRecord, SHAPE_FLOATS, SHAPE, worldToScreen, screenToWorld, requiresCompatibilityTexture, objectBounds } from '../src/renderer-geometry.mjs';
import { compilePlaybackPacket } from '../src/playback-worker.mjs';
import { buildGeometry } from '../src/pivot/geometry.mjs';
import { defaultFigure, createObject, createFrame } from '../src/demo.mjs';

const figure = defaultFigure(), object = createObject(figure, 42, 200, 240), frame = createFrame([object]);
const report = { version: 5, canvas_width: 960, canvas_height: 540, figure_types: [figure], keyframes: [frame] };

test('editing adopts exact worker vector records without retaining packet buffers', async () => {
  const packet = await compilePlaybackPacket(report, 0), geometry = buildGeometry(report, frame);
  const vectors = new WeakMap(), compatibility = new WeakMap(), original = packet.shapes.slice();
  const adopted = adoptPreparedVectors(packet, geometry, vectors, compatibility), g = geometry.objects.get(0);
  assert.equal(adopted.objects, 1); assert.equal(adopted.bytes, packet.shapes.byteLength);
  assert.deepEqual(vectors.get(g), compileVectorObject(g.drawables, g.root));
  assert.equal(compatibility.get(g), false); assert.notEqual(vectors.get(g).buffer, packet.shapes.buffer);
  assert.deepEqual(packet.shapes, original, 'Adoption must preserve cached playback transform indices.');
  assert.equal(adoptPreparedVectors(packet, geometry, vectors, compatibility).objects, 0);
});

test('editing adoption rejects mismatched object descriptors and keeps complex objects on editor rasterization', async () => {
  const packet = await compilePlaybackPacket(report, 0);
  for (const change of [p => p.groups[0].uid++, p => p.transforms[4]++, p => p.groups[0].instanceCount++, p => p.shapes[21]++]) {
    const copy = structuredClone(packet); change(copy);
    const vectors = new WeakMap(), geometry = buildGeometry(report, frame);
    assert.equal(adoptPreparedVectors(copy, geometry, vectors, new WeakMap()).objects, 0);
    assert.equal(vectors.has(geometry.objects.get(0)), false);
  }
  const complexReport = structuredClone(report); complexReport.figure_types[0].segments[0].bend_rad = .2;
  complexReport.figure_types[0].segments[0].transparency = 128;
  const complex = await compilePlaybackPacket(complexReport, 0), geometry = buildGeometry(complexReport, complexReport.keyframes[0]);
  const vectors = new WeakMap(), compatibility = new WeakMap();
  adoptPreparedVectors(complex, geometry, vectors, compatibility);
  assert.equal(vectors.has(geometry.objects.get(0)), false); assert.equal(compatibility.get(geometry.objects.get(0)), true);
});
test('camera coordinate conversion round trips a rotated, translated, zoomed view', () => {
  const options = { report, frame: { camera: { x: 84, y: -73, scale: .7, angle_rad: .63 } }, view: { x: 124, y: 92, scale: 1.43 } };
  const point = { x: -63.2, y: 498.12 }, screen = worldToScreen(point, options), inverse = screenToWorld(screen, options);
  assert.ok(Math.abs(point.x - inverse.x) < 1e-9); assert.ok(Math.abs(point.y - inverse.y) < 1e-9);
});
test('background clipping occupies the existing record flag without changing packet size', () => {
  const figure = shapeRecord({ mode: SHAPE.RECT }), background = shapeRecord({ mode: SHAPE.RECT, clipToCanvas: true });
  assert.equal(figure.length, SHAPE_FLOATS); assert.equal(background.length, SHAPE_FLOATS);
  assert.deepEqual(figure.slice(0, -1), background.slice(0, -1));
  assert.equal(figure[23], 0); assert.equal(background[23], 1);
});
test('figure geometry compiles to finite, root-local GPU vector instances', () => {
  const geometry = buildGeometry(report, frame), g = geometry.objects.get(0), compiled = compileVectorObject(geometry.drawables, g.root, 7);
  assert.equal(compiled.length % SHAPE_FLOATS, 0);
  assert.ok(compiled.every(Number.isFinite));
  assert.equal(compiled[0], 0); assert.equal(compiled[1], 0);
  assert.equal(compiled[21], 7);
  assert.ok(compiled.length / SHAPE_FLOATS > figure.segments.length, 'hollow circles include a white interior and ring');
  assert.equal(requiresCompatibilityTexture(geometry.drawables), false);
});
test('incremental geometry exposes ordered groups and bounded invalidation metadata', () => {
  const a = structuredClone(frame), initial = buildGeometry(report, a);
  a.objects[0].angles[0] += .1;
  const updated = buildGeometry(report, a, {previous: initial, dirtySlots: [0]});
  assert.equal(updated.previousToken, initial.token); assert.notEqual(updated.token, initial.token);
  assert.deepEqual([...updated.changedSlots], [0]); assert.equal(updated.orderedObjects[0], updated.objects.get(0));
  assert.deepEqual(updated.drawables, buildGeometry(report, a).drawables);
  assert.equal(updated.previous, undefined, 'metadata must not retain an unbounded chain of previous scenes');
});
test('polygon triangulation preserves a concave filled area', () => {
  const s = { type: 'poly', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 4, y: 3 }, { x: 0, y: 8 }], rgb: [0, 0, 0], alpha: 1, opacity: 1, obj: {} };
  const compiled = compileVectorObject([s]); let area = 0;
  for (let offset = 0; offset < compiled.length; offset += SHAPE_FLOATS) {
    const [ax, ay, bx, by, cx, cy] = compiled.slice(offset, offset + 6);
    assert.equal(compiled[offset + 20], SHAPE.TRIANGLE);
    area += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  assert.equal(area, 44);
});
test('isolated transparency and media use bounded compatibility textures', () => {
  const geometry = buildGeometry(report, frame), bounds = objectBounds(geometry.drawables);
  assert.ok(bounds.width > 0 && bounds.height > 0 && bounds.width < report.canvas_width);
  assert.equal(requiresCompatibilityTexture(geometry.drawables.map(s => ({ ...s, opacity: .4 }))), true);
  assert.equal(requiresCompatibilityTexture([{ type: 'text' }]), true);
  assert.equal(requiresCompatibilityTexture([{ type: 'poly', points: [{ x: 0, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }, { x: 8, y: 0 }] }]), true, 'self-crossing polygons preserve native even-odd fill');
});
