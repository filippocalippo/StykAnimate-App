// The frame on show read with its objects' numbers as words (engine-shown.mjs `frameOf`, the session's `{packed: true}` read and
// `frameNumbers` packet): the frame the interface gets is the frame the whole text gives, value for value, at a playhead, during a
// gesture and for the document's own frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo, createFrame, createObject} from '../src/demo.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

/** The demo walker, `count` of them over two keyframes that pose them differently; the first with a negative zero, a bend that is not
 * a number and an array too short to pack among its numbers. */
function crowd(count) {
  const report = createDemo(), walker = report.figure_types[0];
  report.figure_types = [walker];
  report.keyframes = [0, 1].map(key => createFrame(Array.from({length: count}, (_, i) => {
    const object = createObject(walker, i + 1, 120 + i * 140, 300 + key * 9);
    object.angles = object.angles.map((angle, joint) => angle + key * (joint + 1) * .05);
    if (i === 0) object.angles[1] = -0;
    return object;
  }), 4));
  return report;
}

/** The frame on show as the whole text gives it, read from the editor's session directly. */
function whole(editor, kind = 'frame') {
  const {session} = editor._shown.source(false);
  return JSON.parse(session.query(kind, '{}', JSON.stringify({tick: editor.tick, frameIndex: editor.frameIndex})));
}

test('a frame read with its numbers as words is the frame the whole text gives', {skip: !engineBuilt}, async () => {
  const {editor} = await ownedEditor({demo: false}, crowd(6));
  for (const tick of [0, 2, 3]) {
    editor.seek(tick);
    const packed = editor._shown.frame();
    assert.deepStrictEqual(packed, whole(editor), `tick ${tick}: the frame`);
    assert.deepStrictEqual(editor._shown.documentFrame(), whole(editor, 'document'), `tick ${tick}: the document's frame`);
    assert.ok(packed.objects.every(object => Array.isArray(object.angles)), `tick ${tick}: every pose's angles are an array again`);
  }
  // The text the interface parses leaves the poses' numbers out: they come as words.
  const {session} = editor._shown.source(false), view = JSON.stringify({tick: editor.tick, frameIndex: editor.frameIndex});
  const text = session.query('frame', JSON.stringify({packed: true}), view), words = session.query_packet('frameNumbers', '{}', view);
  const angles = JSON.stringify(whole(editor).objects[3].angles).slice(1, -1);
  assert.ok(JSON.stringify(whole(editor)).includes(angles) && !text.includes(angles), 'the packed text leaves the angles out');
  assert.ok(words.length >= 6 * editor.report.figure_types[0].segments.length, 'every pose\'s angles are words');
  // At a key the negative zero is read as the text gives it, a zero.
  editor.seek(0);
  assert.ok(Object.is(editor._shown.frame().objects[0].angles[1], 0));
  // A gesture's draft: the joint dragged is read as the session holds it.
  const uid = editor._shown.frame().objects[2].unique_id;
  editor.select(uid, 1);
  assert.ok(editor.beginDrag('Pose joint'));
  const end = [...editor.geometry.objects.get(2).joints.values()][2];
  editor.poseJoint(end.x + 30, end.y + 4);
  editor._evaluated = null;
  assert.deepStrictEqual(editor._shown.frame(), whole(editor), 'the frame during a drag');
  editor.cancelDrag();
});
