import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
const clone = structuredClone;
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0], base = figure.segments[0];
  figure.segments = [11, 22, 33, 44].map((id, i) => ({...base, segment_id: id, parent_id: [0, 11, 22, 0][i],
    angle_rad: [.2, 1.1, -.4, 2][i], bend_rad: [.3, -.2, .4, 0][i], length: [50, 35, 25, 65][i], z_order: i})); figure.segment_count = 4;
  figure.polyfills = [{polyfill_id: 1, segment_ids: [0, 11, 22, 33], color_rgb: [100, 50, 220], alpha_raw: 0, z_order: -1}];
  report.keyframes = [0, 1].map(i => createFrame([createObject(figure, 1, 180, 180, {angles: figure.segments.map(segment => segment.angle_rad + i * .35),
    len_flag: 1, lengths: figure.segments.map(segment => segment.length * (1 + i * .2)), bend_flag: 1, bends: figure.segments.map(segment => segment.bend_rad + i * .1)})], 4));
  const editor = new Editor({demo: false}).load(report); editor.captureFrameSource(editor.report.keyframes[1]); editor.select(1, 0); return editor;
}
for (const branch of [false, true]) for (const flip of [false, true]) test(`native duplicate places ${branch ? 'branch' : 'single edge'} at chosen handle with flip=${flip}`, () => {
  const editor = fixture(), before = editor.serialize(), oldFrames = editor._allSourceFrames().map(frame => clone(frame)), oldGeometry = oldFrames.map(frame => buildGeometry(before, frame));
  const result = editor.duplicateSegment({parentId: 44, branch, flip}); assert.equal(result.handleIds.length, branch ? 3 : 1);
  assert.equal(editor.figure.polyfills.length, branch ? 2 : 1); assert.equal(editor._undo.length, 1);
  editor._allSourceFrames().forEach((frame, i) => {
    const original = oldGeometry[i].objects.get(0), geometry = buildGeometry(editor.report, frame).objects.get(0), target = original.joints.get(44), pivot = original.root;
    for (let j = 0; j < result.handleIds.length; j++) {
      const old = original.joints.get([11, 22, 33][j]), point = geometry.joints.get(result.handleIds[j]);
      assert.ok(Math.abs(point.x - (target.x + (flip ? -1 : 1) * (old.x - pivot.x))) < .0001);
      assert.ok(Math.abs(point.y - (target.y + old.y - pivot.y)) < .0001);
      assert.equal(frame.objects[0].lengths[4 + j], oldFrames[i].objects[0].lengths[j]);
      assert.equal(frame.objects[0].bends[4 + j], (flip ? -1 : 1) * oldFrames[i].objects[0].bends[j]);
    }
    assert.deepEqual(frame.objects[0].angles.slice(0, 4), oldFrames[i].objects[0].angles);
  });
  if (branch) assert.deepEqual(editor.figure.polyfills[1].segment_ids, [44, ...result.handleIds]);
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.deepEqual(editor.serialize(), after);
});
test('invalid duplicate target rejects atomically and the compatibility branch API has no default angular offset', () => {
  const editor = fixture(), before = editor.serialize(); assert.throws(() => editor.duplicateSegment({parentId: 65535}), /parent/i); assert.deepEqual(editor.serialize(), before);
  const result = editor.duplicateSegmentBranch(); assert.equal(result.handleIds.length, 3);
  assert.deepEqual(editor.object.angles.slice(4), editor.object.angles.slice(0, 3));
});
test('duplication reuses free sparse IDs when an imported joint already uses 65535', () => {
  const editor = fixture(), segment = editor.figure.segments[3]; segment.segment_id = 65535;
  editor._invalidate(); const result = editor.duplicateSegment({parentId: 65535, branch: true});
  assert.deepEqual(result.handleIds, [1, 2, 3]); assert.equal(editor.figure.segments[4].parent_id, 65535);
  assert.equal(new Set(editor.figure.segments.map(item => item.segment_id)).size, 7);
});
