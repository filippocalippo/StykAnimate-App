import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';
import {materializeSimpleFrameDraftForPivot} from '../src/pivot-frame-draft.mjs';
import backend from '../desktop/backend.cjs';

function fixture(mode = 'add') {
  const report = emptyDocument(); report.keyframes = [100, 200, 300].map(x => createFrame([createObject(report.figure_types[0], 1, x, 250)], 5));
  const editor = new Editor({demo: false}).load(report), baseline = structuredClone(editor.report.keyframes[1]);
  editor.report.keyframes[1].objects[0].root_x = 777;
  editor.report._styk.simpleFrameDraft = {version: 1, mode, index: 1, frameId: baseline._styk.frameId, baseline};
  return editor.report;
}
test('native Add working pose stays editable in STYK but PIV exports only the saved keys', () => {
  const report = fixture(), before = structuredClone(report), out = materializePivotDocument(report);
  assert.equal(out.keyframes.length, 3); assert.deepEqual(out.keyframes.map(f => f.objects[0].root_x), [100, 200, 300]);
  assert.equal(out._styk.simpleFrameDraft, undefined); assert.deepEqual(report, before);
  assert.equal(out.keyframes[0], report.keyframes[0]); assert.equal(out.figure_types, report.figure_types);
  const reopened = new Editor({demo: false}).load(JSON.parse(JSON.stringify(report)));
  assert.equal(reopened.report.keyframes[1].objects[0].root_x, 777);
  assert.equal(reopened.report._styk.simpleFrameDraft.baseline.objects[0].root_x, 200);
});
test('Update working pose is already a native key; clean native documents retain the exact export path', () => {
  const report = fixture('update'), out = materializeSimpleFrameDraftForPivot(report);
  assert.equal(out.keyframes, report.keyframes); assert.equal(out.keyframes[1].objects[0].root_x, 777);
  assert.equal(out._styk.simpleFrameDraft, undefined);
  delete report._styk.simpleFrameDraft; assert.equal(materializeSimpleFrameDraftForPivot(report), report); assert.equal(materializePivotDocument(report), report);
});
test('draft identity validation rejects a bad checkpoint without changing the source', () => {
  const report = fixture(); report._styk.simpleFrameDraft.baseline._styk.frameId = 'wrong'; const before = structuredClone(report);
  assert.throws(() => materializePivotDocument(report), /identity/); assert.deepEqual(report, before);
});
test('actual PIV writer preserves stored frame count and excludes Add working geometry', () => {
  const report = materializePivotDocument(fixture()), python = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
doc=json.load(sys.stdin)
store=server.ProjectStore(server.WORKSPACE)
raw,name=store.export({'document':doc,'format':'piv'})
print(json.dumps(store.import_bytes(raw,name)['document']))
`;
  const candidate = backend.pythonCandidates()[0], result = spawnSync(candidate.command, [...candidate.args, '-c', python], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(report), encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const reopened = JSON.parse(result.stdout); assert.equal(reopened.keyframes.length, 3);
  assert.deepEqual(reopened.keyframes.map(f => f.objects[0].root_x), [100, 200, 300]);
  assert.deepEqual(reopened.keyframes.map(f => f.duration_raw), [5, 5, 5]);
  assert.equal(reopened._styk?.simpleFrameDraft, undefined);
});
