import test from 'node:test';
import assert from 'node:assert/strict';
import {createObject, createFrame, defaultFigure, emptyDocument} from '../src/demo.mjs';
import {setOrder} from './support/frame-order.mjs';
import {ownedScope} from './support/owned-scope.mjs';

const open = ownedScope();

function fixture() {
  const report = emptyDocument(), [a, b, c] = [17, 300, 900].map(defaultFigure);
  a.segments.forEach(segment => { segment.segment_id *= 11; segment.parent_id *= 11; });
  report.figure_types = [a, b, c];
  const objects = [createObject(a, 1011, 200, 200), createObject(b, 40, 300, 200),
    createObject(a, 707, 400, 200), createObject(c, 9, 500, 200), createObject(b, 500003, 600, 200)];
  objects[2].join = {target_object_slot: 0, target_unique_id: 1011, target_handle_id: 33};
  report.keyframes = [createFrame(objects)];
  setOrder(report.keyframes[0], [9, 707, 1011, 500003, 40]);
  const editor = open({demo: false}); editor.load(report); return editor;
}
const ids = editor => [...editor.selectedUids];

test('connected selection traverses both directions by slots without touching the document or history', () => {
  const editor = fixture(), before = structuredClone(editor.report), geometry = editor.geometry;
  editor.selectConnected(707);
  assert.deepEqual(ids(editor), [1011, 707]); assert.equal(editor.selectedUid, 707);
  assert.equal(editor.geometry, geometry); assert.equal(editor.canUndo, false);
  assert.deepEqual(editor.report, before);
  editor.selectMany([40]); editor.selectConnected(707, {add:true, candidates:[707]});
  assert.deepEqual(ids(editor), [40,707]);
});

test('branch selection includes descendants and attachments', () => {
  const editor = fixture();
  editor.selectBranch(1011, 2);
  assert.equal(editor.branchSelected, true); assert.deepEqual(ids(editor), [1011,707]);
  assert.equal(editor.selectedJoint, 2); assert.equal(editor.canUndo, false);
  editor.select(1011,2); assert.equal(editor.branchSelected,true);
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
