import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {evaluatedFrame, timeline} from '../src/pivot/geometry.mjs';
import {storedFrameReport} from '../src/pivot-frame-draft.mjs';
import {validateAnimationDocument} from '../src/animation-channels.mjs';
import {beginNativePropertyEdit, previewNativePropertyEdit, commitNativePropertyEdit} from '../src/native-property-edit.mjs';
import {compilePlaybackPacket} from '../src/playback-worker.mjs';

const target = {kind: 'figure', uid: 1};
function fixture() {
  const report = emptyDocument();
  report.keyframes = [0, 30, 60].map(x => createFrame([createObject(report.figure_types[0], 1, x, 180)], 5));
  const editor = new Editor({demo: false}).load(report);
  editor.addAnimationKeys([{target, property: 'x', tick: 0, value: 100}, {target, property: 'x', tick: 10, value: 200}]);
  editor.selectFrame(2); editor.select(1);
  return editor;
}
function edit(editor, x) {
  const token = beginNativePropertyEdit(editor, 'root_x');
  previewNativePropertyEdit(token, x); commitNativePropertyEdit(token);
}
function storedX(editor, index = 2) {
  const report = storedFrameReport(editor.report), tick = timeline(report)[index].start;
  return evaluatedFrame(report, index, 0, tick).objects[0].root_x;
}

test('Simple checkpoints authored poses and Discard restores both curves and native poses with undo/redo', () => {
  const editor = fixture(), baseline = structuredClone(editor.report._styk.animation);
  editor.enableFrameDrafts(); edit(editor, 280);
  assert.equal(editor.frameDraft.dirty, true);
  assert.equal(editor.evaluatedFrame.objects[0].root_x, 280);
  editor.seek(editor.totalTicks - 1); assert.equal(editor.evaluatedFrame.objects[0].root_x, 280);
  editor.discardFrameDraft();
  assert.equal(editor.evaluatedFrame.objects[0].root_x, 200);
  assert.deepEqual(editor.report._styk.animation, baseline);
  editor.undo(); assert.equal(editor.evaluatedFrame.objects[0].root_x, 280); assert.equal(editor.frameDraft.dirty, true);
  editor.redo(); assert.equal(editor.evaluatedFrame.objects[0].root_x, 200); assert.equal(editor.frameDraft.dirty, false);
});

test('camera and Scene checkpoints discard together and stored worker playback uses the original curves', async () => {
  const editor = fixture();
  editor.addAnimationKeys([{target: {kind:'camera'}, property:'x', tick:10, value:20},
    {target: {kind:'scene'}, property:'color', tick:10, value:0xff112233}]);
  editor.enableFrameDrafts({mode:'add'});
  editor.setCameraValues({x:90}); editor.setSceneColor(0xff445566); edit(editor, 280);
  const stored = storedFrameReport(editor.report), frame = evaluatedFrame(stored, 2, 0, 10);
  assert.equal(frame.camera.x, 20); assert.equal(frame._stykBackgroundColor, 0xff112233);
  const packet = await compilePlaybackPacket(editor.report, 10, {storedFrames:true});
  assert.equal(packet.transforms[4], 200);
  editor.discardFrameDraft();
  assert.equal(editor.evaluatedFrame.camera.x, 20);
  assert.equal(editor.evaluatedFrame._stykBackgroundColor, 0xff112233);
  assert.equal(editor.evaluatedFrame.objects[0].root_x, 200);
});

test('an appended frame preserves every prior output tick for native and automatic easing', () => {
  for (const automatic of [false, true]) {
    const editor = fixture(); editor.report.auto_easing = automatic;
    if (automatic) {
      const channel = editor.animationChannel(target, 'x');
      editor.setAnimationKeysEasing([{channelId:channel.id,keyIds:channel.keys.map(key=>key.id)}], {interpolation:'auto'});
    }
    const before = Array.from({length:editor.totalTicks}, (_,tick) => { editor.seek(tick); return editor.evaluatedFrame.objects[0].root_x; });
    editor.selectFrame(2); editor.enableFrameDrafts({mode:'add'}); edit(editor, 280); editor.addDraftFrame();
    for (let tick=0;tick<before.length;tick++) { editor.seek(tick); assert.equal(editor.evaluatedFrame.objects[0].root_x,before[tick],`tick ${tick}, automatic ${automatic}`); }
    editor.seek(editor.totalTicks-1); assert.equal(editor.evaluatedFrame.objects[0].root_x,280);
  }
});

test('long held exposures append without allocating per-tick pose sources', () => {
  const editor = fixture(); editor.setFramesDuration([2],65535);
  editor.enableFrameDrafts({mode:'add'}); edit(editor,280);
  const sources = Object.keys(editor.report._styk.frameSources).length;
  editor.addDraftFrame();
  assert.equal(Object.keys(editor.report._styk.frameSources).length,sources);
  assert.ok(editor.animationChannels.every(channel=>channel.keys.length<10));
  editor.seek(editor.totalTicks-1); assert.equal(editor.evaluatedFrame.objects[0].root_x,280);
});

test('invalid persisted animation checkpoints are rejected atomically', async () => {
  const editor=fixture();editor.enableFrameDrafts({mode:'add'});edit(editor,280);
  const saved=editor.serialize(), restored=fixture(), previous=restored.report;
  saved._styk.simpleFrameDraft.animationBaseline.channels[0].keys[0].value=NaN;
  await assert.rejects(restored.loadAsync(saved),/finite/);
  assert.equal(restored.report,previous);
});

test('a rejected Add or mode switch preserves the draft, document, history, and identity allocator', () => {
  const editor=fixture();editor.report.auto_easing=true;editor.setFramesDuration([1],20000);editor.selectFrame(2);
  editor.enableFrameDrafts({mode:'add'});edit(editor,280);
  const before=structuredClone(editor.report), identity=editor._nextFrameIdentity, history=editor._undo.length;
  for (const operation of [()=>editor.addDraftFrame(),()=>editor.disableFrameDrafts()]) {
    assert.throws(operation,/10,000/);
    assert.deepEqual(editor.report,before);assert.equal(editor._nextFrameIdentity,identity);
    assert.equal(editor._undo.length,history);assert.equal(editor.frameDraft.dirty,true);
  }
});

test('stored-frame deletion preserves an authored Add copy and replays correctly across mode changes', () => {
  const editor=fixture();editor.enableFrameDrafts({mode:'add'});edit(editor,280);
  editor.editStoredFrames(()=>editor.deleteFrames([0]));
  assert.equal(editor.report.keyframes.length,2);assert.equal(editor.frameDraft.dirty,true);
  assert.equal(editor.evaluatedFrame.objects[0].root_x,280);
  editor.undo();assert.equal(editor.report.keyframes.length,3);assert.equal(storedX(editor),200);
  editor.redo();assert.equal(editor.report.keyframes.length,2);assert.equal(editor.evaluatedFrame.objects[0].root_x,280);
  editor.discardFrameDraft();assert.notEqual(editor.evaluatedFrame.objects[0].root_x,280);
  editor.disableFrameDrafts();editor.undo();editor.undo();editor.redo();
  assert.equal(editor.report._styk.simpleFrameDraft,undefined);
  validateAnimationDocument(editor.report);
});

test('shared rig splitting remaps both stored and working animation styles, including undo/redo', () => {
  const editor=fixture(), handle=editor.figure.segments[0].segment_id;
  const segment={kind:'segment',uid:1,handleId:handle};
  editor.addAnimationKey(segment,'opacity',10,.6);
  editor.enableFrameDrafts({mode:'add'});editor.addAnimationKey(segment,'opacity',10,.3);
  editor.select(1,0);editor.splitSegment();
  const checkpoint=structuredClone(editor.report._styk.simpleFrameDraft.animationBaseline);
  assert.equal(checkpoint.channels.filter(channel=>channel.property==='opacity').length,2);
  editor.undo();editor.redo();
  assert.deepEqual(editor.report._styk.simpleFrameDraft.animationBaseline,checkpoint);
  editor.discardFrameDraft();
  assert.ok(editor.animationChannels.filter(channel=>channel.property==='opacity').every(channel=>channel.keys[0].value===.6));
  validateAnimationDocument(editor.report);
});

test('failed shared rig edits restore working and checkpoint channel mappings', () => {
  const editor=fixture(), handle=editor.figure.segments[0].segment_id;
  const segment={kind:'segment',uid:1,handleId:handle};
  editor.addAnimationKey(segment,'opacity',10,.6);
  editor.enableFrameDrafts({mode:'add'});editor.addAnimationKey(segment,'opacity',10,.3);
  const animation=structuredClone(editor.report._styk.animation),checkpoint=structuredClone(editor.report._styk.simpleFrameDraft.animationBaseline);
  assert.throws(()=>editor._topologyEdit('Invalid rig',figure=>{figure.segments[0].length=NaN;},{segmentMap:new Map([[handle,[]]])}));
  assert.deepEqual(editor.report._styk.animation,animation);
  assert.deepEqual(editor.report._styk.simpleFrameDraft.animationBaseline,checkpoint);
  editor.discardFrameDraft();validateAnimationDocument(editor.report);
});

test('Simple Add stores an authored working pose without changing the stored source, including history in Advanced', () => {
  const editor = fixture(); editor.enableFrameDrafts({mode: 'add'});
  edit(editor, 280);
  assert.equal(storedX(editor), 200);
  editor.addDraftFrame();
  assert.equal(editor.report.keyframes.length, 4);
  assert.equal(storedX(editor), 200);
  assert.equal(editor.evaluatedFrame.objects[0].root_x, 280);
  validateAnimationDocument(editor.report);
  editor.undo(); assert.equal(editor.report.keyframes.length, 3); assert.equal(editor.evaluatedFrame.objects[0].root_x, 280);
  assert.equal(storedX(editor), 200);
  editor.redo(); assert.equal(editor.evaluatedFrame.objects[0].root_x, 280);
  editor.disableFrameDrafts(); editor.undo(); editor.redo();
  assert.equal(editor.report._styk.simpleFrameDraft, undefined);
  assert.equal(editor.evaluatedFrame.objects[0].root_x, 280);
  validateAnimationDocument(editor.report);
});

test('mode switches retain committed poses, sparse key identities, and settle active property gestures', () => {
  const editor = fixture(), keys = editor.animationChannels[0].keys.map(key => key.id);
  for (let i = 0; i < 5; i++) { editor.enableFrameDrafts(); editor.disableFrameDrafts(); }
  assert.deepEqual(editor.animationChannels[0].keys.map(key => key.id), keys);
  editor.enableFrameDrafts();
  editor.beginAnimationEdit(target, 'x'); editor.previewAnimationEdit(340);
  editor.disableFrameDrafts();
  assert.equal(editor._animationEdit, null); assert.equal(editor.evaluatedFrame.objects[0].root_x, 340);
  editor.undo(); assert.equal(editor.evaluatedFrame.objects[0].root_x, 200);
  editor.redo(); editor.enableFrameDrafts(); assert.equal(editor.evaluatedFrame.objects[0].root_x, 340);
});

test('STYK reopen restores an authored Add checkpoint in either timeline', async () => {
  const editor = fixture(); editor.enableFrameDrafts({mode: 'add'}); edit(editor, 280);
  const saved = editor.serialize();
  for (const simple of [true, false]) {
    const restored = new Editor({demo: false}); await restored.loadAsync(structuredClone(saved));
    if (simple) {
      restored.enableFrameDrafts(); assert.equal(storedX(restored), 200);
      restored.discardFrameDraft(); assert.equal(restored.evaluatedFrame.objects[0].root_x, 200);
    } else {
      restored.disableFrameDrafts(); assert.equal(restored.report.keyframes.length, 4);
      assert.equal(restored.evaluatedFrame.objects[0].root_x, 280);
      assert.equal(storedX(restored), 200);
    }
    validateAnimationDocument(restored.report);
  }
});
