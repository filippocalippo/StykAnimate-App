import test from 'node:test';
import assert from 'node:assert/strict';
import {engineEditor, newOwnedEditor} from './support/owned-editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {materializeSimpleFrameDraftForPivot} from '../src/pivot-frame-draft.mjs';
import {roundTrip} from './support/codec.mjs';
import {pivotDocument, keepsStoredFrames} from './support/engine-export.mjs';

/** Three stored keys whose second is being worked on (moved to 777, its checkpoint at 200), in an editor the engine owns. */
function fixture(mode = 'add', edit = null) {
  const report = emptyDocument();
  report.keyframes = [100, 200, 300].map((x, index) => ({...createFrame([createObject(report.figure_types[0], 1, x, 250)], 5), _styk: {frameId: `frame-${index + 1}`}}));
  const baseline = structuredClone(report.keyframes[1]);
  report.keyframes[1].objects[0].root_x = 777;
  report._styk.simpleFrameDraft = {version: 1, mode, index: 1, frameId: baseline._styk.frameId, baseline};
  edit?.(report);
  return engineEditor({demo: false}, report);
}
test('native Add working pose stays editable in STYK but PIV exports only the saved keys', () => {
  const editor = fixture(), report = editor.report, before = structuredClone(report), out = pivotDocument(editor);
  assert.equal(out.keyframes.length, 3); assert.deepEqual(out.keyframes.map(f => f.objects[0].root_x), [100, 200, 300]);
  assert.equal(out._styk.simpleFrameDraft, undefined); assert.deepEqual(report, before);
  assert.deepEqual(out.keyframes[0].objects, report.keyframes[0].objects); assert.deepEqual(out.figure_types, report.figure_types);
  const reopened = newOwnedEditor({demo: false}).load(JSON.parse(JSON.stringify(report)));
  assert.equal(reopened.report.keyframes[1].objects[0].root_x, 777);
  assert.equal(reopened.report._styk.simpleFrameDraft.baseline.objects[0].root_x, 200);
});
test('Update working pose is already a native key; clean native documents retain the exact export path', () => {
  const editor = fixture('update'), report = editor.report, out = materializeSimpleFrameDraftForPivot(report);
  assert.equal(out.keyframes, report.keyframes); assert.equal(out.keyframes[1].objects[0].root_x, 777);
  assert.equal(out._styk.simpleFrameDraft, undefined);
  assert.equal(pivotDocument(editor).keyframes[1].objects[0].root_x, 777);
  delete report._styk.simpleFrameDraft; assert.equal(materializeSimpleFrameDraftForPivot(report), report);
  assert.equal(keepsStoredFrames(fixture('update', document => { delete document._styk.simpleFrameDraft; })), true);
});
test('draft identity validation rejects a bad checkpoint when the document opens', () => {
  assert.throws(() => fixture('add', document => { document._styk.simpleFrameDraft.baseline._styk.frameId = 'wrong'; }), /identity/);
});
test('actual PIV writer preserves stored frame count and excludes Add working geometry', async () => {
  const report = pivotDocument(fixture());
  const reopened = await roundTrip({document: report, format: 'piv'}); assert.equal(reopened.keyframes.length, 3);
  assert.deepEqual(reopened.keyframes.map(f => f.objects[0].root_x), [100, 200, 300]);
  assert.deepEqual(reopened.keyframes.map(f => f.duration_raw), [5, 5, 5]);
  assert.equal(reopened._styk?.simpleFrameDraft, undefined);
});
