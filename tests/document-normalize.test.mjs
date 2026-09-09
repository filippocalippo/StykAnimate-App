import assert from 'node:assert/strict';
import test from 'node:test';
import {synchronizeExistingDerived} from '../src/document-normalize.mjs';
import {createDemo} from '../src/demo.mjs';

test('missing legacy and STK display aliases stay absent, including replaced flag_bits', () => {
  const report = createDemo(), figure = report.figure_types[0], segment = figure.segments[0];
  segment.flag_bits = {raw: 0, opaque: ['01', .125]};
  delete segment.is_static;
  delete report.duration_seconds;
  const frame = report.keyframes[0], object = frame.objects[0];
  for (const key of ['hidden', 'inbetweens']) delete frame[key];
  for (const key of ['color_override_rgb', 'color_override_mix', 'transparency', 'opacity']) delete object[key];
  const keys = {segment: Object.keys(segment).sort(), bits: Object.keys(segment.flag_bits).sort(),
    frame: Object.keys(frame).sort(), object: Object.keys(object).sort()};
  synchronizeExistingDerived(report);
  assert.deepEqual(Object.keys(segment).sort(), keys.segment);
  assert.deepEqual(Object.keys(segment.flag_bits).sort(), keys.bits);
  assert.deepEqual(Object.keys(frame).sort(), keys.frame);
  assert.deepEqual(Object.keys(object).sort(), keys.object);
  assert.deepEqual(segment.flag_bits.opaque, ['01', .125]);
  assert.equal(Object.hasOwn(report, 'duration_seconds'), false);
});

test('existing aliases track genuine edits while opaque data and fractional pose values survive', () => {
  const report = createDemo(), segment = report.figure_types[0].segments[0], object = report.keyframes[0].objects[0];
  segment.flag_bits = {raw: 0, low_byte: 0, high_byte: 0, set_bits: [], is_static: false, opaque: 'keep'};
  segment.primitive_code = 3; segment.aux_code = 1;
  object.color_override_rgb = []; object.color_override_mix = 0; object.transparency = 0; object.opacity = 1;
  object.color_override_raw = 0x80332211; object.field28 = 51; object.root_x = 1 / 7;
  report.opaque = {values: ['01', null, true, 1 / 3]};
  synchronizeExistingDerived(report);
  assert.equal(segment.flags, 259); assert.equal(segment.flag_bits.raw, 259);
  assert.equal(segment.flag_bits.is_static, true); assert.equal(segment.flag_bits.opaque, 'keep');
  assert.deepEqual(segment.flag_bits.set_bits, [0, 1, 8]);
  assert.deepEqual(object.color_override_rgb, [17, 34, 51]); assert.equal(object.color_override_mix, 128);
  assert.equal(object.transparency, 51); assert.equal(object.opacity, .8); assert.equal(object.root_x, 1 / 7);
  assert.deepEqual(report.opaque.values, ['01', null, true, 1 / 3]);
});
