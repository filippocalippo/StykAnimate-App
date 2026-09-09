import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { validateScene } from '../src/pivot/model.mjs';
import { buildGeometry, evaluatedFrame } from '../src/pivot/geometry.mjs';
import { createObject, createFrame, emptyDocument } from '../src/demo.mjs';

function largeScene(count, topology) {
  const report = emptyDocument();
  const figure = { figure_type_id: 1, name: `${count} ${topology}`, polyfills: [], image_assets: [], text_assets: [],
    segments: Array.from({ length: count }, (_, i) => ({ segment_id: i + 1, parent_id: topology === 'star' ? 0 : i,
      length: .05, angle_rad: 0, thickness: .01, bend_rad: 0, primitive_code: 0, aux_code: 0, flags: 0,
      segment_type: 'line', segment_kind: 'line', color_rgb: [0, 0, 0], transparency: 0, visible: true, z_order: i + 1 })) };
  if (topology === 'reverse-chain') figure.segments.reverse();
  report.figure_types = [figure]; report.keyframes = [createFrame([createObject(figure, 1, 0, 0)], 2), createFrame([createObject(figure, 1, 10, 20)])];
  return report;
}

test('30,000-segment chains, stars and reversed storage order validate/evaluate without recursion overflow', async () => {
  const measurements = [];
  for (const topology of ['chain', 'star', 'reverse-chain']) {
    const report = largeScene(30000, topology), started = performance.now();
    validateScene(report); const validated = performance.now();
    const frame = evaluatedFrame(report, 0, .5), evaluated = performance.now();
    const geometry = buildGeometry(report, frame), ended = performance.now(), object = geometry.objects.get(0);
    assert.equal(geometry.warnings.length, 0); assert.equal(object.joints.size, 30001); assert.equal(object.segments.length, 30000);
    assert.equal(geometry.drawables.length, 30000); assert.equal(object.root.x, 5); assert.equal(object.root.y, 10);
    assert.ok(object.segments.every(segment => Number.isFinite(segment.end.x + segment.end.y)));
    if (topology === 'star') assert.equal(object.joints.get(30000).x, Math.fround(5.05));
    else assert.ok(Math.abs(object.joints.get(30000).x - 1505) < 1);
    measurements.push({ topology, segments: 30000, validationMs: validated - started, evaluationMs: evaluated - validated, geometryMs: ended - evaluated });
  }
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/large-figure-performance.json', import.meta.url), JSON.stringify({ measuredAt: new Date().toISOString(), measurements, note: 'CPU native validation, interpolation and geometry only; not GPU presentation latency.' }, null, 2));
});

test('native per-figure count and 16-bit handle capacity fail before unsupported data enters the editor', () => {
  assert.throws(() => validateScene(largeScene(30001, 'chain')), /30,000/);
  const report = largeScene(1, 'star'); report.figure_types[0].segments[0].segment_id = 65536;
  assert.throws(() => validateScene(report), /segment handle/);
});
