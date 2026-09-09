import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {buildGeometry, evaluatedFrame} from '../src/pivot/geometry.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit, cancelNativePropertyEdit} from '../src/native-property-edit.mjs';

const near = (a, b, epsilon = 1e-4) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
function fixture(joined = false) {
  const editor = new Editor({demo: false}); editor.addFigure(); const root = editor.selectedUid;
  let selected = root;
  if (joined) { selected = editor.duplicateFigure().unique_id; editor.joinTo(root, 4); }
  editor.select(root); editor.updateObject({root_x: 230, root_y: 200});
  editor.duplicateFrame(); editor.moveSelection(70, 25);
  editor.duplicateFrame(); editor.moveSelection(100, -40);
  editor.select(selected); editor.markSaved();
  return {editor, root, selected};
}
function edit(editor, key, value, indices = [0, 1, 2]) {
  const token = beginNativePropertyEdit(editor, key, {indices, rangeMode: 'absolute'});
  previewNativePropertyEdit(token, value); return commitNativePropertyEdit(token);
}
test('numeric X range sets the same channel absolutely, retaining each Y and one undo', () => {
  const {editor, selected} = fixture(), before = editor.serialize(), count = editor._undo.length;
  const ys = editor.report.keyframes.map(frame => frame.objects[0].root_y);
  const token = beginNativePropertyEdit(editor, 'root_x', {indices: [0, 1, 2], rangeMode: 'absolute'});
  previewNativePropertyEdit(token, 450);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.objects[0].root_x), [230, 300, 450]);
  assert.ok(commitNativePropertyEdit(token));
  assert.deepEqual(editor.report.keyframes.map(frame => frame.objects.find(object => object.unique_id === selected).root_x), [450, 450, 450]);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.objects[0].root_y), ys);
  assert.equal(editor._undo.length, count + 1); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.report.keyframes.map(frame => frame.objects[0].root_x), [450, 450, 450]);
});
test('joined-child numeric X aligns the selected root and translates its complete component once', () => {
  const {editor, selected} = fixture(true);
  const before = editor.report.keyframes.map(frame => buildGeometry(editor.report, frame));
  assert.ok(edit(editor, 'root_x', 600));
  for (let index = 0; index < 3; index++) {
    const geometry = buildGeometry(editor.report, editor.report.keyframes[index]);
    const selectedBefore = [...before[index].objects.values()].find(entry => entry.obj.unique_id === selected);
    const selectedAfter = [...geometry.objects.values()].find(entry => entry.obj.unique_id === selected);
    near(selectedAfter.root.x, 600); near(selectedAfter.root.y, selectedBefore.root.y);
    for (const entry of geometry.objects.values()) {
      const old = before[index].objects.get(entry.slot);
      near(entry.root.x - old.root.x, 600 - selectedBefore.root.x); near(entry.root.y, old.root.y);
      if (entry.obj.join) near(entry.obj.root_x, entry.root.x);
    }
  }
});
test('absolute numeric scale and opacity apply to selected UID across sparse frames', () => {
  const {editor} = fixture(); editor.report.keyframes[0].objects[0].scale = 0.5; editor.report.keyframes[1].objects[0].scale = 0.8;
  edit(editor, 'scale', 150, [0, 2]);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.objects[0].scale), [1.5, 0.8, 1.5]);
  edit(editor, 'figure_opacity', 40, [0, 2]);
  assert.deepEqual(editor.report.keyframes.map(frame => frame.objects[0].field28), [153, 0, 153]);
});
test('canceling a numeric range preview leaves every source frame and history intact', () => {
  const {editor} = fixture(true), before = editor.serialize(), count = editor._undo.length;
  const token = beginNativePropertyEdit(editor, 'root_y', {indices: [0, 1, 2], rangeMode: 'absolute'});
  previewNativePropertyEdit(token, 120); cancelNativePropertyEdit(token);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, count);
});
test('camera adapter commits absolute range channels while its preview changes only the active key', () => {
  const {editor} = fixture();
  editor.setCameraValues({x: 20}, [0]); editor.setCameraValues({x: 80}, [1]); editor.setCameraValues({x: 150}, [2]);
  const count = editor._undo.length, before = editor.serialize();
  const token = beginNativePropertyEdit(editor, 'camera_x', {indices: [0, 1, 2], rangeMode: 'absolute'});
  previewNativePropertyEdit(token, 450); assert.deepEqual(editor.report.keyframes.map(frame => frame.camera.x), [20, 80, 450]);
  commitNativePropertyEdit(token); assert.deepEqual(editor.report.keyframes.map(frame => frame.camera.x), [450, 450, 450]);
  assert.equal(editor._undo.length, count + 1); editor.undo(); assert.deepEqual(editor.serialize(), before);
});

for (const [key,value] of [['root_x',450],['root_y',120],['scale',140],['rotation',37],['joint_angle',25],['joint_length',62],['joint_bend',17]]) {
  test(`rerooted native ${key} range keeps evaluated poses and one undo`, () => {
    const {editor,selected}=fixture();editor.setOrigin(4);editor.select(selected,0);
    const before=editor.serialize(),history=editor._undo.length,middle=structuredClone(editor.report.keyframes[1]);
    assert.ok(edit(editor,key,value,[0,2]));assert.equal(editor._undo.length,history+1);
    assert.deepEqual(editor.report.keyframes[1],middle,'Unselected native key stays unchanged.');
    for(const index of [0,2]){
      const source=editor.report.keyframes[index],sample=evaluatedFrame(editor.report,index,0,editor.timeline[index].start);
      const physical=buildGeometry(editor.report,source),composed=buildGeometry(editor.report,sample);
      for(const [slot,object] of physical.objects){
        const actual=composed.objects.get(slot);near(actual.root.x,object.root.x);near(actual.root.y,object.root.y);
        object.segments.forEach((segment,i)=>segment.points.forEach((point,j)=>{
          near(actual.segments[i].points[j].x,point.x);near(actual.segments[i].points[j].y,point.y);
        }));
      }
    }
    const after=editor.serialize();editor.undo();assert.deepEqual(editor.serialize(),before);
    editor.redo();assert.deepEqual(editor.serialize(),after);
  });
}
