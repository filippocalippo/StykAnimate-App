import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument} from '../src/editor.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('native starter project evaluates and serializes every keyframe', () => {
  const editor = open();
  assert.equal(editor.name, 'First steps'); assert.equal(editor.report.keyframes.length, 24);
  assert.equal(editor.totalTicks, 47); assert.equal(editor.dirty, false);
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    editor.seek(tick); assert.equal(editor.geometry.objects.size, 3); assert.equal(editor.geometry.drawables.length, 12);
    assert.deepEqual(editor.geometry.warnings, []);
  }
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('history is bounded and refused edits change nothing', () => {
  const editor = open({historyLimit: 3});
  for (let i = 0; i < 10; i++) editor.updateObject({root_x: 600 + i});
  assert.equal(editor._undo.length, 3);
  assert.throws(() => editor.updateObject({root_x: Infinity}), /finite/);
  assert.throws(() => editor.setFPS(0), /FPS/);
});

test('load validates before replacing the active document; serialization cannot mutate live poses', () => {
  const editor = open(), original = editor.report, revision = editor.revision, undo = editor._undo;
  assert.throws(() => editor.load({...emptyDocument(), keyframes: [{duration_raw: 1, objects: null}]}));
  assert.equal(editor.report, original); assert.equal(editor.revision, revision); assert.equal(editor._undo, undo);
  const output = editor.serialize(); output.keyframes[0].objects[0].angles[0] = 42;
  assert.notEqual(editor.object.angles[0], 42);
});

test('drawing on an empty selection creates a native figure at the pointer in one undo step', () => {
  const editor = open({demo: false}); editor.select(null);
  editor.addSegment({type: 'circle', length: 80, angle: 0, thickness: 6, start: {x: 120, y: 230}});
  assert.equal(editor.frame.objects.length, 1); assert.equal(editor.figure.segments.length, 1);
  assert.equal(editor.figure.segments[0].primitive_code, 1); near(editor.object.root_x, 120); near(editor.object.root_y, 230);
  const geometry = editor.geometry; near(geometry.drawables[0].end.x, 200);
  assert.throws(() => editor.deleteSegment(), /at least one/);
  editor.undo(); assert.equal(editor.frame.objects.length, 0); editor.redo(); assert.equal(editor.frame.objects.length, 1);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('playback seek may update timeline state without evaluating the sampled frame', () => {
  const editor = open(), revision = editor.revision;
  const frame = editor.seek(3, {evaluate: false}); assert.equal(frame, editor.frame); assert.equal(editor.tick, 3);
  assert.equal(editor._evaluated, null); assert.equal(editor.revision, revision);
});


test('connected selection resolution handles a deep reverse chain with linear join reads', () => {
  const editor = open({demo: false}), count = 12000; let reads = 0;
  const objects = Array.from({length: count}, (_, slot) => ({unique_id: slot + 1,
    get join() { reads++; return slot + 1 < count ? {target_object_slot: slot + 1, target_handle_id: 0} : null; }}));
  const result = editor.resolveTranslationSelection(objects.map(o => o.unique_id), {frame: {objects}});
  assert.deepEqual(result.rootUids, [count]); assert.equal(result.affectedUids.length, count);
  assert.ok(reads < count * 8, `Expected linear traversal, observed ${reads} join reads`);
});

