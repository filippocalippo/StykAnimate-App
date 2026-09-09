import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {editorSelectionMethods} from '../src/editor-selection.mjs';
import {createObject, createFrame, defaultFigure, emptyDocument} from '../src/demo.mjs';
import {frameOrder, setOrder} from '../src/pivot/structure.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {objectBounds} from '../src/renderer-geometry.mjs';

Object.assign(Editor.prototype, editorSelectionMethods);

function fixture() {
  const report = emptyDocument(), [a, b, c] = [17, 300, 900].map(defaultFigure);
  a.segments.forEach(segment => { segment.segment_id *= 11; segment.parent_id *= 11; });
  report.figure_types = [a, b, c];
  const objects = [createObject(a, 1011, 200, 200), createObject(b, 40, 300, 200),
    createObject(a, 707, 400, 200), createObject(c, 9, 500, 200), createObject(b, 500003, 600, 200)];
  objects[2].join = {target_object_slot: 0, target_unique_id: 1011, target_handle_id: 33};
  report.keyframes = [createFrame(objects)];
  setOrder(report.keyframes[0], [9, 707, 1011, 500003, 40]);
  const editor = new Editor({demo: false}); editor.load(report); return editor;
}
const ids = editor => [...editor.selectedUids];

test('connected selection traverses both directions by slots, preserving clipboard joins and history', () => {
  const editor = fixture(), before = structuredClone(editor.report), geometry = editor.geometry;
  editor.selectConnected(707);
  assert.deepEqual(ids(editor), [1011, 707]); assert.equal(editor.selectedUid, 707);
  assert.equal(editor.geometry, geometry); assert.equal(editor.canUndo, false);
  assert.deepEqual(editor.report, before);
  assert.equal(editor.copySelection(), 2);
  const pasted = editor.pasteSelection();
  assert.equal(pasted[1].join.target_unique_id, pasted[0].unique_id);
  assert.equal(pasted[1].join.target_handle_id, 33);
  editor.undo(); assert.deepEqual(editor.report.keyframes, before.keyframes);
  editor.selectMany([40]); editor.selectConnected(707, {add:true, candidates:[707]});
  assert.deepEqual(ids(editor), [40,707]);
});

test('branch selection includes descendants and attachments, copies only the posed branch and enclosed polygons', () => {
  const editor = fixture(), figure = editor.report.figure_types[0];
  figure.polyfills = [{polyfill_id:1,segment_ids:[11,33,44],segment_ids_raw:[11,33,44],color_rgb:[12,34,56],alpha_raw:17,z_order:3.5},
    {polyfill_id:2,segment_ids:[11,33,55],color_rgb:[30,40,50],alpha_raw:0,z_order:4}];
  editor._invalidate();
  const before = structuredClone(editor.report), source = editor.geometry.objects.get(0);
  editor.selectBranch(1011, 2);
  assert.equal(editor.branchSelected, true); assert.deepEqual(ids(editor), [1011,707]);
  assert.equal(editor.selectedJoint, 2); assert.equal(editor.canUndo, false);
  editor.select(1011,2); assert.equal(editor.branchSelected,true);
  assert.equal(editor.copySelection(),2); assert.deepEqual(editor.report,before);
  const pasted = editor.pasteSelection(), copied = editor.report.figure_types.find(f => f.figure_type_id === pasted[0].figure_type_id);
  assert.deepEqual(copied.segments.map(s=>[s.segment_id,s.parent_id]),[[33,0],[44,33]]);
  assert.deepEqual(copied.polyfills.map(p=>p.segment_ids),[[0,33,44]]);
  assert.equal(copied.polyfills[0].alpha_raw,17);
  assert.equal(pasted[1].join.target_unique_id,pasted[0].unique_id);
  assert.equal(pasted[1].join.target_handle_id,33);
  const actual=editor.geometry.objects.get(pasted[0].object_slot);
  for (const [i, original] of [2,3].entries()) for (const point of ['start','end']) {
    assert.ok(Math.abs(actual.segments[i][point].x-source.segments[original][point].x-24)<3e-5);
    assert.ok(Math.abs(actual.segments[i][point].y-source.segments[original][point].y-24)<3e-5);
  }
  assert.equal(validateScene(editor.report),editor.report);
  assert.equal(editor.branchSelected,false);
  editor.undo(); assert.deepEqual(editor.report.figure_types,before.figure_types);
  editor.redo(); assert.equal(validateScene(editor.report),editor.report);
  const again=editor.pasteSelection();
  assert.notEqual(again[0].figure_type_id,pasted[0].figure_type_id);
  assert.deepEqual(editor.report.figure_types[0],before.figure_types[0]);
});

test('same-definition selection matches every selected definition and retains the active figure', () => {
  const editor = fixture(); editor.selectMany([40, 1011]);
  const report = editor.report, frame = editor.frame, objects = frame.objects, geometry = editor.geometry;
  const before = structuredClone(report), revision = editor.revision, events = [];
  editor.addEventListener('change', event => events.push(event.detail.kind));
  assert.deepEqual(editor.selectSameDefinition().map(object => object.unique_id), [1011, 40, 707, 500003]);
  assert.equal(editor.selectedUid, 1011); assert.equal(editor.selectedJoint, -1);
  assert.deepEqual(report, before); assert.equal(editor.report, report); assert.equal(editor.frame, frame);
  assert.equal(editor.frame.objects, objects); assert.equal(editor.geometry, geometry);
  assert.equal(editor.revision, revision); assert.equal(editor.dirty, false); assert.equal(editor.canUndo, false);
  assert.deepEqual(events, ['selection']);
});

test('same-definition candidate filtering ignores unknown IDs and add preserves prior selection', () => {
  const editor = fixture(); editor.selectMany([40, 1011]);
  editor.selectSameDefinition({candidates: [707, 707, 500003, 9, 999999]});
  assert.deepEqual(ids(editor), [707, 500003]); assert.equal(editor.selectedUid, 500003);
  editor.selectMany([9, 1011]);
  editor.selectSameDefinition({add: true, candidates: new Set([707])});
  assert.deepEqual(ids(editor), [9, 1011, 707]); assert.equal(editor.selectedUid, 1011);
  editor.selectMany([]); assert.deepEqual(editor.selectSameDefinition(), []); assert.deepEqual(ids(editor), []);
});

test('invert selection toggles the eligible domain once and preserves outside selections', () => {
  const editor = fixture(); editor.selectMany([9, 1011]);
  editor.invertSelection([1011, 707, 707, 999999]);
  assert.deepEqual(ids(editor), [9, 707]); assert.equal(editor.selectedUid, 707);
  editor.invertSelection(); assert.deepEqual(ids(editor), [1011, 40, 500003]);
  editor.invertSelection([]); assert.deepEqual(ids(editor), [1011, 40, 500003]);
  assert.equal(editor.dirty, false); assert.equal(editor.canUndo, false);
});

test('marquee replacement, addition and subtraction preserve the active UID while retained', () => {
  const editor = fixture(); editor.select(1011, 2);
  editor.selectMarquee([707, 1011, 707, 999999]);
  assert.deepEqual(ids(editor), [707, 1011]); assert.equal(editor.selectedUid, 1011); assert.equal(editor.selectedJoint, -1);
  editor.selectMarquee([40, 9], {mode: 'add'});
  assert.deepEqual(ids(editor), [707, 1011, 40, 9]); assert.equal(editor.selectedUid, 1011);
  editor.selectMarquee([707, 9], {mode: 'subtract'});
  assert.deepEqual(ids(editor), [1011, 40]); assert.equal(editor.selectedUid, 1011);
  editor.selectMarquee([1011], {mode: 'subtract'}); assert.equal(editor.selectedUid, 40);
  editor.selectMarquee([]); assert.deepEqual(ids(editor), []); assert.equal(editor.selectedUid, null);
});

test('marquee toggle uses the drag-start baseline instead of repeatedly flipping previous hits', () => {
  const editor = fixture(); editor.selectMany([1011, 40]); const initial = new Set(editor.selectedUids);
  editor.selectMarquee([707, 40], {mode: 'toggle', initial}); assert.deepEqual(ids(editor), [1011, 707]);
  editor.selectMarquee([707, 40], {mode: 'toggle', initial}); assert.deepEqual(ids(editor), [1011, 707]);
  editor.selectMarquee([9, 40], {mode: 'toggle', initial}); assert.deepEqual(ids(editor), [1011, 9]);
  editor.selectMarquee([], {mode: 'toggle', initial}); assert.deepEqual(ids(editor), [1011, 40]);
  assert.deepEqual([...initial], [1011, 40]); assert.equal(editor.canUndo, false); assert.equal(editor.dirty, false);
});

test('selection changes preserve redo and invalid marquee mode leaves selection untouched', () => {
  const editor = fixture(); editor.updateObject({root_x: 210}); editor.undo();
  const redo = editor._redo[0], before = editor._selectionState();
  assert.throws(() => editor.selectMarquee([40], {mode: 'invalid'}), /marquee selection mode/);
  assert.deepEqual(editor._selectionState(), before);
  editor.selectSameDefinition(); editor.invertSelection(); editor.selectMarquee([40]);
  assert.equal(editor._redo[0], redo); assert.equal(editor.canUndo, false); assert.equal(editor.dirty, false);
  editor.redo(); assert.equal(editor.frame.objects[0].root_x, 210);
});

test('bring to front partitions native paint order stably without changing slots, UIDs or joins', () => {
  const editor = fixture(); editor.selectMany([707, 40]);
  const before = structuredClone(editor.frame), originalObjects = editor.frame.objects, selection = editor._selectionState();
  assert.equal(editor.bringToFront(), true);
  assert.deepEqual(frameOrder(editor.frame), [9, 1011, 500003, 707, 40]);
  assert.equal(editor.frame.objects, originalObjects); assert.deepEqual(editor.frame.objects, before.objects);
  assert.deepEqual(editor.frame.object_draw_order, [3, 0, 4, 2, 1]);
  assert.deepEqual(editor._selectionState(), selection); assert.equal(editor._undo.length, 1);
  assert.equal(editor._undo[0].structural, true); assert.doesNotThrow(() => validateScene(editor.serialize()));
  editor.undo(); assert.deepEqual(editor.frame, before); assert.deepEqual(editor._selectionState(), selection);
  editor.redo(); assert.deepEqual(frameOrder(editor.frame), [9, 1011, 500003, 707, 40]);
});

test('send to back is a stable partition with one reversible command', () => {
  const editor = fixture(); editor.selectMany([40, 707]); const before = structuredClone(editor.frame);
  assert.equal(editor.sendToBack(), true); assert.deepEqual(frameOrder(editor.frame), [707, 40, 9, 1011, 500003]);
  assert.deepEqual(editor.frame.objects, before.objects); assert.equal(editor._undo.length, 1);
  editor.undo(); assert.deepEqual(editor.frame, before); assert.equal(editor.dirty, false);
  editor.redo(); assert.deepEqual(frameOrder(editor.frame), [707, 40, 9, 1011, 500003]);
});

test('empty, whole-frame and already terminal layer selections do not create history', () => {
  const editor = fixture(); editor.selectMany([]);
  assert.equal(editor.bringToFront(), false); assert.equal(editor.sendToBack(), false);
  editor.selectMany(editor.frame.objects.map(object => object.unique_id));
  assert.equal(editor.bringToFront(), false); assert.equal(editor.sendToBack(), false);
  editor.selectMany([500003, 40]); assert.equal(editor.bringToFront(), false);
  editor.selectMany([9, 707]); assert.equal(editor.sendToBack(), false);
  assert.equal(editor.canUndo, false); assert.equal(editor.dirty, false);
});

function joinedFixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  for (const segment of figure.segments) { segment.segment_id *= 11; segment.parent_id *= 11; }
  const child = createObject(figure, 707, -500, -600, {join: {target_object_slot: 2, target_unique_id: 1011, target_handle_id: 33}});
  const separate = createObject(figure, 500003, 750, 550);
  const root = createObject(figure, 1011, 150, 250);
  const grandchild = createObject(figure, 9, -400, -500, {join: {target_object_slot: 0, target_unique_id: 707, target_handle_id: 11}});
  const sibling = createObject(figure, 40, -300, -400, {join: {target_object_slot: 2, target_unique_id: 1011, target_handle_id: 77}});
  report.keyframes = [createFrame([child, separate, root, grandchild, sibling])];
  setOrder(report.keyframes[0], [9, 707, 1011, 500003, 40]);
  const editor = new Editor({demo: false}); editor.load(report);
  return editor;
}

// Native runtime endpoints use float32 coordinates.
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} != ${expected}`);
const callbackBounds = g => ({minX: g.root.x - 12, minY: g.root.y - 24,
  maxX: g.root.x + g.obj.unique_id % 13 + 32, maxY: g.root.y + g.obj.unique_id % 19 + 54});
const nativeBounds = g => {
  const b = objectBounds([...g.segments.filter(s => s.seg.visible !== false).map(s => ({...s, type: s.seg.segment_type || 'line'})), ...g.polys]);
  return {minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height};
};
const union = bounds => ({minX: Math.min(...bounds.map(b => b.minX)), minY: Math.min(...bounds.map(b => b.minY)),
  maxX: Math.max(...bounds.map(b => b.maxX)), maxY: Math.max(...bounds.map(b => b.maxY))});
const edgeAt = (bounds, axis, edge) => {
  const min = bounds[axis === 'x' ? 'minX' : 'minY'], max = bounds[axis === 'x' ? 'maxX' : 'maxY'];
  return edge === 'start' ? min : edge === 'end' ? max : (min + max) / 2;
};

for (const axis of ['x', 'y']) for (const edge of ['start', 'center', 'end']) {
  test(`joined-child alignment at ${axis}/${edge} translates whole components and records canonical saved origins`, () => {
    const editor = joinedFixture(); editor.selectMany([707, 500003]);
    const before = structuredClone(editor.frame), originalSelection = editor._selectionState();
    const beforeGeometry = editor.geometry, a = callbackBounds(beforeGeometry.objects.get(0)), b = callbackBounds(beforeGeometry.objects.get(1));
    const target = edgeAt(union([a, b]), axis, edge), offsets = [target - edgeAt(a, axis, edge), target - edgeAt(b, axis, edge)];
    assert.equal(editor.alignSelection(axis, edge, {boundsOf: callbackBounds}), true);
    const afterGeometry = editor.geometry;
    for (const [slot, entry] of beforeGeometry.objects) {
      const offset = offsets[slot === 1 ? 1 : 0], after = afterGeometry.objects.get(slot);
      near(after.root.x, entry.root.x + (axis === 'x' ? offset : 0));
      near(after.root.y, entry.root.y + (axis === 'y' ? offset : 0));
      for (let i = 0; i < entry.segments.length; i++) {
        near(after.segments[i].end.x, entry.segments[i].end.x + (axis === 'x' ? offset : 0));
        near(after.segments[i].end.y, entry.segments[i].end.y + (axis === 'y' ? offset : 0));
      }
      assert.deepEqual(editor.frame.objects[slot].join, before.objects[slot].join);
      assert.deepEqual(editor.frame.objects[slot].angles, before.objects[slot].angles);
      if (editor.frame.objects[slot].join) {
        near(editor.frame.objects[slot].root_x, after.root.x); near(editor.frame.objects[slot].root_y, after.root.y);
      }
    }
    near(edgeAt(callbackBounds(afterGeometry.objects.get(0)), axis, edge), target);
    near(edgeAt(callbackBounds(afterGeometry.objects.get(1)), axis, edge), target);
    assert.deepEqual(editor._selectionState(), originalSelection); assert.deepEqual(frameOrder(editor.frame), frameOrder(before));
    assert.equal(editor._undo.length, 1); assert.equal(editor._undo[0].kind, 'objects');
    assert.equal(editor._undo[0].before.length, 5); assert.doesNotThrow(() => validateScene(editor.serialize()));
    const after = structuredClone(editor.frame);
    editor.undo(); assert.deepEqual(editor.frame, before); assert.equal(editor.dirty, false);
    editor.redo(); assert.deepEqual(editor.frame, after); assert.deepEqual(editor._selectionState(), originalSelection);
  });
}

test('parent and child selections share one union and translate their ancestry root only once', () => {
  const editor = joinedFixture(); editor.selectMany([707, 1011, 500003]);
  const geometry = editor.geometry, root = {...geometry.objects.get(2).root};
  const group = union([callbackBounds(geometry.objects.get(0)), callbackBounds(geometry.objects.get(2))]);
  const separate = callbackBounds(geometry.objects.get(1));
  const target = Math.max(group.maxX, separate.maxX), delta = target - group.maxX;
  assert.equal(editor.alignSelection('x', 'end', {boundsOf: callbackBounds}), true);
  near(editor.geometry.objects.get(2).root.x, root.x + delta);
  const aligned = union([callbackBounds(editor.geometry.objects.get(0)), callbackBounds(editor.geometry.objects.get(2))]);
  near(aligned.maxX, target); assert.equal(editor._undo.length, 1);
});

test('selected siblings align as one group while unselected artwork does not influence the target', () => {
  const editor = joinedFixture(); editor.selectMany([707, 40, 500003]);
  const geometry = editor.geometry, group = union([callbackBounds(geometry.objects.get(0)), callbackBounds(geometry.objects.get(4))]);
  const target = Math.min(group.minY, callbackBounds(geometry.objects.get(1)).minY);
  editor.alignSelection('y', 'start', {boundsOf: callbackBounds});
  const aligned = union([callbackBounds(editor.geometry.objects.get(0)), callbackBounds(editor.geometry.objects.get(4))]);
  near(aligned.minY, target); near(callbackBounds(editor.geometry.objects.get(1)).minY, target);
});

test('default alignment bounds include native vector geometry and accept renderer rectangles', () => {
  const editor = joinedFixture(); editor.selectMany([707, 500003]);
  const bounds = [nativeBounds(editor.geometry.objects.get(0)), nativeBounds(editor.geometry.objects.get(1))];
  const target = Math.max(...bounds.map(b => b.maxY));
  assert.equal(editor.alignSelection('y', 'end'), true);
  for (const slot of [0, 1]) near(nativeBounds(editor.geometry.objects.get(slot)).maxY, target);
  editor.undo();
  assert.equal(editor.alignSelection('y', 'end', {boundsOf: g => {
    const b = nativeBounds(g); return {x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY};
  }}), true);
  for (const slot of [0, 1]) near(nativeBounds(editor.geometry.objects.get(slot)).maxY, target);
});

test('alignment is atomic for bad bounds and invalid arguments; one component creates no history', () => {
  const editor = joinedFixture(); editor.selectMany([707, 1011, 9]); const before = structuredClone(editor.frame);
  assert.equal(editor.alignSelection('x', 'start'), false); assert.equal(editor.canUndo, false);
  editor.selectMany([707, 500003]);
  assert.throws(() => editor.alignSelection('z', 'start'), /axis/);
  assert.throws(() => editor.alignSelection('x', 'middle'), /edge/);
  assert.throws(() => editor.alignSelection('x', 'start', {boundsOf: null}), /bounds function/);
  for (const invalid of [{minX: NaN, minY: 0, maxX: 10, maxY: 10}, {minX: 10, minY: 0, maxX: 0, maxY: 10}, null]) {
    let calls = 0;
    assert.throws(() => editor.alignSelection('x', 'end', {boundsOf: g => ++calls === 2 ? invalid : callbackBounds(g)}), /bounds/);
    assert.deepEqual(editor.frame, before); assert.equal(editor.dragging, false); assert.equal(editor.canUndo, false);
  }
  assert.throws(() => editor.alignSelection('x', 'start', {boundsOf: () => { throw new Error('measurement failed'); }}), /measurement failed/);
  assert.deepEqual(editor.frame, before); assert.equal(editor.dirty, false);
});

test('alignment measures the editable keyframe after a tween seek and commits an earlier drag separately', () => {
  const editor = joinedFixture(); editor.selectMany([707, 500003]);
  editor.frame.duration_raw = 10;
  const second = structuredClone(editor.frame); second.objects[1].root_x += 600;
  editor.report.keyframes.push(second); editor._invalidate({timing: true}); editor.seek(5);
  let measuredX;
  editor.alignSelection('x', 'start', {boundsOf: g => {
    if (g.obj.unique_id === 500003) measuredX = g.root.x;
    return callbackBounds(g);
  }});
  near(measuredX, 750); assert.equal(editor.tick, 0); assert.equal(editor._undo.length, 1);
  editor.undo(); editor.beginTranslationDrag('Prior movement'); editor.moveSelection(20, 0);
  assert.equal(editor.dragging, true);
  editor.alignSelection('x', 'end', {boundsOf: callbackBounds});
  assert.equal(editor.dragging, false); assert.equal(editor._undo.length, 2);
  assert.equal(editor._undo[0].label, 'Prior movement'); assert.equal(editor._undo[1].label, 'Align figures');
});
