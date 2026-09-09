import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {validateSimpleFrameDraft} from '../src/editor-frame-draft.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit} from '../src/native-property-edit.mjs';
import {documentChunks, applyDocumentChunk} from '../src/document-transport.mjs';

const clone = value => structuredClone(value);
function fixture(count = 4, objects = 3) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = Array.from({length: count}, (_, i) => createFrame(Array.from({length: objects}, (_, j) => createObject(figure, j + 1, i * 10 + j * 100, 180)), 5));
  const editor = new Editor({demo: false}).load(report); editor.enableFrameDrafts(); return editor;
}
function value(editor, uid, key, value) {
  editor.select(uid); const token = beginNativePropertyEdit(editor, key); previewNativePropertyEdit(token, value); commitNativePropertyEdit(token);
}

test('prepared load restores a validated Add baseline while rejecting invalid incoming and manual baselines', async () => {
  const source=fixture(2,8);source.beginFrameDraft({mode:'add',index:1});value(source,1,'root_x',85);
  const incoming=clone(source.report),target=fixture();
  await target.loadAsync(incoming);
  assert.equal(target.frameDraft.mode,'add');assert.equal(target.frameDraft.dirty,true);
  assert.equal(target.frame.objects[0].root_x,85);assert.equal(target.report._styk.simpleFrameDraft.baseline.objects[0].root_x,10);
  const current=target.report,invalid=clone(incoming);invalid._styk.simpleFrameDraft.baseline.objects[0].root_x=NaN;
  await assert.rejects(target.loadAsync(invalid));assert.equal(target.report,current);
  target.report._styk.simpleFrameDraft.baseline.objects[0].root_x=NaN;
  assert.throws(()=>target.enableFrameDrafts());
});
test('checkpoint is lazy and captures only first-touch objects across repeated in-place gestures', () => {
  const editor = fixture(1000, 100), frames = editor.report.keyframes.slice(), baseline = clone(editor.frame), untouched = editor.frame.objects[99];
  assert.equal(editor.frameDraft.capturedObjects, 0); assert.equal(editor._frameDraft.baseline, null);
  value(editor, 1, 'root_x', 50); value(editor, 1, 'root_x', 75); value(editor, 2, 'root_y', 400);
  assert.equal(editor.frameDraft.capturedObjects, 2); assert.equal(editor._frameDraft.baseline.objects[99], untouched);
  assert.equal(editor.report.keyframes[999], frames[999]); assert.equal(editor.report._styk.simpleFrameDraft.baseline, editor._frameDraft.baseline);
  editor.discardFrameDraft(); assert.deepEqual(editor.frame, baseline); assert.equal(editor.frameDraft.dirty, false);
  editor.undo(); assert.equal(editor.frame.objects[0].root_x, 75); assert.equal(editor.frame.objects[1].root_y, 400);
  editor.redo(); assert.deepEqual(editor.frame, baseline);
});
test('structural figure addition, deletion and order retain original slots, poses and joins on discard', () => {
  const editor = fixture(), before = clone(editor.frame);
  value(editor, 1, 'root_x', 55); editor.addFigure(); value(editor, 2, 'root_y', 500);
  editor.select(1); editor.deleteSelection(); editor.discardFrameDraft(); assert.deepEqual(editor.frame, before);
});
test('camera, Scene and inbetween duration edits revert together without touching project metadata or libraries', () => {
  const editor = fixture(), before = clone(editor.frame), frames = editor.report.keyframes.slice();
  editor.setCameraValues({x: 130, y: 44, scale: 1.7, angle_rad: .4});
  editor.setSceneColor(0xff447788); editor.setFramesDuration([0], 12);
  value(editor, 1, 'root_x', 80); editor.setCanvasSize(1200, 900);
  editor.discardFrameDraft(); assert.deepEqual(editor.frame, before); assert.equal(editor.report.canvas_width, 1200);
  assert.equal(editor.report.keyframes[3], frames[3]);
});
test('frame property patch captures missing nested branches and definition styles stay outside the draft', () => {
  const editor = fixture(), before = clone(editor.frame);
  value(editor, 1, 'duration', 9); value(editor, 1, 'outline_width', 4);
  editor.discardFrameDraft(); assert.deepEqual(editor.frame, before);
  assert.equal(editor.report.figure_types[0].segment_decode.global_style.outline_thickness, 4);
});
test('single-frame sparse range operations are discardable; multi-frame operations remain atomic', () => {
  const editor = fixture(), before = clone(editor.frame);
  editor.select(1); editor.updateFiguresInFrames({field28: 80}, [0]);
  editor.addFigureInFrames(1, [0], {x: 10, y: 20}); editor.discardFrameDraft(); assert.deepEqual(editor.frame, before);
  value(editor, 1, 'root_x', 55); editor.updateFiguresInFrames({field28: 90}, [0, 1]);
  assert.equal(editor.frameDraft.dirty, false); assert.equal(editor.discardFrameDraft(), false);
  assert.equal(editor.report.keyframes[0].objects[0].field28, 90); assert.equal(editor.report.keyframes[1].objects[0].field28, 90);
});
test('selecting another frame stores its edits and starts a new independent checkpoint', () => {
  const editor = fixture(); value(editor, 1, 'root_x', 60); editor.selectFrame(1);
  assert.equal(editor.frameDraft.mode, 'update'); assert.equal(editor.frameDraft.dirty, false);
  value(editor, 1, 'root_x', 90); editor.discardFrameDraft(); assert.equal(editor.frame.objects[0].root_x, 10);
  assert.equal(editor.report.keyframes[0].objects[0].root_x, 60);
});
test('Add stores an edited working copy at the end and preserves the saved source frame with one undo', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); const before = clone(editor.frame), history = editor._undo.length;
  value(editor, 1, 'root_x', 900); editor.addDraftFrame();
  assert.equal(editor.report.keyframes.length, 5); assert.deepEqual(editor.report.keyframes[3], before);
  assert.equal(editor.frameIndex, 4); assert.equal(editor.frame.objects[0].root_x, 900); assert.equal(editor.frameDraft.mode, 'add');
  assert.notEqual(editor.frame._styk.frameId, before._styk.frameId); assert.equal(editor._undo.length, history + 2);
  editor.undo(); assert.equal(editor.report.keyframes.length, 4); assert.equal(editor.frame.objects[0].root_x, 900);
  assert.equal(editor.frameDraft.mode, 'add'); assert.equal(editor.frameDraft.dirty, true);
  assert.deepEqual(editor.report._styk.simpleFrameDraft.baseline, before);
  editor.redo(); assert.equal(editor.report.keyframes.length, 5); assert.deepEqual(editor.report.keyframes[3], before);
});
test('Update commits current frame; subsequent Add appends a new pose even when Update was in the middle', () => {
  const editor = fixture(); value(editor, 1, 'root_x', 60); editor.updateDraftFrame();
  assert.equal(editor.frameIndex, 3); assert.equal(editor.frame.objects[0].root_x, 30);
  value(editor, 1, 'root_x', 90); editor.addDraftFrame();
  assert.equal(editor.report.keyframes[0].objects[0].root_x, 60); assert.equal(editor.frameIndex, 4); assert.equal(editor.frame.objects[0].root_x, 90);
  assert.equal(editor.report.keyframes[3].objects[0].root_x, 30);
});
test('STYK serialization and bounded transport retain baseline and working pose without appending frames', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 99);
  const saved = editor.serialize(); validateSimpleFrameDraft(saved); assert.equal(saved.keyframes.length, 4);
  let transported; for (const chunk of documentChunks(saved, {maxBytes: 4096})) transported = applyDocumentChunk(transported, clone(chunk));
  const reopened = new Editor({demo: false}).load(transported); reopened.enableFrameDrafts();
  assert.equal(reopened.frameIndex, 3); assert.equal(reopened.frameDraft.mode, 'add'); assert.equal(reopened.frameDraft.dirty, true);
  value(reopened, 2, 'root_y', 410); reopened.addDraftFrame();
  assert.equal(reopened.report.keyframes[3].objects[0].root_x, 30); assert.equal(reopened.report.keyframes[3].objects[1].root_y, 180);
  assert.equal(reopened.frame.objects[0].root_x, 99); assert.equal(reopened.frame.objects[1].root_y, 410);
});
test('malformed persisted checkpoints are rejected before replacing the current document', () => {
  const editor = fixture(), current = editor.report, invalid = clone(current);
  invalid._styk.simpleFrameDraft = {version: 1, mode: 'add', index: 5, frameId: 'frame-6'};
  assert.throws(() => editor.load(invalid), /working frame/); assert.equal(editor.report, current);
  invalid._styk.simpleFrameDraft = {version: 1, mode: 'add', index: 0, frameId: invalid.keyframes[0]._styk.frameId, baseline: {}};
  assert.throws(() => editor.load(invalid), /identity/); assert.equal(editor.report, current);
});
test('Advanced mode retains direct edits and removes draft state without reverting the pose', () => {
  const editor = fixture(); value(editor, 1, 'root_x', 35); editor.disableFrameDrafts();
  assert.equal(editor.frameDraft, null); assert.equal(editor.frame.objects[0].root_x, 35); assert.equal(editor.report._styk.simpleFrameDraft, undefined);
  value(editor, 1, 'root_x', 60); assert.equal(editor.discardFrameDraft(), false);
});
test('switching to Advanced materializes an Add draft without overwriting its stored source', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 80);
  const saved = editor.serialize();
  assert.equal(editor.disableFrameDrafts(), true); assert.equal(editor.report.keyframes.length, 5);
  assert.equal(editor.report.keyframes[3].objects[0].root_x, 30); assert.equal(editor.report.keyframes[4].objects[0].root_x, 80);
  const reopened = new Editor({demo: false}).load(saved); assert.equal(reopened.disableFrameDrafts(), true);
  assert.equal(reopened.report.keyframes[3].objects[0].root_x, 30); assert.equal(reopened.report.keyframes[4].objects[0].root_x, 80);
});
test('metadata-only Update and seek changes have a snapshot/cache revision without making a clean document dirty', () => {
  const editor = fixture(), revision = editor.revision, draftRevision = editor.frameDraftRevision;
  editor.commitFrameDraft({mode: 'add'});
  assert.equal(editor.revision, revision); assert.equal(editor.dirty, false); assert.ok(editor.frameDraftRevision > draftRevision);
  let metadataAtEdit;
  editor.addEventListener('change', event => { if (event.detail.kind === 'edit') metadataAtEdit = editor.report._styk.simpleFrameDraft; });
  value(editor, 1, 'root_x', 99); assert.ok(metadataAtEdit.baseline); const changed = editor.frameDraftRevision;
  editor.commitFrameDraft({mode: 'update'}); editor.selectFrame(1); assert.ok(editor.frameDraftRevision > changed); assert.equal(editor.report._styk.simpleFrameDraft.index, 1);
});
test('preview playback can seek all frames and Stop restores the exact working pose and checkpoint', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 85);
  const saved = clone(editor.report._styk.simpleFrameDraft), revision = editor.frameDraftRevision;
  editor.beginFrameDraftPreview(); for (let tick = 0; tick < editor.totalTicks; tick++) editor.seek(tick);
  assert.deepEqual(editor.report._styk.simpleFrameDraft, saved); assert.equal(editor.frameDraftRevision, revision);
  assert.equal(editor.endFrameDraftPreview(), true); assert.equal(editor.frameIndex, 3); assert.equal(editor.frame.objects[0].root_x, 85);
  assert.deepEqual(editor.report._styk.simpleFrameDraft, saved); assert.equal(editor.frameDraft.dirty, true);
});
test('unsupported dirty Add global edits do not append or overwrite either pose', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 85);
  assert.throws(() => editor.deleteFrames([0]), /working frame/);
  assert.equal(editor.report.keyframes.length, 4); assert.equal(editor.frame.objects[0].root_x, 85);
  assert.equal(editor.report._styk.simpleFrameDraft.baseline.objects[0].root_x, 30); assert.equal(editor.frameDraft.dirty, true);
});

test('shared topology transforms stored and working poses without storing an Add draft', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 85);
  const count = editor.figure.segments.length, before = clone(editor.report._styk.simpleFrameDraft.baseline);
  editor.addSegment({length: 35, angle: .2});
  assert.equal(editor.report.keyframes.length, 4); assert.equal(editor.frameDraft.mode, 'add'); assert.equal(editor.frameDraft.dirty, true);
  assert.equal(editor.frame.objects[0].root_x, 85); assert.equal(editor.report._styk.simpleFrameDraft.baseline.objects[0].root_x, 30);
  for (const frame of [editor.frame, editor.report._styk.simpleFrameDraft.baseline]) for (const object of frame.objects) assert.equal(object.angles.length, count + 1);
  editor.undo(); assert.equal(editor.frameDraft.dirty, true); assert.deepEqual(editor.report._styk.simpleFrameDraft.baseline, before);
  editor.redo(); assert.equal(editor.frameDraft.dirty, true); assert.equal(editor.figure.segments.length, count + 1);
  editor.discardFrameDraft(); assert.equal(editor.frame.objects[0].root_x, 30); assert.equal(editor.figure.segments.length, count + 1);
});

test('topology history restores a cleared journal and later untouched poses still capture their original values', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 85);
  const type = clone(editor.figure); type.figure_type_id = 2; editor.report.figure_types.push(type);
  editor.frame.objects[2].figure_type_id = 2;
  editor.addSegment({length: 35});
  const count = editor.figure.segments.length;
  editor.updateDraftFrame(); assert.equal(editor.frameDraft.dirty, false);
  editor.undo(); assert.equal(editor.frameDraft.mode, 'add'); assert.equal(editor.frameDraft.dirty, true);
  assert.equal(editor.figure.segments.length, count - 1); assert.equal(editor.frame.objects[0].root_x, 85);
  value(editor, 3, 'root_x', 800); editor.discardFrameDraft();
  assert.equal(editor.frame.objects[2].root_x, 230); assert.equal(editor.frame.objects[0].root_x, 30);
});

test('replacement definition and STYK reopening retain the separate stored frame after a topology edit', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 85);
  const replacement = clone(editor.figure); replacement.segments[0].angle_rad += .3;
  editor.replaceFigureDefinition(1, replacement); assert.equal(editor.frameDraft.dirty, true);
  const reopened = new Editor({demo: false}).load(editor.serialize()); reopened.enableFrameDrafts();
  assert.equal(reopened.frameDraft.dirty, true); assert.equal(reopened.report.keyframes.length, 4);
  assert.equal(reopened.frame.objects[0].root_x, 85); reopened.discardFrameDraft(); assert.equal(reopened.frame.objects[0].root_x, 30);
  assert.equal(reopened.figure.segments[0].angle_rad, replacement.segments[0].angle_rad);
});

test('Undo and Redo local edits preserve Add mode, its stored baseline and later first-touch capture', () => {
  const editor = fixture(); editor.beginFrameDraft({mode:'add', index:3});
  value(editor,1,'root_x',85); value(editor,2,'root_x',555);
  editor.undo(); assert.equal(editor.frameDraft.mode,'add'); assert.equal(editor.frameDraft.dirty,true);
  assert.equal(editor.frame.objects[0].root_x,85); assert.equal(editor.frame.objects[1].root_x,130);
  assert.equal(editor.report._styk.simpleFrameDraft.baseline.objects[0].root_x,30);
  editor.redo(); assert.equal(editor.frameDraft.mode,'add'); assert.equal(editor.frame.objects[1].root_x,555);
  editor.undo(); value(editor,3,'root_x',800); editor.discardFrameDraft();
  assert.deepEqual(editor.frame.objects.map(object=>object.root_x),[30,130,230]);
  const first=fixture(); first.beginFrameDraft({mode:'add',index:3}); value(first,1,'root_x',85); first.undo();
  assert.equal(first.frameDraft.mode,'add'); assert.equal(first.frameDraft.dirty,false);
  first.redo(); assert.equal(first.frameDraft.mode,'add'); assert.equal(first.frameDraft.dirty,true);
});

test('context Paste Insert preserves Add pose, edits stored frames and has one atomic Undo', () => {
  const editor=fixture(); editor.copyFrames([0]); editor.beginFrameDraft({mode:'add',index:3}); value(editor,1,'root_x',85);
  const before=clone(editor.report),history=editor._undo.length;
  editor.editStoredFrames(()=>editor.pasteFrames(1));
  assert.equal(editor._undo.length,history+1); assert.equal(editor.report.keyframes.length,5); assert.equal(editor.frameIndex,4);
  assert.equal(editor.frame.objects[0].root_x,85); assert.equal(editor.report._styk.simpleFrameDraft.baseline.objects[0].root_x,30);
  assert.deepEqual(editor.report.keyframes.slice(0,-1).map(frame=>frame.objects[0].root_x),[0,0,10,20]);
  editor.undo(); assert.deepEqual(editor.report,before); assert.equal(editor.frameDraft.dirty,true);
  editor.redo(); assert.equal(editor.report.keyframes.length,5); assert.equal(editor.frame.objects[0].root_x,85);
});

test('single context Delete retains Add working pose even when deleting its source key', () => {
  const editor=fixture(); editor.beginFrameDraft({mode:'add',index:3}); value(editor,1,'root_x',85);
  const before=clone(editor.report); editor.editStoredFrames(()=>editor.deleteFrames([3]));
  assert.equal(editor.report.keyframes.length,3); assert.equal(editor.frameIndex,2); assert.equal(editor.frame.objects[0].root_x,85);
  assert.equal(editor.report._styk.simpleFrameDraft.baseline.objects[0].root_x,20);
  const reopened=new Editor({demo:false}).load(editor.serialize()); reopened.enableFrameDrafts(); reopened.discardFrameDraft();
  assert.equal(reopened.frame.objects[0].root_x,20); editor.undo(); assert.deepEqual(editor.report,before);
});

test('toolbar Delete and Paste-end discard Add working copy inside their single history command', () => {
  for (const operation of [editor=>editor.deleteFrames([0,1]),editor=>editor.pasteFrames(editor.report.keyframes.length)]) {
    const editor=fixture(); editor.copyFrames([0]); editor.beginFrameDraft({mode:'add',index:3}); value(editor,1,'root_x',85);
    const before=clone(editor.report),history=editor._undo.length;
    editor.editStoredFrames(()=>operation(editor),{preserveWorking:false});
    assert.equal(editor._undo.length,history+1); assert.equal(editor.frameDraft.mode,'add'); assert.equal(editor.frameDraft.dirty,false);
    assert.notEqual(editor.frame.objects[0].root_x,85); editor.undo(); assert.deepEqual(editor.report,before); editor.redo(); assert.equal(editor.frameDraft.dirty,false);
  }
});

test('invalid and no-op stored-frame operations preserve the exact working state and history', () => {
  for(const operation of [editor=>editor.moveFrame(2,2),editor=>editor.deleteFrames([-1])]) {
    const editor=fixture(); editor.beginFrameDraft({mode:'add',index:3}); value(editor,1,'root_x',85);
    const before=clone(editor.report),history=editor._undo.length;
    try { editor.editStoredFrames(()=>operation(editor)); } catch(error) { assert.match(error.message,/existing keyframe/); }
    assert.deepEqual(editor.report,before); assert.equal(editor._undo.length,history); assert.equal(editor.frameDraft.mode,'add');
  }
});

test('zero stored keys retain an editable placeholder; first Add promotes it and Undo returns to zero',()=>{
  const editor=fixture(1);editor.beginFrameDraft({mode:'add',empty:true});value(editor,1,'root_x',85);
  assert.equal(editor.frameDraft.storedCount,0);assert.equal(editor.totalTicks,0);assert.deepEqual(editor.timeline,[]);
  const before=clone(editor.report),history=editor._undo.length;
  editor.addDraftFrame();assert.equal(editor.report.keyframes.length,1);assert.equal(editor.frameDraft.empty,false);
  assert.equal(editor.frame.objects[0].root_x,85);assert.equal(editor.totalTicks,1);assert.equal(editor._undo.length,history+1);
  editor.undo();assert.deepEqual(editor.report,before);assert.equal(editor.frameDraft.empty,true);assert.equal(editor.totalTicks,0);
  editor.redo();assert.equal(editor.totalTicks,1);assert.equal(editor.frameDraft.empty,false);
});

test('Delete all restores zero stored keys while retaining the working pose and supports one Undo',()=>{
  const editor=fixture();editor.beginFrameDraft({mode:'add',index:3});value(editor,1,'root_x',85);
  const before=clone(editor.report),history=editor._undo.length;
  editor.editStoredFrames(()=>editor.deleteFrames([0,1,2,3]),{preserveWorking:true,empty:true});
  assert.equal(editor.report.keyframes.length,1);assert.equal(editor.frameDraft.empty,true);assert.equal(editor.totalTicks,0);assert.equal(editor.frame.objects[0].root_x,85);
  assert.equal(editor._undo.length,history+1);editor.undo();assert.deepEqual(editor.report,before);editor.redo();assert.equal(editor.totalTicks,0);
  const reopened=new Editor({demo:false}).load(editor.serialize());reopened.enableFrameDrafts();assert.equal(reopened.frameDraft.empty,true);
  assert.equal(reopened.totalTicks,0);assert.equal(reopened.frame.objects[0].root_x,85);
});

test('Paste into zero stored keys excludes the placeholder and Undo restores its working pose',()=>{
  const editor=fixture(1);editor.copyFrames([0]);editor.beginFrameDraft({mode:'add',empty:true});value(editor,1,'root_x',85);
  const before=clone(editor.report);editor.editStoredFrames(()=>editor.pasteFrames(0),{preserveWorking:false});
  assert.equal(editor.report.keyframes.length,1);assert.equal(editor.frameDraft.empty,false);assert.equal(editor.frame.objects[0].root_x,0);
  const ticks=editor.totalTicks;editor.undo();assert.deepEqual(editor.report,before);assert.equal(editor.totalTicks,0);editor.redo();assert.equal(editor.totalTicks,ticks);
});

test('Advanced conversion promotes an empty working placeholder and malformed empty metadata is rejected',()=>{
  const editor=fixture(1);editor.beginFrameDraft({mode:'add',empty:true});assert.equal(editor.disableFrameDrafts(),true);
  assert.equal(editor.report.keyframes.length,1);assert.equal(editor.totalTicks,1);assert.equal(editor.report._styk.simpleFrameDraft,undefined);
  const bad=fixture().serialize();bad._styk.simpleFrameDraft={version:1,mode:'add',index:0,frameId:bad.keyframes[0]._styk.frameId,empty:true};
  assert.throws(()=>validateSimpleFrameDraft(bad),/placeholder/);
});
test('invalid and no-op global commands restore the exact draft, identities, history and Redo stack', () => {
  for (const operation of [editor => editor.moveFrame(2, 2), editor => editor.deleteFrames([-1]), editor => editor.pasteFrames(0)]) {
    const editor = fixture(); editor.beginFrameDraft({mode: 'add'}); value(editor, 1, 'root_x', 85);
    editor.addDraftFrame(); editor.undo();
    // A real undoable Add retains its working-pose checkpoint in the Redo entry.
    const before = clone(editor.report), nextId = editor._nextFrameIdentity, nextUid = editor._nextUid, undo = editor._undo.slice(), redo = editor._redo.slice(), revision = editor.revision, historySize = editor.historySize;
    try { operation(editor); } catch (error) { assert.match(error.message, /working frame/); }
    assert.deepEqual(editor.report, before); assert.equal(editor._nextFrameIdentity, nextId); assert.equal(editor._nextUid, nextUid);
    assert.deepEqual(editor._undo, undo); assert.deepEqual(editor._redo, redo); assert.equal(editor.revision, revision);
    assert.equal(editor.historySize, historySize);
    assert.equal(editor.frameDraft.mode, 'add'); assert.equal(editor.frameDraft.dirty, true);
  }
});
test('copying stored frames excludes a dirty Add working pose', () => {
  const editor = fixture(); editor.beginFrameDraft({mode: 'add', index: 3}); value(editor, 1, 'root_x', 85);
  editor.copyFrames([3]); assert.equal(editor._frameClipboard[0].objects[0].root_x, 30);
  assert.equal(editor.frame.objects[0].root_x, 85); assert.equal(editor.frameDraft.dirty, true);
});

