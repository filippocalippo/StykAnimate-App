import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {validateScene, validateObjectChanges} from '../src/pivot/model.mjs';

test('object validation reuses validated definitions without reading unrelated segment records', () => {
  const editor = new Editor(), report = editor.report, frame = editor.frame;
  let reads = 0;
  for (const figure of report.figure_types) for (const segment of figure.segments) {
    const length = segment.length;
    Object.defineProperty(segment, 'length', {get() { reads++; return length; }, enumerable: true, configurable: true});
  }
  frame.objects[0].root_x += 10;
  validateObjectChanges(report, frame, [frame.objects[0].unique_id]);
  assert.equal(reads, 0);
  validateScene({...report, keyframes: [frame]}); assert.ok(reads > 0);
});

test('incremental validation rejects invalid numeric and pose channels with atomic editor rollback', () => {
  const editor = new Editor(), before = editor.serialize();
  for (const mutate of [o => { o.root_x = Infinity; }, o => { o.root_y = 1e100; }, o => { o.scale = -1; },
    o => { o.angles[0] = NaN; }, o => { o.angles.pop(); }, o => { o.field28 = 999; },
    o => { o.len_flag = 1; o.lengths = [Infinity]; }]) {
    editor.beginDrag(); mutate(editor.object); editor.touch(); assert.throws(() => editor.commitDrag());
    assert.deepEqual(editor.serialize(), before); assert.equal(editor.dragging, false);
  }
});

test('changed join ancestry is checked for missing handles, invalid slots and indirect cycles', () => {
  const editor = new Editor(), frame = editor.frame, uid = frame.objects[0].unique_id;
  for (const join of [{target_object_slot: 999, target_handle_id: 0}, {target_object_slot: 1, target_handle_id: 65535},
    {target_object_slot: 0, target_handle_id: 0}, {target_object_slot: '1', target_handle_id: 0}]) {
    frame.objects[0].join = join; assert.throws(() => validateObjectChanges(editor.report, frame, [uid]));
  }
  frame.objects[0].join = {target_object_slot: 1, target_handle_id: 0};
  frame.objects[1].join = {target_object_slot: 2, target_handle_id: 0};
  frame.objects[2].join = {target_object_slot: 0, target_handle_id: 0};
  assert.throws(() => validateObjectChanges(editor.report, frame, [uid]), /cyclic/);
});

test('replacement definitions are fully validated before entering the gesture cache', () => {
  const editor = new Editor(), original = editor.report.figure_types[0];
  const replacement = structuredClone(original); replacement.segments[0].parent_id = 65534;
  editor.report.figure_types[0] = replacement;
  assert.throws(() => validateObjectChanges(editor.report, editor.frame, [editor.frame.objects[0].unique_id]), /missing parent/);
});

test('pointer down at a keyframe retains prepared geometry and a tween drag returns to the keyframe', () => {
  const editor = new Editor(), geometry = editor.geometry;
  editor.beginTranslationDrag(); assert.equal(editor.geometry, geometry); editor.cancelDrag();
  editor.seek(1); const tween = editor.geometry; editor.beginDrag();
  assert.equal(editor.tick, 0); assert.notEqual(editor.geometry, tween); editor.cancelDrag();
});
