import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDocument, createFrame, createObject } from '../src/demo.mjs';
import { evaluatedFrame, invalidateEvaluationCaches } from '../src/pivot/geometry.mjs';

test('empty and delayed independent layer tracks do not leak native poses', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [{ ...createFrame([createObject(figure, 1, 100, 100)]), _styk: {frameId: 'first'} }];
  report._styk.animation = { channels: [{ id: 'layer:layer-1:pose', target: {kind: 'layer', id: 'layer-1'}, property: 'pose', keys: [] }] };
  assert.equal(evaluatedFrame(report, 0).objects.length, 0);
  report._styk.animation.channels[0].keys = [{ id: 'later', tick: 5, value: {frameId: 'first'}, interpolation: 'hold' }];
  invalidateEvaluationCaches(report);
  assert.equal(evaluatedFrame(report, 0, 0, 4).objects.length, 0);
  assert.equal(evaluatedFrame(report, 0, 0, 5).objects.length, 1);
});

test('empty and explicit blank Scene/Camera keys reset inherited native fields', () => {
  for (const kind of ['scene', 'camera']) {
    const report = emptyDocument(), figure = report.figure_types[0];
    const source = {...createFrame([createObject(figure, 1, 100, 100)]),
      _styk: {frameId: 'first'}, background_id: 7, background_id_b: 8, background_mix: .5,
      background_color: 0xffaa3300, _stykBackgroundColor: 0xff00bb22,
      camera: {is_default: false, x: 37, y: 84, scale: 2, angle_rad: .7}};
    report.keyframes = [source];
    const channel = {id: `${kind}:pose`, target: {kind}, property: 'pose', keys: []};
    report._styk.animation = {channels: [channel]};
    const verify = frame => {
      assert.equal(frame.objects[0].unique_id, 1, 'permanent tracks do not erase figure poses');
      if (kind === 'camera') {
        assert.deepEqual(frame.camera, {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0});
        assert.equal(frame.background_id, 7, 'Scene is unaffected');
      } else {
        assert.equal(frame.background_id, 0); assert.equal(frame.background_id_b, 0); assert.equal(frame.background_mix, 0);
        assert.equal(frame._stykBackgroundColor, undefined); assert.equal(frame.background_color, undefined);
        assert.equal(frame.camera.x, 37, 'Camera is unaffected');
      }
    };
    verify(evaluatedFrame(report, 0, 0, 0));
    channel.keys = [{id: 'blank', tick: 5, value: {frameId: null}, interpolation: 'hold'}];
    invalidateEvaluationCaches(report);
    verify(evaluatedFrame(report, 0, 0, 4));
    verify(evaluatedFrame(report, 0, 0, 5));
    assert.equal(source.background_id, 7, 'native source remains intact');
    assert.equal(source.camera.x, 37);
  }
});
