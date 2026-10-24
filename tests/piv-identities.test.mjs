import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NATIVE_FRAME_CONTENT_TYPE, unpackNativeFrameResponse, materializeNativeFrames} from '../src/import-wire.mjs';
import {Editor} from '../src/editor.mjs';
import {nodeCodec} from './support/codec.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('recovered native IDs match JSON import and keep separate editable geometry and joins', async () => {
  {
    // backend/test_piv_identities.py identity_source(), as the codec's fixture (engine/tools/piv/fixtures.py).
    const source = await readFile(path.join(app, 'engine/crates/styk-piv/tests/fixtures/modern-identities.piv')), codec = nodeCodec();
    const request = accept => codec.fetch('/api/import?filename=identities.piv', {method: 'POST', headers: {Accept: accept}, body: source});
    const wire = await request(NATIVE_FRAME_CONTENT_TYPE), json = await request('application/json');
    assert.equal(wire.headers.get('Content-Type'), NATIVE_FRAME_CONTENT_TYPE);
    const buffer = await wire.arrayBuffer();
    const packet = unpackNativeFrameResponse(buffer);
    const expected = await json.json();
    const result = await materializeNativeFrames(packet.result, buffer, packet.offset);
    assert.deepEqual(result.document, expected.document);
    const editor = new Editor({demo: false}).load(result.document);
    assert.equal(editor.totalTicks, 8);
    for (const index of [0, 1, 2, 3]) {
      editor.selectFrame(index);
      assert.equal(editor.geometry.objects.size, 6);
      const frame = editor.report.keyframes[index];
      assert.equal(new Set(frame.objects.map(o => o.unique_id)).size, 6);
      assert.equal(frame.objects[4].join.target_unique_id, frame.objects[2].unique_id);
    }
    editor.selectFrame(0);
    const before = structuredClone(editor.frame);
    editor.select(5); editor.moveSelection(9, 0);
    assert.equal(editor.frame.objects.find(o => o.unique_id === 5).root_x, 289);
    assert.equal(editor.frame.objects.find(o => o.unique_id === 10).root_x, 160);
    assert.ok(editor.undo()); assert.deepEqual(editor.frame, before);
    assert.ok(editor.redo());
    // A raw/unrepaired transfer must fail atomically at the frontend boundary.
    const invalid = buffer.slice(0), fresh = unpackNativeFrameResponse(invalid);
    const repair = fresh.result.document.piv_identity_recovery.objects[0];
    new DataView(invalid).setUint32(fresh.offset+repair.record_offset-fresh.result.nativeFrames.sourceOffset,
      repair.source_unique_id, true);
    await assert.rejects(materializeNativeFrames(fresh.result, invalid, fresh.offset), /Duplicate native figure identity/);
    assert.deepEqual(fresh.result.document.keyframes, []);
  }
});
