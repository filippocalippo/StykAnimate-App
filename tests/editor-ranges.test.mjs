import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {installEditorRanges} from '../src/editor-ranges.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {evaluatedFrame, timeline, buildGeometry} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';

installEditorRanges(Editor);
const clone = value => structuredClone(value);
const withoutFrameId = frame => { const value = clone(frame); if (value._styk) delete value._styk.frameId; return value; };
const assertUniqueFrameIds = editor => assert.equal(new Set(editor.report.keyframes.map(frame => frame._styk.frameId)).size, editor.report.keyframes.length);

function fixture({durations = [3, 4, 2, 9], easing = false} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.auto_easing = easing;
  figure.image_assets = [{name: 'Preserved bitmap', data_base64: 'AA=='}];
  figure.text_assets = [{text: 'Preserved text'}];
  report.backgrounds = [{background_id: 1, kind: 2, color: 0xffabcdef}, {background_id: 2, kind: 2, color: 0xfffedcba}];
  report.keyframes = durations.map((ticks, index) => {
    const parent = createObject(figure, 10, [50, 130, 70, 210][index % 4], 90 + index * 8);
    parent.angles = parent.angles.map((angle, i) => angle + (i % 2 ? -1 : 1) * index / 10);
    parent.scale = 1 + index / 10;
    const child = createObject(figure, 11, 12, 18, {join: {target_object_slot: 0, target_unique_id: 10, target_handle_id: 2}});
    const frame = createFrame([parent, child], ticks);
    frame.object_draw_order = [1, 0]; frame.object_draw_order_unique_ids = [11, 10];
    frame.background_id = index % 2 + 1;
    frame.camera = {is_default: false, x: index * 11, y: index * 4, scale: 1 + index / 5, angle_rad: index / 10};
    return frame;
  });
  return new Editor({demo: false}).load(report);
}

function visibleSamples(report) {
  return timeline(report).flatMap(({index, count}) => Array.from({length: count}, (_, tick) => {
    const frame = evaluatedFrame(report, index, tick / count);
    return {camera: clone(frame.camera), background: [frame.background_id, frame.background_id_b, frame.background_mix],
      drawables: buildGeometry(report, frame).drawables};
  }));
}

test('range duration changes are one undo command and only snapshot changed keys', () => {
  const editor = fixture(), before = clone(editor.report), untouched = editor.report.keyframes[1];
  editor.selectFrame(2);
  assert.equal(editor.setFramesDuration([2, 0, 2], 0), 2);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.duration_raw), [0, 4, 0, 9]);
  assert.equal(editor.report.keyframes[1], untouched);
  assert.equal(editor._undo.length, 1); assert.equal(editor._undo[0].changes.length, 2);
  editor.undo(); assert.deepEqual(editor.report, before); assert.equal(editor.frameIndex, 2);
  editor.redo(); assert.equal(editor.report.keyframes[2].duration_raw, 0);
  assert.equal(editor.setFramesDuration([0, 2], 0), 0); assert.equal(editor._undo.length, 1);
  assert.throws(() => editor.setFramesDuration([0], -1), /duration/);
  assert.throws(() => editor.setFramesDuration([4], 1), /existing keyframes/);
});

test('duplicate ranges keep chronological order, native metadata and the existing clipboard', () => {
  const editor = fixture(), before = clone(editor.report);
  editor.copyFrames([0]); const clipboard = clone(editor._frameClipboard);
  assert.equal(editor.duplicateFrames([3, 1, 1]), 2);
  assert.deepEqual(editor.report.keyframes.slice(4).map(withoutFrameId), [before.keyframes[1], before.keyframes[3]].map(withoutFrameId));
  assertUniqueFrameIds(editor);
  assert.notEqual(editor.getFrameId(4), before.keyframes[1]._styk.frameId);
  assert.notEqual(editor.getFrameId(5), before.keyframes[3]._styk.frameId);
  assert.deepEqual(editor._frameClipboard, clipboard);
  assert.equal(editor.frameIndex, 4);
  editor.report.keyframes[4].camera.x += 1;
  assert.equal(editor.report.keyframes[1].camera.x, before.keyframes[1].camera.x);
  editor.undo(); assert.deepEqual(editor.report, before);
  editor.redo(); assert.deepEqual(editor.report.keyframes.slice(4).map(withoutFrameId), [before.keyframes[1], before.keyframes[3]].map(withoutFrameId));
  assertUniqueFrameIds(editor);
  assert.doesNotThrow(() => validateScene(editor.report));
});

test('blank insertion keeps active camera and background while undo restores selection', () => {
  const editor = fixture(); editor.selectFrame(1); editor.select(11);
  const source = clone(editor.frame), before = clone(editor.report);
  assert.equal(editor.insertBlankFrame(0), 0);
  assert.equal(editor.frame.duration_raw, 1); assert.deepEqual(editor.frame.objects, []);
  assert.deepEqual(editor.frame.camera, source.camera);
  assert.equal(editor.frame.background_id, source.background_id);
  assert.deepEqual(editor.frame.object_draw_order, []); assert.equal(editor.selectedUid, null);
  assert.doesNotThrow(() => validateScene(editor.report));
  editor.undo(); assert.deepEqual(editor.report, before); assert.equal(editor.frameIndex, 1); assert.equal(editor.selectedUid, 11);
  editor.redo(); assert.equal(editor.frameIndex, 0); assert.equal(editor.selectedUid, null);
  assert.throws(() => editor.insertBlankFrame(-1), /position/);
});

for (const easing of [false, true]) test(`full bake preserves every visible pose, camera and background (auto easing ${easing})`, () => {
  const editor = fixture({easing}), before = clone(editor.report), expected = visibleSamples(editor.report);
  const figures = editor.report.figure_types, backgrounds = editor.report.backgrounds;
  assert.equal(editor.bakeFrames([0, 1, 2, 3]), expected.length);
  assert.equal(editor.totalTicks, expected.length);
  assert.equal(editor.report.keyframes.length, expected.length);
  assert.ok(editor.report.keyframes.every(frame => frame.duration_raw === 1));
  assert.deepEqual(visibleSamples(editor.report), expected);
  assert.equal(editor.report.figure_types, figures); assert.equal(editor.report.backgrounds, backgrounds);
  for (const frame of editor.report.keyframes) {
    assert.deepEqual(frame.object_draw_order_unique_ids, [11, 10]);
    assert.deepEqual(frame.objects.map(object => object.unique_id), [10, 11]);
    assert.deepEqual(frame.objects[1].join, before.keyframes[0].objects[1].join);
  }
  assert.doesNotThrow(() => validateScene(editor.report));
  assert.equal(editor._undo.length, 1);
  editor.undo(); assert.deepEqual(editor.report, before);
  editor.redo(); assert.deepEqual(visibleSamples(editor.report), expected);
  assert.equal(editor.bakeFrames(editor.report.keyframes.map((_, index) => index)), 0);
});

test('noncontiguous baking keeps untouched keys and hidden keyframes', () => {
  const editor = fixture(), source = editor.report;
  const expected = [0, 2].map(index => Array.from({length: source.keyframes[index].duration_raw}, (_, tick) => {
    const frame = clone(evaluatedFrame(source, index, tick / source.keyframes[index].duration_raw)); frame.duration_raw = 1; return frame;
  }));
  const middle = source.keyframes[1], last = source.keyframes[3];
  assert.equal(editor.bakeFrames([2, 0]), 5);
  assert.deepEqual(editor.report.keyframes.slice(0, 3).map(withoutFrameId), expected[0].map(withoutFrameId));
  assert.deepEqual(editor.report.keyframes.slice(4, 6).map(withoutFrameId), expected[1].map(withoutFrameId));
  assertUniqueFrameIds(editor);
  assert.equal(editor.report.keyframes[3], middle); assert.equal(editor.report.keyframes[6], last);
  editor.undo(); editor.setFramesDuration([1], 0);
  const hidden = editor.report.keyframes[1], samples = visibleSamples(editor.report);
  editor.bakeFrames([0, 1, 2, 3]);
  assert.equal(editor.report.keyframes[3], hidden); assert.equal(hidden.duration_raw, 0);
  assert.deepEqual(visibleSamples(editor.report), samples);
});

test('automatic easing requires a complete connected tween run and rejects partial changes atomically', () => {
  const editor = fixture({easing: true}), before = clone(editor.report);
  assert.throws(() => editor.bakeFrames([0, 2]), /entire connected tween run/);
  assert.deepEqual(editor.report, before); assert.equal(editor.canUndo, false);
  // The final key's stored duration does not add outgoing V5 tween ticks.
  const expected = visibleSamples(editor.report);
  assert.equal(editor.bakeFrames([0, 1, 2]), 9);
  assert.deepEqual(visibleSamples(editor.report), expected);
  editor.undo();
  editor.setFramesDuration([1], 1);
  const split = visibleSamples(editor.report);
  assert.equal(editor.bakeFrames([2]), 2);
  assert.deepEqual(visibleSamples(editor.report), split);
});

test('baking preflights frame, object and segment budgets before allocating or changing history', () => {
  const editor = fixture({durations: [65535, 1]}), before = clone(editor.report);
  assert.throws(() => editor.bakeFrames([0]), /Bake fewer keyframes/);
  assert.deepEqual(editor.report, before); assert.equal(editor.canUndo, false);

  const objectsReport = emptyDocument(), figure = objectsReport.figure_types[0];
  objectsReport.keyframes = [createFrame(Array.from({length: 51}, (_, index) => createObject(figure, index, 0, 0)), 19999), createFrame()];
  editor.load(objectsReport);
  assert.throws(() => editor.bakeFrames([0]), /1,000,000 generated figures/);
  assert.equal(editor.report.keyframes.length, 2); assert.equal(editor.canUndo, false);

  const segmentsReport = emptyDocument(), dense = segmentsReport.figure_types[0];
  dense.segments = Array.from({length: 1001}, (_, index) => ({...dense.segments[0], segment_id: index + 1, parent_id: 0}));
  dense.segment_count = dense.segments.length;
  segmentsReport.keyframes = [createFrame([createObject(dense, 1, 0, 0)], 10000), createFrame()];
  editor.load(segmentsReport);
  assert.throws(() => editor.bakeFrames([0]), /10,000,000 generated segments/);
  assert.equal(editor.report.keyframes.length, 2); assert.equal(editor.canUndo, false);
});
