import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {frameOrder, setOrder} from '../src/pivot/structure.mjs';
import {roundTrip} from './support/codec.mjs';

test('nested joined movement and posing roundtrip through native PIV with canonical origins and sparse handles', async () => {
  const editor = new Editor({demo: false}); editor.addFigure(); const root = editor.selectedUid;
  const child = editor.duplicateFigure().unique_id; editor.joinTo(root, 4);
  const grandchild = editor.duplicateFigure().unique_id; editor.joinTo(child, 2);
  const document = editor.serialize(), frame = document.keyframes[0], order = frameOrder(frame);
  const handle = id => id ? id * 7 + 1 : 0;
  for (const figure of document.figure_types) for (const segment of figure.segments) {
    segment.segment_id = handle(segment.segment_id); segment.parent_id = handle(segment.parent_id);
  }
  frame.objects.reverse(); const slots = new Map(frame.objects.map((object, slot) => [object.unique_id, slot]));
  frame.objects.forEach((object, slot) => { object.object_slot = slot; if (object.join) {
    object.join.target_object_slot = slots.get(object.join.target_unique_id); object.join.target_handle_id = handle(object.join.target_handle_id);
  } }); setOrder(frame, order);
  editor.load(document); editor.select(grandchild); editor.moveSelection(45, -26);
  editor.select(root, 2); editor.rotateJoint(0.35); const geometry = editor.geometry, output = editor.serialize();
  const imported = await roundTrip({document: output, format: 'piv'}), native = buildGeometry(imported, imported.keyframes[0]);
  const byUid = new Map([...native.objects.values()].map(g => [g.obj.unique_id, g]));
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.0005, `${a} != ${b}`);
  for (const g of geometry.objects.values()) {
    const saved = byUid.get(g.obj.unique_id); assert.ok(saved);
    near(saved.root.x, g.root.x); near(saved.root.y, g.root.y);
    if (saved.obj.join) { near(saved.obj.root_x, saved.root.x); near(saved.obj.root_y, saved.root.y); }
    g.segments.forEach((segment, index) => {
      const next = saved.segments[index]; near(segment.start.x, next.start.x); near(segment.start.y, next.start.y);
      near(segment.end.x, next.end.x); near(segment.end.y, next.end.y);
    });
  }
});
